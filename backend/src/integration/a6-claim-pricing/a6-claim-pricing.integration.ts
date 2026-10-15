import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordReadinessAssessment } from '../../modules/pre-claim-readiness/pre-claim-readiness.service.ts'
import { createClaim } from '../../modules/claim/claim.service.ts'
import { removeClaimLine } from '../../modules/claim-line/claim-line.service.ts'
import { updateTariffScheduleVersionVerification } from '../../modules/commercial-coverage/tariff-schedule.service.ts'
import { createTariffRate } from '../../modules/tariff-rate/tariff-rate.service.ts'
import { createPricingRun } from '../../modules/claim-pricing/claim-pricing.service.ts'

// A6.3 — focused acceptance for Tariff Rate & Claim Pricing Foundation (T001–T100).
//
// Tariff worlds (payer, contract, schedule, version) are built through the REF-01 owner routes and rates
// through the A6.3 rate routes while each version is UNVERIFIED; the version is then verified through
// its REF-01 owner. Claims come through the A5.7 recorder (with the exact commercial lineage), the A5.9
// owner route and the A6.1/A6.2 owner routes. ADVERSARIAL writes go in only to create a state no owner
// path can create (another tenant's tariff, an unsupported-currency rate, an incompatible assessment, two
// runs at one instant) or to prove that the database refuses them. Every value is synthetic and keyed by
// this run's id.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A6.3] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A6.3] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A6.3] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A6.3] ${title}`)

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

