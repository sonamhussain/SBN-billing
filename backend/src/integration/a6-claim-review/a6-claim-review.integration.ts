import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordReadinessAssessment } from '../../modules/pre-claim-readiness/pre-claim-readiness.service.ts'
import { createClaim } from '../../modules/claim/claim.service.ts'
import { removeClaimLine } from '../../modules/claim-line/claim-line.service.ts'
import { updateTariffScheduleVersionVerification } from '../../modules/commercial-coverage/tariff-schedule.service.ts'
import { createPricingRun } from '../../modules/claim-pricing/claim-pricing.service.ts'
import { createDraftAssessment } from '../../modules/claim-draft/claim-draft.service.ts'
import { getCurrentReviewAuthority, recordReviewDecision } from '../../modules/claim-review/claim-review.service.ts'

// A6.5 — focused acceptance for Human Review & Submission Approval (T001–T120).
//
// Every Claim is built through its owners: tariff worlds and rates through REF-01 and the A6.3 rate routes,
// runs through the A5.7 recorder, readiness through the A5.9 route, the Claim, its lines, diagnoses and
// pointers through the A6.1/A6.2 routes, pricing runs through the A6.3 route and draft assessments through
// the A6.4 route; review decisions go through the A6.5 route. Separation of duties needs reviewers other
// than the Claim's creator: two synthetic Admin members of the test organization are provisioned per run
// through Better Auth's own server-side user and credential creation (the path its sign-up uses; public
// sign-up stays disabled) and the existing membership and role tables, with a random password that is
// never printed. ADVERSARIAL writes go in only to create a state no owner path can create (another tenant's
// chain, a changed source quantity) or to prove that the database refuses them; every adversarial write that
// should be refused runs in a transaction that is rolled back. Every value is synthetic and keyed by this
// run's id.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A6.5] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A6.5] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A6.5] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A6.5] ${title}`)

// Every `npm run` prepends its node_modules/.bin directories to PATH again, so each level of the nested
// regression chain makes PATH longer; on Windows the deepest suites then exceed the length cmd.exe can use
// and their own tools stop resolving. A spawned command therefore gets PATH without the .bin entries npm
// added on the way here: npm adds exactly those back for the command it runs, so the nested chain starts
// with the PATH it has when it is run on its own. Nothing else in the environment changes.
const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
const childEnv = () => ({
  ...process.env,
  [pathKey]: (process.env[pathKey] ?? '')
    .split(delimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$|[\\/]node-gyp-bin[\\/]?$/i.test(entry))
    .join(delimiter),
})

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), env: childEnv(), maxBuffer: 256 * 1024 * 1024 })
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

