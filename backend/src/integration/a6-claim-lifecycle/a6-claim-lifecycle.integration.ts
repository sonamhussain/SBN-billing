import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { removeClaimLine } from '../../modules/claim-line/claim-line.service.ts'
import { recordReviewDecision } from '../../modules/claim-review/claim-review.service.ts'
import { getCurrentLifecycle, recordLifecycleEvent } from '../../modules/claim-lifecycle/claim-lifecycle.service.ts'

// A6.8 — focused acceptance for Claim Lifecycle State & Transition Governance (T001–T130).
//
// Every frozen submission is built through its owners, exactly as the A6.7 suite builds them: tariff world
// and rates through REF-01 and the A6.3 rate routes, runs through the A5.7 recorder, readiness through the
// A5.9 route, the Claim, lines, diagnoses and pointers through the A6.1/A6.2 routes, pricing through A6.3,
// the draft assessment through A6.4, the APPROVE through A6.5 by a separate synthetic Admin, and the freeze
// through the A6.7 route. Lifecycle events go through the A6.8 route (or, for barrier-controlled races and
// crash injection, its service in-process). ADVERSARIAL writes go in only to prove a database guard or the
// reducer's refusal of a corrupt history; every one of them runs in a transaction that is always rolled back.
// Synthetic Admins are provisioned per run through Better Auth's own server-side creation with a random
// password that is never printed. Every value is synthetic and keyed by this run's id.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A6.8] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A6.8] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A6.8] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A6.8] ${title}`)

// Every `npm run` prepends its node_modules/.bin directories to PATH again, so each level of the nested
// regression chain makes PATH longer; a spawned command therefore gets PATH without the .bin entries npm
// added on the way here (npm adds exactly those back for the command it runs).
const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
const childEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  [pathKey]: (process.env[pathKey] ?? '')
    .split(delimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$|[\\/]node-gyp-bin[\\/]?$/i.test(entry))
    .join(delimiter),
  ...extra,
})