const runId = `A63-${Date.now()}`
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
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const RATE_DIR = 'backend/src/modules/tariff-rate'
const PRICING_DIR = 'backend/src/modules/claim-pricing'
const FE_RATE_DIR = 'frontend/src/modules/tariff-rate'
const FE_PRICING_DIR = 'frontend/src/modules/claim-pricing'
const HARNESS_DIR = 'backend/src/integration/a6-claim-pricing'
const REF_DIR = 'backend/src/modules/commercial-coverage'
const A63_TABLES = ['claim_pricing_line_results', 'claim_pricing_runs', 'tariff_rates']
const A63_ACTIONS = ['tariff_rate.created', 'tariff_rate.retired', 'claim_pricing_run.created']

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

  console.log(`[A6.3] A6.3 tariff rate & claim pricing foundation — run ${runId}`)
  console.log(`[A6.3] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  const priorRunsAtStart = await prisma.claimPricingRun.count({ where: { createdAt: { lt: runStartedAt } } })
  const priorRatesAtStart = await prisma.tariffRate.count({ where: { createdAt: { lt: runStartedAt } } })

  // ---------------------------------------------------------------- gates (T001–T010)
  section('Start gate, migration, permissions and wiring')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a61Merge = mergeOf(a61Branch)
  const a62Merge = mergeOf(a62Branch)
  const laterA6Code = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter((file) => /claim-integrity|claim-approval|claim-payload|claim-submission|claim-draft-assembly/.test(file))
  check(
    'T001',
    'Start gate',
    branch === a63Branch && a61Merge.length === 40 && a62Merge.length === 40 && gitOk('merge-base --is-ancestor origin/main HEAD') && laterA6Code.length === 0,
    `branch ${branch}; A6.1 merged as ${a61Merge.slice(0, 7) || 'NOT FOUND'}; A6.2 merged as ${a62Merge.slice(0, 7) || 'NOT FOUND'}; contains latest main ${git('rev-parse --short origin/main')}; no A6.4+ code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check('T003', 'A6.1/A6.2 ancestry', a61Merge.length === 40 && a62Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a61Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${a62Merge} HEAD`), 'both merge commits are ancestors of HEAD')

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const createdTables = (statements.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).map((m) => m.replace(/CREATE TABLE "|"/g, '')).sort()
  const schemaDiff = git('diff origin/main...HEAD -- :/backend/prisma/schema.prisma').split(/\r?\n/)
  const schemaRemoved = schemaDiff.filter((l) => l.startsWith('-') && !l.startsWith('---'))
  const schemaAddedModels = schemaDiff.filter((l) => /^\+\s*model /.test(l)).map((l) => l.replace(/^\+\s*model\s+(\w+).*$/, '$1')).sort()
  const scopeProblems = [
    [same(createdTables, A63_TABLES), `tables created: ${createdTables.join(', ')}`],
    [!/DROP (INDEX|TABLE|COLUMN)/.test(statements) && !/SET DEFAULT pg_catalog/.test(statements), 'drift'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((m) => A63_TABLES.some((table) => m.includes(`"${table}"`))), 'a table outside A6.3 is altered'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 13 && !/ON DELETE (CASCADE|SET NULL)/.test(statements), 'the thirteen foreign keys are not all ON DELETE RESTRICT'],
    [(statements.match(/CREATE (CONSTRAINT )?TRIGGER [a-z_]+_trg/g) ?? []).length === 7, 'the seven integrity/history triggers are not all created'],
    [!/\b(patient_share|net_amount|copay|coinsurance|discount|tax|approv\w*|payload|xml|x12|npi|nabidh|malaffi|riayati|submission\w*|lifecycle|status)\b/i.test(statements), 'a patient-share, approval, payload, lifecycle or HIE column appears'],
    [schemaRemoved.length === 0 && same(schemaAddedModels, ['ClaimPricingLineResult', 'ClaimPricingRun', 'TariffRate']), 'the schema diff is not exactly the three models and their relations'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T004',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1 ? `expected exactly one migration, found ${migrationPaths.length}` : scopeProblems.length === 0 ? 'one migration; exactly three A6.3 tables, thirteen RESTRICT foreign keys and seven guards; no drift' : `out of scope: ${scopeProblems.join('; ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  const replayA63 = [
    /PASS {2}the A6\.3 CHECKs pin A6-RATE-1 and A6-PRICE-1/,
    /PASS {2}tariff_rates_active_identity_uidx is a partial NULLS NOT DISTINCT unique index/,
    /PASS {2}claim_pricing_runs_complete_trg is present/,
    /PASS {2}tariff_rates carries exactly its 13 A6\.3 columns/,
    /PASS {2}the A6\.3 tables are exactly tariff_rates, claim_pricing_runs and claim_pricing_line_results/,
    /PASS {2}the claim tables are exactly claims plus the four A6\.2 tables/,
  ]
  check(
    'T006',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayA63.every((pattern) => pattern.test(replay.output)),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the A6.3 constraints, unique keys and guards survive`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const familyExpected = ['claimPricing.create', 'claimPricing.read', 'tariffRate.create', 'tariffRate.read', 'tariffRate.update']
  const family = allCodes.filter((code) => /^(tariffRate|claimPricing)\./.test(code)).sort()
  const grants: string[] = []
  for (const code of familyExpected) grants.push(`${code}=${await grantsOf(code)}`)
  const invented = allCodes.filter((code) => /(approve|submit|transmit|patientShare|claimPayload|claimSubmission|remittance)/i.test(code))
  check(
    'T007',
    'Permissions',
    same(family, familyExpected) && same(grants, familyExpected.map((code) => `${code}=${code.endsWith('.read') ? 'ORG_ADMIN,ORG_VIEWER' : 'ORG_ADMIN'}`)) && invented.length === 0,
    'tariffRate create/update and claimPricing create for Admin; reads for Admin and Viewer; no approval, submission or patient-share permission',
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

  // §1 — owner routes for every route this package wires.
  const wiring = [
    await api('POST', `/api/tariff-schedule-versions/${MISSING}/rates`, {}),
    await api('GET', `/api/tariff-schedule-versions/${MISSING}/rates`),
    await api('POST', `/api/tariff-rates/${MISSING}/retire`, {}),
    await api('POST', `/api/claims/${MISSING}/pricing-runs`, {}),
    await api('GET', `/api/claims/${MISSING}/pricing-runs`),
    await api('GET', `/api/claim-pricing-runs/${MISSING}`),
  ]
  const forbiddenVerbs = [await api('DELETE', `/api/tariff-rates/${MISSING}`), await api('PATCH', `/api/tariff-rates/${MISSING}`, {}), await api('DELETE', `/api/claim-pricing-runs/${MISSING}`), await api('PUT', `/api/claim-pricing-runs/${MISSING}`, {})]
  const unauthenticated = [await api('POST', `/api/tariff-schedule-versions/${MISSING}/rates`, {}, anonymous), await api('POST', `/api/claims/${MISSING}/pricing-runs`, {}, anonymous)]
  check(
    'T008',
    'Route wiring',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && forbiddenVerbs.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `six routes answer a missing target with a privacy-safe 404; DELETE/PATCH/PUT are absent (${forbiddenVerbs.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
  )

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const svcA = must('service A', (await post(`/api/organizations/${org}/services`, { internalCode: key('SA'), displayName: 'Synthetic service A' })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: 'Synthetic service B' })).body)
  const procA = must('procedure A', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PA'), displayName: 'Synthetic procedure A', codeSystem: 'SYNTHETIC', externalCode: key('XA') })).body)
  const procB = must('procedure B', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PB'), displayName: 'Synthetic procedure B', codeSystem: 'SYNTHETIC', externalCode: key('XB') })).body)

  // A tariff world: payer, contract (with this facility), schedule and one version, all through REF-01.
  const world = async (label: string, effectiveFrom: string | null = '2026-01-01') => {
    const payer = must(`${label} payer`, (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} ${label} payer` })).body)
    const contract = must(`${label} contract`, (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key(`C-${label}`), displayName: `${runId} ${label} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    must(`${label} contract facility`, (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
    const schedule = must(`${label} schedule`, (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key(`T-${label}`), displayName: `${runId} ${label} tariff` })).body)
    const version = must(`${label} version`, (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key(`V-${label}`), effectiveFrom, effectiveTo: null })).body)
    return { payerId: payer.id as string, contractId: contract.id as string, scheduleId: schedule.id as string, versionId: version.id as string }
  }
  const newVersion = async (scheduleId: string, label: string, effectiveFrom: string | null = '2026-01-01') =>
    must(`${label} version`, (await post(`/api/tariff-schedules/${scheduleId}/versions`, { version: key(`V-${label}`), effectiveFrom, effectiveTo: null })).body).id as string
  const verify = async (versionId: string, verificationStatus = 'VERIFIED') => (await post(`/api/tariff-schedule-versions/${versionId}/verification`, { verificationStatus })).status
  const rateHttp = (versionId: string, body: Record<string, unknown>, who: Who = asAdmin) => api('POST', `/api/tariff-schedule-versions/${versionId}/rates`, body, who)
  const procRate = (procedureCodeId: string, unitTariffAmount: string, extra: Record<string, unknown> = {}) => ({ selectorKind: 'PROCEDURE_CODE', procedureCodeId, modifierCodes: [], currencyCode: 'AED', unitTariffAmount, ...extra })
  const svcRate = (serviceId: string, unitTariffAmount: string, extra: Record<string, unknown> = {}) => ({ selectorKind: 'SERVICE', serviceId, modifierCodes: [], currencyCode: 'AED', unitTariffAmount, ...extra })
  const mustRate = async (versionId: string, body: Record<string, unknown>) => must('rate', (await rateHttp(versionId, body)).body)

  type World = Awaited<ReturnType<typeof world>>
  const plainContext = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: null as string | null, tpaId: null, networkId: null, insuranceProductId: null,
      providerContractId: null as string | null, tariffScheduleId: null as string | null, tariffScheduleVersionId: null as string | null,
    }
  }
  const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
  const recordRun = async (encounterId: string, activityIds: string[], lineage: { world: World; versionId?: string } | null) => {
    const contextSnapshot = await plainContext(encounterId)
    if (lineage) {
      contextSnapshot.payerId = lineage.world.payerId
      contextSnapshot.providerContractId = lineage.world.contractId
      contextSnapshot.tariffScheduleId = lineage.world.scheduleId
      contextSnapshot.tariffScheduleVersionId = lineage.versionId ?? lineage.world.versionId
    }
    const findings = [finding('WARNING', { layer: 'CODING' }), ...activityIds.map((encounterActivityId) => finding('PASS', { encounterActivityId }))]
    const result = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId, contextSnapshot, validatorVersion: 'A5-VAL-1', findings }, actorUserId, tx))
    if (!result.ok) throw new Error(`a valid synthetic run was refused by the A5.7 recorder: ${result.message}`)
    return result.value.id
  }
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
  const assess = async (validationRunId: string) => {
    const res = await post(`/api/validation-runs/${validationRunId}/readiness-assessments`, {})
    if (res.status !== 201 || res.body?.state !== 'READY_FOR_REVIEW') throw new Error(`a valid READY assessment was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body.id as string
  }
  type ActivitySpec = { serviceId?: string; procedureCodeId?: string; quantity: string; unitCode?: string; modifierCodes?: string[] }
  // An Encounter with the given activities, a READY run naming them with the given commercial lineage, its
  // Claim, and one A6.2 line per activity in order.
  const pricedClaim = async (label: string, lineage: { world: World; versionId?: string } | null, activities: ActivitySpec[], lines = true) => {
    const encounter = must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body)
    const activityIds: string[] = []
    for (const spec of activities) activityIds.push(must(`${label} activity`, (await post(`/api/encounters/${encounter.id}/activities`, spec)).body).id)
    const validationRunId = await recordRun(encounter.id, activityIds, lineage)
    const assessmentId = await assess(validationRunId)
    const claim = (await post(`/api/pre-claim-readiness-assessments/${assessmentId}/claims`, {})).body
    if (!claim?.id) throw new Error(`fixture ${label} claim refused: ${JSON.stringify(claim).slice(0, 200)}`)
    const lineIds: string[] = []
    if (lines) for (const activityId of activityIds) lineIds.push(must(`${label} line`, (await post(`/api/claims/${claim.id}/lines`, { encounterActivityId: activityId })).body).id)
    return { encounterId: encounter.id as string, claimId: claim.id as string, activityIds, lineIds, validationRunId }
  }
  const priceHttp = (claimId: string, body: unknown = {}, who: Who = asAdmin) => api('POST', `/api/claims/${claimId}/pricing-runs`, body, who)
  const runsOf = (claimId: string) => prisma.claimPricingRun.count({ where: { claimId } })
  const a63Audits = () => prisma.auditEvent.count({ where: { actionCode: { in: A63_ACTIONS } } })
  const lineOf = (run: any, claimLineId: string) => (run?.lines ?? []).find((line: any) => line.claimLineId === claimLineId)

  // Another tenant: a payer/contract/schedule/version and a service of the other organization. No owner
  // route acts for another tenant, so they are written directly (synthetic, keyed by this run).
  const foreignService = await prisma.service.create({ data: { organizationId: otherOrg, internalCode: key('FS'), displayName: 'Synthetic foreign service' } })
  const foreignPayer = await prisma.payer.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign payer` } })
  const foreignContract = await prisma.providerContract.create({ data: { organizationId: otherOrg, payerId: foreignPayer.id, contractKey: key('FC'), displayName: 'Synthetic foreign contract', effectiveFrom: new Date('2025-01-01') } })
  const foreignSchedule = await prisma.tariffSchedule.create({ data: { providerContractId: foreignContract.id, tariffKey: key('FT'), displayName: 'Synthetic foreign tariff' } })
  const foreignVersion = await prisma.tariffScheduleVersion.create({ data: { tariffScheduleId: foreignSchedule.id, version: key('FV'), effectiveFrom: new Date('2026-01-01') } })
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  let foreignClaimId: string | null = null
  if (foreignEncounter) {
    const contextSnapshot = await plainContext(foreignEncounter.id)
    const recorded = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId: foreignEncounter.id, contextSnapshot, validatorVersion: 'A5-VAL-1', findings: [finding('PASS', { findingCode: 'SYNTHETIC_FOREIGN' })] }, actorUserId, tx))
    const assessment = recorded.ok ? await recordReadinessAssessment(recorded.value.id, {}, actorUserId) : null
    const claim = assessment?.ok ? await createClaim(assessment.value.id, {}, actorUserId) : null
    foreignClaimId = claim?.ok ? claim.value.id : null
  }
  console.log('[A6.3]      fixtures ready: patient, AE-DU/DHA facility profile, clinician, services, procedure codes, and another tenant\'s tariff, service and Claim')

  // ---------------------------------------------------------------- rate entry (T011–T030)
  section('Tariff rate entry, selector, tenancy and validation')
  const rw = await world('rates')
  const auditsBefore11 = await a63Audits()
  const svcRateRes = await rateHttp(rw.versionId, svcRate(svcA.id, '50.0000'))
  check(
    'T011',
    'Admin SERVICE rate',
    svcRateRes.status === 201 && svcRateRes.body?.rateContractVersion === 'A6-RATE-1' && svcRateRes.body?.serviceId === svcA.id && svcRateRes.body?.procedureCodeId === null && (await a63Audits()) === auditsBefore11 + 1,
    `201 ${svcRateRes.body?.rateContractVersion}; one tariff_rate.created event`,
  )
  const procRateRes = await rateHttp(rw.versionId, procRate(procA.id, '125.2500', { modifierCodes: [' M2 ', 'M1'], unitCodeKey: ' SYN-U ' }))
  check(
    'T012',
    'Admin PROCEDURE_CODE rate',
    procRateRes.status === 201 && procRateRes.body?.procedureCodeId === procA.id && procRateRes.body?.serviceId === null && procRateRes.body?.unitCodeKey === 'SYN-U',
    '201; unit trimmed to SYN-U',
  )
  const xor = [
    await rateHttp(rw.versionId, { ...svcRate(svcB.id, '1'), procedureCodeId: procB.id }),
    await rateHttp(rw.versionId, { selectorKind: 'SERVICE', procedureCodeId: procB.id, modifierCodes: [], currencyCode: 'AED', unitTariffAmount: '1' }),
    await rateHttp(rw.versionId, { ...svcRate(svcB.id, '1'), selectorKind: 'BUNDLE' }),
  ]
  check('T013', 'Selector XOR (service)', xor.every((res) => res.status === 400), `both identities, the wrong identity and an unknown selector are refused (${xor.map((r) => r.status).join('/')})`)
  const insertRateSql = `INSERT INTO tariff_rates (id, tariff_schedule_version_id, selector_kind, service_id, procedure_code_id, unit_code_key, modifier_signature, currency_code, unit_tariff_amount, rate_contract_version, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5, $6::text[], $7, $8::numeric, 'A6-RATE-1', $9::uuid)`
  const directRate = (versionId: string, selector: string, serviceId: string | null, procedureCodeId: string | null, unit: string | null, modifiers: string[], currency: string, amount: string) =>
    attemptAdversarial(() => prisma.$executeRawUnsafe(insertRateSql, versionId, selector, serviceId, procedureCodeId, unit, modifiers, currency, amount, actorUserId))
  const dbXor = [await directRate(rw.versionId, 'SERVICE', null, null, null, [], 'AED', '1'), await directRate(rw.versionId, 'SERVICE', svcB.id, procB.id, null, [], 'AED', '1')]
  check('T014', 'Selector XOR (database)', dbXor.every((message) => /tariff_rates_selector_chk/.test(message)), 'a direct rate with no identity or two identities is rejected')
  const foreignVersionRes = await rateHttp(foreignVersion.id, svcRate(svcA.id, '1'))
  const foreignVersionList = await api('GET', `/api/tariff-schedule-versions/${foreignVersion.id}/rates`)
  check(
    'T015',
    'Foreign tariff version',
    foreignVersionRes.status === 404 && foreignVersionList.status === 404 && errorCode(foreignVersionRes.body) === 'NOT_FOUND' && (await prisma.tariffRate.count({ where: { tariffScheduleVersionId: foreignVersion.id } })) === 0,
    'create and list on another tenant\'s version are answered exactly like a missing one (404)',
  )
  const foreignMaster = await rateHttp(rw.versionId, svcRate(foreignService.id, '1'))
  const dbForeignMaster = await directRate(rw.versionId, 'SERVICE', foreignService.id, null, null, [], 'AED', '1')
  check('T016', 'Foreign rated master', foreignMaster.status === 404 && /tariff_rates_scope/.test(dbForeignMaster), 'another tenant\'s service is "not found" through the route and rejected by the database')
  const missingVersion = await rateHttp(MISSING, svcRate(svcA.id, '1'))
  const malformedVersion = await rateHttp('not-a-uuid', svcRate(svcA.id, '1'))
  check('T017', 'Missing/malformed version', missingVersion.status === 404 && malformedVersion.status === 400 && !rawError(malformedVersion.body), `missing ${missingVersion.status}, malformed ${malformedVersion.status}; safe envelopes`)
  const blankUnit = await rateHttp(rw.versionId, svcRate(svcB.id, '1', { unitCodeKey: '  ' }))
  const dbBlankUnit = await directRate(rw.versionId, 'SERVICE', svcB.id, null, ' ', [], 'AED', '1')
  check('T018', 'Unit validation', blankUnit.status === 400 && /tariff_rates_unit_code_chk/.test(dbBlankUnit), 'a blank unit is refused by the service and the database')
  const badModifiers = [await rateHttp(rw.versionId, svcRate(svcB.id, '1', { modifierCodes: [''] })), await rateHttp(rw.versionId, svcRate(svcB.id, '1', { modifierCodes: ['M1', 'M1'] })), await rateHttp(rw.versionId, svcRate(svcB.id, '1', { modifierCodes: 'M1' }))]
  check(
    'T019',
    'Modifier validation',
    badModifiers.every((res) => res.status === 400) && same(procRateRes.body?.modifierCodes, ['M1', 'M2']),
    `blank, repeated and non-array modifiers are refused (${badModifiers.map((r) => r.status).join('/')}); [" M2 ","M1"] is stored canonically as [M1, M2]`,
  )
  const dbUnsorted = await directRate(rw.versionId, 'SERVICE', svcB.id, null, null, ['M2', 'M1'], 'AED', '1')
  const dbPadded = await directRate(rw.versionId, 'SERVICE', svcB.id, null, null, [' M1'], 'AED', '1')
  check('T020', 'Modifier signature (database)', /tariff_rates_modifier_signature/.test(dbUnsorted) && /tariff_rates_modifier_signature/.test(dbPadded), 'an unsorted or padded signature is rejected by the database')

  const storedProc = procRateRes.body?.id ? await prisma.tariffRate.findUnique({ where: { id: procRateRes.body.id } }) : null
  const precision = [await rateHttp(rw.versionId, svcRate(svcB.id, '1.23456')), await rateHttp(rw.versionId, svcRate(svcB.id, 1.5 as unknown as string)), await rateHttp(rw.versionId, svcRate(svcB.id, '1e3'))]
  check(
    'T021',
    'Decimal amount precision',
    storedProc?.unitTariffAmount.toFixed(4) === '125.2500' && procRateRes.body?.unitTariffAmount === '125.2500' && precision.every((res) => res.status === 400),
    `125.2500 is stored exactly; 5 decimals, a JSON number and exponent notation are refused (${precision.map((r) => r.status).join('/')})`,
  )
  const negative = await rateHttp(rw.versionId, svcRate(svcB.id, '-1'))
  const dbNegative = await directRate(rw.versionId, 'SERVICE', svcB.id, null, null, [], 'AED', '-1')
  check('T022', 'No negative amount', negative.status === 400 && /tariff_rates_amount_chk/.test(dbNegative), 'refused by the service and the database')
  const currencies = [await rateHttp(rw.versionId, svcRate(svcB.id, '1', { currencyCode: 'aed' })), await rateHttp(rw.versionId, svcRate(svcB.id, '1', { currencyCode: 'USD' }))]
  const dbCurrency = await directRate(rw.versionId, 'SERVICE', svcB.id, null, null, [], 'aed', '1')
  check('T023', 'Currency validation', currencies.every((res) => res.status === 400) && /tariff_rates_currency_chk/.test(dbCurrency), 'lowercase and unconfigured (USD) currencies are refused; the database rejects a non-ISO code')
  const zeroRate = await rateHttp(rw.versionId, procRate(procB.id, '0.0000'))
  check('T024', 'Explicit zero rate', zeroRate.status === 201 && zeroRate.body?.unitTariffAmount === '0.0000', 'an explicit 0.0000 AED rate is a real rate, accepted')
  const auditsBefore25 = await a63Audits()
  const duplicate = await rateHttp(rw.versionId, svcRate(svcA.id, '60.0000'))
  const dbDuplicate = await directRate(rw.versionId, 'SERVICE', svcA.id, null, null, [], 'AED', '70')
  check(
    'T025',
    'Duplicate active identity',
    duplicate.status === 409 && errorCode(duplicate.body) === 'RATE_DUPLICATE' && /tariff_rates_active_identity_uidx|unique|23505|P2010/i.test(dbDuplicate) && (await a63Audits()) === auditsBefore25,
    'a second active rate for the same exact identity is 409 RATE_DUPLICATE, also at a different amount; the database refuses it too; no audit',
  )
  const svcNullUnit = await rateHttp(rw.versionId, svcRate(svcB.id, '5.0000'))
  const svcNullUnitAgain = await rateHttp(rw.versionId, svcRate(svcB.id, '6.0000'))
  const svcWithUnit = await rateHttp(rw.versionId, svcRate(svcB.id, '7.0000', { unitCodeKey: 'SYN-U' }))
  check(
    'T026',
    'No-unit is one exact value',
    svcNullUnit.status === 201 && svcNullUnitAgain.status === 409 && svcWithUnit.status === 201,
    'two "no unit" rates for one identity collide (NULLS NOT DISTINCT); the same identity with a unit is a different rate',
  )
  const auditsBefore27 = await a63Audits()
  const retire = await api('POST', `/api/tariff-rates/${svcNullUnit.body?.id}/retire`, {})
  const retiredRow = svcNullUnit.body?.id ? await prisma.tariffRate.findUnique({ where: { id: svcNullUnit.body.id } }) : null
  check('T027', 'Retire', retire.status === 200 && retiredRow?.removedAt !== null && retire.body?.removedAt !== null && (await a63Audits()) === auditsBefore27 + 1, 'removedAt is stamped by the database; one tariff_rate.retired event; the row stays')
  const auditsBefore28 = await a63Audits()
  const retireAgain = await api('POST', `/api/tariff-rates/${svcNullUnit.body?.id}/retire`, {})
  check('T028', 'Retire again', retireAgain.status === 409 && errorCode(retireAgain.body) === 'RATE_ALREADY_RETIRED' && (await a63Audits()) === auditsBefore28, '409 RATE_ALREADY_RETIRED; no audit')
  const readd = await rateHttp(rw.versionId, svcRate(svcB.id, '8.0000'))
  check('T029', 'Re-add after retire', readd.status === 201 && readd.body?.id !== svcNullUnit.body?.id && (await prisma.tariffRate.count({ where: { tariffScheduleVersionId: rw.versionId, serviceId: svcB.id, unitCodeKey: null } })) === 2, 'the same identity is added again as a new rate; the retired rate remains as history')
  const rateDelete = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM tariff_rates WHERE id = $1::uuid`, readd.body?.id))
  const rateAmountEdit = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE tariff_rates SET unit_tariff_amount = 9 WHERE id = $1::uuid`, readd.body?.id))
  const rateRestore = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE tariff_rates SET removed_at = NULL WHERE id = $1::uuid`, svcNullUnit.body?.id))
  check(
    'T030',
    'No delete, edit or restore',
    /cannot be deleted/.test(rateDelete) && /identity and amount are immutable/.test(rateAmountEdit) && /cannot be changed or restored/.test(rateRestore),
    'a direct DELETE, amount edit or restore of a retired rate is rejected',
  )

  // ---------------------------------------------------------------- verified lock and races (T031–T040)
  section('Verified version lock, unverified pricing refusal and write races')
  if ((await verify(rw.versionId)) !== 200) throw new Error('fixture: the rates version could not be verified')
  const lockedCreate = await rateHttp(rw.versionId, svcRate(svcB.id, '9.0000', { unitCodeKey: 'SYN-Z' }))
  check('T031', 'VERIFIED blocks create', lockedCreate.status === 409 && errorCode(lockedCreate.body) === 'RATE_VERSION_LOCKED', '409 RATE_VERSION_LOCKED')
  const lockedRetire = await api('POST', `/api/tariff-rates/${readd.body?.id}/retire`, {})
  check('T032', 'VERIFIED blocks retire', lockedRetire.status === 409 && errorCode(lockedRetire.body) === 'RATE_VERSION_LOCKED', '409 RATE_VERSION_LOCKED')
  const dbLockedInsert = await directRate(rw.versionId, 'SERVICE', svcB.id, null, 'SYN-Z', [], 'AED', '1')
  const dbLockedRetire = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE tariff_rates SET removed_at = now() WHERE id = $1::uuid`, readd.body?.id))
  check('T033', 'VERIFIED lock (database)', /rate_version_locked/.test(dbLockedInsert) && /rate_version_locked/.test(dbLockedRetire), 'the database refuses a direct rate insert into, or retirement under, a VERIFIED version')
  const reviewWorld = await world('in review')
  const inReview = await verify(reviewWorld.versionId, 'IN_REVIEW')
  const reviewCreate = await rateHttp(reviewWorld.versionId, svcRate(svcA.id, '1'))
  check('T034', 'IN_REVIEW blocks create', inReview === 200 && reviewCreate.status === 409 && errorCode(reviewCreate.body) === 'RATE_VERSION_LOCKED', 'rates are written only while UNVERIFIED')
  const unverifiedWorld = await world('unverified')
  await mustRate(unverifiedWorld.versionId, procRate(procA.id, '10.0000'))
  const unverifiedClaim = await pricedClaim('unverified claim', { world: unverifiedWorld }, [{ procedureCodeId: procA.id, quantity: '1' }])
  const unverifiedPrice = await priceHttp(unverifiedClaim.claimId)
  check(
    'T035',
    'Unverified bound version',
    unverifiedPrice.status === 409 && errorCode(unverifiedPrice.body) === 'PRICING_COMMERCIAL_CONTEXT_UNRESOLVED' && (await runsOf(unverifiedClaim.claimId)) === 0,
    '409 PRICING_COMMERCIAL_CONTEXT_UNRESOLVED; no run',
  )

  // Rate create vs verification, both ways: whichever holds the version row first decides; the other
  // waits for it and then decides on the committed state.
  const raceA = await world('race a')
  const holdCreate = holdAt('tariffRate.version_locked')
  const createFirst = createTariffRate(raceA.versionId, svcRate(svcA.id, '11.0000'), actorUserId)
  await Promise.race([holdCreate.arrived, createFirst])
  const verifyBehind = updateTariffScheduleVersionVerification(raceA.versionId, 'VERIFIED', actorUserId)
  const verifyWaited = !(await settledWithin(verifyBehind, 600))
  holdCreate.release()
  const [createA, verifyA] = await Promise.all([createFirst, verifyBehind])
  clearConcurrencyProbes()
  const raceB = await world('race b')
  const holdVerify = holdAt('tariff_schedule_version.verification')
  const verifyFirst = updateTariffScheduleVersionVerification(raceB.versionId, 'VERIFIED', actorUserId)
  await Promise.race([holdVerify.arrived, verifyFirst])
  const createBehind = createTariffRate(raceB.versionId, svcRate(svcA.id, '12.0000'), actorUserId)
  const createWaited = !(await settledWithin(createBehind, 600))
  holdVerify.release()
  const [verifyB, createB] = await Promise.all([verifyFirst, createBehind])
  clearConcurrencyProbes()
  check(
    'T036',
    'Rate write vs verification',
    verifyWaited && createA.ok && verifyA.ok && createWaited && verifyB.ok && !createB.ok && createB.code === 'RATE_VERSION_LOCKED' && (await prisma.tariffRate.count({ where: { tariffScheduleVersionId: raceB.versionId } })) === 0,
    'a held rate write made verification wait and both committed; a held verification made the rate write wait and then refuse it (RATE_VERSION_LOCKED)',
  )

  // Main priced world: verified rates for the worked example.
  const pw = await world('priced')
  const rProcA = await mustRate(pw.versionId, procRate(procA.id, '125.2500'))
  const rSvcB = await mustRate(pw.versionId, svcRate(svcB.id, '12.1250'))
  const rZero = await mustRate(pw.versionId, procRate(procB.id, '0.0000', { unitCodeKey: 'SYN-U', modifierCodes: ['M1', 'M2'] }))
  const rSvcA = await mustRate(pw.versionId, svcRate(svcA.id, '125.2500'))
  if ((await verify(pw.versionId)) !== 200) throw new Error('fixture: the priced version could not be verified')
  const c1 = await pricedClaim('worked example', { world: pw }, [
    { procedureCodeId: procA.id, quantity: '1.5' },
    { serviceId: svcB.id, quantity: '1' },
  ])

  const holdPricing = holdAt('claimPricing.version_locked')
  const heldPricing = createPricingRun(c1.claimId, {}, actorUserId)
  await Promise.race([holdPricing.arrived, heldPricing])
  const writerBlocked = await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '800ms'`)
      await tx.$queryRawUnsafe(`SELECT id FROM tariff_schedule_versions WHERE id = $1::uuid FOR UPDATE`, pw.versionId)
    }),
  )
  holdPricing.release()
  const heldResult = await heldPricing
  clearConcurrencyProbes()
  check('T037', 'Pricing holds the version', /lock timeout|55P03|canceling statement/i.test(writerBlocked) && heldResult.ok, 'while a pricing run reads the bound version, a FOR UPDATE writer (rate write or verification) cannot take it')
  const concurrent = await Promise.all([priceHttp(c1.claimId), priceHttp(c1.claimId)])
  const concurrentIds = concurrent.map((res) => res.body?.id)
  check(
    'T038',
    'Concurrent pricing runs',
    concurrent.every((res) => res.status === 201 && res.body?.overallResult === 'PRICED') && concurrentIds[0] !== concurrentIds[1],
    'two simultaneous pricing runs of one Claim both complete as separate immutable runs',
  )
  const c5 = await pricedClaim('edit race', { world: pw }, [
    { procedureCodeId: procA.id, quantity: '1' },
    { serviceId: svcB.id, quantity: '2' },
  ])
  const holdGate = holdAt('claimPricing.create')
  const pricingFirst = createPricingRun(c5.claimId, {}, actorUserId)
  await Promise.race([holdGate.arrived, pricingFirst])
  const removalBehind = removeClaimLine(c5.lineIds[1], {}, actorUserId)
  const removalWaited = !(await settledWithin(removalBehind, 600))
  holdGate.release()
  const [pricedBefore, removal] = await Promise.all([pricingFirst, removalBehind])
  clearConcurrencyProbes()
  const pricedAfter = await createPricingRun(c5.claimId, {}, actorUserId)
  check(
    'T039',
    'Pricing vs line edit',
    removalWaited && pricedBefore.ok && pricedBefore.value.lineCount === 2 && removal.ok && pricedAfter.ok && pricedAfter.value.lineCount === 1,
    'a line removal waited for the pricing run holding the Claim; the run saw 2 lines, the next run sees 1; no mixed snapshot',
  )
  const emptyWorld = await world('empty rates')
  const emptyVerified = await verify(emptyWorld.versionId)
  const emptyClaim = await pricedClaim('no rates', { world: emptyWorld }, [{ procedureCodeId: procA.id, quantity: '1' }])
  const emptyPrice = await priceHttp(emptyClaim.claimId)
  check(
    'T040',
    'Verified version without rates',
    emptyVerified === 200 && emptyPrice.status === 201 && emptyPrice.body?.overallResult === 'INCOMPLETE' && emptyPrice.body?.lines?.[0]?.outcome === 'UNPRICED_RATE_MISSING',
    'a version verifies without rates; pricing then persists an INCOMPLETE run with UNPRICED_RATE_MISSING',
  )

  // ---------------------------------------------------------------- handoff and lineage (T041–T050)
  section('Bound handoff and exact commercial lineage')
  const run1 = await priceHttp(c1.claimId)
  const R1 = run1.body as any
  check(
    'T041',
    'Admin pricing run',
    run1.status === 201 && R1?.pricingContractVersion === 'A6-PRICE-1' && R1?.tariffScheduleVersionId === pw.versionId && R1?.providerContractId === pw.contractId && R1?.tariffScheduleId === pw.scheduleId,
    '201 A6-PRICE-1 against exactly the bound contract, schedule and version',
  )
  const bodies = [await priceHttp(c1.claimId, { tariffScheduleVersionId: pw.versionId }), await priceHttp(c1.claimId, { lines: [] }), await priceHttp(c1.claimId, { totalExtendedTariffAmount: '1' }), await priceHttp(c1.claimId, [])]
  check('T042', 'Body empty only', bodies.every((res) => res.status === 400), `a caller-supplied version, line list, total or non-object body is refused (${bodies.map((r) => r.status).join('/')})`)
  const superseded = await pricedClaim('superseded', { world: pw }, [{ procedureCodeId: procA.id, quantity: '1' }])
  await recordRun(superseded.encounterId, superseded.activityIds, { world: pw })
  const supersededPrice = await priceHttp(superseded.claimId)
  check('T043', 'Superseded basis', supersededPrice.status === 409 && errorCode(supersededPrice.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION' && (await runsOf(superseded.claimId)) === 0, '409 READINESS_SUPERSEDED_BY_NEWER_VALIDATION; no run')
  const tie = await pricedClaim('tie', { world: pw }, [{ procedureCodeId: procA.id, quantity: '1' }])
  await copyRunAtSameInstant(tie.validationRunId)
  const tiePrice = await priceHttp(tie.claimId)
  check('T044', 'Recency tie', tiePrice.status === 409 && errorCode(tiePrice.body) === 'VALIDATION_RUN_RECENCY_AMBIGUOUS' && (await runsOf(tie.claimId)) === 0, '409 VALIDATION_RUN_RECENCY_AMBIGUOUS; no identifier wins')
  const incompatible = await pricedClaim('incompatible', { world: pw }, [{ procedureCodeId: procA.id, quantity: '1' }], false)
  const incompatibleAssessment = (
    await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO pre_claim_readiness_assessments (id, validation_run_id, readiness_policy_version, state, assessed_at, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, 'A5-READY-2', 'READY_FOR_REVIEW', now(), $2::uuid) RETURNING id::text AS id`,
      await recordRun(incompatible.encounterId, incompatible.activityIds, { world: pw }),
      actorUserId,
    )
  )[0].id
  const incompatibleClaim = (
    await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO claims (id, encounter_id, pre_claim_readiness_assessment_id, claim_contract_version, handoff_schema_version, created_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'A6-CLAIM-1', 'PreClaimA6HandoffV1', $3::uuid) RETURNING id::text AS id`,
      incompatible.encounterId,
      incompatibleAssessment,
      actorUserId,
    )
  )[0].id
  const incompatiblePrice = await priceHttp(incompatibleClaim)
  check('T045', 'Incompatible handoff', incompatiblePrice.status === 409 && errorCode(incompatiblePrice.body) === 'CLAIM_HANDOFF_INCOMPATIBLE', '409 CLAIM_HANDOFF_INCOMPATIBLE; no run')
  const noLineage = await pricedClaim('no lineage', null, [{ procedureCodeId: procA.id, quantity: '1' }])
  const noLineagePrice = await priceHttp(noLineage.claimId)
  check('T046', 'Null commercial lineage', noLineagePrice.status === 409 && errorCode(noLineagePrice.body) === 'PRICING_COMMERCIAL_CONTEXT_UNRESOLVED' && (await runsOf(noLineage.claimId)) === 0, 'a bound run without contract/schedule/version is refused; A5.5 is never asked to choose one')
  const futureWorld = await world('future', '2027-01-01')
  await verify(futureWorld.versionId)
  const futureClaim = await pricedClaim('future version', { world: futureWorld }, [{ procedureCodeId: procA.id, quantity: '1' }])
  const futurePrice = await priceHttp(futureClaim.claimId)
  check('T047', 'Version not effective', futurePrice.status === 409 && errorCode(futurePrice.body) === 'PRICING_COMMERCIAL_CONTEXT_UNRESOLVED', 'a version effective only after the service date is refused')
  const openWorld = await world('indeterminate', null)
  await verify(openWorld.versionId)
  const openClaim = await pricedClaim('indeterminate version', { world: openWorld }, [{ procedureCodeId: procA.id, quantity: '1' }])
  const openPrice = await priceHttp(openClaim.claimId)
  check('T048', 'Indeterminate version dates', openPrice.status === 409 && errorCode(openPrice.body) === 'PRICING_COMMERCIAL_CONTEXT_UNRESOLVED', 'a version with no provable effective start is refused, never assumed')
  const newerVersion = await newVersion(pw.scheduleId, 'priced newer')
  await mustRate(newerVersion, procRate(procA.id, '999.0000'))
  await verify(newerVersion)
  const afterNewer = await priceHttp(c1.claimId)
  check(
    'T049',
    'No current-version substitution',
    afterNewer.status === 201 && afterNewer.body?.tariffScheduleVersionId === pw.versionId && lineOf(afterNewer.body, c1.lineIds[0])?.extendedTariffAmount === '187.88',
    'a newer VERIFIED version of the same schedule exists; the run still prices the bound version (AED 187.88, not 999)',
  )
  const insertRunSql = `INSERT INTO claim_pricing_runs (id, claim_id, pricing_contract_version, tariff_schedule_version_id, provider_contract_id, tariff_schedule_id, evaluated_at, created_by_user_id, input_structure_fingerprint, overall_result, line_count, priced_count, currency_code, total_extended_amount) VALUES (gen_random_uuid(), $1::uuid, 'A6-PRICE-1', $2::uuid, $3::uuid, $4::uuid, now(), $5::uuid, repeat('a', 64), $6, $7, $8, $9, $10::numeric)`
  const dbLineage = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertRunSql, c1.claimId, newerVersion, pw.contractId, pw.scheduleId, actorUserId, 'INCOMPLETE', 0, 0, null, null))
  check('T050', 'Lineage guard (database)', /pricing_commercial_context_unresolved/.test(dbLineage), 'a direct run against any version other than the bound one is rejected')

  // ---------------------------------------------------------------- matching (T051–T060)
  section('Exact rate matching')
  const c2 = await pricedClaim('matching', { world: pw }, [
    { procedureCodeId: procB.id, quantity: '2', unitCode: 'SYN-U', modifierCodes: ['M2', 'M1'] },
    { serviceId: svcA.id, procedureCodeId: procA.id, quantity: '1' },
    { procedureCodeId: procB.id, quantity: '1' },
    { procedureCodeId: procB.id, quantity: '1', unitCode: 'SYN-U', modifierCodes: ['M1'] },
    { procedureCodeId: procA.id, quantity: '1', modifierCodes: ['M1'] },
  ])
  const m = (await priceHttp(c2.claimId)).body as any
  const outcome = (index: number) => lineOf(m, c2.lineIds[index])?.outcome
  check('T051', 'No match', outcome(2) === 'UNPRICED_RATE_MISSING' && m?.overallResult === 'INCOMPLETE' && m?.totalExtendedTariffAmount === null, 'UNPRICED_RATE_MISSING; the run is INCOMPLETE with no total')
  check('T052', 'Exactly one match', lineOf(R1, c1.lineIds[0])?.outcome === 'PRICED' && lineOf(R1, c1.lineIds[0])?.tariffRateId === rProcA.id, 'PRICED with the one matching rate')
  check('T053', 'Service + procedure ambiguous', outcome(1) === 'UNPRICED_RATE_AMBIGUOUS' && lineOf(m, c2.lineIds[1])?.extendedTariffAmount === null, 'a Service rate and a Procedure rate both match the mixed activity at the same price: ambiguous, never a priority')
  check('T054', 'Exact unit', outcome(2) === 'UNPRICED_RATE_MISSING' && outcome(0) === 'PRICED', 'a no-unit activity does not match the SYN-U rate; the SYN-U activity does')
  check('T055', 'Exact modifier set', outcome(0) === 'PRICED' && outcome(3) === 'UNPRICED_RATE_MISSING', 'modifiers [M2, M1] match the [M1, M2] rate; [M1] alone does not')
  check('T056', 'Empty modifier set is distinct', outcome(4) === 'UNPRICED_RATE_MISSING', 'a [M1] activity does not match a rate whose signature is the empty set')
  const retiredWorld = await world('retired')
  const oldRate = await mustRate(retiredWorld.versionId, procRate(procA.id, '40.0000'))
  await api('POST', `/api/tariff-rates/${oldRate.id}/retire`, {})
  const newRate = await mustRate(retiredWorld.versionId, procRate(procA.id, '41.0000'))
  await verify(retiredWorld.versionId)
  const retiredClaim = await pricedClaim('retired rate', { world: retiredWorld }, [{ procedureCodeId: procA.id, quantity: '1' }])
  const retiredPrice = (await priceHttp(retiredClaim.claimId)).body as any
  check('T057', 'Retired rate ignored', retiredPrice?.lines?.[0]?.tariffRateId === newRate.id && retiredPrice?.lines?.[0]?.extendedTariffAmount === '41.00', 'only the active rate is a candidate; the retired one is history')
  const removedSource = await pricedClaim('removed source', { world: pw }, [{ procedureCodeId: procA.id, quantity: '1' }])
  await post(`/api/encounter-activities/${removedSource.activityIds[0]}/remove`, {})
  const removedPrice = (await priceHttp(removedSource.claimId)).body as any
  check('T058', 'Removed source', removedPrice?.lines?.[0]?.outcome === 'UNPRICED_SOURCE_INVALID' && removedPrice?.overallResult === 'INCOMPLETE', 'a line whose source activity was later removed is UNPRICED_SOURCE_INVALID, never priced')
  const unpricedLines = (m?.lines ?? []).filter((line: any) => line.outcome !== 'PRICED')
  check(
    'T059',
    'Unpriced carries no amount',
    unpricedLines.length === 4 && unpricedLines.every((line: any) => line.tariffRateId === null && line.unitTariffAmount === null && line.extendedTariffAmount === null && line.currencyCode === null),
    'every unpriced line has a reason and no rate, amount or currency',
  )
  check('T060', 'Zero rate vs missing', lineOf(m, c2.lineIds[0])?.extendedTariffAmount === '0.00' && lineOf(m, c2.lineIds[0])?.tariffRateId === rZero.id && outcome(2) === 'UNPRICED_RATE_MISSING', 'an explicit zero rate prices AED 0.00; a missing rate is UNPRICED_RATE_MISSING')

  // ---------------------------------------------------------------- arithmetic (T061–T070)
  section('Decimal arithmetic, totals and currency')
  check('T061', 'Worked example', lineOf(R1, c1.lineIds[0])?.extendedTariffAmount === '187.88' && lineOf(R1, c1.lineIds[0])?.unitTariffAmount === '125.2500' && lineOf(R1, c1.lineIds[0])?.quantityAtEvaluation === '1.5000', '1.5000 x AED 125.2500 = 187.875 -> AED 187.88')
  check('T062', 'Half-up rounding', lineOf(R1, c1.lineIds[1])?.extendedTariffAmount === '12.13' && lineOf(R1, c1.lineIds[1])?.tariffRateId === rSvcB.id, '1 x AED 12.1250 -> AED 12.13')
  check('T063', 'PRICED total', R1?.overallResult === 'PRICED' && R1?.totalExtendedTariffAmount === '200.01' && R1?.currencyCode === 'AED' && R1?.lineCount === 2 && R1?.pricedCount === 2, 'AED 187.88 + 12.13 = AED 200.01')
  const fw = await world('fractions')
  await mustRate(fw.versionId, procRate(procA.id, '3.0000'))
  await mustRate(fw.versionId, svcRate(svcA.id, '0.3333', { unitCodeKey: 'SYN-Q' }))
  await verify(fw.versionId)
  const fc = await pricedClaim('fractions', { world: fw }, [
    { procedureCodeId: procA.id, quantity: '0.3333' },
    { serviceId: svcA.id, quantity: '3', unitCode: 'SYN-Q' },
  ])
  const f = (await priceHttp(fc.claimId)).body as any
  check('T064', 'Fractional quantity', lineOf(f, fc.lineIds[0])?.extendedTariffAmount === '1.00', '0.3333 x AED 3.0000 = 0.9999 -> AED 1.00')
  check('T065', 'Unit amount never pre-rounded', lineOf(f, fc.lineIds[1])?.extendedTariffAmount === '1.00' && f?.totalExtendedTariffAmount === '2.00', '3 x AED 0.3333 = 0.9999 -> AED 1.00 (pre-rounding the unit to 0.33 would give 0.99)')
  const storedLines = R1?.id ? await prisma.claimPricingLineResult.findMany({ where: { pricingRunId: R1.id }, orderBy: { lineSequenceAtEvaluation: 'asc' } }) : []
  const storedRun = R1?.id ? await prisma.claimPricingRun.findUnique({ where: { id: R1.id } }) : null
  check(
    'T066',
    'Stored Decimal values',
    storedLines[0]?.extendedAmount?.toFixed(4) === '187.8800' && storedLines[0]?.quantityAtEvaluation.toFixed(4) === '1.5000' && storedRun?.totalExtendedAmount?.toFixed(4) === '200.0100',
    'line and total amounts are stored as exact NUMERIC(18,4) values at the currency minor units',
  )
  const cw = await world('currency')
  await mustRate(cw.versionId, procRate(procA.id, '10.0000'))
  await directRate(cw.versionId, 'SERVICE', svcB.id, null, null, [], 'USD', '10')
  await verify(cw.versionId)
  const cc = await pricedClaim('currency', { world: cw }, [
    { procedureCodeId: procA.id, quantity: '1' },
    { serviceId: svcB.id, quantity: '1' },
  ])
  const cur = (await priceHttp(cc.claimId)).body as any
  check('T067', 'Unsupported currency', lineOf(cur, cc.lineIds[1])?.outcome === 'UNPRICED_UNSUPPORTED_CURRENCY' && lineOf(cur, cc.lineIds[1])?.extendedTariffAmount === null, 'a USD rate (not configured) prices nothing: UNPRICED_UNSUPPORTED_CURRENCY')
  check('T068', 'No trustworthy mixed total', cur?.overallResult === 'INCOMPLETE' && cur?.totalExtendedTariffAmount === null && cur?.currencyCode === null && lineOf(cur, cc.lineIds[0])?.extendedTariffAmount === '10.00', 'an AED line beside an unpriced USD line gives an INCOMPLETE run with no total and no currency')
  const zeroLines = await pricedClaim('zero lines', { world: pw }, [{ procedureCodeId: procA.id, quantity: '1' }], false)
  const z = await priceHttp(zeroLines.claimId)
  check('T069', 'Zero active lines', z.status === 201 && z.body?.overallResult === 'INCOMPLETE' && z.body?.lineCount === 0 && z.body?.totalExtendedTariffAmount === null, 'a Claim with no active line persists an INCOMPLETE run with no total')
  const pricingCode = committedProductionCodeOf([PRICING_DIR, RATE_DIR])
  const reached = pricingCode.files.length === 11 && pricingCode.code.includes('evaluateLine') && pricingCode.code.includes('createTariffRate')
  check(
    'T070',
    'No JavaScript number money',
    reached && !/parseFloat|parseInt|Number\(|\.toNumber\(|Math\.round|toFixed\(2\)\s*\*|\* ?100\b/.test(pricingCode.code) && /ROUND_HALF_UP/.test(pricingCode.code),
    'the committed pricing and rate code uses Prisma.Decimal with ROUND_HALF_UP and never a JavaScript number for money',
  )

  // ---------------------------------------------------------------- immutability (T071–T080)
  section('Immutable pricing history')
  const runUpdate = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_pricing_runs SET overall_result = 'INCOMPLETE' WHERE id = $1::uuid`, R1?.id))
  const runDelete = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_pricing_runs WHERE id = $1::uuid`, R1?.id))
  check('T071', 'Run append-only', /append-only/.test(runUpdate) && /append-only/.test(runDelete), 'a direct UPDATE or DELETE of a pricing run is rejected')
  const lineUpdate = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_pricing_line_results SET extended_amount = 1 WHERE pricing_run_id = $1::uuid`, R1?.id))
  const lineDelete = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_pricing_line_results WHERE pricing_run_id = $1::uuid`, R1?.id))
  check('T072', 'Line results append-only', /append-only/.test(lineUpdate) && /append-only/.test(lineDelete), 'a direct UPDATE or DELETE of a line result is rejected')
  const lateLine = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe(
      `INSERT INTO claim_pricing_line_results (id, pricing_run_id, claim_line_id, encounter_activity_id, line_sequence_at_evaluation, outcome, quantity_at_evaluation, input_fingerprint) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 9, 'UNPRICED_RATE_MISSING', 1, repeat('b', 64))`,
      R1?.id,
      c1.lineIds[0],
      c1.activityIds[0],
    ),
  )
  check('T073', 'No late line result', /can only be recorded with its own run/.test(lateLine), 'a line result cannot be added to an existing run by another transaction')
  const pricedWithoutTotal = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertRunSql, c1.claimId, pw.versionId, pw.contractId, pw.scheduleId, actorUserId, 'PRICED', 1, 1, 'AED', null))
  const incompleteWithTotal = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertRunSql, c1.claimId, pw.versionId, pw.contractId, pw.scheduleId, actorUserId, 'INCOMPLETE', 1, 0, null, '5'))
  check('T074', 'Result coherence (database)', /claim_pricing_runs_result_chk/.test(pricedWithoutTotal) && /claim_pricing_runs_result_chk/.test(incompleteWithTotal), 'a PRICED run without a total, or an INCOMPLETE run advertising one, is rejected')
  const hollowRun = await attemptAdversarial(() => prisma.$executeRawUnsafe(insertRunSql, c1.claimId, pw.versionId, pw.contractId, pw.scheduleId, actorUserId, 'INCOMPLETE', 1, 0, null, null))
  check('T075', 'Run complete at commit', /claim_pricing_runs_complete/.test(hollowRun), 'a run declaring one line but holding none is rejected at commit')
  const rollback = async (probe: string) => {
    const before = [await runsOf(c1.claimId), await prisma.claimPricingLineResult.count(), await a63Audits()]
    failAt(probe, 'forced failure (acceptance)')
    let threw = false
    try {
      await createPricingRun(c1.claimId, {}, actorUserId)
    } catch {
      threw = true
    }
    clearConcurrencyProbes()
    return threw && same([await runsOf(c1.claimId), await prisma.claimPricingLineResult.count(), await a63Audits()], before)
  }
  const rollbacks = [await rollback('claimPricing.inserted'), await rollback('claimPricing.audited')]
  check('T076', 'Atomic rollback', rollbacks.every(Boolean), `a forced failure after the lines or after the audit leaves no run, line or audit (${rollbacks.filter(Boolean).length}/2)`)
  const run1Before = JSON.stringify((await api('GET', `/api/claim-pricing-runs/${R1?.id}`)).body)
  await api('PUT', `/api/claims/${c1.claimId}/lines/order`, { claimLineIds: [c1.lineIds[1], c1.lineIds[0]] })
  const reordered = (await priceHttp(c1.claimId)).body as any
  check(
    'T077',
    'Old run unchanged by edits',
    JSON.stringify((await api('GET', `/api/claim-pricing-runs/${R1?.id}`)).body) === run1Before && reordered?.inputStructureFingerprint !== R1?.inputStructureFingerprint && reordered?.lines?.[0]?.claimLineId === c1.lineIds[1],
    'after a reorder the earlier run reads back byte-identical; a new run records the new order and a new fingerprint',
  )
  check('T078', 'Old run readable after supersession', JSON.stringify((await api('GET', `/api/claim-pricing-runs/${R1?.id}`)).body) === run1Before, 'a newer tariff version and later runs leave the earlier run readable and unchanged')
  const repeatA = (await priceHttp(c1.claimId)).body as any
  const repeatB = (await priceHttp(c1.claimId)).body as any
  check('T079', 'Deterministic re-evaluation', repeatA?.id !== repeatB?.id && repeatA?.inputStructureFingerprint === repeatB?.inputStructureFingerprint && repeatA?.totalExtendedTariffAmount === repeatB?.totalExtendedTariffAmount, 'repeating an unchanged pricing makes a new run with the identical fingerprint and total')
  const claimColumns = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims'`).map((row) => row.column_name)
  const listed = ((await api('GET', `/api/claims/${c1.claimId}/pricing-runs`)).body?.items ?? []) as any[]
  const orderOk = listed.every((item, index) => index === 0 || listed[index - 1].evaluatedAt >= item.evaluatedAt)
  check('T080', 'No current pricing pointer', !claimColumns.some((name) => /pric|tariff|amount|current/.test(name)) && listed.length >= 6 && orderOk, `the Claim row has no pricing column; ${listed.length} runs are listed newest first as history`)

  // ---------------------------------------------------------------- tenancy, permissions, audit (T081–T090)
  section('Tenancy, permissions, audit and read consistency')
  const auditsBefore81 = await a63Audits()
  const viewerRate = await rateHttp(reviewWorld.versionId, svcRate(svcB.id, '1'), asViewer)
  check('T081', 'Viewer rate create', viewerRate.status === 403 && (await a63Audits()) === auditsBefore81, '403; no rate and no audit')
  const viewerReads = [await api('GET', `/api/tariff-schedule-versions/${pw.versionId}/rates`, undefined, asViewer), await api('GET', `/api/claims/${c1.claimId}/pricing-runs`, undefined, asViewer), await api('GET', `/api/claim-pricing-runs/${R1?.id}`, undefined, asViewer)]
  const viewerPrice = await priceHttp(c1.claimId, {}, asViewer)
  const viewerRetire = await api('POST', `/api/tariff-rates/${rSvcA.id}/retire`, {}, asViewer)
  check('T082', 'Viewer reads, no writes', viewerReads.every((res) => res.status === 200) && viewerPrice.status === 403 && viewerRetire.status === 403, `reads ${viewerReads.map((r) => r.status).join('/')}; pricing ${viewerPrice.status}; retire ${viewerRetire.status}`)
  const leaks = (body: unknown) => /unitTariffAmount|extendedTariffAmount|totalExtended|AED|SYNTHETIC_FOREIGN|encounterId/.test(JSON.stringify(body ?? {}))
  const foreignPrice = foreignClaimId ? await priceHttp(foreignClaimId) : null
  const foreignList = foreignClaimId ? await api('GET', `/api/claims/${foreignClaimId}/pricing-runs`) : null
  check(
    'T083',
    'Cross-tenant pricing',
    foreignPrice !== null && foreignList !== null && foreignPrice.status === 404 && foreignList.status === 404 && !leaks(foreignPrice.body) && !leaks(foreignList.body),
    foreignPrice === null ? 'no foreign-tenant Claim could be created to prove this' : 'pricing and listing another tenant\'s Claim are 404, exactly like a missing Claim',
  )
  const foreignRunRead = foreignClaimId ? await createPricingRun(foreignClaimId, {}, actorUserId) : null
  const foreignRunId = foreignRunRead?.ok ? foreignRunRead.value.id : null
  const foreignRunGet = foreignRunId ? await api('GET', `/api/claim-pricing-runs/${foreignRunId}`) : null
  const foreignRateRetire = await api('POST', `/api/tariff-rates/${(await prisma.tariffRate.findFirst({ where: { tariffScheduleVersion: { tariffScheduleId: foreignSchedule.id } }, select: { id: true } }))?.id ?? MISSING}/retire`, {})
  check(
    'T084',
    'Cross-tenant reads',
    (foreignRunGet === null || (foreignRunGet.status === 404 && !leaks(foreignRunGet.body))) && foreignRateRetire.status === 404 && foreignVersionList.status === 404,
    foreignRunGet === null
      ? "another tenant's tariff version and rate are 404 with no fee disclosed (its Claim has no commercial lineage, so no foreign pricing run exists to read)"
      : "another tenant's pricing run, tariff version and rate are 404 with no amount disclosed",
  )
  const malformed = [await api('GET', '/api/claim-pricing-runs/not-a-uuid'), await api('POST', '/api/claims/not-a-uuid/pricing-runs', {}), await api('POST', '/api/tariff-rates/not-a-uuid/retire', {}), await api('GET', `/api/claim-pricing-runs/${MISSING}`)]
  check('T085', 'Malformed and missing ids', same(malformed.map((r) => r.status), [400, 400, 400, 404]) && malformed.every((r) => !rawError(r.body)), `${malformed.map((r) => r.status).join('/')}; no raw database text`)
  const rateAudits = await prisma.auditEvent.findMany({ where: { actionCode: { in: ['tariff_rate.created', 'tariff_rate.retired'] }, occurredAt: { gte: runStartedAt } } })
  const rateAuditText = JSON.stringify(rateAudits.map((row) => [row.beforeState, row.afterState]))
  check(
    'T086',
    'Rate audit minimal',
    rateAudits.length > 5 && rateAudits.every((row) => [...deepKeys(row.beforeState), ...deepKeys(row.afterState)].every((k) => ['id', 'tariffScheduleVersionId', 'rateContractVersion', 'createdAt', 'removedAt'].includes(k))) && !/125\.25|AED|unitTariff|currency|serviceId|procedureCodeId/.test(rateAuditText),
    'ids, contract label and timestamps only; no fee amount, currency or rated identity',
  )
  const pricingAudits = await prisma.auditEvent.findMany({ where: { actionCode: 'claim_pricing_run.created', occurredAt: { gte: runStartedAt } } })
  // Identifiers are replaced before the money/currency scan: a random UUID can contain the hex letters
  // "aed", which a case-insensitive currency match would otherwise report as a leaked currency.
  const pricingAuditText = JSON.stringify(pricingAudits.map((row) => row.afterState)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
  check(
    'T087',
    'Pricing audit minimal',
    pricingAudits.length >= 10 && pricingAudits.every((row) => row.beforeState === null && same(Object.keys(row.afterState as object).sort(), ['claimId', 'evaluatedAt', 'id', 'lineCount', 'overallResult', 'pricedCount', 'pricingContractVersion'])) && !/187\.88|200\.01|AED|amount|tariff/i.test(pricingAuditText),
    'run id, Claim id, contract, status, counts and time only; no money, code, patient or payer value',
  )
  const auditsBeforeReads = await prisma.auditEvent.count()
  await api('GET', `/api/claims/${c1.claimId}/pricing-runs`)
  await api('GET', `/api/claim-pricing-runs/${R1?.id}`)
  await api('GET', `/api/tariff-schedule-versions/${pw.versionId}/rates`)
  check('T088', 'No audit on reads', (await prisma.auditEvent.count()) === auditsBeforeReads, 'rate and pricing reads wrote no AuditEvent')
  const auditsBefore89 = await a63Audits()
  for (const attempt of [
    () => rateHttp(pw.versionId, svcRate(svcB.id, '1', { unitCodeKey: 'SYN-Y' })),
    () => rateHttp(reviewWorld.versionId, svcRate(svcB.id, '1')),
    () => rateHttp(rw.versionId, svcRate(svcA.id, 'x')),
    () => api('POST', `/api/tariff-rates/${svcNullUnit.body?.id}/retire`, {}),
    () => priceHttp(unverifiedClaim.claimId),
    () => priceHttp(superseded.claimId),
    () => priceHttp(c1.claimId, { lines: [] }),
    () => priceHttp(c1.claimId, {}, asViewer),
  ])
    await attempt()
  check('T089', 'No false audit', (await a63Audits()) === auditsBefore89, 'locked, invalid, already-retired, unresolved, superseded, injected and denied attempts wrote no AuditEvent')
  const readA = await api('GET', `/api/claim-pricing-runs/${R1?.id}`)
  const readB = await api('GET', `/api/claim-pricing-runs/${R1?.id}`, undefined, asViewer)
  check('T090', 'Read consistency', readA.status === 200 && same(readA.body, readB.body) && same(Object.keys(readA.body ?? {}).includes('lines'), true), 'the same run reads back identically for Admin and Viewer, with its line results')

  // ---------------------------------------------------------------- regressions (T091–T094)
  section('Regressions — A6.2 invoked, nesting A6.1 -> A5.10 -> A1')
  await apiReady('the A6.2 and backward regression chain')
  const chain = run('npm run test:a6:claim-line-diagnosis')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A6.2')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.2] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.2 asserts facts about its own branch, its own diff, and that its claim tables are the only claim
  // tables. On A6.3 those statements are obsolete by design; every other A6.2 check is substantive.
  const a62NonApplicable: Record<string, string> = {
    T001: "A6.2 'Start gate' requires the A6.2 feature branch and no A6.3 code; A6.3 is branched from the main that contains A6.2",
    T004: "A6.2 'Migration scope' judges the single migration this branch adds against main; on A6.3 that is the A6.3 migration",
    T006: "A6.2 'Permissions' treats any pricing permission as invented; A6.3 adds exactly tariffRate.* and claimPricing.* (proven by T007 here)",
    T108: "A6.2 'Connected Care separation' requires the claim% tables to be exactly the A6.2 set; A6.3 legitimately adds claim_pricing_runs and claim_pricing_line_results (clinical/HIE separation is T099 here)",
    T126: "A6.2 'Diff scope' lists the paths A6.2 was allowed to change; A6.3 legitimately changes different ones (T010 here)",
    T130: "A6.2 'Exact head evidence' requires the upstream to be the A6.2 feature branch, deleted when it merged",
  }
  const undocumented = failing.filter((id) => !(id in a62NonApplicable))
  const counts = chain.output.match(/\[A6\.2\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T119') && !/\[A6\.2\] RUN ABORTED|\[A6\.2\] uncaught error/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check(
    'T091',
    'A6.2 regression',
    ran && reconciled && undocumented.length === 0,
    !ran ? 'the A6.2 suite did not complete' : !reconciled ? `A6.2 reports ${failedCount} failure(s) but ${failing.length} could be named` : undocumented.length > 0 ? `undocumented A6.2 failures: ${undocumented.join(', ')}` : `${(chain.output.match(/\[A6\.2\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.2] automated summary: ', 'A6.2 ')}; all ${failedCount} failure(s) are exact obsolete branch/phase guards`,
  )
  for (const id of Object.keys(a62NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T091/${id}`, `A6.2 ${titleOf(row.line)}`, a62NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[A6.3]      ${text.slice(0, 400)}`)
  check('T092', 'A6.1 regression', verdictOf('T119') === 'PASS', `A6.2 T119 (A6.1 with its own justified N/A) ${verdictOf('T119')}`)
  check('T093', 'A5 regression', ['T116', 'T117', 'T118'].every((id) => verdictOf(id) === 'PASS'), `A6.2 T116 (A5.8) ${verdictOf('T116')}, T117 (A5.9) ${verdictOf('T117')}, T118 (A5.10) ${verdictOf('T118')}`)
  check('T094', 'A1–A4 regression', ['T110', 'T111', 'T112', 'T113', 'T114', 'T115'].every((id) => verdictOf(id) === 'PASS'), `A6.2 T110–T115 ${['T110', 'T111', 'T112', 'T113', 'T114', 'T115'].map(verdictOf).join('/')}`)

  // ---------------------------------------------------------------- builds and DB truth (T095–T098)
  section('Build gates and database truth')
  const unitTests = run('npm run test:unit')
  check('T095', 'Unit tests', unitTests.ok && /ℹ fail 0/.test(unitTests.output), (unitTests.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0])
  const typecheck = run('npm run typecheck')
  check('T096', 'Typecheck', typecheck.ok, 'backend typecheck clean')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T097', 'Frontend build/lint', build.ok && lint.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)
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
  check('T098', 'DB health truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- leakage, scope and exact head (T099–T100, T010)
  section('Zero downstream leakage, scans, diff scope and exact head')
  await waitFor(databaseUp, 60_000)
  const a63Columns = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('tariff_rates', 'claim_pricing_runs', 'claim_pricing_line_results')`).map((row) => row.column_name)
  const dtoKeys = [...deepKeys(R1), ...deepKeys(m), ...deepKeys(rProcA)]
  const downstream = [...a63Columns, ...dtoKeys].filter((name) => /patient|share|net|copay|coinsur|discount|tax|approv|state|status|payload|xml|x12|npi|submi|transport|remit|nabidh|malaffi|riayati|hl7|fhir/i.test(name) && !/^(lineSequenceAtEvaluation|line_sequence_at_evaluation)$/.test(name))
  const scanPaths = [`:/${RATE_DIR}`, `:/${PRICING_DIR}`, `:/${FE_RATE_DIR}`, `:/${FE_PRICING_DIR}`]
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const logReach = gitGrep('evaluateLine|TariffRateCheck', scanPaths)
  const feCode = committedProductionCodeOf([FE_RATE_DIR, FE_PRICING_DIR])
  const secretScan = gitGrep("((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})", [`:/${HARNESS_DIR}`, ...scanPaths])
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [`:/${HARNESS_DIR}`])
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git(`show HEAD:${HARNESS_DIR}/a6-claim-pricing.integration.ts`)
  const scanProblems = [
    [downstream.length === 0, `downstream fields: ${downstream.join(', ')}`],
    [reached && !/\b(dhpo|eclaimlink|soap|xml|x12|clearinghouse|nabidh|malaffi|riayati|fhir|hl7)\b/i.test(pricingCode.code + feCode.code), 'a transport, payload or HIE term in A6.3 code'],
    [reached && !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION|CURRENCY)\w*/i.test(pricingCode.code), 'a process-global market or currency switch'],
    [logReach.status === 0 && logScan.status === 1, 'console logging in A6.3 code'],
    [feCode.files.length === 2 && !/\b(localStorage|sessionStorage|indexedDB)\b/.test(feCode.code) && !/fetch\(`[^`]*\?/.test(feCode.code), 'browser storage or a query string in the check pages'],
    [reached && !/req\.query/.test(pricingCode.code), 'a query string read by an A6.3 route'],
    [secretReach.status === 0 && secretScan.status === 1, 'a committed secret'],
    [harnessSource.length > 0 && harnessSource.match(realDataMarkers) === null, 'a real-data marker in the harness'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T099',
    'Zero downstream leakage',
    scanProblems.length === 0,
    scanProblems.length === 0 ? 'no patient share, Net, approval, lifecycle, payload, submission, transport or HIE field in the schema or DTOs; no logging, browser storage, query string, secret or real-data marker' : scanProblems.join('; '),
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
    'backend/src/shared/authorization/require-member-permission.ts',
    'backend/src/shared/database/row-lock.ts',
    'backend/src/shared/errors/error.types.ts',
    'frontend/src/developer/checkRegistry.tsx',
  ]
  const ownDirs = [RATE_DIR, PRICING_DIR, FE_RATE_DIR, FE_PRICING_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !file.includes('a6_3_tariff_rate_claim_pricing') && !allowed.includes(file))
  const refChanged = changedPaths.filter((file) => file.startsWith(`${REF_DIR}/`))
  const laterDomain = changedPaths.filter((file) => /claim-integrity|claim-approval|claim-payload|claim-submission|remittance|integration\/a9|nabidh|malaffi|riayati/i.test(file))
  check(
    'T010',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && refChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length === 0 && refChanged.length === 0 && laterDomain.length === 0
      ? `${changedPaths.length} path(s): the two A6.3 modules, migration, harness and check pages, the shared lock helper, the privacy-safe permission middleware, vocabularies, the replay verifier and wiring; REF-01 untouched; no A6.4+ domain`
      : `unexpected: ${[...outOfScope, ...refChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const priorRunsNow = await prisma.claimPricingRun.count({ where: { createdAt: { lt: runStartedAt } } })
  const priorRatesNow = await prisma.tariffRate.count({ where: { createdAt: { lt: runStartedAt } } })
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T100',
    'Exact head and repeatability',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a63Branch}`) && !/ahead|behind/.test(tracking) && priorRunsNow === priorRunsAtStart && priorRatesNow === priorRatesAtStart,
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; ${priorRunsNow} earlier pricing run(s) and ${priorRatesNow} earlier rate(s) retained unchanged`,
  )

  console.log(`\n[A6.3] run ${runId} — HEAD ${headSha}`)
  console.log(`[A6.3] worked example: Claim ${c1.claimId}, pricing run ${R1?.id} (${R1?.overallResult}, total ${R1?.currencyCode} ${R1?.totalExtendedTariffAmount})`)
  if (failures.length > 0) {
    console.log(`[A6.3] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A6.3] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A6.3] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A6.3] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A6.3] TARIFF RATE / CLAIM PRICING FOUNDATION ACCEPTANCE COMPLETE' : '[A6.3] A6.3 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A6.3] RUN ABORTED: ${error.message}`)
      console.log('[A6.3] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A6.3] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A6.3] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