const runId = `A65-${Date.now()}`
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
const a65Branch = 'feature/a6-5-human-review-submission-approval'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const REVIEW_DIR = 'backend/src/modules/claim-review'
const DRAFT_DIR = 'backend/src/modules/claim-draft'
const FE_REVIEW_DIR = 'frontend/src/modules/claim-review'
const HARNESS_DIR = 'backend/src/integration/a6-claim-review'
const A65_TABLE = 'claim_review_events'
const A65_COLUMNS = ['id', 'claim_id', 'draft_assessment_id', 'reviewer_user_id', 'decision_code', 'sequence', 'approval_fingerprint', 'reason_code', 'referenced_approval_id', 'reviewed_at', 'review_contract_version', 'created_at']
const DECISION_KEYS = ['approvalFingerprint', 'claimId', 'createdAt', 'decisionCode', 'draftAssessmentId', 'id', 'reasonCode', 'referencedApprovalId', 'reviewContractVersion', 'reviewedAt', 'reviewerUserId', 'sequence']
const AUTHORITY_KEYS = ['claimId', 'decisionId', 'draftAssessmentId', 'evaluatedAt', 'fingerprint', 'state']
const AUDIT_KEYS = ['claimId', 'decisionCode', 'draftAssessmentId', 'id', 'reasonCode', 'referencedApprovalId', 'reviewContractVersion', 'sequence']
const REVIEW_ACTIONS = ['claim_review.approved', 'claim_review.returned', 'claim_review.rejected', 'claim_review.revoked']
// The owners A6.5 consumes. A change to any of them would be a change to an accepted contract. The A6.4
// claim-draft owner is judged separately (T009): it may only gain the exported currentness composer.
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
// unexpected acceptance can never leave a row behind.
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

  console.log(`[A6.5] A6.5 human review & submission approval — run ${runId}`)
  console.log(`[A6.5] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  const priorDecisionsAtStart = JSON.stringify(await prisma.claimReviewEvent.findMany({ where: { createdAt: { lt: runStartedAt } }, orderBy: { id: 'asc' } }))

  // ---------------------------------------------------------------- gates (T001–T009)
  section('Start gate, migration, contracts, permissions and wiring')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const merges = [mergeOf(a61Branch), mergeOf(a62Branch), mergeOf(a63Branch), mergeOf(a64Branch)]
  const laterA6Code = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /claim-payload|claim-submission|claim-transport|canonical-payload|claim-serializ/.test(file))
  check(
    'T001',
    'Start gate',
    branch === a65Branch && merges.every((sha) => sha.length === 40) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterA6Code.length === 0,
    `branch ${branch}; A6.1–A6.4 merged as ${merges.map((sha) => sha.slice(0, 7) || 'NOT FOUND').join(', ')}; contains latest main ${git('rev-parse --short origin/main')}; no A6.6+ code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check('T003', 'A6.1–A6.4 ancestry', merges.every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)), 'the four accepted merge commits are ancestors of HEAD')

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const createdTables = (statements.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).map((m) => m.replace(/CREATE TABLE "|"/g, '')).sort()
  // The columns the migration actually creates, judged by name (never words elsewhere in the SQL).
  const createdColumns = (statements.match(new RegExp(`CREATE TABLE "${A65_TABLE}" \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^"([a-z_]+)"/)?.[1])
    .filter((column): column is string => Boolean(column))
  const schemaDiff = git('diff origin/main...HEAD -- :/backend/prisma/schema.prisma').split(/\r?\n/)
  const schemaRemoved = schemaDiff.filter((l) => l.startsWith('-') && !l.startsWith('---'))
  const schemaAddedModels = schemaDiff.filter((l) => /^\+\s*model /.test(l)).map((l) => l.replace(/^\+\s*model\s+(\w+).*$/, '$1')).sort()
  const scopeProblems = [
    [same(createdTables, [A65_TABLE]), `tables created: ${createdTables.join(', ')}`],
    [!/DROP (INDEX|TABLE|COLUMN)/.test(statements) && !/SET DEFAULT pg_catalog/.test(statements), 'drift'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((m) => m.includes(`"${A65_TABLE}"`)), 'a table outside A6.5 is altered'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 4 && !/ON DELETE (CASCADE|SET NULL)/.test(statements), 'the four foreign keys are not all ON DELETE RESTRICT'],
    [(statements.match(/CREATE (CONSTRAINT )?TRIGGER [a-z_]+_trg/g) ?? []).length === 2, 'the two integrity/history triggers are not both created'],
    [
      same(createdColumns, A65_COLUMNS) && !createdColumns.some((column) => /status|lifecycle|payload|xml|x12|npi|submission|patient_share|net_amount|copay|remark|comment|note|nabidh|malaffi|riayati|^(latest|current)_/i.test(column)),
      'the table does not carry exactly its 12 columns, or a lifecycle, payload, submission, remark, pointer, patient-share or HIE column appears',
    ],
    [schemaRemoved.length === 0 && same(schemaAddedModels, ['ClaimReviewEvent']), 'the schema diff is not exactly the one model and its back-relations'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T004',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1 ? `expected exactly one migration, found ${migrationPaths.length}` : scopeProblems.length === 0 ? 'one migration; exactly claim_review_events, four RESTRICT foreign keys and two guards; no drift' : `out of scope: ${scopeProblems.join('; ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  const replayExpected = [
    /PASS {2}the A6\.5 CHECKs pin A6-REVIEW-1 and exactly APPROVE, RETURN, REJECT and REVOKE/,
    /PASS {2}claim_review_events_insert_guard_trg is present/,
    /PASS {2}claim_review_events_append_only_trg is present/,
    /PASS {2}one decision per sequence per claim and one revocation per approval are unique/,
    /PASS {2}claim_review_events carries exactly its 12 A6\.5 columns/,
    /PASS {2}the A6\.5 tables are exactly claim_review_events/,
    /PASS {2}the A6\.4 tables are exactly claim_draft_assessments and claim_draft_findings/,
    /PASS {2}the A6\.3 tables are exactly tariff_rates, claim_pricing_runs and claim_pricing_line_results/,
    /PASS {2}the claim tables are exactly claims plus the four A6\.2 tables/,
  ]
  check(
    'T006',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the A6.5 constraints, unique keys and guards survive beside the A6.2/A6.3/A6.4 ones`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^claimReview\./.test(code)).sort()
  const invented = allCodes.filter((code) => /(approve|approval|submit|transmit|signOff|patientShare|claimPayload|claimSubmission|remittance)/i.test(code))
  check(
    'T007',
    'Permissions',
    same(family, ['claimReview.decide', 'claimReview.read', 'claimReview.revoke']) &&
      (await grantsOf('claimReview.decide')) === 'ORG_ADMIN' &&
      (await grantsOf('claimReview.revoke')) === 'ORG_ADMIN' &&
      (await grantsOf('claimReview.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('claimDraft.assess')) === 'ORG_ADMIN' &&
      (await grantsOf('claim.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      invented.length === 0,
    'claimReview.decide and claimReview.revoke for Admin only, claimReview.read for Admin and Viewer; claim.read and claimDraft.assess unchanged; no approve, submit or transmit permission',
  )

  // ---------------------------------------------------------------- sign-in, reviewers and wiring
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
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const viewerId = (await prisma.user.findFirstOrThrow({ where: { email: viewerEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  const rawError = (body: unknown) => /\bat \w|prisma|SELECT|INSERT|constraint|trigger/i.test(JSON.stringify(body ?? {}))

  // Synthetic reviewers: Better Auth's own server-side user and credential creation, then an ORG_ADMIN
  // membership through the existing tables (as the authorization bootstrap writes them). The password is
  // random per run and never printed.
  const authContext = await auth.$context
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' }, select: { id: true } })
  const provisionReviewer = async (label: string) => {
    const email = `${runId.toLowerCase()}-${label}@reviewers.sbn.test`
    const secretValue = randomBytes(24).toString('base64url')
    const user = await authContext.internalAdapter.createUser({ email, name: `Synthetic reviewer ${label}`, emailVerified: false }, { method: 'email-password' })
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', issuer: 'local:credential', accountId: user.id, password: await authContext.password.hash(secretValue) })
    const membership = await prisma.organizationMembership.create({ data: { organizationId: org, userId: user.id } })
    await prisma.membershipRole.create({ data: { membershipId: membership.id, roleId: adminRole.id } })
    const signed = await signIn(email, secretValue)
    if (signed.status !== 200) throw new Error(`fixture reviewer ${label} could not sign in (${signed.status})`)
    return { id: user.id as string, membershipId: membership.id, who: as(signed.cookie) }
  }
  const B = await provisionReviewer('b')
  const C = await provisionReviewer('c')
  const D = await provisionReviewer('d')

  const decisionPath = (claimId: string) => `/api/claims/${claimId}/review-decisions`
  const decide = (claimId: string, body: unknown, who: Who = B.who) => api('POST', decisionPath(claimId), body, who)
  const history = (claimId: string, who: Who = asAdmin) => api('GET', decisionPath(claimId), undefined, who)
  const authority = (claimId: string, who: Who = asAdmin) => api('GET', `/api/claims/${claimId}/review-authority`, undefined, who)
  const readDecision = (id: string, who: Who = asAdmin) => api('GET', `/api/claim-review-decisions/${id}`, undefined, who)

  const wiring = [
    await api('POST', decisionPath(MISSING), { draftAssessmentId: MISSING, assemblyFingerprint: 'a'.repeat(64), decisionCode: 'APPROVE' }),
    await api('GET', decisionPath(MISSING)),
    await api('GET', `/api/claims/${MISSING}/review-authority`),
    await api('GET', `/api/claim-review-decisions/${MISSING}`),
  ]
  const forbiddenVerbs = [
    await api('DELETE', `/api/claim-review-decisions/${MISSING}`),
    await api('PATCH', `/api/claim-review-decisions/${MISSING}`, {}),
    await api('PUT', `/api/claim-review-decisions/${MISSING}`, {}),
    await api('DELETE', decisionPath(MISSING)),
    await api('PUT', `/api/claims/${MISSING}/review-authority`, {}),
    await api('POST', `/api/claim-review-decisions/${MISSING}/submit`, {}),
    await api('POST', `/api/claims/${MISSING}/submissions`, {}),
  ]
  const unauthenticated = [await api('GET', decisionPath(MISSING), undefined, anonymous), await api('POST', decisionPath(MISSING), {}, anonymous)]
  check(
    'T008',
    'Route wiring',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && forbiddenVerbs.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `four routes answer a missing target with a privacy-safe 404; DELETE/PATCH/PUT/submit are absent (${forbiddenVerbs.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
  )

  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const constantOf = (path: string, name: string) => (git(`show HEAD:${path}`).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/pre-claim-readiness/pre-claim-readiness.types.ts', 'READINESS_POLICY_VERSION'),
    constantOf('backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-line/claim-line.types.ts', 'CLAIM_LINE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-diagnosis/claim-diagnosis.types.ts', 'CLAIM_DIAGNOSIS_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-pricing/claim-pricing.types.ts', 'PRICING_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-draft/claim-draft.types.ts', 'DRAFT_CONTRACT_VERSION'),
    constantOf('backend/src/modules/pre-claim-readiness/pre-claim-readiness.types.ts', 'HANDOFF_SCHEMA_VERSION'),
  ]
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)))
  const oldMigrationChanged = changedPaths.filter((file) => file.includes('prisma/migrations/') && !file.includes('a6_5_human_review_submission_approval'))
  // D1 — the only change to the A6.4 owner is the exported, transaction-aware currentness composer: one
  // file, additions only, reusing the owner's own assembly, reduction and fingerprint.
  const draftOwnerFiles = changedPaths.filter((file) => file.startsWith(`${DRAFT_DIR}/`))
  const draftOwnerDiff = git(`diff origin/main...HEAD -- :/${DRAFT_DIR}`)
  const draftOwnerRemoved = draftOwnerDiff.split(/\r?\n/).filter((line) => line.startsWith('-') && !line.startsWith('---'))
  const narrowOwnerFix =
    same(draftOwnerFiles, [`${DRAFT_DIR}/claim-draft.service.ts`]) &&
    draftOwnerRemoved.length === 0 &&
    /\+export async function composeCurrentDraft\(claimId: string, pricingRunId: string, tx: DbClient\)/.test(draftOwnerDiff) &&
    /\+\s+const assembled = await assemble\(claimId, pricingRunId, tx\)/.test(draftOwnerDiff) &&
    /\+\s+assemblyFingerprint: assemblyFingerprint\(assembled\.snapshot\)/.test(draftOwnerDiff)
  check(
    'T009',
    'Old contracts preserved',
    same(contracts, ['A5-READY-1', 'A6-CLAIM-1', 'A6-LINE-1', 'A6-DX-1', 'A6-PRICE-1', 'A6-DRAFT-1', 'PreClaimA6HandoffV1']) && ownerChanged.length === 0 && oldMigrationChanged.length === 0 && narrowOwnerFix,
    ownerChanged.length + oldMigrationChanged.length === 0 && narrowOwnerFix
      ? 'A5-READY-1, A6-CLAIM-1, A6-LINE-1, A6-DX-1, A6-PRICE-1, A6-DRAFT-1 and PreClaimA6HandoffV1 unchanged; no A5/A6.1–A6.3 owner or applied migration changed; the A6.4 owner only gained the exported composeCurrentDraft (additions only)'
      : `changed: ${[...ownerChanged, ...oldMigrationChanged].join(', ').slice(0, 160)}${narrowOwnerFix ? '' : '; the A6.4 owner change is not exactly the composer export'}`,
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
  const dx: { id: string }[] = []
  for (const letter of ['A', 'B', 'C']) dx.push(must(`diagnosis ${letter}`, (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key(`DX${letter}`), displayName: `Synthetic diagnosis ${letter}` })).body))

  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const contract = must('contract', (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  must('contract facility', (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
  const schedule = must('schedule', (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
  const version = must('version', (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  must('rate A', (await post(`/api/tariff-schedule-versions/${version.id}/rates`, { selectorKind: 'PROCEDURE_CODE', procedureCodeId: procA.id, modifierCodes: [], currencyCode: 'AED', unitTariffAmount: '125.2500' })).body)
  must('rate B', (await post(`/api/tariff-schedule-versions/${version.id}/rates`, { selectorKind: 'SERVICE', serviceId: svcB.id, modifierCodes: [], currencyCode: 'AED', unitTariffAmount: '12.1250' })).body)
  if ((await post(`/api/tariff-schedule-versions/${version.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error('fixture: the tariff version could not be verified')
  const world = { payerId: payer.id as string, contractId: contract.id as string, scheduleId: schedule.id as string, versionId: version.id as string }

  const plainContext = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: world.payerId as string | null, tpaId: null, networkId: null, insuranceProductId: null,
      providerContractId: world.contractId as string | null, tariffScheduleId: world.scheduleId as string | null, tariffScheduleVersionId: world.versionId as string | null,
    }
  }
  const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
  const recordRun = async (encounterId: string, activityIds: string[], diagnosisIds: string[]) => {
    const contextSnapshot = await plainContext(encounterId)
    const findings = [
      finding('WARNING', { layer: 'CODING' }),
      ...activityIds.map((encounterActivityId) => finding('PASS', { encounterActivityId })),
      ...diagnosisIds.map((encounterDiagnosisId) => finding('PASS', { layer: 'CODING', encounterDiagnosisId })),
    ]
    const result = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId, contextSnapshot, validatorVersion: 'A5-VAL-1', findings }, creatorId, tx))
    if (!result.ok) throw new Error(`a valid synthetic run was refused by the A5.7 recorder: ${result.message}`)
    return result.value.id
  }
  const setPointers = async (lineId: string, claimDiagnosisIds: string[]) => {
    const res = await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds })
    if (res.status !== 200) throw new Error(`fixture pointers refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
  }

  type Spec = { lineCount?: number; spareDiagnoses?: number; roles?: string[] }
  // An Encounter with two activities (1.5 x procedure A, 1 x service B = AED 200.01 when priced), its
  // diagnoses named by one READY run, its Claim (created by the creator Admin), one line per activity (or
  // the first lineCount), one ClaimDiagnosis per role and every line pointing to the PRIMARY.
  const draftClaim = async (label: string, spec: Spec = {}) => {
    const encounter = must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body)
    const activityIds: string[] = []
    for (const activity of [{ procedureCodeId: procA.id, quantity: '1.5' }, { serviceId: svcB.id, quantity: '1' }]) activityIds.push(must(`${label} activity`, (await post(`/api/encounters/${encounter.id}/activities`, activity)).body).id)
    const roles = spec.roles ?? ['PRIMARY']
    const encounterDiagnosisIds: string[] = []
    for (let i = 0; i < roles.length + (spec.spareDiagnoses ?? 0); i += 1)
      encounterDiagnosisIds.push(must(`${label} encounter diagnosis`, (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: dx[i].id })).body).id)
    const validationRunId = await recordRun(encounter.id, activityIds, encounterDiagnosisIds)
    const readiness = await post(`/api/validation-runs/${validationRunId}/readiness-assessments`, {})
    if (readiness.status !== 201 || readiness.body?.state !== 'READY_FOR_REVIEW') throw new Error(`fixture ${label}: a valid READY assessment was refused with ${readiness.status}`)
    const claim = must(`${label} claim`, (await post(`/api/pre-claim-readiness-assessments/${readiness.body.id}/claims`, {})).body)
    const lineIds: string[] = []
    for (const activityId of activityIds.slice(0, spec.lineCount ?? activityIds.length)) lineIds.push(must('line', (await post(`/api/claims/${claim.id}/lines`, { encounterActivityId: activityId })).body).id)
    const claimDiagnosisIds: string[] = []
    for (let i = 0; i < roles.length; i += 1) claimDiagnosisIds.push(must('claim diagnosis', (await post(`/api/claims/${claim.id}/diagnoses`, { encounterDiagnosisId: encounterDiagnosisIds[i], roleCode: roles[i] })).body).id)
    for (const lineId of lineIds) await setPointers(lineId, [claimDiagnosisIds[0]])
    return { encounterId: encounter.id as string, claimId: claim.id as string, activityIds, encounterDiagnosisIds, claimDiagnosisIds, lineIds, validationRunId }
  }
  const price = async (claimId: string) => {
    const res = await post(`/api/claims/${claimId}/pricing-runs`, {})
    if (res.status !== 201) throw new Error(`fixture pricing refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as any
  }
  const assess = async (claimId: string, pricingRunId: string, who: Who = asAdmin) => {
    const res = await post(`/api/claims/${claimId}/draft-assessments`, { pricingRunId }, who)
    if (res.status !== 201) throw new Error(`fixture assessment refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as { id: string; outcome: string; assemblyFingerprint: string; pricingRunId: string; createdByUserId: string }
  }
  // A Claim, its exact PRICED run and its REVIEWABLE assessment, all created by the creator Admin.
  const reviewable = async (label: string, spec: Spec = {}) => {
    const claim = await draftClaim(label, spec)
    const pricing = await price(claim.claimId)
    const assessment = await assess(claim.claimId, pricing.id)
    if (assessment.outcome !== 'REVIEWABLE') throw new Error(`fixture ${label}: expected a REVIEWABLE assessment, got ${assessment.outcome}`)
    return { ...claim, pricing, assessment }
  }
  type Assessed = { id: string; assemblyFingerprint: string }
  const approveBody = (a: Assessed) => ({ draftAssessmentId: a.id, assemblyFingerprint: a.assemblyFingerprint, decisionCode: 'APPROVE' })
  const returnBody = (a: Assessed, reasonCode = 'REVIEW_DOCUMENTATION_REQUIRED') => ({ draftAssessmentId: a.id, assemblyFingerprint: a.assemblyFingerprint, decisionCode: 'RETURN', reasonCode })
  const rejectBody = (a: Assessed, reasonCode = 'REVIEW_INTEGRITY_CONCERN') => ({ draftAssessmentId: a.id, assemblyFingerprint: a.assemblyFingerprint, decisionCode: 'REJECT', reasonCode })
  const revokeBody = (a: Assessed, referencedApprovalId: string, extra: Record<string, unknown> = {}) => ({ draftAssessmentId: a.id, assemblyFingerprint: a.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId, ...extra })
  const decisionsOf = (claimId: string) => prisma.claimReviewEvent.count({ where: { claimId } })
  const reviewAudits = () => prisma.auditEvent.count({ where: { actionCode: { in: REVIEW_ACTIONS } } })
  const stateOf = async (claimId: string) => (await authority(claimId)).body?.state as string | undefined
  const stripTime = (body: any) => JSON.stringify({ ...body, evaluatedAt: '' })

  // Another tenant: a verified tariff world and a priced, assessed and approved Claim of the other
  // organization. No owner route acts for another tenant, so its masters are written directly and its chain
  // is built through the owner services in-process (synthetic, keyed by this run).
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  let foreign: { claimId: string; assessmentId: string; fingerprint: string; decisionId: string } | null = null
  if (foreignEncounter) {
    const foreignPayer = await prisma.payer.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign payer` } })
    const foreignContract = await prisma.providerContract.create({ data: { organizationId: otherOrg, payerId: foreignPayer.id, contractKey: key('FC'), displayName: 'Synthetic foreign contract', effectiveFrom: new Date('2000-01-01') } })
    const foreignSchedule = await prisma.tariffSchedule.create({ data: { providerContractId: foreignContract.id, tariffKey: key('FT'), displayName: 'Synthetic foreign tariff' } })
    const foreignVersion = await prisma.tariffScheduleVersion.create({ data: { tariffScheduleId: foreignSchedule.id, version: key('FV'), effectiveFrom: new Date('2000-01-01') } })
    const verified = await updateTariffScheduleVersionVerification(foreignVersion.id, 'VERIFIED', creatorId)
    const contextSnapshot = await plainContext(foreignEncounter.id)
    Object.assign(contextSnapshot, { payerId: foreignPayer.id, providerContractId: foreignContract.id, tariffScheduleId: foreignSchedule.id, tariffScheduleVersionId: foreignVersion.id })
    const recorded = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId: foreignEncounter.id, contextSnapshot, validatorVersion: 'A5-VAL-1', findings: [finding('PASS', { findingCode: 'SYNTHETIC_FOREIGN' })] }, creatorId, tx))
    const readiness = verified.ok && recorded.ok ? await recordReadinessAssessment(recorded.value.id, {}, creatorId) : null
    const claim = readiness?.ok ? await createClaim(readiness.value.id, {}, creatorId) : null
    const priced = claim?.ok ? await createPricingRun(claim.value.id, {}, creatorId) : null
    const assessed = claim?.ok && priced?.ok ? await createDraftAssessment(claim.value.id, { pricingRunId: priced.value.id }, creatorId) : null
    // The foreign Claim has no lines, so its assessment is INCOMPLETE; a RETURN is its foreign decision.
    const returned = claim?.ok && assessed?.ok ? await recordReviewDecision(claim.value.id, { draftAssessmentId: assessed.value.id, assemblyFingerprint: assessed.value.assemblyFingerprint, decisionCode: 'RETURN', reasonCode: 'REVIEW_OTHER' }, B.id) : null
    if (claim?.ok && assessed?.ok && returned?.ok) foreign = { claimId: claim.value.id, assessmentId: assessed.value.id, fingerprint: assessed.value.assemblyFingerprint, decisionId: returned.value.decision.id }
  }
  if (!foreign) throw new Error("fixture: another tenant's assessed and reviewed Claim could not be built (no encounter of the other organization, or an owner refused)")

  // The worked example: a REVIEWABLE draft (AED 200.01) approved by a separate Admin.
  const W = await reviewable('worked example')
  console.log('[A6.5]      fixtures ready: patient, AE-DU/DHA facility profile, clinician, masters, a verified AED tariff world, two synthetic reviewer Admins, the worked-example Claim, and another tenant\'s reviewed Claim')

  const insertDecisionSql = `INSERT INTO claim_review_events (id, claim_id, draft_assessment_id, reviewer_user_id, decision_code, sequence, approval_fingerprint, reason_code, referenced_approval_id, review_contract_version, reviewed_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6, $7, $8::uuid, $9, coalesce($10::timestamptz, now())) RETURNING id::text AS id`
  type DirectDecision = { claimId: string; assessmentId: string; reviewer?: string; decision?: string; sequence?: number; fingerprint?: string | null; reason?: string | null; target?: string | null; contract?: string; reviewedAt?: string | null }
  const insertDecision = async (tx: any, d: DirectDecision) =>
    (await tx.$queryRawUnsafe(insertDecisionSql, d.claimId, d.assessmentId, d.reviewer ?? B.id, d.decision ?? 'RETURN', d.sequence ?? 1, d.fingerprint ?? null, d.decision === undefined || d.decision === 'RETURN' || d.decision === 'REJECT' ? (d.reason === undefined ? 'REVIEW_OTHER' : d.reason) : (d.reason ?? null), d.target ?? null, d.contract ?? 'A6-REVIEW-1', d.reviewedAt ?? null))[0].id as string

  // ---------------------------------------------------------------- contract and request (T011–T020)
  section('Decision contract, strict request, database CHECKs, append-only and sequence guards')
  const decisionCheck = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'claim_review_events_decision_chk'`)[0]?.def ?? ''
  const typesCode = git(`show HEAD:${REVIEW_DIR}/claim-review.types.ts`)
  check(
    'T011',
    'Decision vocabulary',
    ['APPROVE', 'RETURN', 'REJECT', 'REVOKE'].every((code) => decisionCheck.includes(`'${code}'`)) && (decisionCheck.match(/'[A-Z]+'/g) ?? []).length === 4 &&
      /reviewDecisionCodes = \['APPROVE', 'RETURN', 'REJECT', 'REVOKE'\] as const/.test(typesCode) && /REVIEW_CONTRACT_VERSION = 'A6-REVIEW-1'/.test(typesCode),
    'the database and the typed contract hold exactly APPROVE, RETURN, REJECT and REVOKE under A6-REVIEW-1',
  )
  const wrongContract = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, contract: 'A6-REVIEW-2' }))
  const rightContract = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id }))
  check('T012', 'Contract version', /claim_review_events_contract_version_chk/.test(wrongContract) && rightContract.includes(NOT_REFUSED), 'the database refuses any contract but A6-REVIEW-1; the exact contract is accepted (rolled back)')
  const auditsBefore13 = await reviewAudits()
  const malformed = [
    await decide(W.claimId, []),
    await decide(W.claimId, { ...approveBody(W.assessment), decisionCode: 'approve' }),
    await decide(W.claimId, { ...approveBody(W.assessment), decisionCode: 'SUBMIT' }),
    await decide(W.claimId, { ...approveBody(W.assessment), assemblyFingerprint: W.assessment.assemblyFingerprint.toUpperCase() }),
    await decide(W.claimId, { ...approveBody(W.assessment), assemblyFingerprint: 'short' }),
    await decide(W.claimId, { ...approveBody(W.assessment), draftAssessmentId: 'not-a-uuid' }),
    await decide(W.claimId, { ...approveBody(W.assessment), remark: 'looks fine' }),
    await api('POST', '/api/claims/not-a-uuid/review-decisions', approveBody(W.assessment), B.who),
    await api('GET', '/api/claim-review-decisions/not-a-uuid'),
  ]
  check(
    'T013',
    'Strict request',
    malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)) && (await decisionsOf(W.claimId)) === 0 && (await reviewAudits()) === auditsBefore13,
    `missing body, wrong-case or unknown decision, malformed fingerprint or id, an unknown field: ${malformed.map((r) => r.status).join('/')}; no raw database text; nothing written`,
  )
  const forgedFields = ['claimId', 'reviewerUserId', 'sequence', 'approvalFingerprint', 'reviewedAt', 'createdAt', 'reviewContractVersion', 'total', 'payload']
  const forged = []
  for (const field of forgedFields) forged.push(await decide(W.claimId, { ...approveBody(W.assessment), [field]: field === 'sequence' ? 1 : MISSING }))
  check(
    'T014',
    'Server-owned fields',
    forged.every((res, i) => res.status === 400 && new RegExp(`${forgedFields[i]} is owned by the server`).test(res.body?.error?.message ?? '')) && (await decisionsOf(W.claimId)) === 0,
    'Claim, reviewer, sequence, approval fingerprint, instants, contract, total and payload are refused by name; nothing written',
  )
  const freeReason = await decide(W.claimId, { ...returnBody(W.assessment), reasonCode: 'patient seemed unwell' })
  const dbFreeReason = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, reason: 'free text remark' }))
  check(
    'T015',
    'Reason vocabulary',
    freeReason.status === 400 && /reasonCode must be one of/.test(freeReason.body?.error?.message ?? '') && /claim_review_events_reason_chk/.test(dbFreeReason),
    'a free-form reason is refused by the API and by the database CHECK; only the five controlled codes exist',
  )
  const shapes = [
    await decide(W.claimId, { ...approveBody(W.assessment), reasonCode: 'REVIEW_OTHER' }),
    await decide(W.claimId, { ...approveBody(W.assessment), referencedApprovalId: MISSING }),
    await decide(W.claimId, { ...returnBody(W.assessment), reasonCode: undefined }),
    await decide(W.claimId, { draftAssessmentId: W.assessment.id, assemblyFingerprint: W.assessment.assemblyFingerprint, decisionCode: 'REJECT' }),
    await decide(W.claimId, { ...rejectBody(W.assessment), referencedApprovalId: MISSING }),
    await decide(W.claimId, { draftAssessmentId: W.assessment.id, assemblyFingerprint: W.assessment.assemblyFingerprint, decisionCode: 'REVOKE' }),
  ]
  const dbShapes = [
    await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, decision: 'APPROVE', reviewer: B.id, fingerprint: null })),
    await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, decision: 'APPROVE', reviewer: B.id, fingerprint: W.assessment.assemblyFingerprint, reason: 'REVIEW_OTHER' })),
    await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, decision: 'RETURN', fingerprint: W.assessment.assemblyFingerprint })),
    await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, decision: 'REJECT', reason: null })),
    await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, decision: 'REVOKE', target: null })),
  ]
  check(
    'T016',
    'Decision shapes',
    shapes.every((res) => res.status === 400) &&
      // An APPROVE without a fingerprint and a REVOKE without a target are refused by the insert guard,
      // which runs before the CHECK; the other three shapes reach the CHECK itself.
      /claim_review_decision_coherence|claim_review_events_shape_chk/.test(dbShapes[0]) &&
      dbShapes.slice(1, 4).every((message) => /claim_review_events_shape_chk/.test(message)) &&
      /claim_review_decision_coherence|claim_review_events_shape_chk/.test(dbShapes[4]),
    'APPROVE with a reason or target, RETURN/REJECT without a reason or with a target, REVOKE without a target: 400, and the database refuses every such row',
  )

  // The worked example is approved here; its row is the subject of the append-only checks.
  const approvedW = await decide(W.claimId, approveBody(W.assessment))
  const approvalW = approvedW.body?.decision?.id as string
  const updates = [
    await attemptRolledBack((tx) => tx.$executeRawUnsafe(`UPDATE claim_review_events SET decision_code = 'REJECT', reason_code = 'REVIEW_OTHER', approval_fingerprint = NULL WHERE id = $1::uuid`, approvalW)),
    await attemptRolledBack((tx) => tx.$executeRawUnsafe('UPDATE claim_review_events SET reviewer_user_id = $2::uuid WHERE id = $1::uuid', approvalW, C.id)),
    await attemptRolledBack((tx) => tx.$executeRawUnsafe('UPDATE claim_review_events SET draft_assessment_id = draft_assessment_id, sequence = 9 WHERE id = $1::uuid', approvalW)),
    await attemptRolledBack((tx) => tx.$executeRawUnsafe(`UPDATE claim_review_events SET reviewed_at = reviewed_at - interval '1 day' WHERE id = $1::uuid`, approvalW)),
  ]
  check('T017', 'No UPDATE', approvedW.status === 201 && updates.every((message) => /claim_review_events is append-only: UPDATE/.test(message)), 'decision, reviewer, linkage, sequence and timestamp updates are each rejected')
  const deleted = await attemptRolledBack((tx) => tx.$executeRawUnsafe('DELETE FROM claim_review_events WHERE id = $1::uuid', approvalW))
  check('T018', 'No DELETE', /claim_review_events is append-only: DELETE/.test(deleted) && (await decisionsOf(W.claimId)) === 1, 'a direct DELETE is rejected and the decision survives')
  const gap = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, sequence: 3 }))
  const reuse = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, sequence: 1 }))
  const zero = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, sequence: 0 }))
  check(
    'T019',
    'Sequence guard',
    /claim_review_decision_sequence/.test(gap) && /claim_review_decision_sequence|claim_id_sequence_key|duplicate key/.test(reuse) && /claim_review_events_sequence_chk|claim_review_decision_sequence/.test(zero),
    'a gap, a reused and a non-positive sequence are each refused; only the next Claim-local number is accepted',
  )
  const backdated = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, sequence: 2, reviewedAt: '2020-01-01T00:00:00Z' }))
  const forwardDated = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, sequence: 2, reviewedAt: '2099-01-01T00:00:00Z' }))
  const storedW = await prisma.claimReviewEvent.findUniqueOrThrow({ where: { id: approvalW } })
  check(
    'T020',
    'No backdating',
    /claim_review_decision_time/.test(backdated) && /claim_review_decision_time/.test(forwardDated) && storedW.reviewedAt.getTime() === storedW.createdAt.getTime() && storedW.reviewedAt >= runStartedAt,
    'a past or future decision instant is refused; recorded decisions carry the database\'s own transaction time',
  )

  // ---------------------------------------------------------------- permissions and tenancy (T021–T030)
  section('Reviewer permission, Admin/Viewer, tenant isolation and no actor or Claim spoofing')
  const V = await reviewable('viewer target')
  const auditsBefore21 = await reviewAudits()
  const viewerDecide = [await decide(V.claimId, approveBody(V.assessment), asViewer), await decide(V.claimId, returnBody(V.assessment), asViewer), await decide(V.claimId, rejectBody(V.assessment), asViewer)]
  check('T021', 'Viewer cannot decide', viewerDecide.every((res) => res.status === 403 && errorCode(res.body) === 'FORBIDDEN') && (await decisionsOf(V.claimId)) === 0 && (await reviewAudits()) === auditsBefore21, 'approve, return and reject: 403; no decision and no audit')
  const viewerRevoke = await decide(W.claimId, revokeBody(W.assessment, approvalW), asViewer)
  check('T022', 'Viewer cannot revoke', viewerRevoke.status === 403 && (await decisionsOf(W.claimId)) === 1 && (await reviewAudits()) === auditsBefore21, 'claimReview.revoke is Admin only: 403; nothing written')
  const viewerReads = [await history(W.claimId, asViewer), await authority(W.claimId, asViewer), await readDecision(approvalW, asViewer)]
  check('T023', 'Viewer reads', viewerReads.every((res) => res.status === 200) && viewerReads[1].body?.state === 'APPROVED_CURRENT', `history, authority and decision ${viewerReads.map((r) => r.status).join('/')}`)
  const anonymousCalls = [await decide(W.claimId, approveBody(W.assessment), anonymous), await history(W.claimId, anonymous), await authority(W.claimId, anonymous), await readDecision(approvalW, anonymous)]
  check('T024', 'Anonymous', anonymousCalls.every((res) => res.status === 401), `401 on all four routes (${anonymousCalls.map((r) => r.status).join('/')})`)
  const missingClaim = await history(MISSING)
  const foreignAttempts = [
    await decide(foreign.claimId, { draftAssessmentId: foreign.assessmentId, assemblyFingerprint: foreign.fingerprint, decisionCode: 'REJECT', reasonCode: 'REVIEW_OTHER' }),
    await history(foreign.claimId),
    await authority(foreign.claimId),
  ]
  check(
    'T025',
    'Foreign Claim',
    foreignAttempts.every((res) => res.status === 404 && errorCode(res.body) === errorCode(missingClaim.body) && res.body?.error?.message === missingClaim.body?.error?.message) && (await decisionsOf(foreign.claimId)) === 1,
    "decide, history and authority of another tenant's Claim are answered exactly like a missing Claim (404); nothing is written",
  )
  const foreignRead = await readDecision(foreign.decisionId)
  const missingRead = await readDecision(MISSING)
  check(
    'T026',
    'Foreign decision',
    foreignRead.status === 404 && same(foreignRead.body?.error, { ...missingRead.body?.error, requestId: foreignRead.body?.error?.requestId }) && !JSON.stringify(foreignRead.body).includes(foreign.claimId),
    "another tenant's existing decision is answered exactly like a missing one (404); nothing about it is disclosed",
  )
  const foreignAssessmentHere = await decide(V.claimId, { draftAssessmentId: foreign.assessmentId, assemblyFingerprint: foreign.fingerprint, decisionCode: 'RETURN', reasonCode: 'REVIEW_OTHER' })
  const missingAssessmentHere = await decide(V.claimId, { draftAssessmentId: MISSING, assemblyFingerprint: foreign.fingerprint, decisionCode: 'RETURN', reasonCode: 'REVIEW_OTHER' })
  check(
    'T027',
    'Foreign assessment',
    foreignAssessmentHere.status === 404 && same(foreignAssessmentHere.body?.error?.message, missingAssessmentHere.body?.error?.message) && (await decisionsOf(V.claimId)) === 0,
    "another tenant's assessment named on an own Claim is answered exactly like a missing assessment (404); nothing written",
  )
  const spoofActor = await decide(V.claimId, { ...returnBody(V.assessment), reviewerUserId: creatorId })
  const recordedReviewer = storedW.reviewerUserId
  check(
    'T028',
    'No actor spoofing',
    spoofActor.status === 400 && recordedReviewer === B.id && approvedW.body?.decision?.reviewerUserId === B.id,
    'a client-supplied reviewer is refused; the recorded reviewer is the authenticated session user',
  )
  const spoofClaim = await decide(V.claimId, { ...approveBody(W.assessment), claimId: W.claimId })
  const otherOwnClaim = await decide(V.claimId, approveBody(W.assessment))
  check(
    'T029',
    'No Claim spoofing',
    spoofClaim.status === 400 && otherOwnClaim.status === 404 && (await decisionsOf(V.claimId)) === 0 && (await decisionsOf(W.claimId)) === 1,
    'a body claimId is refused; an assessment of another own Claim on this path is answered as missing (404); nothing written on either Claim',
  )
  // Authorization is verified at decision time: D loses its Admin role and is refused afterwards.
  await prisma.membershipRole.deleteMany({ where: { membershipId: D.membershipId } })
  const revokedRole = await decide(V.claimId, returnBody(V.assessment), D.who)
  check('T030', 'Authorization at decision time', revokedRole.status === 403 && (await decisionsOf(V.claimId)) === 0, 'a member whose reviewer role was removed is refused (403) on the next decision; no earlier grant is remembered')

  // ---------------------------------------------------------------- APPROVE (T031–T040)
  section('APPROVE only on an exact, current REVIEWABLE assessment with its own fingerprint')
  const auditsAfterW = await prisma.auditEvent.count({ where: { actionCode: 'claim_review.approved', entityId: approvalW } })
  check(
    'T031',
    'Approve the exact draft',
    approvedW.status === 201 &&
      same(Object.keys(approvedW.body?.decision ?? {}).sort(), DECISION_KEYS) &&
      approvedW.body.decision.decisionCode === 'APPROVE' &&
      approvedW.body.decision.sequence === 1 &&
      approvedW.body.decision.draftAssessmentId === W.assessment.id &&
      approvedW.body.decision.approvalFingerprint === W.assessment.assemblyFingerprint &&
      approvedW.body.decision.reasonCode === null &&
      approvedW.body.decision.reviewContractVersion === 'A6-REVIEW-1' &&
      approvedW.body.authority?.state === 'APPROVED_CURRENT' &&
      approvedW.body.authority?.decisionId === approvalW &&
      approvedW.body.authority?.fingerprint === W.assessment.assemblyFingerprint &&
      auditsAfterW === 1,
    `201: APPROVE #1 of assessment ${W.assessment.id} by a separate Admin with its exact fingerprint; derived authority APPROVED_CURRENT`,
  )
  const I = await draftClaim('incomplete', { lineCount: 0 })
  const assessedI = await assess(I.claimId, (await price(I.claimId)).id)
  const approveI = await decide(I.claimId, approveBody(assessedI))
  check('T032', 'INCOMPLETE refused', assessedI.outcome === 'INCOMPLETE' && approveI.status === 409 && errorCode(approveI.body) === 'CLAIM_REVIEW_NOT_REVIEWABLE' && (await decisionsOf(I.claimId)) === 0, '409 CLAIM_REVIEW_NOT_REVIEWABLE; no decision; no hidden manual override')
  const St = await draftClaim('stale assessment')
  const pricedSt = await price(St.claimId)
  await post(`/api/encounter-activities/${St.activityIds[1]}/remove`, {})
  const assessedSt = await assess(St.claimId, pricedSt.id)
  const approveSt = await decide(St.claimId, approveBody(assessedSt))
  check('T033', 'STALE refused', assessedSt.outcome === 'STALE' && approveSt.status === 409 && errorCode(approveSt.body) === 'CLAIM_REVIEW_NOT_REVIEWABLE' && (await decisionsOf(St.claimId)) === 0, '409 CLAIM_REVIEW_NOT_REVIEWABLE; no decision')
  const Iv = await draftClaim('invalid assessment')
  const pricedIv = await price(Iv.claimId)
  await recordRun(Iv.encounterId, Iv.activityIds, Iv.encounterDiagnosisIds)
  const assessedIv = await assess(Iv.claimId, pricedIv.id)
  const approveIv = await decide(Iv.claimId, approveBody(assessedIv))
  check('T034', 'INVALID refused', assessedIv.outcome === 'INVALID' && approveIv.status === 409 && errorCode(approveIv.body) === 'CLAIM_REVIEW_NOT_REVIEWABLE' && (await decisionsOf(Iv.claimId)) === 0, 'a superseded handoff makes the assessment INVALID: 409 CLAIM_REVIEW_NOT_REVIEWABLE; no decision')
  const F = await reviewable('fingerprint mismatch')
  const wrongFingerprint = await decide(F.claimId, { ...approveBody(F.assessment), assemblyFingerprint: W.assessment.assemblyFingerprint === F.assessment.assemblyFingerprint ? 'c'.repeat(64) : W.assessment.assemblyFingerprint })
  check('T035', 'Fingerprint mismatch', wrongFingerprint.status === 409 && errorCode(wrongFingerprint.body) === 'CLAIM_REVIEW_STALE' && (await decisionsOf(F.claimId)) === 0, 'a well-formed fingerprint that is not the assessment\'s own: 409 CLAIM_REVIEW_STALE; no decision')
  const crossClaim = await decide(F.claimId, approveBody(V.assessment))
  const crossClaimDb = await attemptRolledBack((tx) => insertDecision(tx, { claimId: F.claimId, assessmentId: V.assessment.id, decision: 'APPROVE', reviewer: B.id, fingerprint: V.assessment.assemblyFingerprint }))
  check(
    'T036',
    'Cross-Claim linkage',
    crossClaim.status === 404 && /claim_review_decision_coherence: the draft assessment belongs to another claim/.test(crossClaimDb) && (await decisionsOf(F.claimId)) === 0,
    "a correct assessment and hash under another Claim's path: the service answers it as missing (404) and the database refuses the linkage",
  )
  const R = await reviewable('reorder')
  const reordered = await api('PUT', `/api/claims/${R.claimId}/lines/order`, { claimLineIds: [...R.lineIds].reverse() })
  const approveR = await decide(R.claimId, approveBody(R.assessment))
  check(
    'T037',
    'Line reorder makes it stale',
    reordered.status === 200 && approveR.status === 409 && errorCode(approveR.body) === 'CLAIM_REVIEW_STALE' && (await decisionsOf(R.claimId)) === 0,
    'after a line reorder (same lines, same amounts) the old REVIEWABLE assessment is no longer current: 409 CLAIM_REVIEW_STALE',
  )
  const P = await reviewable('pointer edit', { roles: ['PRIMARY', 'SECONDARY'] })
  await setPointers(P.lineIds[0], P.claimDiagnosisIds)
  const approveP = await decide(P.claimId, approveBody(P.assessment))
  check('T038', 'Pointer edit makes it stale', approveP.status === 409 && errorCode(approveP.body) === 'CLAIM_REVIEW_STALE' && (await decisionsOf(P.claimId)) === 0, 'after a diagnosis-pointer edit the old assessment cannot be approved: 409 CLAIM_REVIEW_STALE')
  const reassessedW = await assess(W.claimId, W.pricing.id)
  const secondApprove = [await decide(W.claimId, approveBody(W.assessment), C.who), await decide(W.claimId, approveBody(reassessedW), C.who)]
  const duplicateDb = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: reassessedW.id, decision: 'APPROVE', reviewer: C.id, sequence: 2, fingerprint: reassessedW.assemblyFingerprint }))
  check(
    'T039',
    'One current approval',
    reassessedW.assemblyFingerprint === W.assessment.assemblyFingerprint &&
      secondApprove.every((res) => res.status === 409 && errorCode(res.body) === 'CLAIM_REVIEW_CONFLICT') &&
      /an approval of this exact fingerprint is already the latest decision/.test(duplicateDb) &&
      (await decisionsOf(W.claimId)) === 1,
    'a second APPROVE of the same or an identical fresh assessment while one is current: 409 CLAIM_REVIEW_CONFLICT; the database also refuses it',
  )
  const claimRowW = await prisma.claim.findUniqueOrThrow({ where: { id: W.claimId } })
  const claimColumns = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims'`).map((row) => row.column_name)
  const assessmentRowW = await prisma.claimDraftAssessment.findUniqueOrThrow({ where: { id: W.assessment.id } })
  check(
    'T040',
    'Approval touches nothing else',
    claimColumns.length === 7 && !claimColumns.some((column) => /approv|review|status|state|latest|current/i.test(column)) && claimRowW.createdByUserId === creatorId && assessmentRowW.outcome === 'REVIEWABLE' && assessmentRowW.assemblyFingerprint === W.assessment.assemblyFingerprint,
    'the Claim keeps its seven columns with no approval, status or pointer; the assessment and pricing run are unchanged',
  )

  // ---------------------------------------------------------------- separation and staleness (T041–T050)
  section('Separation of duties, stale approvals and source, commercial, handoff and diagnosis changes')
  const S1 = await reviewable('separation creator')
  const selfApprove = await decide(S1.claimId, approveBody(S1.assessment), asAdmin)
  check('T041', 'Claim creator cannot approve', selfApprove.status === 409 && errorCode(selfApprove.body) === 'CLAIM_REVIEW_SEPARATION_REQUIRED' && (await decisionsOf(S1.claimId)) === 0, '409 CLAIM_REVIEW_SEPARATION_REQUIRED for the Admin who created the Claim and its assessment; no decision and no audit')
  const assessedByB = await assess(S1.claimId, S1.pricing.id, B.who)
  const assessorApprove = await decide(S1.claimId, approveBody(assessedByB), B.who)
  const separateApprove = await decide(S1.claimId, approveBody(assessedByB), C.who)
  check(
    'T042',
    'Assessment creator cannot approve',
    assessedByB.createdByUserId === B.id && assessorApprove.status === 409 && errorCode(assessorApprove.body) === 'CLAIM_REVIEW_SEPARATION_REQUIRED' && separateApprove.status === 201,
    'the Admin who recorded the assessment is refused (409); a third Admin who created neither approves it (201)',
  )
  const S2 = await reviewable('separation database')
  const dbSelf = await attemptRolledBack((tx) => insertDecision(tx, { claimId: S2.claimId, assessmentId: S2.assessment.id, decision: 'APPROVE', reviewer: creatorId, fingerprint: S2.assessment.assemblyFingerprint }))
  const dbSeparate = await attemptRolledBack((tx) => insertDecision(tx, { claimId: S2.claimId, assessmentId: S2.assessment.id, decision: 'APPROVE', reviewer: B.id, fingerprint: S2.assessment.assemblyFingerprint }))
  check('T043', 'Separation in the database', /claim_review_separation/.test(dbSelf) && dbSeparate.includes(NOT_REFUSED), 'a direct APPROVE by the creator is refused by the database; by a separate user it is accepted (rolled back) — no approver is ever invented')
  const L = await reviewable('stale after removal')
  const approveL = await decide(L.claimId, approveBody(L.assessment))
  const currentL = await stateOf(L.claimId)
  await post(`/api/claim-lines/${L.lineIds[1]}/remove`, {})
  const afterL = await authority(L.claimId)
  const historyL = await history(L.claimId)
  check(
    'T044',
    'Line removal stales an approval',
    approveL.status === 201 && currentL === 'APPROVED_CURRENT' && afterL.body?.state === 'APPROVAL_STALE' && afterL.body?.decisionId === approveL.body?.decision?.id && historyL.body?.items?.length === 1,
    'APPROVED_CURRENT, then after a line removal APPROVAL_STALE (no authority); the APPROVE stays in history unchanged',
  )
  const So = await reviewable('stale after source removal')
  await decide(So.claimId, approveBody(So.assessment))
  await post(`/api/encounter-activities/${So.activityIds[0]}/remove`, {})
  check('T045', 'Source removal stales it', (await stateOf(So.claimId)) === 'APPROVAL_STALE', 'a source activity removed after approval: APPROVAL_STALE')
  const Q = await reviewable('stale after quantity change')
  await decide(Q.claimId, approveBody(Q.assessment))
  // A4.6 exposes no activity edit, so the source quantity is changed directly (synthetic, adversarial).
  await prisma.$executeRawUnsafe('UPDATE encounter_activities SET quantity = 3 WHERE id = $1::uuid', Q.activityIds[1])
  check('T046', 'Pricing drift stales it', (await stateOf(Q.claimId)) === 'APPROVAL_STALE', 'a source quantity changed after pricing: the priced draft no longer matches; APPROVAL_STALE')
  const H = await reviewable('stale after new validation')
  await decide(H.claimId, approveBody(H.assessment))
  await recordRun(H.encounterId, H.activityIds, H.encounterDiagnosisIds)
  check('T047', 'Handoff change stales it', (await stateOf(H.claimId)) === 'APPROVAL_STALE', 'a newer validation run supersedes the bound handoff: APPROVAL_STALE')
  const Dx = await reviewable('stale after diagnosis change', { spareDiagnoses: 1 })
  await decide(Dx.claimId, approveBody(Dx.assessment))
  must('secondary diagnosis', (await post(`/api/claims/${Dx.claimId}/diagnoses`, { encounterDiagnosisId: Dx.encounterDiagnosisIds[1], roleCode: 'SECONDARY' })).body)
  check('T048', 'Diagnosis change stales it', (await stateOf(Dx.claimId)) === 'APPROVAL_STALE', 'a diagnosis added after approval: APPROVAL_STALE')
  const repricedL = await price(L.claimId)
  const reassessedL = await assess(L.claimId, repricedL.id)
  const reapproveL = await decide(L.claimId, approveBody(reassessedL), C.who)
  const historyL2 = await history(L.claimId)
  check(
    'T049',
    'Corrected assessment supersedes',
    reassessedL.outcome === 'REVIEWABLE' && reapproveL.status === 201 && reapproveL.body?.authority?.state === 'APPROVED_CURRENT' && reapproveL.body?.authority?.decisionId === reapproveL.body?.decision?.id &&
      same(historyL2.body?.items?.map((d: any) => [d.sequence, d.decisionCode, d.draftAssessmentId]), [[1, 'APPROVE', L.assessment.id], [2, 'APPROVE', reassessedL.id]]),
    'after a fresh pricing run and assessment a new APPROVE supersedes the stale one without a revocation; both stay in history',
  )
  const reapproveOld = await decide(So.claimId, approveBody(So.assessment), C.who)
  check('T050', 'Stale assessment stays refused', reapproveOld.status === 409 && errorCode(reapproveOld.body) === 'CLAIM_REVIEW_STALE' && (await decisionsOf(So.claimId)) === 1, 'the old assessment of a stale approval cannot be approved again: 409 CLAIM_REVIEW_STALE')

  // ---------------------------------------------------------------- RETURN and REJECT (T051–T060)
  section('RETURN and REJECT: controlled reasons, no accidental approval, history and safe DTOs')
  const Rt = await reviewable('return')
  const returned = await decide(Rt.claimId, returnBody(Rt.assessment))
  check(
    'T051',
    'RETURN',
    returned.status === 201 && returned.body?.decision?.decisionCode === 'RETURN' && returned.body.decision.reasonCode === 'REVIEW_DOCUMENTATION_REQUIRED' && returned.body.decision.approvalFingerprint === null && returned.body.authority?.state === 'NOT_APPROVED',
    '201 with its controlled reason and no fingerprint; authority NOT_APPROVED',
  )
  const rejectedIv = await decide(Iv.claimId, rejectBody(assessedIv))
  check('T052', 'REJECT', rejectedIv.status === 201 && rejectedIv.body?.decision?.reasonCode === 'REVIEW_INTEGRITY_CONCERN' && rejectedIv.body?.authority?.state === 'NOT_APPROVED', 'an INVALID draft is rejected with its controlled reason; authority NOT_APPROVED')
  const noReason = [await decide(Rt.claimId, { draftAssessmentId: Rt.assessment.id, assemblyFingerprint: Rt.assessment.assemblyFingerprint, decisionCode: 'RETURN' }), await decide(Rt.claimId, { draftAssessmentId: Rt.assessment.id, assemblyFingerprint: Rt.assessment.assemblyFingerprint, decisionCode: 'REJECT' })]
  check('T053', 'Reason required', noReason.every((res) => res.status === 400 && /requires a reasonCode/.test(res.body?.error?.message ?? '')) && (await decisionsOf(Rt.claimId)) === 1, 'RETURN and REJECT without a reason: 400; nothing written')
  const returnOverCurrent = await decide(W.claimId, returnBody(W.assessment), C.who)
  const rejectOverCurrent = await decide(W.claimId, rejectBody(W.assessment), C.who)
  check(
    'T054',
    'No implicit withdrawal',
    [returnOverCurrent, rejectOverCurrent].every((res) => res.status === 409 && errorCode(res.body) === 'CLAIM_REVIEW_CONFLICT') && (await decisionsOf(W.claimId)) === 1 && (await stateOf(W.claimId)) === 'APPROVED_CURRENT',
    'a RETURN or REJECT over a current approval is refused (409); the approval is withdrawn only by an explicit REVOKE',
  )
  const rejectOverCurrent2 = await decide(L.claimId, { draftAssessmentId: L.assessment.id, assemblyFingerprint: L.assessment.assemblyFingerprint, decisionCode: 'REJECT', reasonCode: 'REVIEW_CODING_CORRECTION' })
  const rejectOverStale = await decide(Dx.claimId, rejectBody(Dx.assessment, 'REVIEW_CODING_CORRECTION'), C.who)
  check(
    'T055',
    'Reject over a stale approval',
    rejectOverCurrent2.status === 409 && errorCode(rejectOverCurrent2.body) === 'CLAIM_REVIEW_CONFLICT' && rejectOverStale.status === 201 && rejectOverStale.body?.authority?.state === 'NOT_APPROVED',
    'a rejection while a re-approval is current is refused (409); over a stale approval it is recorded (201) and grants nothing',
  )
  const unrelated = await stateOf(W.claimId)
  const afterReturnState = await stateOf(Rt.claimId)
  check('T056', 'No accidental approval', afterReturnState === 'NOT_APPROVED' && unrelated === 'APPROVED_CURRENT' && (await prisma.claimReviewEvent.count({ where: { claimId: Rt.claimId, decisionCode: 'APPROVE' } })) === 0, 'a RETURN grants nothing and leaves every other Claim\'s authority as it was')
  const historyW = await history(W.claimId)
  const historyRows = await prisma.claimReviewEvent.findMany({ where: { createdAt: { gte: runStartedAt } }, orderBy: [{ claimId: 'asc' }, { sequence: 'asc' }] })
  const contiguous = Object.values(historyRows.reduce<Record<string, number[]>>((acc, row) => ({ ...acc, [row.claimId]: [...(acc[row.claimId] ?? []), row.sequence] }), {})).every((sequences) => sequences.every((s, i) => s === i + 1))
  check(
    'T057',
    'History order',
    historyL2.body?.items?.every((item: any, i: number) => item.sequence === i + 1) && historyW.body?.items?.length === 1 && contiguous,
    'every history is in ascending Claim-local sequence 1..N with no gap, never by time or identifier',
  )
  const dtoKeys = [...deepKeys(approvedW.body), ...deepKeys(historyW.body), ...deepKeys(returned.body)]
  const dtoText = JSON.stringify([approvedW.body, historyW.body, returned.body])
  check(
    'T058',
    'Safe DTOs',
    same(Object.keys(historyW.body?.items?.[0] ?? {}).sort(), DECISION_KEYS) &&
      same(Object.keys(approvedW.body?.authority ?? {}).sort(), AUTHORITY_KEYS) &&
      !dtoKeys.some((k) => /patient|member|diagnos|procedure|service|amount|tariff|price|currency|remark|comment|note|payload|submission/i.test(k)) &&
      !/AED|200\.01|125\.25/.test(dtoText),
    'decisions and authority carry ids, codes, sequence, fingerprint and instants only; no patient, diagnosis, amount, remark or payload',
  )
  const readApproval = await readDecision(approvalW)
  check('T059', 'Read consistency', readApproval.status === 200 && same(readApproval.body, approvedW.body?.decision) && same(historyW.body?.items?.[0], approvedW.body?.decision) && same(viewerReads[2].body, readApproval.body), 'the decision reads back identically by id, in history, for Admin and Viewer, and equals the creation response')
  const creatorReturn = await decide(V.claimId, returnBody(V.assessment, 'REVIEW_PRICING_QUESTION'), asAdmin)
  check('T060', 'Return needs no separation', creatorReturn.status === 201 && creatorReturn.body?.decision?.reasonCode === 'REVIEW_PRICING_QUESTION' && creatorReturn.body?.authority?.state === 'NOT_APPROVED', 'separation of duties is required for approval only; the creator may send a draft back, which grants nothing')

  // ---------------------------------------------------------------- REVOKE (T061–T070)
  section('REVOKE: target authority, duplicate revocation, historical retention and later fresh review')
  const approvalBeforeRevoke = JSON.stringify(await prisma.claimReviewEvent.findUniqueOrThrow({ where: { id: approvalW } }))
  const revokedW = await decide(W.claimId, revokeBody(W.assessment, approvalW, { reasonCode: 'REVIEW_INTEGRITY_CONCERN' }), C.who)
  const historyW2 = await history(W.claimId)
  check(
    'T061',
    'Approve then revoke',
    revokedW.status === 201 && revokedW.body?.decision?.decisionCode === 'REVOKE' && revokedW.body.decision.referencedApprovalId === approvalW && revokedW.body.decision.sequence === 2 && revokedW.body.authority?.state === 'NOT_APPROVED' &&
      same(historyW2.body?.items?.map((d: any) => d.decisionCode), ['APPROVE', 'REVOKE']),
    'history holds both events; the derived authority is NOT_APPROVED',
  )
  const revokeAgain = await decide(W.claimId, revokeBody(W.assessment, approvalW), C.who)
  const revokeAgainDb = await attemptRolledBack((tx) => insertDecision(tx, { claimId: W.claimId, assessmentId: W.assessment.id, decision: 'REVOKE', reviewer: C.id, sequence: 3, target: approvalW }))
  check(
    'T062',
    'No duplicate revocation',
    revokeAgain.status === 409 && errorCode(revokeAgain.body) === 'CLAIM_REVIEW_CONFLICT' && /claim_review_decision_coherence|referenced_approval_id_key|duplicate key/.test(revokeAgainDb) && (await decisionsOf(W.claimId)) === 2,
    'a second revocation of the same approval is refused by the service (409) and the database',
  )
  const revokeReturn = await decide(Rt.claimId, revokeBody(Rt.assessment, returned.body?.decision?.id))
  check('T063', 'Only an approval is revoked', revokeReturn.status === 409 && errorCode(revokeReturn.body) === 'CLAIM_REVIEW_CONFLICT' && (await decisionsOf(Rt.claimId)) === 1, 'a RETURN cannot be revoked: 409 CLAIM_REVIEW_CONFLICT')
  const firstApprovalL = historyL2.body?.items?.[0]?.id as string
  const revokeOlder = await decide(L.claimId, revokeBody(L.assessment, firstApprovalL), C.who)
  check('T064', 'Only the latest approval', revokeOlder.status === 409 && errorCode(revokeOlder.body) === 'CLAIM_REVIEW_CONFLICT' && (await decisionsOf(L.claimId)) === 2, 'a superseded older approval cannot be revoked: 409')
  const latestApprovalL = reapproveL.body?.decision?.id as string
  const revokeMismatch = await decide(L.claimId, revokeBody(L.assessment, latestApprovalL), C.who)
  check('T065', 'Same assessment', revokeMismatch.status === 409 && errorCode(revokeMismatch.body) === 'CLAIM_REVIEW_CONFLICT' && (await decisionsOf(L.claimId)) === 2, 'a revocation naming another assessment than the approval it withdraws: 409')
  const revokeStale = await decide(So.claimId, revokeBody(So.assessment, (await prisma.claimReviewEvent.findFirstOrThrow({ where: { claimId: So.claimId } })).id), C.who)
  check('T066', 'A stale approval can be revoked', revokeStale.status === 201 && revokeStale.body?.authority?.state === 'NOT_APPROVED', 'a stale approval that is still the latest decision is withdrawn explicitly (201); history becomes unambiguous')
  const revokeForeignTarget = await decide(L.claimId, revokeBody(reassessedL, approvalW), C.who)
  const revokeForeignTargetDb = await attemptRolledBack((tx) => insertDecision(tx, { claimId: L.claimId, assessmentId: reassessedL.id, decision: 'REVOKE', reviewer: C.id, sequence: 3, target: approvalW }))
  check('T067', 'Another Claim\'s approval', revokeForeignTarget.status === 409 && /a revocation must withdraw this claim's latest approval/.test(revokeForeignTargetDb) && (await decisionsOf(L.claimId)) === 2, "another Claim's approval named as the target is refused by the service and the database")
  const approvalAfterRevoke = JSON.stringify(await prisma.claimReviewEvent.findUniqueOrThrow({ where: { id: approvalW } }))
  check('T068', 'Historical retention', approvalAfterRevoke === approvalBeforeRevoke && (await readDecision(approvalW)).status === 200, 'the revoked approval row is byte-for-byte unchanged and still readable')
  const freshAfterRevoke = await decide(W.claimId, approveBody(reassessedW), C.who)
  check(
    'T069',
    'Later fresh review',
    freshAfterRevoke.status === 201 && freshAfterRevoke.body?.decision?.sequence === 3 && freshAfterRevoke.body?.authority?.state === 'APPROVED_CURRENT',
    'after an explicit revocation a separate reviewer approves a fresh assessment of the unchanged draft (APPROVE #3, APPROVED_CURRENT)',
  )
  const freeRevokeReason = await decide(W.claimId, revokeBody(reassessedW, freshAfterRevoke.body?.decision?.id, { reasonCode: 'changed my mind' }), C.who)
  check('T070', 'Revoke reason vocabulary', freeRevokeReason.status === 400 && revokedW.body?.decision?.reasonCode === 'REVIEW_INTEGRITY_CONCERN' && (await decisionsOf(W.claimId)) === 3, 'a free-text revoke reason is refused (400); a controlled one is recorded')

  // ---------------------------------------------------------------- concurrency (T071–T080)
  section('Serial Claim lock, concurrent approvals, approve/edit and revoke/approve races, rollback')
  const reviewDecisionOf = (claimId: string, body: Record<string, unknown>, reviewer = B.id) => recordReviewDecision(claimId, body, reviewer)
  const K1 = await reviewable('race decision first')
  const hold1 = holdAt('claimReview.claim_locked')
  const approve1 = reviewDecisionOf(K1.claimId, approveBody(K1.assessment))
  await Promise.race([hold1.arrived, approve1])
  const remove1 = removeClaimLine(K1.lineIds[1], {}, creatorId)
  const remove1Waited = !(await settledWithin(remove1, 600))
  hold1.release()
  const [r1Approve, r1Remove] = await Promise.all([approve1, remove1])
  clearConcurrencyProbes()
  check(
    'T071',
    'Decision holds the Claim',
    remove1Waited && r1Approve.ok && r1Approve.value.authority.state === 'APPROVED_CURRENT' && r1Remove.ok && (await stateOf(K1.claimId)) === 'APPROVAL_STALE',
    'a line removal waited for the approval holding the Claim; the approval judged the unchanged draft, then the removal committed and the authority became APPROVAL_STALE',
  )
  const K2 = await reviewable('race writer first')
  const hold2 = holdAt('claimLine.remove')
  const remove2 = removeClaimLine(K2.lineIds[1], {}, creatorId)
  await Promise.race([hold2.arrived, remove2])
  const approve2 = reviewDecisionOf(K2.claimId, approveBody(K2.assessment))
  const approve2Waited = !(await settledWithin(approve2, 600))
  hold2.release()
  const [r2Remove, r2Approve] = await Promise.all([remove2, approve2])
  clearConcurrencyProbes()
  check(
    'T072',
    'Edit first, fresh snapshot',
    approve2Waited && r2Remove.ok && !r2Approve.ok && r2Approve.code === 'CLAIM_REVIEW_STALE' && (await decisionsOf(K2.claimId)) === 0,
    'the approval waited for a line removal holding the Claim and then judged the post-removal draft: CLAIM_REVIEW_STALE, never the snapshot from before it waited',
  )
  const K3 = await reviewable('race two reviewers')
  const concurrent = await Promise.all([decide(K3.claimId, approveBody(K3.assessment), B.who), decide(K3.claimId, approveBody(K3.assessment), C.who)])
  const statuses = concurrent.map((res) => res.status).sort()
  const loser = concurrent.find((res) => res.status !== 201)
  check(
    'T073',
    'Simultaneous approvals',
    same(statuses, [201, 409]) && errorCode(loser?.body) === 'CLAIM_REVIEW_CONFLICT' && (await prisma.claimReviewEvent.count({ where: { claimId: K3.claimId, decisionCode: 'APPROVE' } })) === 1,
    'two reviewers approving the same draft at once: exactly one 201 and one deterministic 409 CLAIM_REVIEW_CONFLICT; never two authorities',
  )
  const K4 = await reviewable('race pricing')
  const hold4 = holdAt('claimReview.claim_locked')
  const approve4 = reviewDecisionOf(K4.claimId, approveBody(K4.assessment))
  await Promise.race([hold4.arrived, approve4])
  const pricing4 = createPricingRun(K4.claimId, {}, creatorId)
  const pricing4Waited = !(await settledWithin(pricing4, 600))
  hold4.release()
  const [r4Approve, r4Pricing] = await Promise.all([approve4, pricing4])
  clearConcurrencyProbes()
  check(
    'T074',
    'Pricing waits for the decision',
    pricing4Waited && r4Approve.ok && r4Pricing.ok && new Date(r4Pricing.value.evaluatedAt) > new Date(r4Approve.value.decision.reviewedAt) && (await stateOf(K4.claimId)) === 'APPROVED_CURRENT',
    'a pricing run waited for the approval holding the Claim; a newer run of the same structure leaves the approved draft current',
  )
  const K5 = await reviewable('race revoke approve')
  const first5 = await decide(K5.claimId, approveBody(K5.assessment), B.who)
  const fresh5 = await assess(K5.claimId, K5.pricing.id)
  const hold5 = holdAt('claimReview.claim_locked')
  const revoke5 = reviewDecisionOf(K5.claimId, revokeBody(K5.assessment, first5.body?.decision?.id), C.id)
  await Promise.race([hold5.arrived, revoke5])
  const approve5 = reviewDecisionOf(K5.claimId, approveBody(fresh5), C.id)
  const approve5Waited = !(await settledWithin(approve5, 600))
  hold5.release()
  const [r5Revoke, r5Approve] = await Promise.all([revoke5, approve5])
  clearConcurrencyProbes()
  const history5 = await history(K5.claimId)
  check(
    'T075',
    'Revoke/approve race',
    approve5Waited && r5Revoke.ok && r5Approve.ok && same(history5.body?.items?.map((d: any) => d.decisionCode), ['APPROVE', 'REVOKE', 'APPROVE']) && (await authority(K5.claimId)).body?.decisionId === r5Approve.value.decision.id,
    'an approval waited for a revocation holding the Claim, then judged the post-revocation history; exactly one current authority (the newest approval)',
  )
  const K6 = await reviewable('race assessment')
  const hold6 = holdAt('claimReview.claim_locked')
  const approve6 = reviewDecisionOf(K6.claimId, approveBody(K6.assessment))
  await Promise.race([hold6.arrived, approve6])
  const assess6 = createDraftAssessment(K6.claimId, { pricingRunId: K6.pricing.id }, creatorId)
  const assess6Waited = !(await settledWithin(assess6, 600))
  hold6.release()
  const [r6Approve, r6Assess] = await Promise.all([approve6, assess6])
  clearConcurrencyProbes()
  check(
    'T076',
    'Assessment waits for the decision',
    assess6Waited && r6Approve.ok && r6Assess.ok && r6Assess.value.assemblyFingerprint === K6.assessment.assemblyFingerprint,
    'an A6.4 assessment waited for the approval holding the Claim; its fingerprint matches the approved one',
  )
  const K7 = await reviewable('rollback')
  const countsK7 = async () => JSON.stringify([await decisionsOf(K7.claimId), await reviewAudits()])
  const beforeRollback = await countsK7()
  failAt('claimReview.inserted', 'forced failure after the decision row')
  const forcedA = await attemptAdversarial(() => reviewDecisionOf(K7.claimId, approveBody(K7.assessment)))
  check('T077', 'Rollback after insert', /forced failure/.test(forcedA) && (await countsK7()) === beforeRollback, 'a failure after the decision row leaves no decision and no audit')
  failAt('claimReview.audited', 'forced failure after the audit')
  const forcedB = await attemptAdversarial(() => reviewDecisionOf(K7.claimId, approveBody(K7.assessment)))
  clearConcurrencyProbes()
  check('T078', 'Rollback after audit', /forced failure/.test(forcedB) && (await countsK7()) === beforeRollback, 'a failure after the audit leaves no decision and no audit')
  // A serializable writer that reads this Claim's decisions and changes one of its sources commits while the
  // approval holds a snapshot: the approval must be rolled back and retried, then judge the fresh draft.
  const K8 = await reviewable('race serialization')
  const hold8 = holdAt('claimReview.claim_locked')
  const approve8 = reviewDecisionOf(K8.claimId, approveBody(K8.assessment))
  await Promise.race([hold8.arrived, approve8])
  const conflicting = await attemptAdversarial(() =>
    prisma.$transaction(
      async (tx) => {
        await tx.claimReviewEvent.count({ where: { claimId: K8.claimId } })
        await tx.$executeRawUnsafe('UPDATE encounter_activities SET quantity = 4 WHERE id = $1::uuid', K8.activityIds[0])
      },
      { isolationLevel: 'Serializable' },
    ),
  )
  hold8.release()
  const r8Approve = await approve8
  clearConcurrencyProbes()
  check(
    'T079',
    'Serialization retry',
    conflicting === '' && !r8Approve.ok && r8Approve.code === 'CLAIM_REVIEW_STALE' && (await decisionsOf(K8.claimId)) === 0,
    'a conflicting serializable source change committed mid-approval: the approval was retried on a fresh snapshot and refused as stale; nothing written',
  )
  // A failure that is not a recognized serialization conflict is never retried: the one-shot probe would
  // let a retry through and write a row.
  const K9 = await reviewable('no blanket retry')
  failAt('claimReview.claim_locked', 'Connection terminated unexpectedly (synthetic)')
  const dropped = await attemptAdversarial(() => reviewDecisionOf(K9.claimId, approveBody(K9.assessment)))
  clearConcurrencyProbes()
  check('T080', 'No blanket retry', /Connection terminated unexpectedly/.test(dropped) && (await decisionsOf(K9.claimId)) === 0, 'a dropped connection mid-transaction leaves no half decision or audit and is not retried')

  // ---------------------------------------------------------------- forward gate (T081–T090)
  section('A6.7 forward gate: no ClaimSubmission, no payload serialization, no external transport')
  const reviewCode = committedProductionCodeOf([REVIEW_DIR])
  const feCode = committedProductionCodeOf([FE_REVIEW_DIR])
  const reached = reviewCode.files.length === 6 && reviewCode.code.includes('composeCurrentDraft') && reviewCode.code.includes('lockRowForUpdateNowait')
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  check('T081', 'No ClaimSubmission', reached && !tables.some((t) => /submission|evidence_package|claim_snapshot|claim_payload|transport/.test(t)) && !/claimSubmission|ClaimSubmission/.test(reviewCode.code), 'no ClaimSubmission, evidence-package, payload or transport table, model or call')
  check('T082', 'No payload serialization', reached && !/\b(xml|x12|serializeClaim\w*|serializePayload\w*|payloadHash|buildPayload|canonicalPayload|toXml)\b/i.test(reviewCode.code + feCode.code), 'no XML, X12, payload hash or serialization in A6.5 code')
  check('T083', 'No external transport', reached && !/\b(fetch|axios|https?\.request|dhpo|eclaimlink|clearinghouse|soap|sftp|transactionId|apiKey|clientSecret)\b/i.test(reviewCode.code), 'no network call, credential or transport identifier in the A6.5 backend')
  const forwardCurrent = await prisma.$transaction(async (tx) => getCurrentReviewAuthority(W.claimId, tx))
  const forwardStale = await prisma.$transaction(async (tx) => getCurrentReviewAuthority(K1.claimId, tx))
  check(
    'T084',
    'Transaction-aware authority',
    forwardCurrent.state === 'APPROVED_CURRENT' && forwardCurrent.decisionId === freshAfterRevoke.body?.decision?.id && forwardStale.state === 'APPROVAL_STALE' && /export async function getCurrentReviewAuthority\(claimId: string, tx: DbClient\)/.test(reviewCode.code),
    'getCurrentReviewAuthority(claimId, tx) runs on the caller\'s transaction for a later freeze gate: current for a current approval, stale otherwise',
  )
  const N = await reviewable('never decided')
  check('T085', 'REVIEWABLE alone is not approval', (await stateOf(N.claimId)) === 'NOT_APPROVED' && (await authority(N.claimId)).body?.decisionId === null, 'a READY_FOR_REVIEW handoff and a REVIEWABLE assessment with no decision: NOT_APPROVED')
  const nonGranting = [await stateOf(Rt.claimId), await stateOf(Iv.claimId), await stateOf(So.claimId), await stateOf(H.claimId)]
  check('T086', 'Nothing else grants authority', same(nonGranting, ['NOT_APPROVED', 'NOT_APPROVED', 'NOT_APPROVED', 'APPROVAL_STALE']), 'RETURN, REJECT, REVOKE and a stale approval: no authority')
  const reviewColumns = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claim_review_events'`).map((row) => row.column_name).sort()
  check('T087', 'No submission evidence', same(reviewColumns, [...A65_COLUMNS].sort()), 'the decision carries exactly its 12 columns: no payload hash, snapshot or submission evidence')
  const pointerColumns = (await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* '(latest_?approv|current_?approv|approval_?state|approved_?at|approved_?by|review_?status)'`)
  check('T088', 'No lifecycle state or pointer', pointerColumns.length === 0 && claimColumns.length === 7, 'no approval state, approvedAt/By, review status or latest/current-approval pointer anywhere')
  const runAudits = await prisma.auditEvent.findMany({ where: { actionCode: { in: REVIEW_ACTIONS }, occurredAt: { gte: runStartedAt } } })
  const runDecisions = await prisma.claimReviewEvent.findMany({ where: { createdAt: { gte: runStartedAt } } })
  const auditByEntity = new Map(runAudits.map((row) => [row.entityId, row]))
  const actionFor: Record<string, string> = { APPROVE: 'claim_review.approved', RETURN: 'claim_review.returned', REJECT: 'claim_review.rejected', REVOKE: 'claim_review.revoked' }
  const ownDecisions = runDecisions.filter((row) => row.claimId !== foreign!.claimId)
  check(
    'T089',
    'Audit exactly once',
    runAudits.length === runDecisions.length &&
      ownDecisions.every((row) => {
        const audit = auditByEntity.get(row.id)
        return audit !== undefined && audit.actionCode === actionFor[row.decisionCode] && audit.entityType === 'CLAIM_REVIEW_DECISION' && audit.organizationId === org && audit.actorUserId === row.reviewerUserId
      }),
    `${runDecisions.length} decision(s) of this run, each with exactly one audit of its action, on the decision entity, in the Claim's organization, by its reviewer`,
  )
  const auditText = JSON.stringify(runAudits.map((row) => row.afterState)).replace(UUID_PATTERN, '<id>')
  check(
    'T090',
    'Audit minimal',
    runAudits.length >= 20 &&
      runAudits.every((row) => row.beforeState === null && same(Object.keys(row.afterState as object).sort(), AUDIT_KEYS)) &&
      !/AED|200\.01|amount|tariff|PRIMARY|SECONDARY|procedure|service|diagnos|patient|payer|[0-9a-f]{64}/i.test(auditText),
    'ids, decision code, sequence, controlled reason and contract only; no amount, code, role, patient, payer or fingerprint',
  )

  // ---------------------------------------------------------------- database abuse (T091–T100)
  section('Direct database writes: foreign keys, linkage, delete, update, collision and cross-tenant abuse')
  const missingFks = [
    await attemptRolledBack((tx) => insertDecision(tx, { claimId: MISSING, assessmentId: N.assessment.id })),
    await attemptRolledBack((tx) => insertDecision(tx, { claimId: N.claimId, assessmentId: MISSING })),
    await attemptRolledBack((tx) => insertDecision(tx, { claimId: N.claimId, assessmentId: N.assessment.id, reviewer: MISSING })),
    await attemptRolledBack((tx) => insertDecision(tx, { claimId: N.claimId, assessmentId: N.assessment.id, decision: 'REVOKE', target: MISSING })),
  ]
  check('T091', 'Invalid foreign keys', missingFks.every((message) => /foreign key|violates|claim_review_decision_coherence/i.test(message) && !message.includes(NOT_REFUSED)), 'a missing Claim, assessment, reviewer or revoked approval is refused')
  const wrongLink = await attemptRolledBack((tx) => insertDecision(tx, { claimId: N.claimId, assessmentId: W.assessment.id }))
  check('T092', 'Wrong Claim/draft link', /claim_review_decision_coherence: the draft assessment belongs to another claim/.test(wrongLink), 'a decision about another Claim\'s assessment is refused')
  const claimDelete = await attemptRolledBack((tx) => tx.$executeRawUnsafe('DELETE FROM claims WHERE id = $1::uuid', W.claimId))
  const assessmentDelete = await attemptRolledBack((tx) => tx.$executeRawUnsafe('DELETE FROM claim_draft_assessments WHERE id = $1::uuid', W.assessment.id))
  const reviewerDelete = await attemptRolledBack((tx) => tx.$executeRawUnsafe('DELETE FROM "user" WHERE id = $1::uuid', B.id))
  check('T093', 'Hard delete', [claimDelete, assessmentDelete, reviewerDelete].every((message) => /foreign key|restrict|append-only|cannot be deleted/i.test(message) && !message.includes(NOT_REFUSED)), 'the Claim, assessment and reviewer behind a decision cannot be hard-deleted')
  const updateEach = await Promise.all(
    ['claim_id = claim_id', 'review_contract_version = review_contract_version', "approval_fingerprint = 'd' || substr(approval_fingerprint, 2)", 'referenced_approval_id = NULL', 'created_at = now()'].map((assignment) =>
      attemptRolledBack((tx) => tx.$executeRawUnsafe(`UPDATE claim_review_events SET ${assignment} WHERE id = $1::uuid`, approvalW)),
    ),
  )
  check('T094', 'UPDATE of any column', updateEach.every((message) => /append-only: UPDATE/.test(message)), 'even a no-op UPDATE of any column is rejected')
  const collision = await attemptAdversarial(() =>
    Promise.all([
      prisma.$transaction((tx) => insertDecision(tx, { claimId: N.claimId, assessmentId: N.assessment.id, sequence: 1, reason: 'REVIEW_OTHER' }).then(() => pause(300))),
      pause(50).then(() => prisma.$transaction((tx) => insertDecision(tx, { claimId: N.claimId, assessmentId: N.assessment.id, sequence: 1, reason: 'REVIEW_OTHER' }))),
    ]),
  )
  const collidedRows = await decisionsOf(N.claimId)
  check('T095', 'Sequence collision', /duplicate key|claim_id_sequence_key|claim_review_decision_sequence/.test(collision) && collidedRows === 1, 'two concurrent direct inserts of the same Claim-local sequence: exactly one survives, the other is refused')
  const foreignOnOwn = await attemptRolledBack((tx) => insertDecision(tx, { claimId: N.claimId, assessmentId: foreign!.assessmentId, sequence: 2 }))
  const ownOnForeign = await attemptRolledBack((tx) => insertDecision(tx, { claimId: foreign!.claimId, assessmentId: N.assessment.id, sequence: 2 }))
  check('T096', 'Cross-tenant abuse', /claim_review_decision_coherence/.test(foreignOnOwn) && /claim_review_decision_coherence/.test(ownOnForeign), "an own Claim with another tenant's assessment, and the reverse, are refused by the database")
  const approveNotReviewable = await attemptRolledBack((tx) => insertDecision(tx, { claimId: I.claimId, assessmentId: assessedI.id, decision: 'APPROVE', reviewer: B.id, fingerprint: assessedI.assemblyFingerprint }))
  const approveForeignFingerprint = await attemptRolledBack((tx) => insertDecision(tx, { claimId: N.claimId, assessmentId: N.assessment.id, decision: 'APPROVE', reviewer: B.id, sequence: 2, fingerprint: 'e'.repeat(64) }))
  check('T097', 'Direct approval guards', /only a REVIEWABLE draft assessment can be approved/.test(approveNotReviewable) && /the approval fingerprint is not the assessment's own/.test(approveForeignFingerprint), 'a direct APPROVE of an INCOMPLETE assessment, or with a fingerprint that is not its own, is refused')
  const revokeNonLatest = await attemptRolledBack((tx) => insertDecision(tx, { claimId: L.claimId, assessmentId: L.assessment.id, decision: 'REVOKE', reviewer: C.id, sequence: 3, target: firstApprovalL }))
  const revokeReturnDb = await attemptRolledBack((tx) => insertDecision(tx, { claimId: Rt.claimId, assessmentId: Rt.assessment.id, decision: 'REVOKE', reviewer: C.id, sequence: 2, target: returned.body?.decision?.id }))
  check('T098', 'Direct revocation guards', /a revocation must withdraw this claim's latest approval/.test(revokeNonLatest) && /a revocation must withdraw this claim's latest approval/.test(revokeReturnDb), 'a direct REVOKE of a superseded approval or of a RETURN is refused')
  const scanPaths = [`:/${REVIEW_DIR}`, `:/${FE_REVIEW_DIR}`]
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const logReach = gitGrep('admitDecision|ClaimReviewCheck', scanPaths)
  const secretScan = gitGrep("((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})", [`:/${HARNESS_DIR}`, ...scanPaths])
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [`:/${HARNESS_DIR}`])
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git(`show HEAD:${HARNESS_DIR}/a6-claim-review.integration.ts`)
  const hygiene = [
    [feCode.files.length === 1 && !/\b(localStorage|sessionStorage|indexedDB)\b/.test(feCode.code), 'browser storage in the check page'],
    [!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(feCode.code) && !/(===|!==|==)\s*'(APPROVED_CURRENT|NOT_APPROVED|APPROVAL_STALE|APPROVE|REVOKE)'/.test(feCode.code), 'the check page writes or decides authority'],
    [logReach.status === 0 && logScan.status === 1, 'console logging in A6.5 code'],
    [secretReach.status === 0 && secretScan.status === 1, 'a committed secret'],
    [harnessSource.length > 0 && harnessSource.match(realDataMarkers) === null, 'a real-data marker in the harness'],
    [!/req\.query/.test(reviewCode.code), 'a query string read in A6.5 routes'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check('T099', 'No browser truth, logging or secrets', hygiene.length === 0, hygiene.length === 0 ? 'the check page is read only and displays server authority; no browser storage, logging, secret, real-data marker or query parameter' : hygiene.join('; '))
  const fks = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = 'claim_review_events'`
  check('T100', 'RESTRICT foreign keys', fks.length === 4 && fks.every((fk) => fk.confdeltype === 'r'), `${fks.length} foreign keys (Claim, assessment, reviewer, revoked approval), all ON DELETE RESTRICT`)

  // ---------------------------------------------------------------- recomputed authority (T101–T110)
  section('Recomputed current authority, pricing and pointer changes, reproducible fingerprints and stable order')
  const Ra = await reviewable('recompute', { roles: ['PRIMARY', 'SECONDARY'] })
  const approvedRa = await decide(Ra.claimId, approveBody(Ra.assessment))
  const rowsBeforeRead = await prisma.claimReviewEvent.count()
  const readsRa = [await authority(Ra.claimId), await authority(Ra.claimId)]
  check(
    'T101',
    'Authority is recomputed',
    approvedRa.status === 201 && readsRa.every((res) => res.body?.state === 'APPROVED_CURRENT') && (await prisma.claimReviewEvent.count()) === rowsBeforeRead,
    'every authority read recomposes the A6.4 draft on one snapshot; nothing is stored or refreshed',
  )
  check('T102', 'Pricing change', (await stateOf(Q.claimId)) === 'APPROVAL_STALE' && (await stateOf(K4.claimId)) === 'APPROVED_CURRENT', 'a priced-source change stales the approval; a newer pricing run of the unchanged structure does not')
  await setPointers(Ra.lineIds[0], Ra.claimDiagnosisIds)
  const staleRa = await authority(Ra.claimId)
  check('T103', 'Pointer change', staleRa.body?.state === 'APPROVAL_STALE' && staleRa.body?.fingerprint === Ra.assessment.assemblyFingerprint, 'a pointer change after approval: APPROVAL_STALE, still naming the approved fingerprint')
  const previewW = await api('GET', `/api/claims/${W.claimId}/draft?pricingRunId=${W.pricing.id}`)
  check(
    'T104',
    'Reproducible fingerprint',
    previewW.body?.assemblyFingerprint === W.assessment.assemblyFingerprint && reassessedW.assemblyFingerprint === W.assessment.assemblyFingerprint && storedW.approvalFingerprint === W.assessment.assemblyFingerprint,
    'the approved fingerprint equals the A6.4 assessment, a fresh assessment and the live preview of the unchanged draft',
  )
  const historyIds = (historyW2.body?.items ?? []).map((d: any) => d.id)
  check('T105', 'Stable order', same((await history(W.claimId)).body?.items?.slice(0, 2).map((d: any) => d.id), historyIds) && same((await history(W.claimId)).body?.items?.map((d: any) => d.sequence), [1, 2, 3]), 'repeated history reads return the same sequence order, never UUID or time order')
  const repeated = [await authority(W.claimId), await authority(W.claimId)]
  check('T106', 'Deterministic authority', stripTime(repeated[0].body) === stripTime(repeated[1].body), 'repeated authority reads are identical apart from the evaluation instant')
  const auditsBefore107 = await reviewAudits()
  const rowsBefore107 = await prisma.claimReviewEvent.count()
  await history(W.claimId)
  await authority(W.claimId)
  await readDecision(approvalW)
  await authority(Ra.claimId, asViewer)
  check('T107', 'Reads write nothing', (await reviewAudits()) === auditsBefore107 && (await prisma.claimReviewEvent.count()) === rowsBefore107, 'history, authority and decision reads write no decision and no audit')
  const Rb = await reviewable('read during edit')
  await decide(Rb.claimId, approveBody(Rb.assessment))
  const hold8b = holdAt('claimLine.removed')
  const remove8b = removeClaimLine(Rb.lineIds[1], {}, creatorId)
  await Promise.race([hold8b.arrived, remove8b])
  const during = authority(Rb.claimId)
  const duringPrompt = await settledWithin(during, 5000)
  const duringBody = (await during).body
  hold8b.release()
  await remove8b
  clearConcurrencyProbes()
  check('T108', 'Read never mixes', duringPrompt && duringBody?.state === 'APPROVED_CURRENT' && (await stateOf(Rb.claimId)) === 'APPROVAL_STALE', 'an authority read during an uncommitted line removal answers at once from one committed snapshot; after the commit it is stale')
  const adminView = await authority(W.claimId)
  const viewerView = await authority(W.claimId, asViewer)
  check('T109', 'Admin and Viewer agree', stripTime(adminView.body) === stripTime(viewerView.body), 'the Viewer sees exactly the Admin authority (only the evaluation instant differs)')
  const violations = await prisma.$queryRaw<{ id: string }[]>`
    SELECT d.id::text AS id FROM claim_review_events d
    JOIN claim_draft_assessments a ON a.id = d.draft_assessment_id
    JOIN claims c ON c.id = d.claim_id
    WHERE d.created_at >= ${runStartedAt} AND d.claim_id <> ${N.claimId}::uuid
      AND (a.claim_id <> d.claim_id
        OR d.sequence <> (SELECT count(*) FROM claim_review_events e WHERE e.claim_id = d.claim_id AND e.sequence <= d.sequence)
        OR (d.decision_code = 'APPROVE' AND (a.outcome <> 'REVIEWABLE' OR a.assembly_fingerprint <> d.approval_fingerprint OR d.reviewer_user_id IN (c.created_by_user_id, a.created_by_user_id)))
        OR (d.decision_code = 'REVOKE' AND NOT EXISTS (SELECT 1 FROM claim_review_events t WHERE t.id = d.referenced_approval_id AND t.claim_id = d.claim_id AND t.decision_code = 'APPROVE' AND t.sequence = d.sequence - 1))
        OR (SELECT count(*) FROM audit_events v WHERE v.entity_id = d.id) <> 1)`
  check('T110', 'No split decision anywhere', violations.length === 0 && runDecisions.length >= 20, `every decision of this run (apart from the one direct-write collision fixture of T095) is coherent with its assessment and Claim, contiguous, separated, correctly targeted and audited once`)

  // ---------------------------------------------------------------- regressions (T111–T116)
  section('Regressions — A6.4 invoked, nesting A6.3 -> A6.2 -> A6.1 -> A5.10 -> A1')
  await apiReady('the A6.4 and backward regression chain')
  const chain = run('npm run test:a6:claim-draft')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A6.4')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.4] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.4 asserts facts about its own branch, its own migration, its own diff and its own upstream. On A6.5
  // those statements are obsolete by design; every other A6.4 check is substantive.
  const a64NonApplicable: Record<string, string> = {
    T001: "A6.4 'Start gate' requires the A6.4 feature branch and no A6.5+ code; A6.5 is branched from the main that contains A6.4 and adds the claim-review module",
    T004: "A6.4 'Migration scope' judges the single migration this branch adds against main; on A6.5 that is the A6.5 migration (T004 here)",
    T009: "A6.4 'Old contracts preserved' counts every migration path in this branch's diff except its own as a changed applied migration; A6.5 adds a new one and changes none (T009 here)",
    T010: "A6.4 'Diff scope' lists the paths A6.4 was allowed to change; A6.5 legitimately changes different ones (T010 here)",
    T120: "A6.4 'Exact head, repeatability, no leakage' requires the upstream to be the A6.4 feature branch, deleted when it merged (exact head and repeatability are T120 here)",
  }
  const undocumented = failing.filter((id) => !(id in a64NonApplicable))
  const counts = chain.output.match(/\[A6\.4\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T115') && !/\[A6\.4\] RUN ABORTED|\[A6\.4\] uncaught error/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check(
    'T111',
    'A6.4 regression',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A6.4 suite did not complete'
      : !reconciled
        ? `A6.4 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A6.4 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A6\.4\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.4] automated summary: ', 'A6.4 ')}; all ${failedCount} failure(s) named and accounted for`,
  )
  for (const id of Object.keys(a64NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A6.4 ${titleOf(row.line)}`, a64NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[A6.5]      ${text.slice(0, 400)}`)
  check('T112', 'A6.3 regression', verdictOf('T111') === 'PASS', `A6.4 T111 (A6.3 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A6.2 regression', verdictOf('T112') === 'PASS', `A6.4 T112 (A6.2) ${verdictOf('T112')}`)
  check('T114', 'A6.1 regression', verdictOf('T113') === 'PASS', `A6.4 T113 (A6.1) ${verdictOf('T113')}`)
  check('T115', 'A5 regression', verdictOf('T114') === 'PASS', `A6.4 T114 (A5.8, A5.9, A5.10) ${verdictOf('T114')}`)
  check('T116', 'A1–A4 regression', verdictOf('T115') === 'PASS', `A6.4 T115 (A1–A4) ${verdictOf('T115')}`)

  // ---------------------------------------------------------------- builds, DB integrity and DB truth (T117–T119)
  section('Build gates, database integrity and database truth')
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  check('T117', 'Unit tests and typecheck', unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok, `${(unitTests.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}; backend typecheck clean`)
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  const liveGuards = await prisma.$queryRaw<{ name: string }[]>`
    SELECT tgname::text AS name FROM pg_trigger WHERE tgrelid = 'claim_review_events'::regclass AND NOT tgisinternal
    UNION ALL SELECT conname::text FROM pg_constraint WHERE conrelid = 'claim_review_events'::regclass AND contype IN ('c', 'u', 'p')`
  const liveIndexes = await prisma.$queryRaw<{ name: string }[]>`SELECT indexname::text AS name FROM pg_indexes WHERE tablename = 'claim_review_events'`
  check(
    'T118',
    'Frontend, replay and DB integrity',
    build.ok && lint.ok && replay.ok &&
      ['claim_review_events_insert_guard_trg', 'claim_review_events_append_only_trg', 'claim_review_events_contract_version_chk', 'claim_review_events_decision_chk', 'claim_review_events_sequence_chk', 'claim_review_events_reason_chk', 'claim_review_events_shape_chk', 'claim_review_events_pkey'].every((name) => liveGuards.some((row) => row.name === name)) &&
      ['claim_review_events_claim_id_sequence_key', 'claim_review_events_referenced_approval_id_key'].every((name) => liveIndexes.some((row) => row.name === name)),
    `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean; replay clean; the live database holds both guards, five CHECKs and both unique keys`,
  )
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
    'backend/src/modules/claim-draft/claim-draft.service.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/errors/error.types.ts',
    'frontend/src/developer/checkRegistry.tsx',
  ]
  const ownDirs = [REVIEW_DIR, FE_REVIEW_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !file.includes('a6_5_human_review_submission_approval') && !allowed.includes(file))
  const laterDomain = changedPaths.filter((file) => /claim-payload|claim-submission|claim-transport|canonical|serializ|remittance|integration\/a9|nabidh|malaffi|riayati/i.test(file))
  check(
    'T010',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0 && narrowOwnerFix,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0 && narrowOwnerFix
      ? `${changedPaths.length} path(s): the A6.5 module, migration, harness and check page, the A6.4 composer export, vocabularies, the replay verifier and wiring; no other owner changed; no A6.6+ domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const transportTerms = /\b(dhpo|eclaimlink|soap|xml|x12|clearinghouse|nabidh|malaffi|riayati|fhir|hl7)\b/i
  const leakage = [
    [reached && !transportTerms.test(reviewCode.code + feCode.code), 'a transport, payload or HIE term in A6.5 code'],
    [reached && !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION|CURRENCY|MODE)\w*/i.test(reviewCode.code), 'a process-global market or jurisdiction switch'],
    [reached && !/\b(submitClaim|createSubmission|serializeClaim\w*|toXml|buildPayload|autoApprove\w*|bulkApprove\w*|approveAll\w*)\s*\(/.test(reviewCode.code), 'a submission, payload or automatic/bulk approval function'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  const priorDecisionsNow = JSON.stringify(await prisma.claimReviewEvent.findMany({ where: { createdAt: { lt: runStartedAt } }, orderBy: { id: 'asc' } }))
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T120',
    'Exact head, repeatability, no leakage',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a65Branch}`) && !/ahead|behind/.test(tracking) && priorDecisionsNow === priorDecisionsAtStart && leakage.length === 0,
    leakage.length > 0
      ? leakage.join('; ')
      : `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; ${JSON.parse(priorDecisionsNow).length} earlier decision(s) retained unchanged; no submission, payload, transport, HIE, global market mode or automatic approval`,
  )

  console.log(`\n[A6.5] run ${runId} — HEAD ${headSha}`)
  console.log(
    `[A6.5] worked example: Claim ${W.claimId}, assessment ${W.assessment.id} REVIEWABLE (fingerprint ${W.assessment.assemblyFingerprint}); APPROVE ${approvalW} -> APPROVED_CURRENT; REVOKE ${revokedW.body?.decision?.id} -> NOT_APPROVED; fresh APPROVE ${freshAfterRevoke.body?.decision?.id} -> ${adminView.body?.state}; edit -> stale (Claim ${L.claimId}); corrected assessment -> new APPROVE ${latestApprovalL}`,
  )
  if (failures.length > 0) {
    console.log(`[A6.5] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A6.5] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A6.5] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A6.5] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A6.5] HUMAN REVIEW / SUBMISSION APPROVAL ACCEPTANCE COMPLETE' : '[A6.5] A6.5 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A6.5] RUN ABORTED: ${error.message}`)
      console.log('[A6.5] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A6.5] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A6.5] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