function run(command: string, extra: Record<string, string> = {}): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), env: childEnv(extra), maxBuffer: 256 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const gitArgs = (args: string[]) => (spawnSync('git', args, { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const git = (args: string) => gitArgs(args.split(' '))
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

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

const runId = `A68-${Date.now()}`
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
const a66Branch = 'feature/a6-6-canonical-claim-payload'
const a67Branch = 'feature/a6-7-immutable-claim-submission-evidence'
const a68Branch = 'feature/a6-8-claim-lifecycle-transition-governance'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const LIFECYCLE_DIR = 'backend/src/modules/claim-lifecycle'
const FE_LIFECYCLE_DIR = 'frontend/src/modules/claim-lifecycle'
const HARNESS_DIR = 'backend/src/integration/a6-claim-lifecycle'
const MIGRATION = 'backend/prisma/migrations/20261018090000_a6_8_claim_lifecycle_transition_governance/migration.sql'
const REDUCER_TEST = `${LIFECYCLE_DIR}/claim-lifecycle.reducer.test.ts`
const TABLE = 'claim_freeze_lifecycle_events'
const REASONS = ['INTERNAL_DATA_REVIEW', 'INTERNAL_DOCUMENTATION_PENDING', 'INTERNAL_SUPERVISOR_DIRECTION', 'INTERNAL_CORRECTION_PENDING', 'INTERNAL_OTHER']
const EVENT_KEYS = ['id', 'submissionId', 'sequence', 'eventCode', 'reasonCode', 'actorUserId', 'lifecycleContractVersion', 'occurredAt', 'createdAt']
const STATE_KEYS = ['submissionId', 'lifecycleContractVersion', 'state', 'lastEventId', 'lastSequence', 'evaluatedAt']
const AUDIT_KEYS = ['eventId', 'submissionId', 'claimId', 'eventCode', 'reasonCode', 'sequence', 'lifecycleContractVersion', 'occurredAt']
const A68_COLUMNS = ['id', 'claim_submission_id', 'sequence', 'event_code', 'reason_code', 'actor_user_id', 'occurred_at', 'lifecycle_contract_version', 'created_at']
// The locked A6-LIFECYCLE-1 table, written out independently of the implementation.
const TABLE_EDGES: Record<string, string> = {
  'FROZEN PLACE_HOLD': 'HELD',
  'FROZEN AUTHORIZE_RELEASE': 'RELEASE_ELIGIBLE',
  'FROZEN WITHDRAW_INTERNAL': 'WITHDRAWN_INTERNAL',
  'HELD RELEASE_HOLD': 'FROZEN',
  'HELD WITHDRAW_INTERNAL': 'WITHDRAWN_INTERNAL',
  'RELEASE_ELIGIBLE PLACE_HOLD': 'HELD',
  'RELEASE_ELIGIBLE WITHDRAW_INTERNAL': 'WITHDRAWN_INTERNAL',
}
// The owners A6.8 consumes or must leave untouched. A change to any of them would be a change to an accepted
// contract.
const OWNER_DIRS = [
  'backend/src/modules/claim',
  'backend/src/modules/claim-line',
  'backend/src/modules/claim-diagnosis',
  'backend/src/modules/claim-pricing',
  'backend/src/modules/tariff-rate',
  'backend/src/modules/claim-draft',
  'backend/src/modules/claim-review',
  'backend/src/modules/claim-payload',
  'backend/src/modules/claim-submission',
  'backend/src/modules/claim-evidence',
  'backend/src/modules/pre-claim-readiness',
  'backend/src/modules/validation-run',
  'backend/src/modules/commercial-coverage',
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
const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// An independent harness-side replay of the locked table (never the module's reducer).
const replayTable = (codes: string[]) => {
  let state = 'FROZEN'
  for (const code of codes) {
    const next = TABLE_EDGES[`${state} ${code}`]
    if (!next) return null
    state = next
  }
  return state
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A6.8] A6.8 claim lifecycle state & transition governance — run ${runId}`)
  console.log(`[A6.8] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- gates (T001–T009)
  section('Start gate, the one A6.8 migration, contracts, permissions and wiring')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const merges = [a61Branch, a62Branch, a63Branch, a64Branch, a65Branch, a66Branch, a67Branch].map(mergeOf)
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /claim-correction|claim-supersession|claim-resubmission|claim-transport|claim-outbox|dhpo|eclaimlink|remittance/i.test(file))
  check(
    'T001',
    'Start gate',
    branch === a68Branch && merges.every((sha) => sha.length === 40) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A6.1–A6.7 merged as ${merges.map((sha) => sha.slice(0, 7) || 'NOT FOUND').join(', ')}; contains latest main ${git('rev-parse --short origin/main')}; no A6.9+/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check('T003', 'A6.1–A6.7 ancestry', merges.every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)), 'the seven accepted merge commits are ancestors of HEAD')
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma/migrations']).split(/\r?\n/).filter(Boolean)
  check(
    'T004',
    'Only the A6.8 migration',
    same(migrationStatus, [`A\t${MIGRATION}`]),
    migrationStatus.length === 1 ? `one added migration, no applied migration modified: ${MIGRATION.split('/').slice(-2, -1)[0]}` : `migration changes: ${migrationStatus.join(' | ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  const replayExpected = [
    /PASS {2}the A6\.8 tables are exactly claim_freeze_lifecycle_events/,
    /PASS {2}claim_freeze_lifecycle_events_insert_guard_trg is present after a clean replay/,
    /PASS {2}the A6\.8 CHECKs pin A6-LIFECYCLE-1/,
    /PASS {2}the A6\.7 tables are exactly claim_freezes and its evidence manifest and entry tables/,
    /PASS {2}the A6\.5 tables are exactly claim_review_events/,
    /PASS {2}the claim tables are exactly claims plus the four A6\.2 tables/,
  ]
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  const mainMigrationCount = git('ls-tree -d --name-only --full-tree origin/main backend/prisma/migrations/').split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line)).length
  check(
    'T006',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === mainMigrationCount + 1,
    `${appliedCount} migrations applied cleanly from empty — main's ${mainMigrationCount} plus the one A6.8 migration; every A6.2–A6.8 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^claimLifecycle/.test(code)).sort()
  const invented = allCodes.filter((code) => /(approve|approval|submit|transmit|signOff|claimSubmission|remittance|send|export|acknowledg|claim\w*\.(status|transition|release|withdraw|hold))/i.test(code))
  check(
    'T007',
    'Permissions',
    same(family, ['claimLifecycle.read', 'claimLifecycle.record']) &&
      (await grantsOf('claimLifecycle.record')) === 'ORG_ADMIN' &&
      (await grantsOf('claimLifecycle.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('claimFreeze.create')) === 'ORG_ADMIN' &&
      (await grantsOf('claimFreeze.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('claimFreezeEvidence.read')) === 'ORG_ADMIN' &&
      invented.length === 0,
    'record (Admin) and read (Admin, Viewer); A6.7 grants unchanged; no send, submit, export, status or per-transition permission',
  )

  await apiReady('signing in')
  let connectionResets = 0
  let serverErrors = 0
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
    if (res.status >= 500) serverErrors += 1
    return { status: res.status, body: res.body as any }
  }
  const post = (path: string, body: unknown, who: Who = asAdmin) => api('POST', path, body, who)
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  // Raw database text in a response body: SQL keywords, a stack frame, or a physical table/guard name (lower
  // case — the public error codes such as CLAIM_LIFECYCLE_CONFLICT are upper case and expected).
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat \w|prisma|SELECT|INSERT|constraint|trigger/i.test(text) || /claim_freeze|claim_lifecycle_[a-z]/.test(text)
  }
  const markerOf = (message: string) => (message.match(/claim_lifecycle_[a-z]+|[a-z_]+_chk|[a-z_]+_fkey|is append-only|duplicate key/) ?? [message.includes('ROLLED_BACK') ? 'ACCEPTED' : '?'])[0]

  // Synthetic Admins: Better Auth's own server-side user and credential creation, then an ORG_ADMIN
  // membership through the existing tables. The password is random per run and never printed.
  const authContext = await auth.$context
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' }, select: { id: true } })
  const provisionAdmin = async (label: string, organizationId = org) => {
    const email = `${runId.toLowerCase()}-${label}@reviewers.sbn.test`
    const secretValue = randomBytes(24).toString('base64url')
    const user = await authContext.internalAdapter.createUser({ email, name: `Synthetic admin ${label}`, emailVerified: false }, { method: 'email-password' })
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', issuer: 'local:credential', accountId: user.id, password: await authContext.password.hash(secretValue) })
    const membership = await prisma.organizationMembership.create({ data: { organizationId, userId: user.id } })
    await prisma.membershipRole.create({ data: { membershipId: membership.id, roleId: adminRole.id } })
    const signed = await signIn(email, secretValue)
    if (signed.status !== 200) throw new Error(`fixture admin ${label} could not sign in (${signed.status})`)
    return { id: user.id as string, who: as(signed.cookie) }
  }
  // B approves (separation of duties for A6.5) and records lifecycle events as a second actor; O is an
  // Admin of the OTHER organization.
  const B = await provisionAdmin('b')
  const O = await provisionAdmin('o', otherOrg)

  const eventsPath = (id: string) => `/api/claim-submissions/${id}/lifecycle-events`
  const statePath = (id: string) => `/api/claim-submissions/${id}/lifecycle`
  const record = (id: string, eventCode: string, reasonCode: string | null = eventCode === 'AUTHORIZE_RELEASE' ? null : 'INTERNAL_DATA_REVIEW', who: Who = asAdmin) =>
    post(eventsPath(id), { eventCode, reasonCode }, who)
  const stateOf = async (id: string, who: Who = asAdmin) => (await api('GET', statePath(id), undefined, who)).body
  const wiring = [
    await record(MISSING, 'PLACE_HOLD'),
    await api('GET', eventsPath(MISSING)),
    await api('GET', statePath(MISSING)),
  ]
  const absent = [
    await api('PATCH', statePath(MISSING), { state: 'HELD' }),
    await api('PUT', statePath(MISSING), { state: 'HELD' }),
    await api('POST', statePath(MISSING), { state: 'HELD' }),
    await api('DELETE', eventsPath(MISSING)),
    await api('PATCH', `${eventsPath(MISSING)}/${MISSING}`, {}),
    await api('DELETE', `${eventsPath(MISSING)}/${MISSING}`),
    await api('POST', `/api/claim-submissions/${MISSING}/send`, {}),
    await api('PUT', `/api/claim-submissions/${MISSING}/status`, {}),
    await api('POST', `/api/claim-submissions/${MISSING}/release`, {}),
  ]
  const unauthenticated = [await record(MISSING, 'PLACE_HOLD', 'INTERNAL_OTHER', anonymous), await api('GET', eventsPath(MISSING), undefined, anonymous), await api('GET', statePath(MISSING), undefined, anonymous)]
  check(
    'T008',
    'Route wiring',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && absent.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `three routes answer a missing submission with a privacy-safe 404; status PATCH/PUT/POST, event edits, send, release and status routes are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
  )

  const constantOf = (path: string, name: string) => (git(`show HEAD:${path}`).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-pricing/claim-pricing.types.ts', 'PRICING_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-draft/claim-draft.types.ts', 'DRAFT_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-review/claim-review.types.ts', 'REVIEW_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-payload/claim-payload.types.ts', 'PAYLOAD_SCHEMA_VERSION'),
    constantOf('backend/src/modules/claim-submission/claim-submission.types.ts', 'SUBMISSION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-evidence/claim-evidence.types.ts', 'EVIDENCE_MANIFEST_VERSION'),
  ]
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)))
  // The paths A6.8 may change (judged in T010 at the end, and used to prove the nested N/A causes).
  const allowed = [
    'backend/package.json',
    'backend/src/app.ts',
    'backend/prisma/schema.prisma',
    MIGRATION,
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/errors/error.types.ts',
    'backend/src/modules/audit/audit.types.ts',
    'frontend/src/developer/checkRegistry.tsx',
  ]
  const ownDirs = [LIFECYCLE_DIR, FE_LIFECYCLE_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const laterDomain = changedPaths.filter((file) => /claim-correction|claim-supersession|claim-resubmission|claim-transport|claim-outbox|remittance|integration\/a9|dhpo|eclaimlink|nabidh|malaffi|riayati/i.test(file))
  check(
    'T009',
    'Old contracts preserved',
    same(contracts, ['A6-CLAIM-1', 'A6-PRICE-1', 'A6-DRAFT-1', 'A6-REVIEW-1', 'A6-PAYLOAD-1', 'A6-SUBMISSION-1', 'A6-EVIDENCE-1']) && ownerChanged.length === 0,
    ownerChanged.length === 0 ? 'A6-CLAIM-1, A6-PRICE-1, A6-DRAFT-1, A6-REVIEW-1, A6-PAYLOAD-1, A6-SUBMISSION-1 and A6-EVIDENCE-1 unchanged; no A5/A6.1–A6.7 owner module changed' : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: frozen submissions')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: `${runId} service B` })).body)
  const procA = must('procedure A', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PA'), displayName: `${runId} procedure A`, codeSystem: 'SYNTHETIC', externalCode: key('XA') })).body)
  const dxA = must('diagnosis A', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DXA'), displayName: `${runId} diagnosis A` })).body)
  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const contract = must('contract', (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  must('contract facility', (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
  const schedule = must('schedule', (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
  const version = must('version', (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  const rate = (body: Record<string, unknown>) => post(`/api/tariff-schedule-versions/${version.id}/rates`, { modifierCodes: [], currencyCode: 'AED', ...body })
  must('rate A', (await rate({ selectorKind: 'PROCEDURE_CODE', procedureCodeId: procA.id, unitTariffAmount: '125.2500' })).body)
  must('rate B', (await rate({ selectorKind: 'SERVICE', serviceId: svcB.id, unitTariffAmount: '12.1250' })).body)
  if ((await post(`/api/tariff-schedule-versions/${version.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error('fixture: the tariff version could not be verified')

  const plainContext = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: payer.id as string | null, tpaId: null, networkId: null, insuranceProductId: null,
      providerContractId: contract.id as string | null, tariffScheduleId: schedule.id as string | null, tariffScheduleVersionId: version.id as string | null,
    }
  }
  const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
  // A frozen submission built through every owner: an Encounter with two activities and a diagnosis, one
  // READY run, its Claim with two lines and one PRIMARY diagnosis, a PRICED run, a REVIEWABLE assessment,
  // an APPROVE by B and the A6.7 freeze.
  const frozen = async (label: string) => {
    const encounter = must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body)
    const activityIds: string[] = []
    for (const activity of [{ procedureCodeId: procA.id, quantity: '1.5' }, { serviceId: svcB.id, quantity: '1' }]) activityIds.push(must(`${label} activity`, (await post(`/api/encounters/${encounter.id}/activities`, activity)).body).id)
    const encounterDiagnosisId = must(`${label} diagnosis`, (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body).id
    const contextSnapshot = await plainContext(encounter.id)
    const findings = [finding('WARNING', { layer: 'CODING' }), ...activityIds.map((encounterActivityId) => finding('PASS', { encounterActivityId })), finding('PASS', { layer: 'CODING', encounterDiagnosisId })]
    const recorded = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId: encounter.id, contextSnapshot, validatorVersion: 'A5-VAL-1', findings }, creatorId, tx))
    if (!recorded.ok) throw new Error(`fixture ${label}: a valid run was refused (${recorded.message})`)
    const readiness = await post(`/api/validation-runs/${recorded.value.id}/readiness-assessments`, {})
    if (readiness.status !== 201) throw new Error(`fixture ${label}: readiness refused with ${readiness.status}`)
    const claim = must(`${label} claim`, (await post(`/api/pre-claim-readiness-assessments/${readiness.body.id}/claims`, {})).body)
    const lineIds: string[] = []
    for (const activityId of activityIds) lineIds.push(must('line', (await post(`/api/claims/${claim.id}/lines`, { encounterActivityId: activityId })).body).id)
    const claimDiagnosisId = must('claim diagnosis', (await post(`/api/claims/${claim.id}/diagnoses`, { encounterDiagnosisId, roleCode: 'PRIMARY' })).body).id
    for (const lineId of lineIds)
      if ((await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds: [claimDiagnosisId] })).status !== 200) throw new Error(`fixture ${label}: pointers refused`)
    const pricing = await post(`/api/claims/${claim.id}/pricing-runs`, {})
    const assessment = await post(`/api/claims/${claim.id}/draft-assessments`, { pricingRunId: pricing.body?.id })
    if (assessment.body?.outcome !== 'REVIEWABLE') throw new Error(`fixture ${label}: expected a REVIEWABLE assessment, got ${assessment.status} ${assessment.body?.outcome}`)
    const approval = await post(`/api/claims/${claim.id}/review-decisions`, { draftAssessmentId: assessment.body.id, assemblyFingerprint: assessment.body.assemblyFingerprint, decisionCode: 'APPROVE' }, B.who)
    if (approval.status !== 201) throw new Error(`fixture ${label}: approval refused with ${approval.status}`)
    const freeze = await post(`/api/claims/${claim.id}/submissions`, { draftAssessmentId: assessment.body.id, approvalDecisionId: approval.body.decision.id })
    if (freeze.status !== 201) throw new Error(`fixture ${label}: the A6.7 freeze was refused with ${freeze.status} ${errorCode(freeze.body) ?? ''}`)
    return { id: freeze.body.submissionId as string, claimId: claim.id as string, lineIds, assessment: assessment.body as { id: string; assemblyFingerprint: string }, approvalId: approval.body.decision.id as string, freezeDto: freeze.body }
  }
  type Frozen = Awaited<ReturnType<typeof frozen>>

  const counts = async () => {
    const rows = await prisma.$queryRaw<{ t: string; n: bigint }[]>`
      SELECT 'events' AS t, count(*) AS n FROM claim_freeze_lifecycle_events UNION ALL SELECT 'lifecycle_audits', count(*) FROM audit_events WHERE action_code = 'claim_lifecycle.event_recorded'
      UNION ALL SELECT 'all_audits', count(*) FROM audit_events UNION ALL SELECT 'freezes', count(*) FROM claim_freezes UNION ALL SELECT 'decisions', count(*) FROM claim_review_events
      UNION ALL SELECT 'claims', count(*) FROM claims`
    // PostgreSQL may run the UNION ALL as a Parallel Append, so the row order is not guaranteed: the object
    // is always built in this fixed key order, so equal counts always compare equal.
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(['events', 'lifecycle_audits', 'all_audits', 'freezes', 'decisions', 'claims'].map((name) => [name, byName.get(name) as number])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const freezeHash = async (id: string) =>
    (
      await prisma.$queryRaw<{ h: string }[]>`SELECT encode(sha256(convert_to(
        (SELECT row_to_json(f)::text FROM claim_freezes f WHERE f.id = ${id}::uuid) ||
        (SELECT row_to_json(m)::text FROM claim_freeze_evidence_manifests m WHERE m.claim_submission_id = ${id}::uuid) ||
        (SELECT string_agg(row_to_json(e)::text, '|' ORDER BY e.ordinal) FROM claim_freeze_evidence_entries e JOIN claim_freeze_evidence_manifests m2 ON m2.id = e.evidence_package_id WHERE m2.claim_submission_id = ${id}::uuid) ||
        (SELECT row_to_json(r)::text FROM claim_review_events r JOIN claim_freezes f2 ON f2.approval_review_event_id = r.id WHERE f2.id = ${id}::uuid),
        'UTF8')), 'hex') AS h`
    )[0].h
  const NOT_REFUSED = 'ROLLED_BACK'
  const refusedBy = (message: string, marker: RegExp) => message !== '' && !message.includes(NOT_REFUSED) && marker.test(message)
  // A direct INSERT into the lifecycle table inside a transaction that is always rolled back.
  const directInsert = (submissionId: string, values: { sequence: number; eventCode: string; reasonCode: string | null; actor?: string; contract?: string; occurredAt?: boolean }) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, claim_submission_id, sequence, event_code, reason_code, actor_user_id, lifecycle_contract_version${values.occurredAt ? ', occurred_at' : ''})
           VALUES (gen_random_uuid(), $1::uuid, $2::int, $3, $4, $5::uuid, $6${values.occurredAt ? ", now() - interval '1 day'" : ''})`,
          submissionId,
          values.sequence,
          values.eventCode,
          values.reasonCode,
          values.actor ?? creatorId,
          values.contract ?? 'A6-LIFECYCLE-1',
        )
        throw new Error(NOT_REFUSED)
      }),
    )

  const W = await frozen('worked example')
  const U = await frozen('untouched')
  const FW = await frozen('frozen to withdrawn')
  const RW = await frozen('released to withdrawn')
  const X = await frozen('forbidden edges')
  const RS = await frozen('reasons')
  // DS only ever receives direct, rolled-back inserts: it stays FROZEN with no row for the whole run.
  const DS = await frozen('direct sql')
  console.log('[A6.8]      fixtures ready: patient, AE-DU/DHA facility profile, clinician, masters, a verified AED tariff world, two synthetic Admins (one of another organization) and seven frozen submissions')

  // ---------------------------------------------------------------- request, authentication, ownership (T011–T020)
  section('Request validation, authentication, tenant safety and permissions')
  const countsAtStart = await counts()
  const initialW = await api('GET', statePath(W.id))
  check(
    'T011',
    'Contract version',
    constantOf(`${LIFECYCLE_DIR}/claim-lifecycle.types.ts`, 'LIFECYCLE_CONTRACT_VERSION') === 'A6-LIFECYCLE-1' && initialW.status === 200 && initialW.body?.lifecycleContractVersion === 'A6-LIFECYCLE-1' && same(Object.keys(initialW.body ?? {}), STATE_KEYS),
    'A6-LIFECYCLE-1 in code and on the derived disposition, with exactly its six keys',
  )
  const unknownFields = [await post(eventsPath(W.id), { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER', note: 'x' }), await post(eventsPath(W.id), { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER', comment: 'x' })]
  check('T012', 'Strict body', unknownFields.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && /unknown field/.test(res.body?.error?.message ?? '')), 'an unknown field is refused by name: 400')
  const serverOwned = await Promise.all(
    ['actorUserId', 'sequence', 'status', 'state', 'occurredAt', 'destination', 'payer', 'externalReference', 'payloadDigest', 'idempotencyKey'].map((field) => post(eventsPath(W.id), { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER', [field]: 'x' })),
  )
  check('T013', 'Server-owned fields', serverOwned.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')), 'client actor, sequence, status, state, time, destination, payer, external reference, digest and idempotency key are refused by name')
  const shapes = [
    await post(eventsPath(W.id), { eventCode: 'PLACE_HOLD', reasonCode: null }),
    await post(eventsPath(W.id), { eventCode: 'PLACE_HOLD', reasonCode: 'please hold' }),
    await post(eventsPath(W.id), { eventCode: 'AUTHORIZE_RELEASE', reasonCode: 'INTERNAL_OTHER' }),
    await post(eventsPath(W.id), { eventCode: 'PLACE_HOLD' }),
    await post(eventsPath(W.id), { eventCode: 'place_hold', reasonCode: 'INTERNAL_OTHER' }),
    await post(eventsPath(W.id), { eventCode: 'SEND', reasonCode: 'INTERNAL_OTHER' }),
  ]
  check('T014', 'Controlled event and reason shape', shapes.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR'), 'a missing or free-text reason, a reason on AUTHORIZE_RELEASE, a missing key, a lowercase or unknown event code: 400')
  const malformed = [
    await post('/api/claim-submissions/not-a-uuid/lifecycle-events', { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER' }),
    await api('GET', '/api/claim-submissions/not-a-uuid/lifecycle-events'),
    await api('GET', '/api/claim-submissions/1234/lifecycle'),
    await post(eventsPath(W.id), []),
    await post(eventsPath(W.id), 'PLACE_HOLD'),
  ]
  // A bare JSON string is refused by the shared JSON parser (INVALID_JSON) before the route; everything else
  // by the route's own validation.
  check(
    'T015',
    'Malformed ids and bodies',
    malformed.every((res) => res.status === 400 && ['VALIDATION_ERROR', 'INVALID_JSON'].includes(errorCode(res.body) ?? '') && !rawError(res.body)),
    `malformed path ids, an array and a bare string body: ${malformed.map((r) => `${r.status} ${errorCode(r.body)}`).join(' / ')}; no raw database text`,
  )
  const anon = [await record(W.id, 'PLACE_HOLD', 'INTERNAL_OTHER', anonymous), await api('GET', eventsPath(W.id), undefined, anonymous), await api('GET', statePath(W.id), undefined, anonymous)]
  check('T016', 'Authentication', anon.every((res) => res.status === 401), 'every A6.8 route requires a session: 401 without one')
  const viewerPost = await record(W.id, 'PLACE_HOLD', 'INTERNAL_OTHER', asViewer)
  const viewerReads = [await api('GET', eventsPath(W.id), undefined, asViewer), await api('GET', statePath(W.id), undefined, asViewer)]
  check('T017', 'Viewer limits', viewerPost.status === 403 && errorCode(viewerPost.body) === 'FORBIDDEN' && viewerReads.every((res) => res.status === 200), 'a Viewer reads history and disposition (200) but cannot record an event (403)')
  const foreign = [await record(W.id, 'PLACE_HOLD', 'INTERNAL_OTHER', O.who), await api('GET', eventsPath(W.id), undefined, O.who), await api('GET', statePath(W.id), undefined, O.who)]
  const foreignMissing = await api('GET', statePath(MISSING), undefined, O.who)
  check(
    'T018',
    'Tenant safety',
    foreign.every((res) => res.status === 404) && same(foreign[2].body?.error?.message, foreignMissing.body?.error?.message),
    "an Admin of another organization gets 404 for this tenant's submission (record, history, disposition) — exactly like a missing one",
  )
  check('T019', 'Missing submission', wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && (await unchanged(countsAtStart)), 'a missing submission: 404 NOT_FOUND on every route, nothing written')
  const refusalsLeftNothing = await unchanged(countsAtStart)

  // ---------------------------------------------------------------- FROZEN baseline and allowed transitions (T021–T035)
  section('FROZEN baseline and every allowed A6-LIFECYCLE-1 transition')
  const rowsOf = async (id: string) => prisma.claimFreezeLifecycleEvent.count({ where: { claimFreezeId: id } })
  const historyOf = async (id: string) => (await api('GET', eventsPath(id))).body?.items ?? []
  const hashWBefore = await freezeHash(W.id)
  const freezeReadBefore = (await api('GET', `/api/claim-submissions/${W.id}`)).body
  const untouched = await stateOf(U.id)
  check(
    'T021',
    'FROZEN without a row',
    untouched.state === 'FROZEN' && untouched.lastEventId === null && untouched.lastSequence === 0 && (await historyOf(U.id)).length === 0 && (await rowsOf(U.id)) === 0,
    'an untouched freeze derives FROZEN (no last event, sequence 0) and has no lifecycle row at all',
  )
  const before22 = await counts()
  const e1 = await record(W.id, 'PLACE_HOLD', 'INTERNAL_DOCUMENTATION_PENDING')
  const after22 = await counts()
  check(
    'T022',
    'FROZEN → PLACE_HOLD → HELD',
    e1.status === 201 && e1.body.lifecycle.state === 'HELD' && e1.body.event.sequence === 1 && e1.body.event.reasonCode === 'INTERNAL_DOCUMENTATION_PENDING' && after22.events - before22.events === 1 && after22.lifecycle_audits - before22.lifecycle_audits === 1,
    '201, sequence 1, controlled reason stored, one event and one audit',
  )
  const e2 = await record(W.id, 'RELEASE_HOLD', 'INTERNAL_SUPERVISOR_DIRECTION')
  check('T023', 'HELD → RELEASE_HOLD → FROZEN', e2.status === 201 && e2.body.lifecycle.state === 'FROZEN' && e2.body.event.sequence === 2, 'releasing the hold returns to FROZEN at sequence 2; it does not authorize release')
  const e3 = await record(W.id, 'AUTHORIZE_RELEASE')
  check('T024', 'FROZEN → AUTHORIZE_RELEASE → RELEASE_ELIGIBLE', e3.status === 201 && e3.body.lifecycle.state === 'RELEASE_ELIGIBLE' && e3.body.event.sequence === 3 && e3.body.event.reasonCode === null, 'an explicit internal release decision with no reason, at sequence 3 — not a send')
  const hashWAfterScenario = await freezeHash(W.id)
  const e4 = await record(W.id, 'PLACE_HOLD', 'INTERNAL_CORRECTION_PENDING')
  check('T025', 'RELEASE_ELIGIBLE → PLACE_HOLD → HELD', e4.status === 201 && e4.body.lifecycle.state === 'HELD' && e4.body.event.sequence === 4, 'a hold cancels internal release eligibility (not the freeze)')
  const e5 = await record(W.id, 'WITHDRAW_INTERNAL', 'INTERNAL_OTHER')
  check('T026', 'HELD → WITHDRAW_INTERNAL', e5.status === 201 && e5.body.lifecycle.state === 'WITHDRAWN_INTERNAL' && e5.body.event.sequence === 5, 'a held freeze can be withdrawn internally')
  const fw = await record(FW.id, 'WITHDRAW_INTERNAL', 'INTERNAL_DATA_REVIEW')
  check('T027', 'FROZEN → WITHDRAW_INTERNAL', fw.status === 201 && fw.body.lifecycle.state === 'WITHDRAWN_INTERNAL' && fw.body.event.sequence === 1, 'an untouched freeze can be withdrawn directly')
  const rw1 = await record(RW.id, 'AUTHORIZE_RELEASE')
  const rw2 = await record(RW.id, 'WITHDRAW_INTERNAL', 'INTERNAL_SUPERVISOR_DIRECTION')
  check('T028', 'RELEASE_ELIGIBLE → WITHDRAW_INTERNAL', rw1.status === 201 && rw2.status === 201 && rw2.body.lifecycle.state === 'WITHDRAWN_INTERNAL', 'a release-eligible freeze can be withdrawn; no external send is inferred')
  check(
    'T029',
    'Response shape',
    same(Object.keys(e1.body), ['event', 'lifecycle']) && same(Object.keys(e1.body.event), EVENT_KEYS) && same(Object.keys(e1.body.lifecycle), STATE_KEYS) && e1.body.lifecycle.evaluatedAt === e1.body.event.occurredAt && e1.body.lifecycle.lastEventId === e1.body.event.id,
    'the event and the disposition after it; the disposition rests on that event at its database time',
  )
  const finalW = await stateOf(W.id)
  check('T030', 'Read after write', finalW.state === 'WITHDRAWN_INTERNAL' && finalW.lastEventId === e5.body.event.id && finalW.lastSequence === 5, 'the derived disposition read equals the last recorded result')
  const historyW = await historyOf(W.id)
  check(
    'T031',
    'Ordered history',
    same(historyW.map((e: any) => [e.sequence, e.eventCode]), [[1, 'PLACE_HOLD'], [2, 'RELEASE_HOLD'], [3, 'AUTHORIZE_RELEASE'], [4, 'PLACE_HOLD'], [5, 'WITHDRAW_INTERNAL']]) && historyW.every((e: any) => same(Object.keys(e), EVENT_KEYS)),
    'the history is every event in sequence order with exactly its nine keys',
  )
  check('T032', 'Worked scenario leaves the freeze intact', hashWAfterScenario === hashWBefore && (await freezeHash(W.id)) === hashWBefore, 'after hold, release hold and authorize release the canonical bytes, digest, evidence package, seal and APPROVE are byte-identical')
  const timesW = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT bool_and(occurred_at = created_at AND occurred_at <= now()) AS ok FROM claim_freeze_lifecycle_events WHERE claim_submission_id = ${W.id}::uuid`
  check('T033', 'Database time', timesW[0]?.ok === true && historyW.every((e: any, i: number) => i === 0 || e.occurredAt >= historyW[i - 1].occurredAt), 'every event carries the database transaction time; times never go backwards in sequence order')
  const reasonResults: number[] = []
  for (const [index, reason] of REASONS.entries()) reasonResults.push((await record(RS.id, index % 2 === 0 ? 'PLACE_HOLD' : 'RELEASE_HOLD', reason)).status)
  const storedReasons = (await historyOf(RS.id)).map((e: any) => e.reasonCode)
  check('T034', 'All five controlled reasons', reasonResults.every((code) => code === 201) && same(storedReasons, REASONS), 'each controlled reason code is accepted and stored exactly')
  check('T035', 'Independent streams', (await stateOf(U.id)).state === 'FROZEN' && fw.body.event.sequence === 1 && (await stateOf(RS.id)).state === 'HELD', "one freeze's events never change another's disposition; each stream starts at sequence 1")

  // ---------------------------------------------------------------- forbidden edges (T036–T050)
  section('Forbidden edges, terminal state, controlled reasons and duplicate refusals')
  const before36 = await counts()
  const refusedEdge = (res: { status: number; body: any }) => res.status === 409 && errorCode(res.body) === 'CLAIM_LIFECYCLE_TRANSITION_NOT_ALLOWED'
  const x1 = await record(X.id, 'RELEASE_HOLD', 'INTERNAL_OTHER')
  check('T036', 'FROZEN refuses RELEASE_HOLD', refusedEdge(x1), 'there is no hold to release: 409')
  // The second Admin records this hold: the actor is whoever is signed in.
  const xHold = await record(X.id, 'PLACE_HOLD', 'INTERNAL_OTHER', B.who)
  check('T020', 'Actor from the session', e1.body.event.actorUserId === creatorId && xHold.status === 201 && xHold.body.event.actorUserId === B.id, 'each event names the signed-in Admin who recorded it; no request field can name an actor')
  const x2 = await record(X.id, 'PLACE_HOLD', 'INTERNAL_OTHER')
  check('T037', 'HELD refuses a second hold', refusedEdge(x2), 'a duplicate PLACE_HOLD: 409, never a replayed 200')
  const x3 = await record(X.id, 'AUTHORIZE_RELEASE')
  check('T038', 'HELD refuses AUTHORIZE_RELEASE', refusedEdge(x3), 'a held freeze cannot be silently authorized: 409')
  await record(X.id, 'RELEASE_HOLD', 'INTERNAL_OTHER')
  await record(X.id, 'AUTHORIZE_RELEASE')
  const x4 = await record(X.id, 'AUTHORIZE_RELEASE')
  check('T039', 'RELEASE_ELIGIBLE refuses a repeat', refusedEdge(x4), 'AUTHORIZE_RELEASE while already release eligible: 409')
  const x5 = await record(X.id, 'RELEASE_HOLD', 'INTERNAL_OTHER')
  check('T040', 'RELEASE_ELIGIBLE refuses RELEASE_HOLD', refusedEdge(x5), 'there is no hold to release: 409')
  await record(X.id, 'WITHDRAW_INTERNAL', 'INTERNAL_OTHER')
  const terminal = [await record(X.id, 'PLACE_HOLD', 'INTERNAL_OTHER'), await record(X.id, 'RELEASE_HOLD', 'INTERNAL_OTHER'), await record(X.id, 'AUTHORIZE_RELEASE'), await record(X.id, 'WITHDRAW_INTERNAL', 'INTERNAL_OTHER')]
  check('T041', 'WITHDRAWN refuses PLACE_HOLD', refusedEdge(terminal[0]), 'no reopen after withdrawal: 409')
  check('T042', 'WITHDRAWN refuses RELEASE_HOLD', refusedEdge(terminal[1]), '409')
  check('T043', 'WITHDRAWN refuses AUTHORIZE_RELEASE', refusedEdge(terminal[2]), '409')
  check('T044', 'WITHDRAWN refuses a second withdrawal', refusedEdge(terminal[3]), 'terminal v1 internal disposition: 409')
  const after36 = await counts()
  check('T045', 'Refusals leave nothing', after36.events - before36.events === 4 && after36.lifecycle_audits - before36.lifecycle_audits === 4, 'across nine refused edges only the four legal events between them were written, each with one audit')
  const dup1 = await record(U.id, 'PLACE_HOLD', 'INTERNAL_OTHER')
  const dup2 = await record(U.id, 'PLACE_HOLD', 'INTERNAL_OTHER')
  check('T046', 'Same request twice', dup1.status === 201 && refusedEdge(dup2) && (await rowsOf(U.id)) === 1, 'the identical request a second time is a 409, not a replay: exactly one event')
  const distinctReasons = (await prisma.$queryRaw<{ shape: string }[]>`SELECT DISTINCT event_code || ':' || coalesce(reason_code, 'NULL') AS shape FROM claim_freeze_lifecycle_events`).map((row) => row.shape)
  check(
    'T047',
    'Only controlled reasons stored',
    distinctReasons.every((shape) => (shape.startsWith('AUTHORIZE_RELEASE:') ? shape === 'AUTHORIZE_RELEASE:NULL' : REASONS.includes(shape.split(':')[1]))),
    `${distinctReasons.length} event/reason shapes in the table, every one controlled`,
  )
  check('T048', 'Safe, deterministic refusals', [x1, x2, x3, x4, x5, ...terminal, dup2].every((res) => !rawError(res.body)) && same(terminal[0].body?.error?.code, terminal[1].body?.error?.code), 'refusals carry a code and a safe message; no SQL, constraint or trigger text')
  const unitRun = run(`node --test ${REDUCER_TEST.replace('backend/', '')}`)
  check('T049', 'All 16 pairs, table-driven', unitRun.ok && /ℹ pass 11/.test(unitRun.output) && /ℹ fail 0/.test(unitRun.output) && /✔ every one of the 16 state\/event pairs follows the locked table exactly/.test(unitRun.output), 'the reducer follows the locked table for all 16 state/event pairs (7 allowed, 9 refused) — and the 9 refusals were each proven live above')
  const finalX = await stateOf(X.id)
  check(
    'T050',
    'Terminal state holds',
    finalX.state === 'WITHDRAWN_INTERNAL' && finalX.lastSequence === 4 && same((await historyOf(X.id)).map((e: any) => e.eventCode), ['PLACE_HOLD', 'RELEASE_HOLD', 'AUTHORIZE_RELEASE', 'WITHDRAW_INTERNAL']),
    'after nine refused events the history is exactly the four legal ones and the disposition stays WITHDRAWN_INTERNAL',
  )

  // ---------------------------------------------------------------- direct SQL guards (T051–T065)
  section('Direct SQL: foreign keys, CHECKs, sequence, transition and immutability guards')
  const fkRows = await prisma.$queryRaw<{ name: string; del: string }[]>`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = ${TABLE}`
  check('T051', 'RESTRICT foreign keys', fkRows.length === 2 && fkRows.every((row) => row.del === 'r'), 'the submission and actor foreign keys are both ON DELETE RESTRICT')
  const controlInsert = await directInsert(U.id, { sequence: 2, eventCode: 'RELEASE_HOLD', reasonCode: 'INTERNAL_OTHER' })
  check('T052', 'Valid direct insert accepted', controlInsert.includes(NOT_REFUSED), 'a legal next event inserted directly is accepted (then rolled back): the refusals below are the guards, not the setup')
  check('T053', 'Illegal edge refused', refusedBy(await directInsert(U.id, { sequence: 2, eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }), /claim_lifecycle_transition/), 'a forged AUTHORIZE_RELEASE from HELD is refused by the database')
  check('T054', 'Sequence gap refused', refusedBy(await directInsert(U.id, { sequence: 5, eventCode: 'RELEASE_HOLD', reasonCode: 'INTERNAL_OTHER' }), /claim_lifecycle_sequence/), 'a sequence that is not the next one is refused')
  check('T055', 'Sequence reuse refused', refusedBy(await directInsert(U.id, { sequence: 1, eventCode: 'RELEASE_HOLD', reasonCode: 'INTERNAL_OTHER' }), /claim_lifecycle_sequence|duplicate key/), 'reusing an existing sequence is refused')
  check('T056', 'Client time refused', refusedBy(await directInsert(U.id, { sequence: 2, eventCode: 'RELEASE_HOLD', reasonCode: 'INTERNAL_OTHER', occurredAt: true }), /claim_lifecycle_time/), 'a supplied instant is refused: only database time')
  // The transition guard (BEFORE INSERT) runs before the CHECKs, so an unknown code is refused by whichever
  // database guard sees it first — never stored.
  check('T057', 'Unknown event refused', refusedBy(await directInsert(DS.id, { sequence: 1, eventCode: 'SEND', reasonCode: 'INTERNAL_OTHER' }), /event_code_chk|claim_lifecycle_transition/), 'an event outside the four codes is refused by the database')
  const badReasons = [
    await directInsert(U.id, { sequence: 2, eventCode: 'RELEASE_HOLD', reasonCode: 'free text' }),
    await directInsert(U.id, { sequence: 2, eventCode: 'RELEASE_HOLD', reasonCode: null }),
    await directInsert(DS.id, { sequence: 1, eventCode: 'AUTHORIZE_RELEASE', reasonCode: 'INTERNAL_OTHER' }),
  ]
  check('T058', 'Reason shape refused', badReasons.every((message) => refusedBy(message, /reason_chk/)), `a free-text reason, a missing reason, and a reason on AUTHORIZE_RELEASE are refused by CHECK (${badReasons.map(markerOf).join(', ')})`)
  check('T059', 'Other contract refused', refusedBy(await directInsert(U.id, { sequence: 2, eventCode: 'RELEASE_HOLD', reasonCode: 'INTERNAL_OTHER', contract: 'A6-LIFECYCLE-2' }), /contract_version_chk/), 'only A6-LIFECYCLE-1')
  check('T060', 'Missing submission refused', refusedBy(await directInsert(MISSING, { sequence: 1, eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER' }), /foreign key|claim_submission_id_fkey/), 'an event of a non-existent freeze is refused by the foreign key')
  check('T061', 'Missing actor refused', refusedBy(await directInsert(U.id, { sequence: 2, eventCode: 'RELEASE_HOLD', reasonCode: 'INTERNAL_OTHER', actor: MISSING }), /foreign key|actor_user_id_fkey/), 'an event by a non-existent user is refused by the foreign key')
  const updates = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = sequence WHERE claim_submission_id = $1::uuid`, W.id)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET reason_code = 'INTERNAL_OTHER' WHERE claim_submission_id = $1::uuid AND sequence = 1`, W.id)),
  ]
  check('T062', 'No update, even a no-op', updates.every((message) => /is append-only/.test(message)), 'UPDATE is refused, including an update that changes nothing')
  check('T063', 'No delete', /is append-only/.test(await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE claim_submission_id = $1::uuid`, W.id))), 'DELETE is refused')
  const freezeColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claim_freezes'`).map((row) => row.c)
  const lifecycleColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${TABLE}`).map((row) => row.c)
  check(
    'T064',
    'No state or pointer column',
    freezeColumns.length === 13 && !freezeColumns.some((c) => /state|status|lifecycle|latest|current/.test(c)) && lifecycleColumns.length === 9 && lifecycleColumns.every((c) => A68_COLUMNS.includes(c)),
    'claim_freezes keeps its 13 columns (no state or latest pointer); the lifecycle table has exactly its 9 columns and no state',
  )
  const terminalInsert = await directInsert(X.id, { sequence: 5, eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER' })
  check('T065', 'Terminal in the database', refusedBy(terminalInsert, /claim_lifecycle_transition/), `after WITHDRAWN_INTERNAL even a direct insert at the next sequence is refused (${markerOf(terminalInsert)})`)

  // ---------------------------------------------------------------- concurrency (T066–T080)
  section('Concurrency, Claim-lock ordering, isolation, atomic rollback and bounded retry')
  const serviceCode = committedCode(`${LIFECYCLE_DIR}/claim-lifecycle.service.ts`)
  const txBody = serviceCode.slice(serviceCode.indexOf('async (tx) => {'), serviceCode.indexOf('{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable'))
  check(
    'T066',
    'Claim lock first, SERIALIZABLE',
    /^async \(tx\) => \{\s*if \(!\(await lockRowForUpdateNowait\(tx, 'claims', owner\.claimId\)\)\)/.test(txBody) && /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && !/withReadSnapshot|prisma\./.test(txBody),
    'the Claim row lock (NOWAIT) is the first statement; every read and write uses the one SERIALIZABLE transaction client',
  )
  const C1 = await frozen('concurrent identical')
  const before67 = await counts()
  const pair = await Promise.all([record(C1.id, 'PLACE_HOLD', 'INTERNAL_OTHER'), record(C1.id, 'PLACE_HOLD', 'INTERNAL_OTHER')])
  const after67 = await counts()
  check(
    'T067',
    'Concurrent duplicates',
    same(pair.map((res) => res.status).sort(), [201, 409]) && after67.events - before67.events === 1 && after67.lifecycle_audits - before67.lifecycle_audits === 1,
    `two simultaneous identical holds: ${pair.map((res) => res.status).sort().join('/')}; exactly one event and one audit`,
  )
  const C2 = await frozen('concurrent different')
  const both = await Promise.all([record(C2.id, 'PLACE_HOLD', 'INTERNAL_OTHER'), record(C2.id, 'AUTHORIZE_RELEASE')])
  const historyC2 = (await historyOf(C2.id)).map((e: any) => e.eventCode)
  check(
    'T068',
    'Concurrent decisions serialize',
    replayTable(historyC2) !== null && historyC2.length === both.filter((res) => res.status === 201).length && (await stateOf(C2.id)).state === replayTable(historyC2),
    `a hold and a release decided at once: [${both.map((r) => r.status).join(', ')}], history ${historyC2.join(' → ')} — one legal serial order, never mixed`,
  )
  const L = await frozen('lock wait')
  const hold69 = holdAt('claimLifecycle.claim_locked')
  const first69 = recordLifecycleEvent(L.id, { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER' }, creatorId)
  await Promise.race([hold69.arrived, first69])
  const second69 = recordLifecycleEvent(L.id, { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER' }, B.id)
  const waited69 = !(await settledWithin(second69, 3000))
  hold69.release()
  const r69a = await first69
  const r69b = await second69
  clearConcurrencyProbes()
  check('T069', 'Second decision waits, then re-reads', waited69 && r69a.ok && !r69b.ok && r69b.code === 'CLAIM_LIFECYCLE_TRANSITION_NOT_ALLOWED', 'a second hold during the first one waits for the Claim lock, then sees HELD on a fresh snapshot: 409')
  const E = await frozen('line edit')
  const hold70 = holdAt('claimLine.removed')
  const removal = removeClaimLine(E.lineIds[1], {}, creatorId)
  await Promise.race([hold70.arrived, removal])
  const event70 = recordLifecycleEvent(E.id, { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_DATA_REVIEW' }, creatorId)
  const waited70 = !(await settledWithin(event70, 3000))
  hold70.release()
  const removed = await removal
  const r70 = await event70
  clearConcurrencyProbes()
  check('T070', 'Ordered after Claim writers', waited70 && removed.ok && r70.ok && r70.value.event.sequence === 1, 'a lifecycle event during an uncommitted A6.2 line edit waits for the shared Claim lock, then records')
  const R = await frozen('revocation')
  const hold71 = holdAt('claimReview.inserted')
  const revoke71 = recordReviewDecision(R.claimId, { draftAssessmentId: R.assessment.id, assemblyFingerprint: R.assessment.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: R.approvalId }, B.id)
  await Promise.race([hold71.arrived, revoke71])
  const event71 = recordLifecycleEvent(R.id, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }, creatorId)
  const waited71 = !(await settledWithin(event71, 3000))
  hold71.release()
  const revoked = await revoke71
  const r71 = await event71
  clearConcurrencyProbes()
  check(
    'T071',
    'Approval is not rechecked',
    waited71 && revoked.ok && r71.ok && r71.value.lifecycle.state === 'RELEASE_ELIGIBLE',
    'an event during an uncommitted A6.5 REVOKE waits for the Claim lock; afterwards it records — A6.8 neither re-derives nor extends approval, and the freeze is unchanged',
  )
  const K = await frozen('crash injection')
  const countsBeforeCrash = await counts()
  const crashAt = async (probe: string) => {
    clearConcurrencyProbes()
    setConcurrencyProbe(probe, async () => {
      throw new Error(`INJECTED_CRASH_AT_${probe}`)
    })
    const message = await attemptAdversarial(() => recordLifecycleEvent(K.id, { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER' }, creatorId))
    clearConcurrencyProbes()
    return { message, unchanged: await unchanged(countsBeforeCrash) }
  }
  const crash1 = await crashAt('claimLifecycle.inserted')
  const crash2 = await crashAt('claimLifecycle.audited')
  check('T072', 'Crash after the event', crash1.message.includes('INJECTED_CRASH') && crash1.unchanged, 'a failure after the event insert rolls back everything')
  check('T073', 'Crash after the audit', crash2.message.includes('INJECTED_CRASH') && crash2.unchanged, 'a failure after the audit, before commit, rolls back the event and the audit')
  const afterCrash = await record(K.id, 'PLACE_HOLD', 'INTERNAL_OTHER')
  check('T074', 'Retry after a crash', afterCrash.status === 201 && afterCrash.body.event.sequence === 1 && (await rowsOf(K.id)) === 1, 'the same decision after the failures records exactly once, at sequence 1')
  const I = await frozen('isolation')
  const hold75 = holdAt('claimLifecycle.inserted')
  const pending75 = recordLifecycleEvent(I.id, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }, creatorId)
  await Promise.race([hold75.arrived, pending75])
  const during75 = api('GET', statePath(I.id))
  const prompt75 = await settledWithin(during75, 5000)
  const duringState = (await during75).body?.state
  hold75.release()
  const r75 = await pending75
  clearConcurrencyProbes()
  check('T075', 'Reads see committed state only', prompt75 && duringState === 'FROZEN' && r75.ok && (await stateOf(I.id)).state === 'RELEASE_ELIGIBLE', 'a read during an uncommitted event answers at once from the committed state (FROZEN); after the commit it is RELEASE_ELIGIBLE')
  check(
    'T076',
    'Bounded retry',
    /const MAX_EVENT_ATTEMPTS = 3/.test(serviceCode) && /const MAX_LOCK_WAITS = 5/.test(serviceCode) && /P2034/.test(serviceCode) && /40001/.test(serviceCode) && /deadlock detected/.test(serviceCode),
    'serialization, deadlock and unique races retry at most three times on a fresh transaction; a busy Claim is waited for at most five times',
  )
  check(
    'T077',
    'Unknown outcome never re-appended',
    /if \(isUnknownOutcome\(error\)\)\s*return \{ ok: false, code: 'CLAIM_LIFECYCLE_CONFLICT'/.test(serviceCode) && !/isUnknownOutcome\(error\)\)\s*\{?\s*(attempt|continue)/.test(serviceCode),
    'a lost connection or transaction leaves the outcome unknown: a safe 409 telling the caller to read the history, never a blind second append',
  )
  const uniqueIndex = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_indexes WHERE tablename = ${TABLE} AND indexname = 'claim_freeze_lifecycle_events_claim_submission_id_sequence_key' AND indexdef ILIKE '%UNIQUE%'`
  check('T078', 'Unique race backstop', Number(uniqueIndex[0].n) === 1 && /isUniqueViolation\(error\)/.test(serviceCode), 'one (submission, sequence) unique key; a colliding writer is retried on a fresh read, never duplicated')
  const atomic = await prisma.$queryRaw<{ bad: bigint }[]>`
    SELECT count(*) AS bad FROM claim_freeze_lifecycle_events e
    WHERE (SELECT count(*) FROM audit_events a WHERE a.entity_id = e.id AND a.action_code = 'claim_lifecycle.event_recorded') <> 1`
  check('T079', 'Event and audit together', Number(atomic[0].bad) === 0, 'every lifecycle event in the database has exactly one audit event (none missing, none doubled)')
  const contiguous = await prisma.$queryRaw<{ bad: bigint }[]>`
    SELECT count(*) AS bad FROM (SELECT claim_submission_id, max(sequence) AS m, count(*) AS n, min(sequence) AS lo FROM claim_freeze_lifecycle_events GROUP BY claim_submission_id) s WHERE s.m <> s.n OR s.lo <> 1`
  check('T080', 'No gaps after the races', Number(contiguous[0].bad) === 0, 'every submission\'s sequences are exactly 1..N after concurrent, waiting and crashed decisions')

  // ---------------------------------------------------------------- reducer, replay and reads (T081–T095)
  section('Pure reducer determinism, history replay and safe read consistency')
  check('T081', 'Reducer unit tests', unitRun.ok && /ℹ fail 0/.test(unitRun.output), `${(unitRun.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}: allowed and forbidden edges, gaps, unknown codes, reason shapes, terminal state, determinism`)
  const twice = [await stateOf(RS.id), await stateOf(RS.id)]
  check('T082', 'Deterministic reads', twice[0].state === twice[1].state && twice[0].lastEventId === twice[1].lastEventId && twice[0].lastSequence === twice[1].lastSequence, 'the same history always derives the same disposition; only evaluatedAt moves')
  const replaySubjects = [W, U, FW, RW, X, RS, C1, C2, L, E, R, K, I]
  const replayed = await Promise.all(replaySubjects.map(async (subject) => ({ derived: (await stateOf(subject.id)).state, replayed: replayTable((await historyOf(subject.id)).map((e: any) => e.eventCode)) })))
  check('T083', 'History replay', replayed.every((row) => row.derived === row.replayed), `for ${replayed.length} submissions an independent replay of the locked table over the history equals the derived disposition`)
  const corruptRead = async (setup: (tx: any) => Promise<unknown>) => {
    let outcome = 'NOT_RUN'
    await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        await setup(tx)
        const result = await getCurrentLifecycle(RW.id, tx)
        outcome = result.ok ? `OK ${result.value.state}` : result.code
        throw new Error(NOT_REFUSED)
      }),
    )
    return outcome
  }
  const insertRaw = (tx: any, sequence: number, code: string, reason: string | null) =>
    tx.$executeRawUnsafe(`INSERT INTO ${TABLE} (id, claim_submission_id, sequence, event_code, reason_code, actor_user_id, lifecycle_contract_version) VALUES (gen_random_uuid(), $1::uuid, $2::int, $3, $4, $5::uuid, 'A6-LIFECYCLE-1')`, RW.id, sequence, code, reason, creatorId)
  const illegalHistory = await corruptRead((tx) => insertRaw(tx, 3, 'RELEASE_HOLD', 'INTERNAL_OTHER'))
  check('T084', 'Illegal history refused', illegalHistory === 'CLAIM_LIFECYCLE_CONFLICT', `an illegal edge written behind the guards (rolled back) is refused on read: ${illegalHistory}; never guessed`)
  const gapHistory = await corruptRead((tx) => insertRaw(tx, 7, 'PLACE_HOLD', 'INTERNAL_OTHER'))
  check('T085', 'Gap refused', gapHistory === 'CLAIM_LIFECYCLE_CONFLICT', `a sequence gap written behind the guards (rolled back): ${gapHistory}`)
  const reorderHistory = await corruptRead(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = sequence + 10 WHERE claim_submission_id = $1::uuid`, RW.id)
  })
  check('T086', 'Non-1..N history refused', reorderHistory === 'CLAIM_LIFECYCLE_CONFLICT', `a history that does not start at 1 (rolled back): ${reorderHistory}; no row is selected by id or time`)
  const before87 = await counts()
  for (const subject of [W, U, X]) {
    await api('GET', statePath(subject.id))
    await api('GET', eventsPath(subject.id))
  }
  const readsLeftNothing = await unchanged(before87)
  check('T087', 'Reads write nothing', readsLeftNothing, 'history and disposition reads write no row and no audit')
  const dbNow = (await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now.getTime()
  const evaluated = await stateOf(W.id)
  check('T088', 'Evaluated at database time', Math.abs(new Date(evaluated.evaluatedAt).getTime() - dbNow) < 60_000 && evaluated.evaluatedAt >= historyW.at(-1).occurredAt, 'evaluatedAt is the database time of the read, after the last event')
  const historyRS = await historyOf(RS.id)
  const stateRS = await stateOf(RS.id)
  check('T089', 'History and disposition agree', stateRS.lastSequence === historyRS.length && stateRS.lastEventId === historyRS.at(-1).id, 'the disposition rests on exactly the last event of the history')
  const inTx = await withReadSnapshot(undefined, (tx) => getCurrentLifecycle(W.id, tx))
  check('T090', 'Transaction-aware read', inTx.ok && inTx.value.state === finalW.state && inTx.value.lastEventId === finalW.lastEventId, 'getCurrentLifecycle(submissionId, tx) for later owners equals the HTTP read')
  const reducerCode = committedCode(`${LIFECYCLE_DIR}/claim-lifecycle.reducer.ts`)
  const repositoryCode = committedCode(`${LIFECYCLE_DIR}/claim-lifecycle.repository.ts`)
  check('T091', 'Never by id or time', !/\.sort\(|Date|createdAt|occurredAt|\bid\b/.test(reducerCode) && /orderBy: \{ sequence: 'asc' \}/.test(repositoryCode), 'the reducer reads only sequence, code, reason and contract; history is ordered by sequence alone')
  const viewerState = await stateOf(W.id, asViewer)
  check('T092', 'Viewer sees the same', viewerState.state === finalW.state && viewerState.lastEventId === finalW.lastEventId, 'a Viewer reads exactly the disposition an Admin reads')
  const eventHash = async () => (await prisma.$queryRaw<{ h: string }[]>`SELECT encode(sha256(convert_to(string_agg(row_to_json(e)::text, '|' ORDER BY e.sequence), 'UTF8')), 'hex') AS h FROM claim_freeze_lifecycle_events e WHERE claim_submission_id = ${W.id}::uuid`)[0].h
  const eventsWAt = await eventHash()
  const freezeReadAfter = (await api('GET', `/api/claim-submissions/${W.id}`)).body
  check('T095', 'A6.7 reads unchanged', same(freezeReadAfter, freezeReadBefore) && same(freezeReadBefore, W.freezeDto), 'the A6.7 frozen submission read is identical before and after five lifecycle events')

  // ---------------------------------------------------------------- audit (T096–T105)
  section('Audit exactly once, none on refusals or reads, metadata only')
  const auditsW = await prisma.auditEvent.findMany({ where: { actionCode: 'claim_lifecycle.event_recorded', entityId: { in: historyW.map((e: any) => e.id) } } })
  check('T096', 'Exactly one audit per event', auditsW.length === historyW.length && new Set(auditsW.map((a) => a.entityId)).size === historyW.length, `${auditsW.length} audits for ${historyW.length} events, one each`)
  const firstAudit = auditsW.find((a) => a.entityId === e1.body.event.id)
  check('T097', 'Action, entity and actor', !!firstAudit && firstAudit.entityType === 'CLAIM_LIFECYCLE_EVENT' && firstAudit.actorUserId === creatorId && firstAudit.beforeState === null, 'claim_lifecycle.event_recorded on CLAIM_LIFECYCLE_EVENT, entity = the event, actor = the signed-in user')
  check('T098', 'Metadata keys', !!firstAudit && same(Object.keys(firstAudit.afterState as object).sort(), [...AUDIT_KEYS].sort()), 'exactly ids, event and reason code, sequence, contract and time')
  check(
    'T099',
    'No audit on refusals',
    after36.lifecycle_audits - before36.lifecycle_audits === 4 && crash1.unchanged && crash2.unchanged && after67.lifecycle_audits - before67.lifecycle_audits === 1,
    'the nine refused edges, the losing concurrent duplicate and the crashed attempts left no audit (T045, T067, T072–T073)',
  )
  check('T100', 'No audit on reads', readsLeftNothing && refusalsLeftNothing, 'reads and request refusals wrote no row and no audit (T019, T087)')
  const exposed = JSON.stringify([e1.body, historyW, finalW, auditsW.map((a) => a.afterState)])
  check(
    'T101',
    'PHI minimization',
    !exposed.includes(`${runId}-P`) && !exposed.includes('1990-01-01') && !exposed.includes(key('DXA')) && !/200\.0|125\.25|12\.125|[0-9a-f]{64}/.test(exposed),
    'no patient name, birth date, diagnosis code, amount or digest in any DTO or audit',
  )
  check('T102', 'No freeze bytes or manifest', ![...deepKeys(JSON.parse(exposed))].some((k) => /bytes|manifest|payload|seal|sha/i.test(k)), 'lifecycle responses and audits carry no payload bytes, manifest, seal or digest')
  check('T103', 'Audit organization', !!firstAudit && firstAudit.organizationId === org, "the audit belongs to the submission's organization")
  check('T104', 'Audit time is the event time', !!firstAudit && (firstAudit.afterState as any).occurredAt === e1.body.event.occurredAt && (firstAudit.afterState as any).sequence === 1, 'the audit records the event at its database time and sequence')
  check('T105', 'Safe error bodies', [...shapes, ...malformed, viewerPost, ...foreign, x1, dup2].every((res) => !rawError(res.body)), 'every refusal carries a code and a safe message only')

  // ---------------------------------------------------------------- boundaries (T106–T110)
  section('No transport, send, outbox or acknowledgement; no writes to A6.7 frozen tables')
  const production = committedProductionCodeOf([LIFECYCLE_DIR])
  check('T106', 'No transport', !/from 'node:(http|https|net|tls|dgram)'|fetch\(|axios|undici|<\?xml|x12|hl7|fhir|outbox|queue|enqueue/i.test(production.code), 'no network client, XML/X12/HL7/FHIR, outbox or queue in A6.8 code')
  const insertTargets = [...repositoryCode.matchAll(/INSERT INTO "([a-z_]+)"/g)].map((match) => match[1])
  check(
    'T107',
    'No writes to frozen tables',
    same(insertTargets, [TABLE]) && !/\b(tx|db|prisma)\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(production.code) && !/\bUPDATE "|DELETE FROM/.test(production.code),
    'the only write is the append-only lifecycle insert (and the shared audit); claim_freezes, its package, entries and the approval are never written',
  )
  const claimColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims'`).map((row) => row.c)
  check('T108', 'No status anywhere new', claimColumns.length === 7 && freezeColumns.length === 13, 'claims keeps its 7 columns and claim_freezes its 13: no status, state or latest pointer was added anywhere')
  const queueTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(outbox|queue|job|transmission|acknowledg|remittance|successor|supersed|correction)'`).map((row) => row.t)
  const lifecycleTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~ 'lifecycle' AND table_name ~ '^claim'`).map((row) => row.t)
  check('T109', 'No queue, successor or second table', queueTables.length === 0 && same(lifecycleTables, [TABLE]), 'exactly one claim lifecycle table; no outbox, queue, job, transmission, acknowledgement or successor/correction table')
  const typesCode = committedCode(`${LIFECYCLE_DIR}/claim-lifecycle.types.ts`)
  const frontend = committedCode(`${FE_LIFECYCLE_DIR}/ClaimLifecycleCheck.tsx`)
  check(
    'T110',
    'Internal states only',
    !/'(SUBMITTED|SENT|RECEIVED|ACCEPTED|REJECTED|ADJUDICATED|PAID|ACKNOWLEDGED)'/.test(typesCode) && frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|console\.|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend),
    'no payer-style state exists; the Developer Tools page only reads and keeps nothing in browser storage',
  )

  // ---------------------------------------------------------------- regressions (T111–T120)
  section('Regressions — A6.7 invoked, nesting A6.6 -> A6.5 -> A6.4 -> A6.3 -> A6.2 -> A6.1 -> A5.10 -> A1')
  await apiReady('the A6.7 and backward regression chain')
  const chain = run('npm run test:a6:claim-submission')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A6.7')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.7] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.7 asserts facts about its own branch, its own migration and schema diff, its own diff scope, the
  // absence of A6.8 code and tables, and its own upstream. On A6.8 those statements are obsolete by design;
  // every other A6.7 check is substantive. T120 below proves each cause independently, never from the id.
  const a67NonApplicable: Record<string, string> = {
    T001: "A6.7 'Start gate' requires the A6.7 feature branch and no A6.8+ code; A6.8 is branched from the main that contains A6.7 and adds the claim-lifecycle module",
    T004: "A6.7 'Only the A6.7 migration' judges its own branch's migration; A6.8 adds exactly one different migration (T004 here)",
    T010: "A6.7 'Diff scope' lists the paths A6.7 was allowed to change; A6.8 legitimately changes different ones (T010 here)",
    T105: "A6.7 'Additive schema only' pins its own branch's three models; A6.8's diff adds exactly one model and no removal (T120 here)",
    T107: "A6.7 'No A6.8/A9/A7 code' is the A6.7→A6.8 phase boundary itself; on A6.8 the only such module is A6.8's own claim-lifecycle (T120 here)",
    T109: "A6.7 'No queue or job table' also pins exactly three claim_freeze* tables; the fourth is A6.8's own lifecycle table and no queue/job table exists (T109/T120 here)",
    T120: "A6.7 'Nested N/A causes proven' proves A6.6's causes against the A6.7 branch (its migration, diff and upstream); on A6.8 those proofs are re-done here (T120)",
    T130: "A6.7 'Exact head, repeatability, evidence' requires the upstream to be the A6.7 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a67NonApplicable))
  const summary = chain.output.match(/\[A6\.7\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A6\.7\] RUN ABORTED|\[A6\.7\] uncaught error/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOf = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  check(
    'T111',
    'A6.7 regression',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A6.7 suite did not complete'
      : !reconciled
        ? `A6.7 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A6.7 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A6\.7\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.7] automated summary: ', 'A6.7 ')}; all ${failedCount} failure(s) named and accounted for`,
  )
  for (const id of Object.keys(a67NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A6.7 ${titleOf(row.line)}`, a67NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[A6.8]      ${text.slice(0, 400)}`)
  check('T112', 'A6.6 regression', verdictOf('T111') === 'PASS', `A6.7 T111 (A6.6 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A6.5 regression', verdictOf('T112') === 'PASS', `A6.7 T112 (A6.5) ${verdictOf('T112')}`)
  check('T114', 'A6.4 regression', verdictOf('T113') === 'PASS', `A6.7 T113 (A6.4) ${verdictOf('T113')}`)
  check('T115', 'A6.3 regression', verdictOf('T114') === 'PASS', `A6.7 T114 (A6.3) ${verdictOf('T114')}`)
  check('T116', 'A6.2 regression', verdictOf('T115') === 'PASS', `A6.7 T115 (A6.2) ${verdictOf('T115')}`)
  check('T117', 'A6.1 regression', verdictOf('T116') === 'PASS', `A6.7 T116 (A6.1) ${verdictOf('T116')}`)
  check('T118', 'A5 and A1–A4 regression', verdictOf('T117') === 'PASS', `A6.7 T117 (A5.8–A5.10 and A1–A4 through A6.6) ${verdictOf('T117')}`)
  const a67Substantive = rows.filter((row) => !(row.id in a67NonApplicable) && row.verdict !== 'PASS' && !row.id.includes('/'))
  check('T119', 'A6.7 substantive checks', ran && a67Substantive.length === 0 && rows.filter((row) => row.verdict === 'PASS').length >= 120 && verdictOf('T118') === 'PASS' && verdictOf('T119') === 'PASS', `${rows.filter((row) => row.verdict === 'PASS').length} A6.7 checks PASS — freeze, guards, crash, races, vectors and read-back — with no substantive FAIL`)
  // Each documented A6.7 failure must fail for its branch-only reason, proved independently on this branch.
  const schemaDiff = gitArgs(['diff', 'origin/main...HEAD', '--', ':/backend/prisma/schema.prisma']).split(/\r?\n/)
  const schemaRemoved = schemaDiff.filter((line) => /^-[^-]/.test(line))
  const schemaModels = schemaDiff.filter((line) => /^\+model /.test(line)).map((line) => line.replace(/^\+model (\w+).*/, '$1'))
  const a67LaterDirs = git('ls-tree -d --name-only --full-tree HEAD backend/src/modules/').split(/\r?\n/).filter((dir) => /lifecycle|transport|outbox|remittance|dhpo|eclaimlink|adapter/i.test(dir))
  const a67LaterFiles = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter((file) => /claim-lifecycle|submission-lifecycle|claim-transport|claim-outbox|dhpo|eclaimlink|remittance/i.test(file))
  const freezeLikeTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'claim\\_freeze%' ORDER BY table_name`).map((row) => row.t)
  const a67Unexpected = (lineOf('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const isA68Change = (file: string, index: number) => changedPaths.includes(file) || (index === a67Unexpected.length - 1 && changedPaths.some((path) => path.startsWith(file)))
  const unprovenA66 = (lineOf('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  const causes: Record<string, boolean> = {
    T001: a67LaterFiles.length > 0 && a67LaterFiles.every((file) => file.startsWith(`${LIFECYCLE_DIR}/`) || file.startsWith(`${FE_LIFECYCLE_DIR}/`) || file.startsWith(`${HARNESS_DIR}/`)),
    T004: same(migrationStatus, [`A\t${MIGRATION}`]),
    T010: a67Unexpected.length > 0 && a67Unexpected.every(isA68Change) && outOfScope.length === 0,
    T105: schemaRemoved.length === 0 && same(schemaModels, ['ClaimFreezeLifecycleEvent']),
    T107: same(a67LaterDirs, [LIFECYCLE_DIR]) && a67LaterFiles.every((file) => ownDirs.some((dir) => file.startsWith(`${dir}/`))),
    T109: queueTables.length === 0 && same(freezeLikeTables, ['claim_freeze_evidence_entries', 'claim_freeze_evidence_manifests', 'claim_freeze_lifecycle_events', 'claim_freezes']),
    // A6.7 re-proves A6.6's branch-only causes against the A6.7 branch; on A6.8 only those tied to the
    // branch (start gate files, migration, diff scope, upstream) can be unproven — re-proved here.
    T120: unprovenA66.length > 0 && unprovenA66.every((id) => ['T001', 'T004', 'T010', 'T120'].includes(id)) && same(migrationStatus, [`A\t${MIGRATION}`]) && outOfScope.length === 0 && tracking.includes(`origin/${a68Branch}`),
    T130: tracking.includes(`origin/${a68Branch}`) && !/origin\/feature\/a6-7/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  check('T120', 'Nested N/A causes proven', ran && unproven.length === 0, unproven.length === 0 ? `each documented A6.7 failure (${failing.join(', ') || 'none'}) fails only for its branch-only reason, proved independently on this branch` : `cause not proven for: ${unproven.join(', ')}`)

  // ---------------------------------------------------------------- builds, replay and DB truth (T121–T130)
  section('Units, typecheck, frontend, Prisma/replay, DB outage recovery, exact head')
  const allUnit = run('npm run test:unit')
  check('T121', 'Unit tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the A6.8 reducer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Typecheck', typecheck.ok, 'backend typecheck clean')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const appliedChecksum = (await prisma.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM _prisma_migrations WHERE migration_name = '20261018090000_a6_8_claim_lifecycle_transition_governance' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.checksum
  const fileChecksum = sha256Of(readFileSync(`../${MIGRATION}`))
  check('T125', 'Prisma and replay', replay.ok && status.ok && appliedChecksum === fileChecksum, `the A6.8 migration is applied with the checksum of the committed file (${fileChecksum.slice(0, 12)}…); replay clean`)
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
  check('T126', 'DB outage recovery', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')
  await waitFor(databaseUp, 60_000)
  const afterOutage = await stateOf(W.id)
  check('T093', 'History immutable to the end', (await eventHash()) === eventsWAt && afterOutage.lastEventId === finalW.lastEventId, 'after every later test and a database restart the worked history is byte-identical')
  const finalDS = await stateOf(DS.id)
  check(
    'T094',
    'No default row ever',
    finalDS.state === 'FROZEN' && finalDS.lastEventId === null && (await rowsOf(DS.id)) === 0 && (await rowsOf(U.id)) === 1 && (await stateOf(FW.id)).lastSequence === 1,
    'a freeze that only ever saw refused or rolled-back writes and many reads is still FROZEN with no row; rows exist only for explicit, accepted events',
  )
  check('T127', 'No unexpected 5xx', serverErrors === 0 && afterOutage.state === 'WITHDRAWN_INTERNAL', `${serverErrors} HTTP 5xx answers in this run; the disposition reads back after the restart`)
  const runSubmissions = new Set(replaySubjects.map((subject) => subject.id))
  const runEvents = await prisma.claimFreezeLifecycleEvent.findMany({ where: { createdAt: { gte: new Date(e1.body.event.createdAt) } }, select: { claimFreezeId: true } })
  check('T128', 'Synthetic data only', runEvents.length > 0 && runEvents.every((row) => runSubmissions.has(row.claimFreezeId)), `${runEvents.length} lifecycle events in this run, every one on a synthetic freeze built by this run (names keyed by ${runId})`)
  console.log(`[A6.8]      worked example: Claim ${W.claimId} -> submission ${W.id}: FROZEN -> PLACE_HOLD(INTERNAL_DOCUMENTATION_PENDING) -> RELEASE_HOLD(INTERNAL_SUPERVISOR_DIRECTION) -> AUTHORIZE_RELEASE -> PLACE_HOLD -> WITHDRAW_INTERNAL`)
  console.log(`[A6.8]      freeze ${W.id} digest ${W.freezeDto.payloadSha256}, seal ${W.freezeDto.evidencePackage.packageSealSha256} — byte-identical before and after`)
  check('T129', 'Worked example evidence', replayTable(historyW.map((e: any) => e.eventCode)) === 'WITHDRAWN_INTERNAL' && hashWAfterScenario === hashWBefore && (await freezeHash(W.id)) === hashWBefore, 'the printed worked example is re-derived from its history; the frozen record is unchanged')

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  check(
    'T010',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A6.8 module, migration and model, harness and check page, two permissions, two error codes, one audit action and wiring; no owner changed; no A6.9/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  check(
    'T130',
    'Exact head, repeatability, evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a68Branch}`) && !/ahead|behind/.test(tracking) && afterOutage.lastEventId === finalW.lastEventId,
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; after the database restart the worked disposition reads back identically`,
  )

  console.log(`\n[A6.8] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A6.8] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A6.8] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A6.8] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A6.8] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A6.8] CLAIM LIFECYCLE STATE / TRANSITION GOVERNANCE ACCEPTANCE COMPLETE' : '[A6.8] A6.8 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A6.8] RUN ABORTED: ${error.message}`)
      console.log('[A6.8] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A6.8] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A6.8] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
