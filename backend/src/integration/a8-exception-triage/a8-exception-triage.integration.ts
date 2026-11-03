import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordExceptionIntake } from '../../modules/exception-intake/exception-intake.service.ts'
import { deriveTriageDisposition } from '../../modules/exception-triage/exception-triage.reducer.ts'
import { getTriageDispositionOf, getTriageHistoryOf, recordTriageEvent } from '../../modules/exception-triage/exception-triage.service.ts'
import { TRIAGE_CONTRACT_VERSION, returnReasonCodes, triageCategoryCodes, triageEventCodes, triagePriorityCodes } from '../../modules/exception-triage/exception-triage.types.ts'

// A8.2 — focused acceptance for Exception Triage & Assignment Event History (A8-EXCEPTION-TRIAGE-1, T001–T130).
//
// Every Claim, freeze, source, case, assessment and A8.1 intake is built through its owners exactly as the A8.1 suite
// builds them: a Claim frozen twice without an A6.9 link is a genuine history contradiction, and its intake is recorded
// through the A8.1 route. Every triage event is recorded through the A8.2 route or, where a probe must pause or fail one
// writer, through the production A8.2 service in this process. Direct SQL writes are adversarial only, run against the
// live guards (or, to isolate one CHECK, with the triggers off), and are ALWAYS rolled back; a broken stored history is
// planted only inside such a transaction and the production read answers on THAT transaction. Synthetic users are
// provisioned per run through Better Auth's own server-side creation with a random password that is never printed.

const TAG = 'A8.2'
let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []
const printed: string[] = []

const say = (line: string) => {
  printed.push(line)
  console.log(line)
}

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    say(`[${TAG}] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    say(`[${TAG}] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  say(`[${TAG}] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => say(`\n[${TAG}] ${title}`)
const progress = (text: string) => say(`[${TAG}]      ${text}`)

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
const committedText = (path: string) => git(`show HEAD:${path}`)
const committedCode = (path: string) =>
  committedText(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
const committedProductionCodeOf = (dirs: string[]) => {
  const files = dirs.flatMap((dir) => committedFiles(dir)).filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `A82-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a82Branch = 'feature/a8-2-exception-triage'
const a81Branch = 'feature/a8-1-exception-intake'
const a81FixBranch = 'fix/a8-1-harness-later-phase-recognition'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
const UPSTREAM_BRANCHES = [
  'feature/a6-10-a6-integration-acceptance', 'feature/a7-1-revenue-source-evidence', 'feature/a7-2-evidence-classification', 'feature/a7-3-adjudication-evidence-readiness',
  'feature/a7-4-revenue-evidence-case-assembly', 'feature/a7-5-case-closure-prerequisite-assessment', 'feature/a7-6-closure-basis-trace', 'feature/a7-7-revenue-evidence-timeline', a78Branch, a79Branch, a710Branch, a81Branch,
]
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/exception-triage'
const FE_DIR = 'frontend/src/modules/exception-triage'
const HARNESS_DIR = 'backend/src/integration/a8-exception-triage'
const REGISTER_DOC = 'docs/A8_Exception_Triage.md'
const MIGRATION_NAME = '20261031090000_a8_2_exception_triage'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const TABLE = 'exception_triage_events'
const INTAKE_TABLE = 'exception_intake_records'
const UNIT_TESTS = [`${MODULE_DIR}/exception-triage.reducer.test.ts`, `${MODULE_DIR}/exception-triage.validation.test.ts`]
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const CONTRACT = 'A8-EXCEPTION-TRIAGE-1'
const TIMELINE_CONTRACT = 'A7-REVENUE-TIMELINE-1'
const EVENT_KEYS = ['triageEventId', 'contractVersion', 'exceptionIntakeId', 'organizationId', 'claimId', 'sequence', 'eventCode', 'categoryCode', 'priorityCode', 'assignedMemberId', 'reasonCode', 'recordedByUserId', 'recordedAt']
const HISTORY_KEYS = ['contractVersion', 'exceptionIntakeId', 'items', 'evaluatedAt']
const DISPOSITION_KEYS = ['contractVersion', 'exceptionIntakeId', 'dispositionCode', 'categoryCode', 'priorityCode', 'assignedMemberId', 'assigneeCurrentlyEligible', 'eventCount', 'lastSequence', 'evaluatedAt']
const COLUMNS = ['id', 'exception_intake_id', 'organization_id', 'claim_id', 'contract_version', 'sequence', 'event_code', 'category_code', 'priority_code', 'assigned_member_id', 'reason_code', 'recorded_by_user_id', 'recorded_at', 'created_at']
const APPROVAL_LINE = 'CONDITIONAL ARCHITECTURE APPROVAL — 2026-11-01'
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/shared/authorization/authorization.types.ts',
  'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'backend/src/modules/audit/audit.types.ts', 'frontend/src/developer/checkRegistry.tsx', REGISTER_DOC,
]
// Every table a triage write could conceivably touch, in a fixed key order. A read or a refusal must leave every one as
// it was; a recorded event adds exactly one row here and one audit.
const COUNT_TABLES = [TABLE, INTAKE_TABLE, 'audit_events', 'claims', 'claim_freezes', 'claim_freeze_lifecycle_events', 'claim_correction_links', 'organization_memberships', 'membership_roles']

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

// A probe that fails every time it is reached (it re-arms itself), counting how often a writer reached it.
function failEveryTime(probe: string, message: string) {
  clearConcurrencyProbes()
  const state = { reached: 0 }
  const handler = async () => {
    state.reached += 1
    setConcurrencyProbe(probe, handler)
    throw new Error(message)
  }
  setConcurrencyProbe(probe, handler)
  return state
}

// A probe that fails exactly once.
function failOnce(probe: string, message: string) {
  clearConcurrencyProbes()
  const state = { reached: 0 }
  setConcurrencyProbe(probe, async () => {
    state.reached += 1
    throw new Error(message)
  })
  return state
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
const withoutEvaluatedAt = (body: unknown) => JSON.stringify(body, (k, v) => (k === 'evaluatedAt' || k === 'requestId' ? undefined : v))

// The disposition replayed by THIS suite, independently of the module's reducer, from a history's items.
type HistoryItem = { sequence: number; eventCode: string; categoryCode: string | null; priorityCode: string | null; assignedMemberId: string | null }
function replayIndependently(items: HistoryItem[]) {
  let dispositionCode = 'UNTRIAGED'
  let categoryCode: string | null = null
  let priorityCode: string | null = null
  let assignedMemberId: string | null = null
  for (const item of items) {
    if (item.eventCode === 'TRIAGE_CLASSIFY') [dispositionCode, categoryCode, priorityCode, assignedMemberId] = ['TRIAGED', item.categoryCode, item.priorityCode, null]
    else if (item.eventCode === 'ASSIGN_OWNER' || item.eventCode === 'REASSIGN_OWNER') [dispositionCode, assignedMemberId] = ['ASSIGNED', item.assignedMemberId]
    else if (item.eventCode === 'RETURN_TO_TRIAGE') [dispositionCode, assignedMemberId] = ['TRIAGED', null]
  }
  return { dispositionCode, categoryCode, priorityCode, assignedMemberId, eventCount: items.length, lastSequence: items.length > 0 ? items[items.length - 1].sequence : null }
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] A8.2 exception triage & assignment event history (${CONTRACT}) — run ${runId}`)
  say(`[${TAG}] HEAD ${headAtStart} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- preflight and allowed scope (T001–T010)
  section('Preflight and allowed scope: the accepted A8.1 merge, ancestry, one additive migration, Prisma, replay, the narrow permissions, three routes, earlier contracts, diff scope')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a81Merge = mergeOf(a81Branch)
  const a81FixMerge = mergeOf(a81FixBranch)
  const a710Merge = mergeOf(a710Branch)
  const upstreamMerges = UPSTREAM_BRANCHES.map((name) => ({ name, sha: mergeOf(name) }))
  check(
    'T001',
    'A8.1 accepted merge ancestor',
    branch === a82Branch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && a81FixMerge.length === 40 && gitOk(`merge-base --is-ancestor ${a81FixMerge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; A8.1 merged as ${a81Merge.slice(0, 7) || 'NOT FOUND'} and its harness correction as ${a81FixMerge.slice(0, 7) || 'NOT FOUND'}, both ancestors; latest main ${git('rev-parse --short origin/main')} contained; not stacked`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean tree and origin parity', dirty.length === 0 && tracking.includes(`origin/${a82Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'A6.10/A7.1–A7.10/A8.1 ancestry',
    upstreamMerges.every((m) => m.sha.length === 40 && gitOk(`merge-base --is-ancestor ${m.sha} HEAD`)),
    `A6.10, A7.1–A7.10 and A8.1 merges (${upstreamMerges.map((m) => m.sha.slice(0, 7)).join(', ')}) are all ancestors of HEAD`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  // A8.2's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge added
  // (the same values, literally, on its own branch). A later package's changes are that package's to prove.
  const ownMerge = branch === a82Branch ? '' : mergeOf(a82Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'
  const ownTip = ownMerge || 'HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = migrationDirsAt(ownTip)
  const ownBaseMigrationDirs = migrationDirsAt(ownBase)
  check(
    'T004',
    'Exactly one A8.2 additive migration',
    same(ownPrismaStatus, [`A\t${MIGRATION}`, 'M\tbackend/prisma/schema.prisma']) && ownHeadMigrationDirs.length === ownBaseMigrationDirs.length + 1 && ownBaseMigrationDirs.every((dir) => ownHeadMigrationDirs.includes(dir)) && ownHeadMigrationDirs[ownHeadMigrationDirs.length - 1].endsWith(MIGRATION_NAME),
    `exactly one migration added (${MIGRATION_NAME}, the newest in its own scope) and the schema extended; all ${ownBaseMigrationDirs.length} applied migrations before it untouched`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma validate, generate and status', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'the schema validates and generates; the working database is up to date with every migration (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check(
    'T006',
    'Clean scratch database migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && /PASS {2}the A8\.2 tables are exactly exception_triage_events/.test(replay.output) &&
      /PASS {2}exception_triage_events_insert_guard_trg is present/.test(replay.output) && /PASS {2}one triage event per \(intake, sequence\) is unique/.test(replay.output) && /PASS {2}the A8\.2 CHECKs pin A8-EXCEPTION-TRIAGE-1/.test(replay.output),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD; every A8.2 CHECK, unique index, trigger and RESTRICT key survives`,
  )
  const catalogueAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/authorization/authorization.types.ts`]).matchAll(/^\s+'([A-Za-z_]+\.[A-Za-z_]+)',/gm)].map((m) => m[1])
  const catalogueHead = catalogueAt(ownTip)
  const catalogueMain = catalogueAt(ownBase)
  const laterPermissions = ownMerge ? catalogueAt('HEAD').filter((c) => !catalogueHead.includes(c)) : []
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  check(
    'T007',
    'Narrow versioned permissions',
    same(catalogueHead.filter((c) => !catalogueMain.includes(c)).sort(), ['exceptionTriage.read', 'exceptionTriage.record']) && catalogueMain.every((c) => catalogueHead.includes(c)) &&
      same(allCodes.filter((c) => /^exceptionTriage\./.test(c)).sort(), ['exceptionTriage.read', 'exceptionTriage.record']) && (await grantsOf('exceptionTriage.record')) === 'ORG_ADMIN' && (await grantsOf('exceptionTriage.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('exceptionIntake.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      !allCodes.some((c) => /^exception/i.test(c) && !['exceptionIntake.create', 'exceptionIntake.read', 'exceptionTriage.read', 'exceptionTriage.record'].includes(c) && !laterPermissions.includes(c)),
    'the catalogue adds exactly exceptionTriage.record (Admin) and exceptionTriage.read (Admin, Viewer); the A8.1 parent read is unchanged; no permission removed; no other exception permission (investigate, resolve, escalate, close or export) exists',
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
  const get = (path: string, who: Who = asAdmin) => api('GET', path, undefined, who)
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const errorMessage = (body: any) => (body?.error?.message ?? '') as string
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  // Raw database text in a response body: SQL keywords, a stack frame or a physical table or guard name.
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /exception_triage_|exception_intake_|claim_freeze|organization_memberships/.test(text)
  }

  // Synthetic users: Better Auth's own server-side user and credential creation, then a membership (with the ORG_ADMIN
  // role, or with no role at all). The password is random per run and never printed.
  const authContext = await auth.$context
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' }, select: { id: true } })
  const provisionMember = async (label: string, organizationId = org, withRole = true) => {
    const email = `${runId.toLowerCase()}-${label}@reviewers.sbn.test`
    const secretValue = randomBytes(24).toString('base64url')
    const user = await authContext.internalAdapter.createUser({ email, name: `Synthetic member ${label}`, emailVerified: false }, { method: 'email-password' })
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', issuer: 'local:credential', accountId: user.id, password: await authContext.password.hash(secretValue) })
    const membership = await prisma.organizationMembership.create({ data: { organizationId, userId: user.id } })
    if (withRole) await prisma.membershipRole.create({ data: { membershipId: membership.id, roleId: adminRole.id } })
    const signed = await signIn(email, secretValue)
    if (signed.status !== 200) throw new Error(`fixture member ${label} could not sign in (${signed.status})`)
    return { id: user.id as string, membershipId: membership.id as string, who: as(signed.cookie), cookie: signed.cookie }
  }
  // B approves home freezes; M1–M4 are eligible Admins (M1 is the worked scenario's first owner whose role is later
  // removed, M3 an actor whose role is revoked); NR is a member without any role; O and O2 belong to the other tenant.
  const B = await provisionMember('b')
  const M1 = await provisionMember('m1')
  const M2 = await provisionMember('m2')
  const M3 = await provisionMember('m3')
  const M4 = await provisionMember('m4')
  const NR = await provisionMember('norole', org, false)
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)
  const viewerMembership = (await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId: org, user: { email: viewerEmail } }, select: { id: true } })).id
  const adminMembership = (await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId: org, userId: creatorId }, select: { id: true } })).id

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: two organizations; Claims frozen twice without a link and their A8.1 intakes; a normal linked Claim with evidence, case and assessment')
  const tenantWorld = async (label: string, organizationId: string, who: Who, actorId: string, approver: Who) => {
    const at = (path: string, body: unknown) => post(path, body, who)
    const patient = must(`${label} patient`, (await at(`/api/organizations/${organizationId}/patients`, { givenName: 'Synthetic', familyName: `${runId}-${label}-P`, dateOfBirth: '1990-01-01' })).body)
    const facility = must(`${label} facility`, (await at(`/api/organizations/${organizationId}/facilities`, { name: `${runId} ${label} facility` })).body)
    const profile = must(`${label} profile`, (await at(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    if ((await at(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error(`fixture ${label} profile activation failed`)
    const clinician = must(`${label} clinician`, (await at(`/api/organizations/${organizationId}/clinicians`, { displayName: `${runId} ${label} clinician` })).body)
    must(`${label} assignment`, (await at(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    const svcB = must(`${label} service`, (await at(`/api/organizations/${organizationId}/services`, { internalCode: key(`${label}-SB`), displayName: `${runId} ${label} service B` })).body)
    const procA = must(`${label} procedure`, (await at(`/api/organizations/${organizationId}/procedure-codes`, { internalCode: key(`${label}-PA`), displayName: `${runId} ${label} procedure A`, codeSystem: 'SYNTHETIC', externalCode: key(`${label}-XA`) })).body)
    const dxA = must(`${label} diagnosis`, (await at(`/api/organizations/${organizationId}/diagnosis-codes`, { code: key(`${label}-DXA`), displayName: `${runId} ${label} diagnosis A` })).body)
    const payer = must(`${label} payer`, (await at(`/api/organizations/${organizationId}/payers`, { displayName: `${runId} ${label} payer` })).body)
    const contract = must(`${label} contract`, (await at(`/api/organizations/${organizationId}/provider-contracts`, { contractKey: key(`${label}-C`), displayName: `${runId} ${label} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    must(`${label} contract facility`, (await at(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
    const schedule = must(`${label} schedule`, (await at(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key(`${label}-T`), displayName: `${runId} ${label} tariff` })).body)
    const version = must(`${label} version`, (await at(`/api/tariff-schedules/${schedule.id}/versions`, { version: key(`${label}-V`), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
    const rate = (body: Record<string, unknown>) => at(`/api/tariff-schedule-versions/${version.id}/rates`, { modifierCodes: [], currencyCode: 'AED', ...body })
    must(`${label} rate A`, (await rate({ selectorKind: 'PROCEDURE_CODE', procedureCodeId: procA.id, unitTariffAmount: '125.2500' })).body)
    must(`${label} rate B`, (await rate({ selectorKind: 'SERVICE', serviceId: svcB.id, unitTariffAmount: '12.1250' })).body)
    if ((await at(`/api/tariff-schedule-versions/${version.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error(`fixture ${label}: the tariff version could not be verified`)
    const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
    type Assessed = { id: string; assemblyFingerprint: string }
    const assessDraft = async (claimId: string, pricingRunId: string) => {
      const res = await at(`/api/claims/${claimId}/draft-assessments`, { pricingRunId })
      if (res.status !== 201 || res.body?.outcome !== 'REVIEWABLE') throw new Error(`fixture ${label}: expected a REVIEWABLE assessment, got ${res.status} ${res.body?.outcome}`)
      return res.body as Assessed
    }
    const approve = async (claimId: string, assessment: Assessed) => {
      const res = await post(`/api/claims/${claimId}/review-decisions`, { draftAssessmentId: assessment.id, assemblyFingerprint: assessment.assemblyFingerprint, decisionCode: 'APPROVE' }, approver)
      if (res.status !== 201) throw new Error(`fixture ${label}: approval refused with ${res.status}`)
      return res.body.decision.id as string
    }
    const revoke = async (claimId: string, assessment: Assessed, approvalId: string) => {
      const res = await post(`/api/claims/${claimId}/review-decisions`, { draftAssessmentId: assessment.id, assemblyFingerprint: assessment.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: approvalId }, approver)
      if (res.status !== 201) throw new Error(`fixture ${label}: revocation refused with ${res.status}`)
    }
    const freezeNow = async (claimId: string, assessment: Assessed, approvalId: string) => {
      const res = await at(`/api/claims/${claimId}/submissions`, { draftAssessmentId: assessment.id, approvalDecisionId: approvalId })
      if (res.status !== 201) throw new Error(`fixture ${label}: the A6.7 freeze was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
      return res.body.submissionId as string
    }
    // A Claim with `count` lawfully frozen submissions: each later one after revoking the current approval, on a NEW
    // draft assessment with its own new approval.
    const series = async (name: string, count: number) => {
      const encounter = must(name, (await at(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body)
      const activityIds: string[] = []
      for (const activity of [{ procedureCodeId: procA.id, quantity: '1.5' }, { serviceId: svcB.id, quantity: '1' }]) activityIds.push(must(`${name} activity`, (await at(`/api/encounters/${encounter.id}/activities`, activity)).body).id)
      const encounterDiagnosisId = must(`${name} diagnosis`, (await at(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body).id
      const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
      const contextSnapshot = {
        serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
        insuranceMembershipId: null, payerId: payer.id as string | null, tpaId: null, networkId: null, insuranceProductId: null,
        providerContractId: contract.id as string | null, tariffScheduleId: schedule.id as string | null, tariffScheduleVersionId: version.id as string | null,
      }
      const findings = [finding('WARNING', { layer: 'CODING' }), ...activityIds.map((encounterActivityId) => finding('PASS', { encounterActivityId })), finding('PASS', { layer: 'CODING', encounterDiagnosisId })]
      const recorded = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId: encounter.id, contextSnapshot, validatorVersion: 'A5-VAL-1', findings }, actorId, tx))
      if (!recorded.ok) throw new Error(`fixture ${name}: a valid run was refused (${recorded.message})`)
      const readiness = await at(`/api/validation-runs/${recorded.value.id}/readiness-assessments`, {})
      if (readiness.status !== 201) throw new Error(`fixture ${name}: readiness refused with ${readiness.status}`)
      const claim = must(`${name} claim`, (await at(`/api/pre-claim-readiness-assessments/${readiness.body.id}/claims`, {})).body)
      const lineIds: string[] = []
      for (const activityId of activityIds) lineIds.push(must('line', (await at(`/api/claims/${claim.id}/lines`, { encounterActivityId: activityId })).body).id)
      const claimDiagnosisId = must('claim diagnosis', (await at(`/api/claims/${claim.id}/diagnoses`, { encounterDiagnosisId, roleCode: 'PRIMARY' })).body).id
      for (const lineId of lineIds)
        if ((await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds: [claimDiagnosisId] }, who)).status !== 200) throw new Error(`fixture ${name}: pointers refused`)
      const pricing = await at(`/api/claims/${claim.id}/pricing-runs`, {})
      const freezes: string[] = []
      let assessment: Assessed | null = null
      let approvalId: string | null = null
      for (let i = 0; i < count; i += 1) {
        if (assessment && approvalId) await revoke(claim.id, assessment, approvalId)
        assessment = await assessDraft(claim.id, pricing.body.id)
        approvalId = await approve(claim.id, assessment)
        freezes.push(await freezeNow(claim.id, assessment, approvalId))
      }
      return { claimId: claim.id as string, freezes }
    }
    return { series }
  }
  const home = await tenantWorld('home', org, asAdmin, creatorId, B.who)
  const away = await tenantWorld('away', otherOrg, O.who, O.id, O2.who)
  const runToken = runId.replace(/^A82-/, '')
  const ref = (suffix: string) => `SYN-${runToken}-${suffix}`.toUpperCase()
  const linkedSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref(suffix) }, who)
    if (res.status !== 201) throw new Error(`fixture source ${suffix} could not be registered through A7.1: ${res.status} ${errorCode(res.body) ?? ''}`)
    const E = res.body.revenueSourceEvidenceId as string
    const Cl = (await post(`/api/revenue-source-evidence/${E}/classifications`, {}, who)).body.classificationId as string
    const R = (await post(`/api/revenue-evidence-classifications/${Cl}/adjudication-readiness`, {}, who)).body.readinessId as string
    if (!Cl || !R) throw new Error(`fixture ${suffix}: classification or readiness refused`)
    return E
  }
  const caseOf = async (submissionId: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-evidence-cases`, {}, who)
    if (res.status !== 201) throw new Error(`fixture case could not be assembled through A7.4: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { caseId: string; assemblyCode: string }
  }
  const assessmentOf = async (caseId: string, who: Who = asAdmin) => {
    const res = await post(`/api/revenue-evidence-cases/${caseId}/closure-prerequisite-assessments`, {}, who)
    if (res.status !== 201) throw new Error(`fixture assessment could not be recorded through A7.5: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { assessmentId: string; assessmentCode: string }
  }
  const timelineBody = (claimId: string) => ({ sourceKind: 'REVENUE_TIMELINE', sourceRecordId: claimId, sourceContractVersion: TIMELINE_CONTRACT, exceptionReasonCode: 'PROVENANCE_CONFLICT' })
  type Intake = { label: string; claimId: string; intakeId: string; organizationId: string; freezes: string[] }
  // A Claim frozen twice with no A6.9 link (a genuine contradiction the A7.7 owner refuses) and its A8.1 intake,
  // recorded through the A8.1 route.
  const intakeFor = async (label: string, world = home, who: Who = asAdmin): Promise<Intake> => {
    const claim = await world.series(label, 2)
    const res = await post(`/api/claims/${claim.claimId}/exception-intake`, timelineBody(claim.claimId), who)
    if (res.status !== 201) throw new Error(`fixture ${label}: the A8.1 intake was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return { label, claimId: claim.claimId, intakeId: res.body.exceptionIntakeId, organizationId: res.body.organizationId, freezes: claim.freezes }
  }
  // W — the worked scenario (§9) and the golden history; its first freeze also carries an A7.1 source, an A7.4 case and
  // an A7.5 assessment so every owner record of the Claim can be proven untouched. L — illegal transitions and role
  // changes. S — direct SQL (never a committed event). J — failure injection, retries and unknown outcomes. R — races.
  // K — waiting for an A8.1 owner write and mixed parallel writes. F — the other tenant's intake.
  const W = await intakeFor('worked')
  await linkedSource(W.freezes[0], 'W1-E1')
  const CASE_W = await caseOf(W.freezes[0])
  const ASSESS_W = await assessmentOf(CASE_W.caseId)
  const L = await intakeFor('illegal')
  const S = await intakeFor('sql')
  const J = await intakeFor('inject')
  const R = await intakeFor('race')
  const K = await intakeFor('lock')
  const F = await intakeFor('foreign', away, O.who)
  // N — a normal linked Claim with evidence, a case and its assessment: no exception, read through A7.6–A7.9.
  const N = await home.series('normal', 2)
  if ((await post(`/api/claims/${N.claimId}/correction-links`, { priorSubmissionId: N.freezes[0], correctedSubmissionId: N.freezes[1], reasonCode: 'CORRECTED_CODING' })).status !== 201) throw new Error('fixture N: the A6.9 link was refused')
  await linkedSource(N.freezes[0], 'N1-E1')
  const CASE_N = await caseOf(N.freezes[0])
  const ASSESS_N = await assessmentOf(CASE_N.caseId)
  const homeIntakes = [W, L, S, J, R, K]
  const runClaims = [...homeIntakes.map((k) => k.claimId), N.claimId]
  progress(`fixtures ready: two synthetic AE-DU/DHA worlds; ${homeIntakes.length} A8.1 intakes on contradicted Claims in Org A and one in Org B; normal Claim N with case ${CASE_N.assemblyCode} and assessment ${ASSESS_N.assessmentCode}; W's assessment ${ASSESS_W.assessmentCode}`)

  const base = (k: { claimId: string; intakeId: string }) => `/api/claims/${k.claimId}/exceptions/${k.intakeId}`
  const record = (k: { claimId: string; intakeId: string }, body: unknown, who: Who = asAdmin) => post(`${base(k)}/triage-events`, body, who)
  const history = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/triage-history`, who)
  const disposition = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/triage-disposition`, who)
  const classify = (categoryCode = 'PROVENANCE_INTEGRITY', priorityCode = 'ELEVATED') => ({ eventCode: 'TRIAGE_CLASSIFY', categoryCode, priorityCode })
  const assign = (assignedMemberId: string) => ({ eventCode: 'ASSIGN_OWNER', assignedMemberId })
  const reassign = (assignedMemberId: string) => ({ eventCode: 'REASSIGN_OWNER', assignedMemberId })
  const giveBack = (reasonCode = 'ASSIGNEE_UNAVAILABLE') => ({ eventCode: 'RETURN_TO_TRIAGE', reasonCode })
  const eventsOf = (intakeId: string) => prisma.exceptionTriageEvent.findMany({ where: { exceptionIntakeId: intakeId }, orderBy: { sequence: 'asc' } })
  const auditsOfEvent = (eventId: string) => prisma.auditEvent.findMany({ where: { entityType: 'EXCEPTION_TRIAGE_EVENT', entityId: eventId } })
  const triageAuditsOfIntake = (intakeId: string) => prisma.auditEvent.count({ where: { actionCode: 'exception_triage.recorded', afterState: { path: ['exceptionIntakeId'], equals: intakeId } } })
  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const triageRowsHash = (intakeIds: string[]) => hashOf(`SELECT e.* FROM ${TABLE} e WHERE e.exception_intake_id = ANY($1::uuid[])`, intakeIds)
  const intakeRowsHash = (claimIds: string[]) => hashOf(`SELECT r.* FROM ${INTAKE_TABLE} r WHERE r.claim_id = ANY($1::uuid[])`, claimIds)
  const NOT_COMMITTED = 'ROLLED_BACK'
  // A rolled-back transaction: the mutation runs, its outcome is captured, then everything is undone. Every table must
  // read back exactly.
  const rolledBack = async <T>(work: (tx: DbClient) => Promise<T>): Promise<{ value?: T; message: string; clean: boolean }> => {
    const before = await counts()
    const out: { value?: T } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          out.value = await work(tx)
          throw new Error(NOT_COMMITTED)
        },
        { timeout: 60_000 },
      ),
    )
    return { ...out, message, clean: await unchanged(before) }
  }
  type Row = Partial<Record<string, string | number | null>>
  // One direct event row of intake `k`: by default its valid first classification, by the authenticated Admin.
  const rowOf = (k: Intake, o: Row = {}): Row => ({
    exception_intake_id: k.intakeId, organization_id: k.organizationId, claim_id: k.claimId, contract_version: CONTRACT, sequence: 1, event_code: 'TRIAGE_CLASSIFY',
    category_code: 'PROVENANCE_INTEGRITY', priority_code: 'ROUTINE', assigned_member_id: null, reason_code: null, recorded_by_user_id: creatorId, ...o,
  })
  const insertRow = (tx: DbClient, row: Row) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, category_code, priority_code, assigned_member_id, reason_code, recorded_by_user_id)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6, $7, $8, $9::uuid, $10, $11::uuid)`,
      row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.category_code, row.priority_code, row.assigned_member_id, row.reason_code, row.recorded_by_user_id,
    )
  // Direct rows in order, in one transaction that is always rolled back: against the live guards, or with the triggers
  // off (replica) so that only a CHECK, a unique index or a NOT NULL can refuse. Answers the first refusal.
  const directInsert = async (rows: Row[], options: { triggersOff?: boolean } = {}) => {
    const attempt = await rolledBack(async (tx) => {
      if (options.triggersOff) await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const row of rows) await insertRow(tx, row)
    })
    return { refused: !attempt.message.includes(NOT_COMMITTED), message: attempt.message, clean: attempt.clean }
  }
  const classifyRow = (k: Intake, sequence: number, o: Row = {}) => rowOf(k, { sequence, ...o })
  const assignRow = (k: Intake, sequence: number, member: string, o: Row = {}) => rowOf(k, { sequence, event_code: 'ASSIGN_OWNER', category_code: null, priority_code: null, assigned_member_id: member, ...o })
  // A stored history planted with the triggers off (and, where named, one CHECK dropped) inside a rolled-back
  // transaction; the production reads answer on THAT transaction.
  const plantedRead = async (k: Intake, rows: Row[], dropCheck?: string) =>
    rolledBack(async (tx) => {
      if (dropCheck) await tx.$executeRawUnsafe(`ALTER TABLE ${TABLE} DROP CONSTRAINT ${dropCheck}`)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const row of rows) await insertRow(tx, row)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      return { history: await getTriageHistoryOf(k.claimId, k.intakeId, tx), disposition: await getTriageDispositionOf(k.claimId, k.intakeId, tx) }
    })
  const snap = async () => ({
    freezes: await hashOf(`SELECT f.*, m.id AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    lifecycle: await hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    links: await hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = ANY($1::uuid[])`, runClaims),
    sources: await hashOf(`SELECT r.* FROM revenue_source_evidence r JOIN claim_freezes f ON f.id = r.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    classifications: await hashOf(`SELECT c.* FROM source_evidence_classifications c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id JOIN claim_freezes f ON f.id = r.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    readiness: await hashOf(`SELECT g.* FROM evidence_gate_results g JOIN revenue_source_evidence r ON r.id = g.source_evidence_id JOIN claim_freezes f ON f.id = r.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    cases: await hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM evidence_case_snapshots h JOIN claim_freezes f ON f.id = h.claim_submission_id WHERE f.claim_id = ANY($1::uuid[]) UNION ALL SELECT e.id, row_to_json(e)::text FROM evidence_case_entries e JOIN evidence_case_snapshots h ON h.id = e.assembly_id JOIN claim_freezes f ON f.id = h.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])) x`, runClaims),
    assessments: await hashOf(`SELECT a.* FROM evidence_prereq_results a JOIN evidence_case_snapshots h ON h.id = a.evidence_case_id JOIN claim_freezes f ON f.id = h.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    intakes: await intakeRowsHash([...runClaims, F.claimId]),
    intakeAudits: await hashOf(`SELECT a.id, a.action_code, a.entity_id, a.after_state, a.occurred_at FROM audit_events a WHERE a.entity_type = 'EXCEPTION_INTAKE' AND a.entity_id = ANY($1::uuid[])`, [...homeIntakes, F].map((k) => k.intakeId)),
  })
  const reads = async () => ({
    trace: (await get(`/api/closure-prerequisite-assessments/${ASSESS_N.assessmentId}/basis-trace`)).body,
    timeline: (await get(`/api/claims/${N.claimId}/revenue-evidence-timeline`)).body,
    delta: (await get(`/api/claims/${N.claimId}/revenue-evidence-delta`)).body,
    continuity: (await get(`/api/claims/${N.claimId}/revenue-evidence-continuity`)).body,
    contradicted: (await get(`/api/claims/${W.claimId}/revenue-evidence-timeline`)).body,
    intakes: (await get(`/api/claims/${W.claimId}/exception-intake`)).body,
  })
  const ownerSnapshotBefore = await snap()
  const ownerReadsBefore = await reads()

  // ---------------------------------------------------------------- wiring and scope (T008–T010)
  const routeCode = committedCode(`${MODULE_DIR}/exception-triage.route.ts`)
  const missingClaim = { claimId: MISSING, intakeId: W.intakeId }
  const wiring = [await record(missingClaim, classify()), await history(missingClaim), await disposition(missingClaim)]
  const absent = [
    await api('PATCH', `${base(W)}/triage-events`, {}), await api('PUT', `${base(W)}/triage-events`, {}), await api('DELETE', `${base(W)}/triage-events`), await get(`${base(W)}/triage-events`),
    await get(`${base(W)}/triage-events/${MISSING}`), await api('PUT', `${base(W)}/triage-disposition`, {}), await post(`${base(W)}/triage-disposition`, {}), await post(`${base(W)}/assign`, {}),
    await post(`${base(W)}/resolve`, {}), await post(`${base(W)}/escalate`, {}), await post(`${base(W)}/investigations`, {}), await get(base(W)), await get(`${base(W)}/triage-current`),
    await get('/api/exception-triage'), await get(`/api/claims/${W.claimId}/exceptions`), await get('/api/triage-events'),
  ]
  check(
    'T008',
    'Strict three-route mount; all others absent',
    wiring.every((r) => r.status === 404 && errorCode(r.body) === 'NOT_FOUND') && absent.every((r) => r.status === 404) &&
      (routeCode.match(/exceptionTriageRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 3 && /exceptionTriageRouter\.post\(`\$\{BASE\}\/triage-events`/.test(routeCode) &&
      /exceptionTriageRouter\.get\(`\$\{BASE\}\/triage-history`/.test(routeCode) && /exceptionTriageRouter\.get\(`\$\{BASE\}\/triage-disposition`/.test(routeCode) && /const BASE = '\/:claimId\/exceptions\/:exceptionIntakeId'/.test(routeCode),
    `the POST and both GETs answer a missing Claim with a privacy-safe 404; on a real intake, PATCH/PUT/DELETE, an event by id, a current selector, assign, resolve, escalate, investigations, a collection and cross-Claim searches are absent (${absent.map((r) => r.status).join('/')})`,
  )
  const contractConstantsAt = (ref: string) =>
    gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, 'backend/src/modules'])
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path) && !path.startsWith(`${MODULE_DIR}/`))
      .flatMap((path) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(/export const ([A-Z_]*CONTRACT_VERSION) = '([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`))
      .sort()
  const contractsOwn = contractConstantsAt(ownTip)
  const productDiff = ownChangedPaths.filter((p) => /^backend\/src\/modules\//.test(p) && !p.startsWith(`${MODULE_DIR}/`) && p !== 'backend/src/modules/audit/audit.types.ts')
  check(
    'T009',
    'Old contracts and applied migrations unchanged',
    contractsOwn.length >= 20 && same(contractsOwn, contractConstantsAt(ownBase)) && productDiff.length === 0 && ownPrismaStatus.every((s) => !/^M\tbackend\/prisma\/migrations\//.test(s)) && committedText(`${MODULE_DIR}/exception-triage.types.ts`).includes(`TRIAGE_CONTRACT_VERSION = '${CONTRACT}'`),
    `all ${contractsOwn.length} A1–A8.1 owner contracts identical to main; no earlier module's code and no applied migration changed`,
  )
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${FE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file))
  const earlierSuites = changedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`))
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a9|dhpo|eclaimlink|investigat|resolution|escalat|export|work-queue|\bsla\b/i.test(file))
  check(
    'T010',
    'A8.2-only changed-file allowlist',
    changedPaths.length > 0 && outOfScope.length === 0 && earlierSuites.length === 0 && laterDomain.length === 0,
    outOfScope.length + earlierSuites.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A8.2 module, page, harness, migration and register and the narrow shared additions; no earlier suite changed; no A8.3+ or A9 domain`
      : `unexpected: ${[...new Set([...outOfScope, ...earlierSuites, ...laterDomain])].join(', ').slice(0, 300)}`,
  )

  // ---------------------------------------------------------------- contract and input validation (T011–T020)
  section('Contract and input validation: the v1 literal and DTOs, strict keys, server-owned fields, malformed ids, unknown events and codes, injection')
  const countsAtStart = await counts()
  const untriagedW = { disposition: await disposition(W), history: await history(W), rows: (await eventsOf(W.intakeId)).length }
  const W1 = await record(W, classify('PROVENANCE_INTEGRITY', 'ELEVATED'))
  const contractDef = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${TABLE}_contract_chk'`))[0]?.d ?? ''
  const historyW1 = await history(W)
  const dispositionW1 = await disposition(W)
  check(
    'T011',
    'A8-EXCEPTION-TRIAGE-1 exact code and DTOs',
    W1.status === 201 && W1.body.contractVersion === CONTRACT && TRIAGE_CONTRACT_VERSION === CONTRACT && same(Object.keys(W1.body), EVENT_KEYS) && same(Object.keys(historyW1.body), HISTORY_KEYS) &&
      same(Object.keys(dispositionW1.body), DISPOSITION_KEYS) && historyW1.body.contractVersion === CONTRACT && dispositionW1.body.contractVersion === CONTRACT && contractDef.includes(`'${CONTRACT}'`) && /IS NOT NULL/.test(contractDef),
    `the first event on W carries ${CONTRACT} and exactly the ${EVENT_KEYS.length} event keys; the history and disposition carry exactly theirs; the database CHECK pins the literal`,
  )
  const strict = [
    await record(L, { ...classify(), assignedMemberId: M2.membershipId }), await record(L, { ...assign(M2.membershipId), categoryCode: 'HUMAN_REVIEW' }), await record(L, { ...giveBack(), assignedMemberId: M2.membershipId }),
    await record(L, { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'HUMAN_REVIEW' }), await record(L, { eventCode: 'ASSIGN_OWNER' }), await record(L, {}), await record(L, [classify()]),
  ]
  check('T012', 'Strict event request keys', strict.every((r) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR') && (await eventsOf(L.intakeId)).length === 0, "any field outside the event's own set, a missing field, an empty object or an array is a 400; nothing recorded")
  const serverOwned = await Promise.all(
    ['id', 'triageEventId', 'sequence', 'organizationId', 'claimId', 'exceptionIntakeId', 'recordedByUserId', 'actorUserId', 'recordedAt', 'contractVersion', 'dispositionCode'].map((k) =>
      record(L, { ...classify(), [k]: k === 'sequence' ? 1 : k === 'recordedAt' ? '2020-01-01T00:00:00.000Z' : k === 'contractVersion' ? CONTRACT : k === 'dispositionCode' ? 'TRIAGED' : MISSING }),
    ),
  )
  const queried = await post(`${base(L)}/triage-events?sequence=1`, classify())
  check(
    'T013',
    'Reject supplied actor/tenant/sequence/time',
    serverOwned.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && queried.status === 400 && (await eventsOf(L.intakeId)).length === 0,
    'an id, sequence, organization, Claim, intake, actor, time, contract or state in the body, or a query parameter, is refused (400): the server owns them',
  )
  const badIds = ['not-a-uuid', MISSING.replace(/-/g, ''), `${MISSING}0`, encodeURIComponent("1' OR '1'='1")]
  const malformedClaim = [
    ...(await Promise.all(badIds.map((id) => record({ claimId: id, intakeId: W.intakeId }, classify())))),
    ...(await Promise.all(badIds.map((id) => history({ claimId: id, intakeId: W.intakeId })))),
    ...(await Promise.all(badIds.map((id) => disposition({ claimId: id, intakeId: W.intakeId })))),
  ]
  check('T014', 'Reject malformed Claim id', malformedClaim.every((r) => r.status === 400 && /invalid claim id/.test(errorMessage(r.body)) && !rawError(r.body)), `malformed and SQL-shaped Claim ids on all three routes: ${[...new Set(malformedClaim.map((r) => r.status))].join('/')}`)
  const malformedIntake = [
    ...(await Promise.all(badIds.map((id) => record({ claimId: W.claimId, intakeId: id }, classify())))),
    ...(await Promise.all(badIds.map((id) => history({ claimId: W.claimId, intakeId: id })))),
    ...(await Promise.all(badIds.map((id) => disposition({ claimId: W.claimId, intakeId: id })))),
  ]
  check('T015', 'Reject malformed exception id', malformedIntake.every((r) => r.status === 400 && /invalid exception intake id/.test(errorMessage(r.body)) && !rawError(r.body)), `malformed and SQL-shaped intake ids on all three routes: ${[...new Set(malformedIntake.map((r) => r.status))].join('/')}`)
  const unknownEvents = await Promise.all(['RESOLVE_EXCEPTION', 'CLOSE', 'ESCALATE', 'triage_classify', '', 'ASSIGN'].map((eventCode) => record(L, { eventCode })))
  check('T016', 'Reject unknown event code', unknownEvents.every((r) => r.status === 400 && /unknown triage event code/.test(errorMessage(r.body))), `only ${triageEventCodes.join(', ')} are accepted`)
  const badCategories = await Promise.all(['PAYER_DENIAL', 'provenance_integrity', '', null, 7].map((v) => record(L, { ...classify(), categoryCode: v })))
  check('T017', 'Reject invalid category code', badCategories.every((r) => r.status === 400 && /unknown triage category/.test(errorMessage(r.body))), `only the ${triageCategoryCodes.length} controlled categories are accepted`)
  const badPriorities = await Promise.all(['CRITICAL', 'STAT', 'elevated', '', 1].map((v) => record(L, { ...classify(), priorityCode: v })))
  check('T018', 'Reject invalid priority code', badPriorities.every((r) => r.status === 400 && /unknown triage priority/.test(errorMessage(r.body))), `only ${triagePriorityCodes.join(', ')} are accepted (internal review order, never clinical or payer urgency)`)
  const badReasons = await Promise.all(['RESOLVED', 'PAYER_DENIED', 'assignee_unavailable', ''].map((v) => record(L, { ...giveBack(), reasonCode: v })))
  check('T019', 'Reject invalid reason code', badReasons.every((r) => r.status === 400 && /unknown return reason/.test(errorMessage(r.body))), `only the ${returnReasonCodes.length} controlled return reasons are accepted`)
  const injection = [
    await record(L, assign("' OR 1=1 --")), await record(L, assign('not-a-member')), await record(L, { eventCode: 'ASSIGN_OWNER', assignedMemberId: { $ne: null } }),
    await record(L, { ...classify(), categoryCode: "PROVENANCE_INTEGRITY'; DROP TABLE claims; --" }), await record(L, JSON.parse('{"__proto__": {"eventCode": "TRIAGE_CLASSIFY"}, "categoryCode": "HUMAN_REVIEW", "priorityCode": "ROUTINE"}')),
    await record(L, { ...classify(), patientName: `${runId}-home-P`, dateOfBirth: '1990-01-01' }), await record(L, { ...classify(), amount: '125.25' }), await record(L, { ...classify(), note: 'free text' }),
  ]
  check(
    'T020',
    'Reject injected member, PHI or unexpected body',
    injection.every((r) => r.status === 400 && !rawError(r.body)) && (await eventsOf(L.intakeId)).length === 0 && (await unchanged({ ...countsAtStart, [TABLE]: countsAtStart[TABLE] + 1, audit_events: countsAtStart.audit_events + 1 })),
    'SQL-, operator- and prototype-shaped values, a malformed member, PHI, an amount and free text are refused with a safe body; only W\'s one valid event and its audit exist',
  )

  // ---------------------------------------------------------------- identity, roles and privacy (T021–T030)
  section('Identity, roles and privacy: 401, Viewer 403, Admin 201/200, Viewer reads, foreign Claim and intake = missing, cross-tenant assignee')
  check('T021', 'Anonymous POST refused 401', (await record(W, classify('HUMAN_REVIEW'), anonymous)).status === 401, 'no session: 401 before any lookup')
  check('T022', 'Anonymous history GET refused 401', (await history(W, anonymous)).status === 401, 'no session: 401')
  check('T023', 'Anonymous disposition GET refused 401', (await disposition(W, anonymous)).status === 401, 'no session: 401')
  const viewerPost = await record(L, classify(), asViewer)
  check('T024', 'Viewer POST refused 403', viewerPost.status === 403 && (await eventsOf(L.intakeId)).length === 0, 'a Viewer (exceptionTriage.read only) is refused 403 and nothing is recorded')
  check('T025', 'Admin authorized POST 201', W1.status === 201 && W1.body.recordedByUserId === creatorId && W1.body.claimId === W.claimId && W1.body.organizationId === org && W1.body.exceptionIntakeId === W.intakeId && W1.body.sequence === 1, 'an Admin records the first event on W (201), as itself, numbered 1, in its own organization and Claim')
  check('T026', 'Admin history read 200', historyW1.status === 200 && historyW1.body.items.length === 1 && same(historyW1.body.items[0], W1.body), "an Admin reads W's history: exactly the recorded event")
  const viewerHistory = await history(W, asViewer)
  const viewerDisposition = await disposition(W, asViewer)
  check('T027', 'Viewer controlled read 200', viewerHistory.status === 200 && viewerDisposition.status === 200 && withoutEvaluatedAt(viewerHistory.body) === withoutEvaluatedAt(historyW1.body) && withoutEvaluatedAt(viewerDisposition.body) === withoutEvaluatedAt(dispositionW1.body), 'a Viewer reads exactly the same history and disposition')
  const missingEnvelope = (r: { body: any }) => ({ ...r.body?.error, requestId: null })
  const foreignClaim = [await record(F, classify()), await history(F), await disposition(F)]
  const missingClaimReads = [await record({ claimId: MISSING, intakeId: F.intakeId }, classify()), await history({ claimId: MISSING, intakeId: F.intakeId }), await disposition({ claimId: MISSING, intakeId: F.intakeId })]
  check(
    'T028',
    'Foreign Claim equals missing 404',
    foreignClaim.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingClaimReads[i]))) && (await eventsOf(F.intakeId)).length === 0,
    "another organization's Claim and intake get exactly the missing-Claim envelope on all three routes; nothing recorded",
  )
  const foreignIntake = [await record({ claimId: W.claimId, intakeId: F.intakeId }, classify()), await history({ claimId: W.claimId, intakeId: F.intakeId }), await disposition({ claimId: W.claimId, intakeId: F.intakeId })]
  const otherClaimIntake = [await record({ claimId: W.claimId, intakeId: L.intakeId }, classify()), await history({ claimId: W.claimId, intakeId: L.intakeId })]
  const missingIntake = [await record({ claimId: W.claimId, intakeId: MISSING }, classify()), await history({ claimId: W.claimId, intakeId: MISSING }), await disposition({ claimId: W.claimId, intakeId: MISSING })]
  check(
    'T029',
    'Foreign intake equals missing 404',
    foreignIntake.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[i]))) && otherClaimIntake.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[0]))) && (await eventsOf(L.intakeId)).length === 0,
    "another tenant's intake, or another Claim's intake of this tenant, named under W's Claim is exactly the missing-intake 404; nothing recorded",
  )
  const L1 = await record(L, classify('HISTORICAL_COHERENCE', 'ROUTINE'))
  const crossTenant = await record(L, assign(O.membershipId))
  const missingMember = await record(L, assign(MISSING))
  const noRoleMember = await record(L, assign(NR.membershipId))
  check(
    'T030',
    'Cross-tenant assignee refused',
    L1.status === 201 && [crossTenant, missingMember, noRoleMember].every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_TRIAGE_ASSIGNEE_NOT_ELIGIBLE' && same(missingEnvelope(r), missingEnvelope(crossTenant))) && (await eventsOf(L.intakeId)).length === 1,
    "assigning L to the other tenant's member is refused 409 with exactly the envelope of a missing or role-less member (no tenant or membership existence disclosed); nothing recorded",
  )

  // ---------------------------------------------------------------- baseline and legal transitions (T031–T040)
  section('Baseline and legal transitions: the §9 worked scenario on W — classify, assign M1, a verified membership change, reassign M2, return, reclassify')
  const columns = (await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${TABLE}' ORDER BY ordinal_position`)).map((r) => r.c)
  check(
    'T031',
    'UNTRIAGED: no row and no stored status',
    untriagedW.rows === 0 && untriagedW.disposition.status === 200 && untriagedW.disposition.body.dispositionCode === 'UNTRIAGED' && untriagedW.disposition.body.eventCount === 0 && untriagedW.disposition.body.lastSequence === null &&
      untriagedW.disposition.body.assignedMemberId === null && untriagedW.disposition.body.assigneeCurrentlyEligible === null && same(untriagedW.history.body.items, []) && same(columns, COLUMNS),
    'before any event W has zero rows and derives UNTRIAGED (no assignee, eligibility null); the table has no status, current or latest column',
  )
  check('T032', 'Classification to TRIAGED', W1.status === 201 && W1.body.eventCode === 'TRIAGE_CLASSIFY' && dispositionW1.body.dispositionCode === 'TRIAGED' && dispositionW1.body.categoryCode === 'PROVENANCE_INTEGRITY' && dispositionW1.body.priorityCode === 'ELEVATED' && dispositionW1.body.assignedMemberId === null, 'TRIAGE_CLASSIFY(PROVENANCE_INTEGRITY, ELEVATED) derives TRIAGED with that category and priority and no assignee')
  const halfClassify = [await record(W, { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'HUMAN_REVIEW' }), await record(W, { eventCode: 'TRIAGE_CLASSIFY', priorityCode: 'URGENT' }), await record(W, { eventCode: 'TRIAGE_CLASSIFY', categoryCode: null, priorityCode: null })]
  check('T033', 'Classification requires category and priority', halfClassify.every((r) => r.status === 400) && (await eventsOf(W.intakeId)).length === 1, 'a classification without its category, without its priority, or with nulls is a 400; nothing recorded')
  const W2 = await record(W, assign(M1.membershipId))
  const dispositionW2 = await disposition(W)
  check('T034', 'Assign from TRIAGED', W2.status === 201 && W2.body.sequence === 2 && W2.body.assignedMemberId === M1.membershipId && dispositionW2.body.dispositionCode === 'ASSIGNED' && dispositionW2.body.assignedMemberId === M1.membershipId, 'ASSIGN_OWNER(M1) from TRIAGED derives ASSIGNED to M1 (event 2)')
  const M1row = await prisma.organizationMembership.findUniqueOrThrow({ where: { id: M1.membershipId }, select: { organizationId: true } })
  const viewerAssign = await record(L, assign(viewerMembership))
  check(
    'T035',
    'Same-organization eligible assignee',
    M1row.organizationId === org && dispositionW2.body.assigneeCurrentlyEligible === true && viewerAssign.status === 409 && errorCode(viewerAssign.body) === 'EXCEPTION_TRIAGE_ASSIGNEE_NOT_ELIGIBLE' && (await eventsOf(L.intakeId)).length === 1,
    "M1 is a membership of W's organization whose role grants exceptionTriage.record (eligible now: true); the Viewer's membership in the same organization (read only) is refused 409",
  )
  // The verified membership change (§9): M1 loses its role. History is never rewritten; the disposition still names
  // M1 as the historical assignee and reports that M1 is no longer eligible (approval condition 1).
  const wHashBeforeRoleChange = await triageRowsHash([W.intakeId])
  await prisma.membershipRole.deleteMany({ where: { membershipId: M1.membershipId } })
  const dispositionAfterRoleChange = await disposition(W)
  const wHashAfterRoleChange = await triageRowsHash([W.intakeId])
  const W3 = await record(W, reassign(M2.membershipId))
  const historyW3 = await history(W)
  const dispositionW3 = await disposition(W)
  check(
    'T036',
    'Reassign from ASSIGNED to a different member',
    W3.status === 201 && W3.body.sequence === 3 && dispositionW3.body.dispositionCode === 'ASSIGNED' && dispositionW3.body.assignedMemberId === M2.membershipId && dispositionW3.body.assigneeCurrentlyEligible === true && historyW3.body.items[1].assignedMemberId === M1.membershipId,
    'REASSIGN_OWNER(M2) derives ASSIGNED to M2 (eligible) and the history still records M1 as the holder of event 2',
  )
  const W4 = await record(W, giveBack('ASSIGNEE_UNAVAILABLE'))
  const dispositionW4 = await disposition(W)
  check('T037', 'Return from ASSIGNED with reason', W4.status === 201 && W4.body.sequence === 4 && W4.body.reasonCode === 'ASSIGNEE_UNAVAILABLE' && dispositionW4.body.dispositionCode === 'TRIAGED', 'RETURN_TO_TRIAGE(ASSIGNEE_UNAVAILABLE) derives TRIAGED (event 4)')
  check(
    'T038',
    'Return strips the derived assignee',
    dispositionW4.body.assignedMemberId === null && dispositionW4.body.assigneeCurrentlyEligible === null && dispositionW4.body.categoryCode === 'PROVENANCE_INTEGRITY' && dispositionW4.body.priorityCode === 'ELEVATED' && W4.body.assignedMemberId === null,
    'after the return there is no current assignee (eligibility null); the classification is kept; the event itself names no member',
  )
  const sameAgain = await record(W, classify('PROVENANCE_INTEGRITY', 'ELEVATED'))
  const W5 = await record(W, classify('PROVENANCE_INTEGRITY', 'URGENT'))
  const dispositionW5 = await disposition(W)
  check(
    'T039',
    'Reclassification from TRIAGED by approved policy',
    sameAgain.status === 409 && errorCode(sameAgain.body) === 'EXCEPTION_TRIAGE_TRANSITION_REFUSED' && W5.status === 201 && W5.body.sequence === 5 && dispositionW5.body.priorityCode === 'URGENT' && dispositionW5.body.dispositionCode === 'TRIAGED',
    'from TRIAGED an identical classification is refused 409 (no silent override); a changed priority is a new event 5 (approval condition 2)',
  )
  const historyW5 = await history(W)
  const expectedW = { contractVersion: CONTRACT, exceptionIntakeId: W.intakeId, dispositionCode: 'TRIAGED', categoryCode: 'PROVENANCE_INTEGRITY', priorityCode: 'URGENT', assignedMemberId: null, assigneeCurrentlyEligible: null, eventCount: 5, lastSequence: 5 }
  check(
    'T040',
    'Ordered history and derived DTO exact',
    same(historyW5.body.items.map((e: any) => e.sequence), [1, 2, 3, 4, 5]) && same(historyW5.body.items.map((e: any) => e.eventCode), ['TRIAGE_CLASSIFY', 'ASSIGN_OWNER', 'REASSIGN_OWNER', 'RETURN_TO_TRIAGE', 'TRIAGE_CLASSIFY']) &&
      historyW5.body.items.every((e: any) => same(Object.keys(e), EVENT_KEYS) && e.recordedByUserId === creatorId) && same([W1, W2, W3, W4, W5].map((r) => r.body), historyW5.body.items) && withoutEvaluatedAt(dispositionW5.body) === JSON.stringify(expectedW),
    'W reads back events 1..5 in sequence, each byte-identical to its 201 answer, and the disposition is exactly TRIAGED / PROVENANCE_INTEGRITY / URGENT, no assignee, 5 events',
  )
  const wHashFinal = await triageRowsHash([W.intakeId])
  const goldenBefore = { history: withoutEvaluatedAt(historyW5.body), disposition: withoutEvaluatedAt(dispositionW5.body), audits: JSON.stringify(await Promise.all(historyW5.body.items.map(async (e: any) => (await auditsOfEvent(e.triageEventId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))))) }

  // ---------------------------------------------------------------- illegal transitions and refusal (T041–T050)
  section('Illegal transitions and refusal on L: every refused pair from every state, same-member reassignment, unsupported events, no fake current state')
  const L0 = await intakeFor('illegal-0')
  const countsBeforeIllegal = await counts()
  const fromUntriaged = { assign: await record(L0, assign(M2.membershipId)), reassign: await record(L0, reassign(M2.membershipId)), back: await record(L0, giveBack()) }
  const isRefusedTransition = (r: { status: number; body: any }) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_TRIAGE_TRANSITION_REFUSED'
  check('T041', 'UNTRIAGED refuses assignment', isRefusedTransition(fromUntriaged.assign) && isRefusedTransition(fromUntriaged.reassign) && (await eventsOf(L0.intakeId)).length === 0, 'with no classification, ASSIGN_OWNER and REASSIGN_OWNER are refused 409; nothing recorded')
  check('T042', 'UNTRIAGED refuses return', isRefusedTransition(fromUntriaged.back) && (await eventsOf(L0.intakeId)).length === 0, 'with no assignment, RETURN_TO_TRIAGE is refused 409; nothing recorded')
  const unsupported = (k: Intake) => Promise.all(['RESOLVE_EXCEPTION', 'ESCALATE', 'INVESTIGATE', 'CLOSE'].map((eventCode) => record(k, { eventCode })))
  const unsupportedUntriaged = await unsupported(L0)
  // L is TRIAGED (T030).
  const fromTriaged = { reassign: await record(L, reassign(M2.membershipId)), back: await record(L, giveBack()) }
  const unsupportedTriaged = await unsupported(L)
  const L2 = await record(L, assign(M2.membershipId))
  const fromAssigned = {
    assignAgain: await record(L, assign(M4.membershipId)), assignSame: await record(L, assign(M2.membershipId)), classifySame: await record(L, classify('HISTORICAL_COHERENCE', 'ROUTINE')),
    classifyChanged: await record(L, classify('HUMAN_REVIEW', 'URGENT')), sameMember: await record(L, reassign(M2.membershipId)),
  }
  const unsupportedAssigned = await unsupported(L)
  check('T043', 'ASSIGNED refuses a second initial assignment', L2.status === 201 && isRefusedTransition(fromAssigned.assignAgain) && isRefusedTransition(fromAssigned.assignSame), 'once ASSIGNED, ASSIGN_OWNER (another member or the same) is refused 409: a change of owner is a reassignment')
  check('T044', 'ASSIGNED refuses classification', isRefusedTransition(fromAssigned.classifySame) && isRefusedTransition(fromAssigned.classifyChanged), 'an ASSIGNED exception is never reclassified directly, even with a changed category and priority: it must first return to triage (approval condition 2)')
  check('T045', 'TRIAGED refuses reassignment', isRefusedTransition(fromTriaged.reassign), 'with no current owner, REASSIGN_OWNER is refused 409')
  check('T046', 'TRIAGED refuses return', isRefusedTransition(fromTriaged.back), 'with no current owner, RETURN_TO_TRIAGE is refused 409')
  check('T047', 'Same-member reassignment refused', isRefusedTransition(fromAssigned.sameMember), 'REASSIGN_OWNER to the member who already holds it is refused 409')
  const sqlUnsupported = await directInsert([classifyRow(S, 1, { event_code: 'RESOLVE_EXCEPTION' })], { triggersOff: true })
  check(
    'T048',
    'Unsupported direct event from any state refused',
    [...unsupportedUntriaged, ...unsupportedTriaged, ...unsupportedAssigned].every((r) => r.status === 400 && /unknown triage event code/.test(errorMessage(r.body))) && sqlUnsupported.refused && /exception_triage_events_event_code_chk/.test(sqlUnsupported.message),
    'RESOLVE_EXCEPTION, ESCALATE, INVESTIGATE and CLOSE are refused (400) from UNTRIAGED, TRIAGED and ASSIGNED, and a direct row with such a code is refused by the event-code CHECK',
  )
  const countsAfterIllegal = await counts()
  const lEvents = await eventsOf(L.intakeId)
  check(
    'T049',
    'Refused writes leave rows and audits unchanged',
    lEvents.length === 2 && (await triageAuditsOfIntake(L.intakeId)) === 2 && (await eventsOf(L0.intakeId)).length === 0 &&
      same(countsAfterIllegal, { ...countsBeforeIllegal, [TABLE]: countsBeforeIllegal[TABLE] + 1, audit_events: countsBeforeIllegal.audit_events + 1 }),
    "every refusal in this section (from UNTRIAGED, TRIAGED and ASSIGNED) wrote nothing: the only new rows in every table are L's one legal assignment and its one audit",
  )
  const fakeCurrent = [
    await record(L, { ...giveBack(), dispositionCode: 'TRIAGED' }), await record(L, { ...reassign(M4.membershipId), currentAssignee: M4.membershipId }), await record(L, { ...giveBack(), state: 'TRIAGED' }),
    await get(`${base(L)}/triage-disposition?current=1`), await get(`${base(L)}/triage-disposition?state=ASSIGNED`), await get(`${base(L)}/triage-history?latestEventId=${MISSING}`), await get(`${base(L)}/triage-history?sequence=1`),
  ]
  const lDisposition = await disposition(L)
  check(
    'T050',
    'No user-selected fake CURRENT state',
    fakeCurrent.every((r) => r.status === 400) && lDisposition.body.dispositionCode === 'ASSIGNED' && lDisposition.body.assignedMemberId === M2.membershipId && same(replayIndependently(lEvents), { ...replayIndependently(lEvents), dispositionCode: lDisposition.body.dispositionCode, assignedMemberId: lDisposition.body.assignedMemberId }) && !COLUMNS.some((c) => /status|state|current|latest/.test(c)),
    'a state, current assignee or disposition in a POST, and a current/latest/state/sequence selector on a GET, are refused (400); the disposition is always derived from the stored sequence, never stored or chosen',
  )

  // ---------------------------------------------------------------- direct SQL integrity (T051–T060)
  section('Direct SQL integrity on S (always rolled back): RESTRICT keys, a valid row, parent, actor, assignee and tenant coherence, contract, code and shape CHECKs, sequence, append-only')
  const fks = await prisma.$queryRawUnsafe<{ name: string; del: string }[]>(`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid = '${TABLE}'::regclass ORDER BY conname`)
  const deleteMember = await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM organization_memberships WHERE id = $1::uuid`, M2.membershipId))
  const deleteUser = await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id = $1::uuid`, creatorId))
  check(
    'T051',
    'All RESTRICT foreign keys',
    fks.length === 5 && fks.every((fk) => fk.del === 'r') && /foreign key|23503/.test(deleteMember.message) && !deleteMember.message.includes(NOT_COMMITTED) && deleteMember.clean && !deleteUser.message.includes(NOT_COMMITTED) && deleteUser.clean,
    `${fks.map((f) => f.name.replace(`${TABLE}_`, '')).join(', ')}: all ON DELETE RESTRICT; deleting an assigned membership or the recording user is refused`,
  )
  const validRows = await directInsert([classifyRow(S, 1), assignRow(S, 2, M2.membershipId), rowOf(S, { sequence: 3, event_code: 'REASSIGN_OWNER', category_code: null, priority_code: null, assigned_member_id: M4.membershipId }), rowOf(S, { sequence: 4, event_code: 'RETURN_TO_TRIAGE', category_code: null, priority_code: null, reason_code: 'ASSIGNMENT_INCORRECT' })])
  check('T052', 'Valid direct events accepted, then rolled back', !validRows.refused && validRows.message.includes(NOT_COMMITTED) && validRows.clean && (await eventsOf(S.intakeId)).length === 0, "four direct rows forming S's legal path 1..4 pass every guard and CHECK; the transaction is rolled back and nothing remains")
  const unknownParent = await directInsert([rowOf(S, { exception_intake_id: randomUUID() })])
  check('T053', 'Unknown parent FK refused', unknownParent.refused && /exception_triage_events_exception_intake_id_fkey|23503/.test(unknownParent.message) && unknownParent.clean, 'a direct event naming an intake that does not exist is refused by its RESTRICT key')
  const foreignActor = await directInsert([rowOf(S, { recorded_by_user_id: O.id })])
  const unknownActor = await directInsert([rowOf(S, { recorded_by_user_id: randomUUID() })])
  check('T054', 'Foreign actor refused', foreignActor.refused && /exception_triage_member/.test(foreignActor.message) && unknownActor.refused && /exception_triage_member|recorded_by_user_id_fkey/.test(unknownActor.message), "a direct event recorded by the other tenant's member, or by no user at all, is refused")
  const coherence = {
    foreignOrg: await directInsert([rowOf(S, { organization_id: otherOrg })]), otherClaim: await directInsert([rowOf(S, { claim_id: W.claimId })]),
    foreignAssignee: await directInsert([classifyRow(S, 1), assignRow(S, 2, O.membershipId)]), roleless: await directInsert([classifyRow(S, 1), assignRow(S, 2, NR.membershipId)]),
    viewerAssignee: await directInsert([classifyRow(S, 1), assignRow(S, 2, viewerMembership)]), missingAssignee: await directInsert([classifyRow(S, 1), assignRow(S, 2, MISSING)]),
  }
  check(
    'T055',
    'Invalid assignee/membership coherence refused',
    /exception_triage_coherence/.test(coherence.foreignOrg.message) && /exception_triage_coherence/.test(coherence.otherClaim.message) &&
      [coherence.foreignAssignee, coherence.roleless, coherence.viewerAssignee, coherence.missingAssignee].every((r) => r.refused && /exception_triage_assignee/.test(r.message) && r.clean),
    "a direct event under the other organization or another Claim is refused (coherence); an assignment to the other tenant's member, a role-less member, a read-only Viewer or a missing membership is refused by the assignee guard",
  )
  const contractGuarded = await directInsert([rowOf(S, { contract_version: 'A8-EXCEPTION-TRIAGE-2' })])
  const contractAlone = await directInsert([rowOf(S, { contract_version: 'A8-EXCEPTION-TRIAGE-2' })], { triggersOff: true })
  check('T056', 'Unknown contract CHECK refused', [contractGuarded, contractAlone].every((r) => r.refused && /exception_triage_events_contract_chk/.test(r.message)), 'a future contract is refused by the contract CHECK, with the guard on and with every trigger off')
  const codeAlone = await directInsert([rowOf(S, { event_code: 'CLOSE_EXCEPTION' })], { triggersOff: true })
  const codeGuarded = await directInsert([rowOf(S, { event_code: 'CLOSE_EXCEPTION' })])
  check('T057', 'Invalid event-code CHECK refused', codeAlone.refused && /exception_triage_events_event_code_chk/.test(codeAlone.message) && codeGuarded.refused && /exception_triage_(transition|events_event_code_chk)/.test(codeGuarded.message), 'an uncontrolled event code is refused by its CHECK on its own, and by the guard first when the guard is on')
  const shapes = [
    await directInsert([rowOf(S, { assigned_member_id: M2.membershipId })], { triggersOff: true }), await directInsert([rowOf(S, { event_code: 'ASSIGN_OWNER', assigned_member_id: M2.membershipId })], { triggersOff: true }),
    await directInsert([rowOf(S, { event_code: 'RETURN_TO_TRIAGE', category_code: null, priority_code: null })], { triggersOff: true }), await directInsert([rowOf(S, { category_code: 'PAYER_DENIED' })], { triggersOff: true }),
    await directInsert([rowOf(S, { priority_code: null })], { triggersOff: true }), await directInsert([rowOf(S, { event_code: 'RETURN_TO_TRIAGE', category_code: null, priority_code: null, reason_code: 'RESOLVED' })], { triggersOff: true }),
  ]
  check('T058', 'Event field shape CHECK refused', shapes.every((r) => r.refused && /exception_triage_events_shape_chk/.test(r.message) && r.clean), 'a classification naming a member, an assignment carrying a category, a return without a reason, an uncontrolled category, a missing priority and an uncontrolled reason are each refused by the shape CHECK')
  const sequences = {
    gap: await directInsert([classifyRow(S, 2)]), reuse: await directInsert([classifyRow(S, 1), classifyRow(S, 1, { priority_code: 'URGENT' })]),
    zero: await directInsert([classifyRow(S, 0)], { triggersOff: true }), duplicateKey: await directInsert([classifyRow(S, 1), classifyRow(S, 1, { priority_code: 'URGENT' })], { triggersOff: true }),
  }
  check(
    'T059',
    'Sequence gap or reuse refused',
    /exception_triage_sequence/.test(sequences.gap.message) && /exception_triage_sequence/.test(sequences.reuse.message) && /exception_triage_events_sequence_chk/.test(sequences.zero.message) && /exception_triage_events_sequence_key|23505/.test(sequences.duplicateKey.message),
    'a first event numbered 2 and a reused number are refused by the guard; number 0 by the sequence CHECK; and with every trigger off a reused number is still refused by the unique (intake, sequence) index',
  )
  const wEventId = historyW5.body.items[0].triageEventId as string
  const wipes = {
    noop: await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = sequence WHERE id = $1::uuid`, wEventId)), update: await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET priority_code = 'ROUTINE' WHERE id = $1::uuid`, wEventId)),
    deletion: await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, wEventId)), truncation: await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`)),
    cascade: await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`)),
  }
  // A later owner's ON DELETE RESTRICT key into this table would make PostgreSQL refuse a plain TRUNCATE before any
  // trigger runs; TRUNCATE ... CASCADE still reaches this guard. Judged on behaviour: every wipe is refused and nothing
  // changes.
  const referencedBy = await prisma.$queryRawUnsafe<{ del: string }[]>(`SELECT confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND confrelid = '${TABLE}'::regclass`)
  const truncationRefused = /append-only/.test(wipes.truncation.message) || (/cannot truncate a table referenced in a foreign key constraint/.test(wipes.truncation.message) && referencedBy.length > 0 && referencedBy.every((row) => row.del === 'r'))
  check(
    'T060',
    'Any UPDATE and DELETE rejected',
    [wipes.noop, wipes.update, wipes.deletion, wipes.cascade].every((r) => /append-only/.test(r.message) && r.clean) && truncationRefused && wipes.truncation.clean && (await triageRowsHash([W.intakeId])) === wHashFinal,
    'an UPDATE (even a no-op), a DELETE, a TRUNCATE and a TRUNCATE … CASCADE of triage events are each refused (append-only); nothing changed',
  )

  // ---------------------------------------------------------------- append-only history and transaction (T061–T070)
  section('Append-only history and transaction on J: crash after the event, crash after the audit, retry after rollback, atomic event+audit, database time, no audit on refusals, no backfill')
  const failAfterEvent = failOnce('exceptionTriage.inserted', 'injected failure after the triage insert')
  const crashedEvent = await attemptAdversarial(() => recordTriageEvent(J.claimId, J.intakeId, classify('SOURCE_REFERENCE', 'ROUTINE'), creatorId))
  const afterCrash1 = { rows: (await eventsOf(J.intakeId)).length, audits: await triageAuditsOfIntake(J.intakeId) }
  const failAfterAudit = failOnce('exceptionTriage.audited', 'injected failure after the triage audit')
  const crashedAudit = await attemptAdversarial(() => recordTriageEvent(J.claimId, J.intakeId, classify('SOURCE_REFERENCE', 'ROUTINE'), creatorId))
  const afterCrash2 = { rows: (await eventsOf(J.intakeId)).length, audits: await triageAuditsOfIntake(J.intakeId) }
  const holdInsert = holdAt('exceptionTriage.inserted')
  const jCallStarted = new Date()
  const committing = recordTriageEvent(J.claimId, J.intakeId, classify('SOURCE_REFERENCE', 'ROUTINE'), creatorId)
  await Promise.race([holdInsert.arrived, committing])
  const during = { rows: (await eventsOf(J.intakeId)).length, audits: await triageAuditsOfIntake(J.intakeId) }
  holdInsert.release()
  const J1 = await committing
  const jCallReturned = new Date()
  clearConcurrencyProbes()
  const jEvents1 = await eventsOf(J.intakeId)
  check('T061', 'One event plus one audit, atomic', during.rows === 0 && during.audits === 0 && J1.ok && jEvents1.length === 1 && (await auditsOfEvent(jEvents1[0].id)).length === 1, 'while the inserted event was uncommitted no other connection saw it or its audit; after commit, exactly one of each')
  check('T062', 'Crash after event before audit rolls back', failAfterEvent.reached === 1 && /injected failure after the triage insert/.test(crashedEvent) && afterCrash1.rows === 0 && afterCrash1.audits === 0, 'a failure right after the insert rolled back the whole transaction: no event, no audit, no retry')
  check('T063', 'Crash after audit before commit rolls back', failAfterAudit.reached === 1 && /injected failure after the triage audit/.test(crashedAudit) && afterCrash2.rows === 0 && afterCrash2.audits === 0, 'a failure after the audit rolled back both: no event, no audit, no retry')
  check('T064', 'Retry after confirmed rollback: one insert', J1.ok && J1.value.sequence === 1 && jEvents1.length === 1 && (await triageAuditsOfIntake(J.intakeId)) === 1, 'after two confirmed rollbacks the next request recorded exactly one event, numbered 1 (no gap, no duplicate), with one audit')
  check('T065', 'Earlier A8.1 intake immutable', (await intakeRowsHash([...runClaims, F.claimId])) === ownerSnapshotBefore.intakes && (await hashOf(`SELECT a.id, a.action_code, a.entity_id, a.after_state, a.occurred_at FROM audit_events a WHERE a.entity_type = 'EXCEPTION_INTAKE' AND a.entity_id = ANY($1::uuid[])`, [...homeIntakes, F].map((k) => k.intakeId))) === ownerSnapshotBefore.intakeAudits, 'every A8.1 intake and intake audit of this run is byte-identical after all triage so far')
  const jRow = (await prisma.$queryRawUnsafe<{ same: boolean; started: boolean; utc: string }[]>(`SELECT recorded_at = created_at AS same, recorded_at >= $2::timestamptz AS started, to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS utc FROM ${TABLE} WHERE id = $1::uuid`, jEvents1[0].id, runStartedAt.toISOString()))[0]
  const backdated = await rolledBack((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, category_code, priority_code, recorded_by_user_id, recorded_at, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, 1, 'TRIAGE_CLASSIFY', 'HUMAN_REVIEW', 'ROUTINE', $5::uuid, now() - interval '1 day', now() - interval '1 day')`,
      S.intakeId, S.organizationId, S.claimId, CONTRACT, creatorId,
    ),
  )
  check(
    'T066',
    'Event timestamp from the database only',
    jRow?.same === true && jRow.started && J1.ok && jRow.utc === J1.value.recordedAt && /exception_triage_time/.test(backdated.message) && backdated.clean && serverOwned.some((r) => r.status === 400),
    'recorded_at = created_at = the transaction time within this run, returned as that exact UTC instant; a client time is refused (T013) and a backdated direct row is refused by the guard',
  )
  // The audit records the event's own database time. The audit row's occurredAt is filled by the accepted A1 audit
  // writer (Prisma's @default(now()), the application clock — unchanged owner code, an A10 observation); it must lie
  // inside the one request that wrote the event, measured on that same application clock.
  const jAudit = (await auditsOfEvent(jEvents1[0].id))[0]
  check(
    'T067',
    'Audit timestamp equals the event',
    !!jAudit && (jAudit.afterState as any)?.recordedAt === jEvents1[0].recordedAt.toISOString() && jAudit.occurredAt >= jCallStarted && jAudit.occurredAt <= jCallReturned &&
      jAudit.organizationId === J.organizationId && jAudit.actorUserId === creatorId && jAudit.actionCode === 'exception_triage.recorded' && jAudit.beforeState === null,
    `the audit records exactly the event's database time (${jEvents1[0].recordedAt.toISOString()}), its organization and actor; the audit row itself was written within that one request (A1's writer stamps occurredAt ${jAudit?.occurredAt.toISOString()} from the application clock)`,
  )
  const auditsBeforeReads = await prisma.auditEvent.count()
  const refusals = [await record(J, { eventCode: 'CLOSE' }), await record(J, classify(), asViewer), await record(F, classify()), await record(J, giveBack()), await record(J, assign(NR.membershipId))]
  for (const who of [asAdmin, asViewer]) {
    await history(J, who)
    await disposition(J, who)
  }
  check('T068', 'No audit on read or refusal', (await prisma.auditEvent.count()) === auditsBeforeReads && refusals.map((r) => r.status).join('/') === '400/403/404/409/409', `reads by an Admin and a Viewer and five refusals (${refusals.map((r) => r.status).join('/')}) wrote no audit`)
  const late = await directInsert([rowOf(W, { sequence: 3, event_code: 'RETURN_TO_TRIAGE', category_code: null, priority_code: null, reason_code: 'ASSIGNMENT_INCORRECT' })])
  const serviceCode = committedCode(`${MODULE_DIR}/exception-triage.service.ts`)
  const repositoryCode = committedCode(`${MODULE_DIR}/exception-triage.repository.ts`)
  check(
    'T069',
    'No late backfill or resequence',
    late.refused && /exception_triage_sequence/.test(late.message) && (await triageRowsHash([W.intakeId])) === wHashFinal && !/\.update\(|\.updateMany\(|\.upsert\(|\.delete\(|UPDATE "exception_triage_events"/.test(serviceCode + repositoryCode) &&
      serverOwned.some((r) => r.status === 400),
    'a direct event slotted into W\'s past (number 3 of 5) is refused by the guard; the client can never name a number (T013); the module never updates, upserts or deletes an event',
  )
  const runEvents = await prisma.exceptionTriageEvent.findMany({ where: { recordedAt: { gte: runStartedAt } }, select: { id: true } })
  const runAudits = await prisma.auditEvent.findMany({ where: { actionCode: 'exception_triage.recorded', occurredAt: { gte: runStartedAt } }, select: { entityId: true } })
  check('T070', 'No row without its audited action', runEvents.length >= 8 && runEvents.every((e) => runAudits.filter((a) => a.entityId === e.id).length === 1) && runAudits.every((a) => runEvents.some((e) => e.id === a.entityId)), `${runEvents.length} events and ${runAudits.length} triage audits this run pair one to one: no orphan audit and no event without its audit`)

  // ---------------------------------------------------------------- concurrency and unknown outcome (T071–T080)
  section('Concurrency and unknown outcome: Claim lock first, simultaneous classifications, assignments and reassignments, an A8.1 owner write, mixed parallel writes, bounded retries, unknown commit, unique backstop')
  const onTx = serviceCode.slice(serviceCode.indexOf('async function recordOnTransaction'), serviceCode.indexOf('async function reconcileUnknownOutcome'))
  const firstStatement = onTx.split('\n').slice(1).find((line) => line.trim().length > 0) ?? ''
  const holdLock = holdAt('exceptionTriage.claim_locked')
  const firstJ = recordTriageEvent(J.claimId, J.intakeId, assign(M2.membershipId), creatorId)
  await Promise.race([holdLock.arrived, firstJ])
  const secondJ = recordTriageEvent(J.claimId, J.intakeId, assign(M4.membershipId), creatorId)
  const secondWaited = !(await settledWithin(secondJ, 1500))
  holdLock.release()
  const [j2a, j2b] = await Promise.all([firstJ, secondJ])
  clearConcurrencyProbes()
  check(
    'T071',
    'Claim lock first and SERIALIZABLE',
    /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(firstStatement) && /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && secondWaited && j2a.ok && j2b.ok === false && j2b.code === 'EXCEPTION_TRIAGE_TRANSITION_REFUSED',
    'the Claim row lock is the first statement of one SERIALIZABLE transaction; while one assignment holds it a second waits, then is judged against the committed history (ASSIGNED refuses ASSIGN_OWNER, 409)',
  )
  const classifyRace = await Promise.all(Array.from({ length: 5 }, () => record(R, classify('CONTRACT_COMPATIBILITY', 'ROUTINE'))))
  check(
    'T072',
    'Simultaneous classifications: one accepted',
    classifyRace.filter((r) => r.status === 201).length === 1 && classifyRace.filter((r) => isRefusedTransition(r)).length === 4 && (await eventsOf(R.intakeId)).length === 1 && (await triageAuditsOfIntake(R.intakeId)) === 1,
    `five identical classifications at once: one 201 and four 409 (an identical reclassification is refused); one event, one audit (${classifyRace.map((r) => r.status).join('/')})`,
  )
  const assignRace = await Promise.all([record(R, assign(M2.membershipId)), record(R, assign(M4.membershipId))])
  const rAfterAssign = await eventsOf(R.intakeId)
  check(
    'T073',
    'Competing initial assignments: one accepted',
    assignRace.filter((r) => r.status === 201).length === 1 && assignRace.filter((r) => isRefusedTransition(r)).length === 1 && rAfterAssign.length === 2 && rAfterAssign[1].eventCode === 'ASSIGN_OWNER',
    `two initial assignments at once (M2, M4): one 201, one 409; R is ASSIGNED to exactly one of them (${assignRace.map((r) => r.status).join('/')})`,
  )
  const holder = rAfterAssign[1].assignedMemberId
  const reassignRace = await Promise.all([record(R, reassign(B.membershipId)), record(R, reassign(adminMembership))])
  const rAfterReassign = await eventsOf(R.intakeId)
  check(
    'T074',
    'Competing reassignments: one legal order',
    reassignRace.every((r) => r.status === 201) && same(rAfterReassign.map((e) => e.sequence), [1, 2, 3, 4]) && rAfterReassign[2].assignedMemberId !== holder && rAfterReassign[3].assignedMemberId !== rAfterReassign[2].assignedMemberId && deriveTriageDisposition({ exceptionIntakeId: R.intakeId, organizationId: R.organizationId, claimId: R.claimId }, rAfterReassign).ok,
    'two reassignments to two other members at once are serialized into one legal order (3 then 4, each to a different member than the one before); the stored history derives',
  )
  const holdOwner = holdAt('exceptionIntake.claim_locked')
  const ownerWrite = recordExceptionIntake(K.claimId, timelineBody(K.claimId), creatorId)
  await Promise.race([holdOwner.arrived, ownerWrite])
  const triageWhileOwner = recordTriageEvent(K.claimId, K.intakeId, classify('HUMAN_REVIEW', 'ROUTINE'), creatorId)
  const triageWaited = !(await settledWithin(triageWhileOwner, 1500))
  holdOwner.release()
  const [ownerResult, k1] = await Promise.all([ownerWrite, triageWhileOwner])
  clearConcurrencyProbes()
  check('T075', 'Assignment waits for A8.1 owner writes', triageWaited && ownerResult.ok && ownerResult.value.replayed === true && k1.ok && k1.value.sequence === 1, "while an A8.1 write holds K's Claim lock, a triage write on K's intake waits; both then complete (the A8.1 replay first, the triage event numbered 1)")
  const mixed = await Promise.all([
    record(K, assign(M2.membershipId)), record(K, assign(M4.membershipId)), record(K, classify('HUMAN_REVIEW', 'URGENT')), record(K, giveBack('CLASSIFICATION_REVIEW_NEEDED')), record(K, reassign(M4.membershipId)), record(K, classify('SOURCE_REFERENCE', 'ELEVATED')),
  ])
  const kEvents = await eventsOf(K.intakeId)
  const accepted = mixed.filter((r) => r.status === 201)
  check(
    'T076',
    'Parallel same-Claim operations serializable',
    mixed.every((r) => r.status === 201 || r.status === 409) && kEvents.length === 1 + accepted.length && same(kEvents.map((e) => e.sequence), kEvents.map((_e, i) => i + 1)) && same(accepted.map((r) => r.body.sequence).sort((a: number, b: number) => a - b), kEvents.slice(1).map((e) => e.sequence)) &&
      deriveTriageDisposition({ exceptionIntakeId: K.intakeId, organizationId: K.organizationId, claimId: K.claimId }, kEvents).ok && (await triageAuditsOfIntake(K.intakeId)) === kEvents.length,
    `six mixed writes at once (${mixed.map((r) => r.status).join('/')}): every accepted one is a legal step of one serial order numbered without a gap, every other one a 409, one audit per event`,
  )
  const once = failOnce('exceptionTriage.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const retried = await recordTriageEvent(J.claimId, J.intakeId, reassign(M4.membershipId), creatorId)
  const always = failEveryTime('exceptionTriage.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const exhausted = await recordTriageEvent(J.claimId, J.intakeId, giveBack(), creatorId)
  clearConcurrencyProbes()
  const jEvents3 = await eventsOf(J.intakeId)
  check(
    'T077',
    'Bounded transaction retry',
    once.reached === 1 && retried.ok && retried.value.sequence === 3 && always.reached === 3 && exhausted.ok === false && exhausted.code === 'EXCEPTION_TRIAGE_CONFLICT' && /kept conflicting; nothing was recorded/.test(exhausted.message) && jEvents3.length === 3 &&
      /const MAX_TRIAGE_ATTEMPTS = 3/.test(serviceCode) && /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode),
    'one serialization failure is retried on a fresh transaction and records exactly one event (3); failing every time, the writer stops after exactly 3 attempts with a 409 and nothing recorded; lock waits are bounded by 30 s',
  )
  const lost = failEveryTime('exceptionTriage.audited', 'Connection terminated unexpectedly')
  const unknownOutcome = await recordTriageEvent(J.claimId, J.intakeId, giveBack(), creatorId)
  const early = failEveryTime('exceptionTriage.claim_locked', 'Connection terminated unexpectedly')
  const earlyOutcome = await recordTriageEvent(J.claimId, J.intakeId, giveBack(), creatorId)
  clearConcurrencyProbes()
  check(
    'T078',
    'Unknown commit not blindly appended',
    lost.reached === 1 && unknownOutcome.ok === false && unknownOutcome.code === 'EXCEPTION_TRIAGE_CONFLICT' && /holds no event at sequence 4; nothing was recorded/.test(unknownOutcome.message) &&
      early.reached === 1 && earlyOutcome.ok === false && /failed before an event was written/.test(earlyOutcome.message) && (await eventsOf(J.intakeId)).length === 3 && /reconcileAttempt\(records, attempted\)/.test(serviceCode),
    "a connection lost after the audit is reconciled against the committed history (no event 4: nothing recorded) and a loss before the insert is reported as such; each reached once — never resubmitted, never reported as success (the RECORDED and OTHER_EVENT outcomes are proven by the reducer's unit tests, T081)",
  )
  const uniqueIndex = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT indexdef AS d FROM pg_indexes WHERE indexname = '${TABLE}_sequence_key'`))[0]?.d ?? ''
  check('T079', 'DB unique key backstop', /UNIQUE/i.test(uniqueIndex) && /\(exception_intake_id, sequence\)/.test(uniqueIndex) && /exception_triage_events_sequence_key|23505/.test(sequences.duplicateKey.message) && /isUniqueViolation\(error\)/.test(serviceCode), 'a unique (intake, sequence) index refuses a reused number even with every trigger off (T059); the service retries such a collision on a fresh transaction')
  const contiguous = async (k: Intake) => {
    const rows = await eventsOf(k.intakeId)
    return same(rows.map((e) => e.sequence), rows.map((_e, i) => i + 1)) && (await triageAuditsOfIntake(k.intakeId)) === rows.length
  }
  check('T080', 'No gaps after races', (await contiguous(R)) && (await contiguous(K)) && (await contiguous(J)) && (await contiguous(W)) && (await contiguous(L)), 'after every race, injected failure and retry, W, L, J, R and K are each numbered 1..N with exactly one audit per event')

  // ---------------------------------------------------------------- pure reducer and read integrity (T081–T090)
  section('Pure reducer and read integrity: unit tests, determinism, independent replay, planted malformed, gapped and wrongly started histories, read-only GETs, UTC time, agreement, transaction-aware reads')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  const reducerCode = committedCode(`${MODULE_DIR}/exception-triage.reducer.ts`)
  check(
    'T081',
    'Pure reducer legal-path unit tests',
    ownUnit.ok && /ℹ pass 10/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output) && !/prisma|await |async |Date\.now|Math\.random|new Date|from '\.\.\/\.\.\/shared/.test(reducerCode),
    'the 10 reducer and request tests pass (every legal and refused transition, shapes, read refusals, the worked scenario and the uncertain-outcome reconciliation); the reducer reads no database, clock or randomness',
  )
  const wParent = { exceptionIntakeId: W.intakeId, organizationId: W.organizationId, claimId: W.claimId }
  const wStored = await eventsOf(W.intakeId)
  const derivations = new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveTriageDisposition(wParent, wStored))))
  const wAgain = [await disposition(W), await disposition(W), await disposition(W, asViewer)]
  check('T082', 'Same history gives identical disposition', derivations.size === 1 && wAgain.every((r) => withoutEvaluatedAt(r.body) === withoutEvaluatedAt(dispositionW5.body)), "one hundred derivations of W's stored history are identical, and three reads (Admin and Viewer) answer the same disposition")
  const independent = await Promise.all([W, L, R, K, J].map(async (k) => {
    const h = await history(k)
    const d = await disposition(k)
    const mine = replayIndependently(h.body.items)
    return same(mine, { dispositionCode: d.body.dispositionCode, categoryCode: d.body.categoryCode, priorityCode: d.body.priorityCode, assignedMemberId: d.body.assignedMemberId, eventCount: d.body.eventCount, lastSequence: d.body.lastSequence })
  }))
  check('T083', 'Independent replay matches the disposition', independent.every(Boolean), "this suite's own replay of each history (W, L, R, K, J) gives exactly the disposition the module derives")
  const malformed = await plantedRead(S, [classifyRow(S, 1, { assigned_member_id: M2.membershipId })], `${TABLE}_shape_chk`)
  const foreignRow = await plantedRead(S, [classifyRow(S, 1, { organization_id: otherOrg })])
  const impossible = await plantedRead(S, [rowOf(S, { sequence: 1, event_code: 'RETURN_TO_TRIAGE', category_code: null, priority_code: null, reason_code: 'ASSIGNEE_UNAVAILABLE' })])
  const refusedRead = (r: { value?: { history: any; disposition: any }; clean: boolean }) => r.value?.history.ok === false && r.value.history.code === 'EXCEPTION_TRIAGE_CONFLICT' && r.value.disposition.ok === false && r.value.disposition.code === 'EXCEPTION_TRIAGE_CONFLICT' && r.clean
  check('T084', 'Malformed event rejected on read', [malformed, foreignRow, impossible].every(refusedRead), "a stored classification naming a member (its CHECK dropped), another tenant's row and an impossible first event (planted, rolled back) each make both reads refuse 409 — never repaired or skipped")
  const gapped = await plantedRead(J, [rowOf(J, { sequence: 5, event_code: 'RETURN_TO_TRIAGE', category_code: null, priority_code: null, reason_code: 'ASSIGNEE_UNAVAILABLE' })])
  check('T085', 'Gap rejected on read', refusedRead(gapped), "J's history with a planted event 5 after 3 (no 4) makes both reads refuse 409")
  const lateStart = await plantedRead(S, [classifyRow(S, 2)])
  check('T086', 'Invalid sequence start rejected', refusedRead(lateStart), 'a history starting at number 2 (planted) makes both reads refuse 409')
  const countsBeforeGet = await counts()
  for (const k of [W, L, J, R, K]) for (const who of [asAdmin, asViewer]) {
    await history(k, who)
    await disposition(k, who)
  }
  check('T087', 'Read-only GET writes nothing', (await unchanged(countsBeforeGet)) && /withReadSnapshot\(undefined, \(tx\) => getTriageHistoryOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode) && /withReadSnapshot\(undefined, \(tx\) => getTriageDispositionOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode), 'twenty reads by an Admin and a Viewer changed no row; each read runs in one READ ONLY snapshot')
  const dbBefore = (await prisma.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`)[0].t
  const evaluated = [await history(W), await disposition(W)]
  const dbAfter = (await prisma.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`)[0].t
  check(
    'T088',
    'Database evaluatedAt is UTC',
    evaluated.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.body.evaluatedAt) && new Date(r.body.evaluatedAt) >= new Date(dbBefore.getTime() - 1) && new Date(r.body.evaluatedAt) <= dbAfter) && historyW5.body.items.every((e: any) => /Z$/.test(e.recordedAt)),
    'evaluatedAt and every recordedAt are ISO-8601 UTC instants; evaluatedAt is the database transaction time of the read',
  )
  const agree = await Promise.all([W, L, R, K, J].map(async (k) => {
    const h = (await history(k)).body
    const d = (await disposition(k)).body
    const last = h.items[h.items.length - 1]
    return d.eventCount === h.items.length && d.lastSequence === (last?.sequence ?? null) && (last?.eventCode === 'RETURN_TO_TRIAGE' || last?.eventCode === 'TRIAGE_CLASSIFY' ? d.dispositionCode === 'TRIAGED' && d.assignedMemberId === null : d.dispositionCode === 'ASSIGNED' && d.assignedMemberId === last.assignedMemberId)
  }))
  check('T089', 'History and disposition agree with the last transition', agree.every(Boolean), "for W, L, R, K and J the disposition's count, last number and state follow exactly from the history's last event")
  const viaTx = await prisma.$transaction(async (tx) => ({ history: await getTriageHistoryOf(W.claimId, W.intakeId, tx), disposition: await getTriageDispositionOf(W.claimId, W.intakeId, tx) }))
  const viaHttp = { history: (await history(W)).body, disposition: (await disposition(W)).body }
  check(
    'T090',
    'Transaction-aware read same as HTTP',
    viaTx.history.ok && viaTx.disposition.ok && withoutEvaluatedAt(viaTx.history.value) === withoutEvaluatedAt(viaHttp.history) && withoutEvaluatedAt(viaTx.disposition.value) === withoutEvaluatedAt(viaHttp.disposition),
    "getTriageHistoryOf and getTriageDispositionOf on a caller's transaction answer exactly what the HTTP reads answer",
  )

  // ---------------------------------------------------------------- role changes and security (T091–T100)
  section('Role changes and security: historical assignee kept, eligibility rechecked, a revoked actor, identical sanitized reads, no PHI, money, payload, browser storage or unsafe errors, no audit on GET')
  check(
    'T091',
    'Historical assignee retained after role removal',
    wHashAfterRoleChange === wHashBeforeRoleChange && dispositionAfterRoleChange.body.dispositionCode === 'ASSIGNED' && dispositionAfterRoleChange.body.assignedMemberId === M1.membershipId && dispositionAfterRoleChange.body.assigneeCurrentlyEligible === false &&
      historyW5.body.items[1].assignedMemberId === M1.membershipId && (await eventsOf(W.intakeId))[1].assignedMemberId === M1.membershipId,
    "removing M1's role rewrote nothing: W's rows are byte-identical, the disposition still names M1 as the assignee and reports it no longer eligible (false), and event 2 still records M1 after the reassignment",
  )
  // M3 records on L (ASSIGNED to M2) as an Admin, then loses its role.
  const L3 = await record(L, giveBack('ASSIGNMENT_INCORRECT'), M3.who)
  await prisma.membershipRole.deleteMany({ where: { membershipId: M3.membershipId } })
  const toRevoked = await record(L, assign(M1.membershipId))
  const toRevokedDirect = await directInsert([assignRow(L, (await eventsOf(L.intakeId)).length + 1, M1.membershipId)])
  const L4 = await record(L, assign(M4.membershipId))
  check(
    'T092',
    'Future assignment rechecks eligibility',
    L3.status === 201 && toRevoked.status === 409 && errorCode(toRevoked.body) === 'EXCEPTION_TRIAGE_ASSIGNEE_NOT_ELIGIBLE' && toRevokedDirect.refused && /exception_triage_assignee/.test(toRevokedDirect.message) && L4.status === 201 && (await disposition(L)).body.assigneeCurrentlyEligible === true,
    "a new assignment to M1 (role removed) is refused 409 by the service and by the database guard; the same request to the eligible M4 is accepted — eligibility is evaluated at each assignment",
  )
  const revokedWrite = await record(L, reassign(M2.membershipId), M3.who)
  const revokedRead = await history(L, M3.who)
  check('T093', 'Role revocation blocks the next write', revokedWrite.status === 403 && revokedRead.status === 403 && (await eventsOf(L.intakeId)).length === 4 && (await eventsOf(L.intakeId))[2].recordedByUserId === M3.id, "M3 recorded L's return while an Admin; once its role is revoked its next write (and read) is 403 and nothing is recorded — its earlier event stays attributed to it")
  const sanitized = await Promise.all([W, L].map(async (k) => withoutEvaluatedAt((await history(k)).body) === withoutEvaluatedAt((await history(k, asViewer)).body) && withoutEvaluatedAt((await disposition(k)).body) === withoutEvaluatedAt((await disposition(k, asViewer)).body)))
  check('T094', 'Admin and Viewer read the same sanitized data', sanitized.every(Boolean), "W's and L's history and disposition are identical for an Admin and a Viewer")
  const triageText = JSON.stringify(await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${TABLE} WHERE claim_id = ANY($1::uuid[])`, runClaims), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  const dtoKeys = [...deepKeys([historyW5.body, dispositionW5.body, (await history(L)).body, (await disposition(L)).body])]
  check(
    'T095',
    'No patient identifiers or diagnoses',
    !COLUMNS.some((c) => /patient|name|birth|email|phone|address|gender|diagnos|clinician|encounter/.test(c)) && !dtoKeys.some((k) => /patient|name|birth|diagnos|clinician|encounter/i.test(k)) && !triageText.includes(`${runId}-home-P`) && !triageText.includes('1990-01-01') && !triageText.includes(key('home-DXA')),
    'no patient, clinical or encounter column or DTO key, and no such value in any stored event of this run',
  )
  check(
    'T096',
    'No monetary, payer or denial claims',
    !COLUMNS.some((c) => /amount|currency|price|balance|payer|payment|denial|outcome/.test(c)) && !dtoKeys.some((k) => /amount|currency|price|balance|payer|payment|denial|outcome|financial/i.test(k)) && !/AED|125\.25|12\.125|DENIED|PAID/.test(triageText),
    'no amount, currency, payer, payment, denial or outcome column, key or value',
  )
  check(
    'T097',
    'No raw intake source payload',
    !COLUMNS.some((c) => /source|basis|identity|fingerprint|payload|reference|narrative|description|note/.test(c)) && !dtoKeys.some((k) => /source|basis|identity|fingerprint|payload|narrative|description|note/i.test(k)) && !triageText.includes(ref('W1-E1')),
    "no intake source, basis, identity, digest, payload or free-text column or key: an event names its intake only by id",
  )
  const feCode = committedProductionCodeOf([FE_DIR]).code
  const moduleCode = committedProductionCodeOf([MODULE_DIR]).code
  check(
    'T098',
    'No browser persistence or log leakage',
    feCode.length > 0 && !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|setInterval|setTimeout|navigator\.sendBeacon/.test(feCode) && !/console\.|logger\.|process\.stdout/.test(moduleCode),
    'the developer page stores nothing in the browser, logs nothing and never polls; the module writes no log',
  )
  const envelopes = [strict[0], (await record(W, classify(), anonymous)), viewerPost, foreignClaim[0], crossTenant, sameAgain]
  check('T099', 'Safe 400/401/403/404/409 envelopes', envelopes.every((r) => same(Object.keys(r.body?.error ?? {}).sort(), ['code', 'message', 'requestId']) && !rawError(r.body)) && envelopes.map((r) => r.status).join('/') === '400/401/403/404/409/409', `400, 401, 403, 404 and 409 refusals carry only code, message and requestId (${envelopes.map((r) => r.status).join('/')}); no SQL, stack, table or guard name`)
  const auditsBeforeGets = await prisma.auditEvent.count()
  for (const k of [W, L, R, K, J, S]) for (const who of [asAdmin, asViewer]) {
    await history(k, who)
    await disposition(k, who)
  }
  await history(F, O.who)
  await disposition(F, O2.who)
  check('T100', 'No audit on any GET', (await prisma.auditEvent.count()) === auditsBeforeGets && (await history(F, O.who)).status === 200, 'twenty-six history and disposition reads in both tenants wrote no audit')

  // ---------------------------------------------------------------- phase separation and ownership (T101–T110)
  section('Phase separation and ownership: every A6/A7 record and A7.6–A7.9 read and every A8.1 intake unchanged; no investigation, resolution, SLA, escalation, export, transport, queue or payment')
  const ownerSnapshotAfter = await snap()
  const ownerReadsAfter = await reads()
  progress(`triage events this run: W ${(await eventsOf(W.intakeId)).length}, L ${(await eventsOf(L.intakeId)).length}, J ${(await eventsOf(J.intakeId)).length}, R ${(await eventsOf(R.intakeId)).length}, K ${(await eventsOf(K.intakeId)).length}, S ${(await eventsOf(S.intakeId)).length}`)
  check('T101', 'A6.7 frozen records unchanged', ownerSnapshotAfter.freezes === ownerSnapshotBefore.freezes, `after every triage write of this run, each freeze and sealed manifest of the ${runClaims.length} Claims is byte-identical`)
  check('T102', 'A6.8 lifecycle events unchanged', ownerSnapshotAfter.lifecycle === ownerSnapshotBefore.lifecycle, 'every lifecycle event is byte-identical')
  check('T103', 'A6.9 correction links unchanged', ownerSnapshotAfter.links === ownerSnapshotBefore.links, "every correction link (N's included) is byte-identical")
  check(
    'T104',
    'A7.1–A7.5 records unchanged',
    ['sources', 'classifications', 'readiness', 'cases', 'assessments'].every((k) => (ownerSnapshotAfter as Record<string, string>)[k] === (ownerSnapshotBefore as Record<string, string>)[k]),
    "every A7.1 source, A7.2 classification, A7.3 readiness, A7.4 case and A7.5 assessment of W and N is byte-identical",
  )
  check(
    'T105',
    'A7.6–A7.9 read results unchanged',
    withoutEvaluatedAt(ownerReadsAfter.trace) === withoutEvaluatedAt(ownerReadsBefore.trace) && withoutEvaluatedAt(ownerReadsAfter.timeline) === withoutEvaluatedAt(ownerReadsBefore.timeline) && withoutEvaluatedAt(ownerReadsAfter.delta) === withoutEvaluatedAt(ownerReadsBefore.delta) &&
      withoutEvaluatedAt(ownerReadsAfter.continuity) === withoutEvaluatedAt(ownerReadsBefore.continuity) && withoutEvaluatedAt(ownerReadsAfter.contradicted) === withoutEvaluatedAt(ownerReadsBefore.contradicted) && ownerReadsBefore.trace?.assessmentId === ASSESS_N.assessmentId,
    "N's A7.6 trace, A7.7 timeline, A7.8 delta and A7.9 continuity, and W's refused A7.7 timeline, read back identically (all but evaluatedAt)",
  )
  check(
    'T106',
    'A8.1 intake immutable',
    ownerSnapshotAfter.intakes === ownerSnapshotBefore.intakes && ownerSnapshotAfter.intakeAudits === ownerSnapshotBefore.intakeAudits && same(ownerReadsAfter.intakes, ownerReadsBefore.intakes) && (await prisma.exceptionIntakeRecord.count({ where: { claimId: K.claimId } })) === 1,
    "every A8.1 intake and its audit is byte-identical, W's intake list reads back identically, and K's concurrent A8.1 request replayed its intake (still one)",
  )
  // Tables that existed on main belong to earlier phases; only what this branch adds is judged. Later phases' tables are
  // those created by migrations committed after A8.2's own merge (none on its own branch).
  const tablesAt = (ref: string) => new Set(migrationDirsAt(ref).flatMap((dir) => [...gitArgs(['show', `${ref}:${dir}/migration.sql`]).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])))
  const mainTables = tablesAt(ownBase)
  const a82Tables = [...committedText(MIGRATION).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
  const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])) : [])
  const newTablesLike = async (pattern: string) => (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`, pattern)).map((r) => r.t).filter((t) => !mainTables.has(t) && !laterPhaseTables.has(t))
  const workflowRoutes = (paths: string[]) => Promise.all(paths.map((p) => post(`${base(W)}/${p}`, {})))
  const investigation = await workflowRoutes(['investigations', 'investigate', 'actions', 'notes'])
  check(
    'T107',
    'No investigation action implemented',
    investigation.every((r) => r.status === 404) && (await newTablesLike('(investigat|remediat|action|finding_note)')).length === 0 && !/investigat|remediat/i.test(moduleCode) && !triageEventCodes.some((c) => /INVESTIGAT|REMEDIAT/.test(c)),
    'no investigation, action or note route, table, event code or module logic',
  )
  const resolution = await workflowRoutes(['resolve', 'close', 'escalate', 'sla'])
  check(
    'T108',
    'No resolution, SLA or escalation fields',
    resolution.every((r) => r.status === 404) && !COLUMNS.some((c) => /resol|sla|due|deadline|escalat|severity|closed/.test(c)) && !dtoKeys.some((k) => /resol|sla|due|deadline|escalat|severity|closed/i.test(k)) && (await newTablesLike('(resolution|escalat|sla|deadline)')).length === 0,
    'no resolve, close, escalate or SLA route, and no resolution, SLA, due date, escalation or severity column, key or table',
  )
  const exportRoutes = await Promise.all([post(`${base(W)}/export`, {}), get(`${base(W)}/audit-package`), post(`/api/claims/${W.claimId}/exception-exports`, {})])
  check(
    'T109',
    'No audit package export or storage',
    exportRoutes.every((r) => r.status === 404) && (await newTablesLike('(export|package|archive|attachment)')).length === 0 && !/from 'node:fs'|writeFile|createWriteStream|Blob\(|attachment/.test(moduleCode + feCode),
    'no export or audit-package route or table, and no file, blob or attachment handling',
  )
  const moneyOrTransport = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|[Bb]alance|[Ll]edger|[Pp]ayment|[Rr]emittance|from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|enqueue|setInterval|worker_threads|cron|\bsla\b/
  const laterTables = await newTablesLike('(work_queue|outbox|transmission|acknowledg|remittance|payment|ledger|receivable|settle|reconcil|_job)')
  check(
    'T110',
    'No A9 transport, queue, payment or revenue closure',
    same(a82Tables, [TABLE]) && mainTables.size > 50 && laterTables.length === 0 && !moneyOrTransport.test(moduleCode) && (await post(`/api/claims/${W.claimId}/payments`, {})).status === 404,
    `the A8.2 migration creates exactly ${TABLE}; no queue, transmission, payment or settlement table or route; the module holds no money, network, queue or job logic`,
  )

  // ---------------------------------------------------------------- regression obligations (T111–T120)
  section('Regression obligations — A8.1 invoked, nesting A7.10 -> A7.9 -> … -> A7.1 -> A6.10 -> … -> A1')
  await apiReady('the A8.1 and backward regression chain')
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const chain = run('npm run test:a8:exception-intake')
  const nestedLog = `a82-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A8.1')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A8.1] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A8.1 asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD) and re-proves A7.10's
  // branch-only causes against its own branch. On A8.2 those statements are obsolete by design; every other A8.1 check
  // is substantive. T120 below proves each cause independently on this branch.
  const a81NonApplicable: Record<string, string> = {
    T001: "A8.1 'A7.10 exact merge ancestor' requires the A8.1 feature branch; A8.2 is branched from the main that contains the A8.1 merge (T001 here)",
    T002: "A8.1 'Clean tree and origin parity' requires tracking origin/feature/a8-1-…; THIS branch's clean tree and parity are proved by T002 here",
    T010: "A8.1 'Changed-file allowlist' lists the paths A8.1 was allowed to change; A8.2 legitimately changes its own (T010 here)",
    T110: "A8.1 'All historical branch N/A causes justified' proves A7.10's branch-only causes against the A8.1 branch; on A8.2 they are re-proved here (T120)",
    T130: "A8.1 'Exact HEAD, clean origin, independent run' compares HEAD with origin/feature/a8-1-…; THIS run's identity and pushed HEAD are proved by T130 here",
  }
  const undocumented = failing.filter((id) => !(id in a81NonApplicable))
  const summary = chain.output.match(/\[A8\.1\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.1\] RUN ABORTED|\[A8\.1\] uncaught error|\[A8\.1\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a81Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  check(
    'T111',
    'A8.1 substantive regression executed',
    ran && reconciled && undocumented.length === 0 && a81Passing === 130 - failing.length && a81Passing >= 125 &&
      ['T004', 'T005', 'T006', 'T007', 'T009', 'T050', 'T100', 'T106', 'T111', 'T119', 'T120', 'T125', 'T126', 'T127', 'T128', 'T129'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A8.1 suite did not complete'
      : !reconciled
        ? `A8.1 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A8.1 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A8\.1\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A8.1] automated summary: ', 'A8.1 ')}; all ${a81Passing} substantive checks PASS (its own-scope T004/T007/T009, the FK-aware T050 and the later-phase-aware T100/T119 included) and every failure is documented`,
  )
  for (const id of Object.keys(a81NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A8.1 ${titleOf(row.line)}`, a81NonApplicable[id])
  }
  check('T112', 'A7.10 substantive integration regression', verdictOf('T101') === 'PASS', `A8.1 T101 (A7.10 with its own justified N/A) ${verdictOf('T101')}`)
  check('T113', 'A7.9 evidence continuity regression', verdictOf('T102') === 'PASS', `A8.1 T102 (A7.9) ${verdictOf('T102')}`)
  check('T114', 'A7.8 delta and A7.7 timeline regressions', verdictOf('T103') === 'PASS' && verdictOf('T104') === 'PASS', `A8.1 T103 (A7.8) ${verdictOf('T103')} and T104 (A7.7) ${verdictOf('T104')}`)
  check('T115', 'A7.6 trace and A7.5 prerequisite regressions', verdictOf('T105') === 'PASS' && verdictOf('T106') === 'PASS', `A8.1 T105 (A7.6) ${verdictOf('T105')} and T106 (A7.5–A7.4) ${verdictOf('T106')}`)
  check('T116', 'A7.4 case and A7.3 readiness regressions', verdictOf('T106') === 'PASS' && verdictOf('T107') === 'PASS', `A8.1 T106 (A7.5–A7.4) ${verdictOf('T106')} and T107 (A7.3–A7.1) ${verdictOf('T107')}`)
  check('T117', 'A7.2 classification and A7.1 source regressions', verdictOf('T107') === 'PASS', `A8.1 T107 (A7.3–A7.1) ${verdictOf('T107')}`)
  check('T118', 'A6.10/A6.1–A6.9 regression chain', verdictOf('T108') === 'PASS', `A8.1 T108 (A6.10, which nests A6.9 → A6.1) ${verdictOf('T108')}`)
  check('T119', 'A5 and A1–A4 substantive regressions', verdictOf('T109') === 'PASS' && verdictOf('T121') === 'PASS', `A8.1 T109 (the A6.10 → A1 chain, which reaches A5.10 → A1) ${verdictOf('T109')}; A8.1 T121 (every A1–A8.1 unit suite) ${verdictOf('T121')}`)
  // Each documented A8.1 failure must fail for its branch-only reason, proved independently on this branch; A8.1
  // T110's unproven A7.10 items are re-proved against this branch too.
  const originOf = (name: string) => gitArgs(['rev-parse', '--verify', '--quiet', `origin/${name}`])
  const originA82 = originOf(a82Branch)
  const a81Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA710 = (lineOfRow('T110').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const nestedA710 = (id: string) => chain.output.split(/\r?\n/).find((line) => new RegExp(`^\\[A8\\.1\\] +nested: \\[A7\\.10\\] ${id} `).test(line)) ?? ''
  const a710Unexpected = (nestedA710('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA79 = (nestedA710('T111').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter((id) => /^T\d{3}$/.test(id))
  const nestedA710Failures = chain.output.split(/\r?\n/).filter((line) => /^\[A8\.1\] +nested: \[A7\.10\] T\d{3} .* \.{3,} FAIL/.test(line)).length
  const a710SelfCount = Number((nestedA710('T130').match(/(\d+) of the 129 checks before this one PASS/) ?? [])[1] ?? -1)
  // A suite lists its unexpected paths and, when package.json carries more than its one script, says so in words; a
  // list cut short may end in a prefix of a path.
  const inScope = (paths: string[]) => paths.length > 0 && paths.every((path, index) => changedPaths.includes(path) || (path === 'package.json beyond the one script' && changedPaths.includes('backend/package.json')) || (index === paths.length - 1 && changedPaths.some((p) => p.startsWith(path))))
  const a710Causes: Record<string, boolean> = {
    T001: branch === a82Branch && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: dirty.length === 0 && tracking.includes(`origin/${a82Branch}`) && !/ahead|behind/.test(tracking),
    T010: inScope(a710Unexpected) && outOfScope.length === 0,
    T111: unprovenA79.length > 0 && unprovenA79.every((id) => ['T001', 'T002', 'T010', 'T120', 'T130'].includes(id)) && originOf(a79Branch) === '' && originOf(a78Branch) === '' && tracking.includes(`origin/${a82Branch}`) && outOfScope.length === 0,
    T122: originOf(a710Branch) === '' && originA82 === headAtStart,
    T123: originOf(a710Branch) === '' && originA82 === headAtStart,
    T130: a710SelfCount === 129 - (nestedA710Failures - 1),
  }
  const causes: Record<string, boolean> = {
    T001: branch === a82Branch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`),
    T002: dirty.length === 0 && tracking.includes(`origin/${a82Branch}`) && !/ahead|behind/.test(tracking),
    T010: inScope(a81Unexpected) && outOfScope.length === 0,
    T110: unprovenA710.length > 0 && unprovenA710.every((id) => id in a710Causes && a710Causes[id]),
    T130: originA82 === headAtStart && originOf(a81Branch) !== headAtStart && failing.every((id) => id in a81NonApplicable),
  }
  const unprovenHere = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A8\.1\] T101\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T120',
    'Every historical N/A branch-only reason proved',
    ran && failing.every((id) => id in a81NonApplicable) && unprovenHere.length === 0 && naLines.length === nestedA710Failures && naLines.length >= 5 && naLines.every((line) => line.length > 80),
    unprovenHere.length === 0
      ? `each documented A8.1 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved independently here (A8.1 T110's A7.10 items ${unprovenA710.join(', ') || 'none'} re-proved); A8.1 itself justifies its ${naLines.length} A7.10 items`
      : `cause not proven for: ${unprovenHere.join(', ')}`,
  )

  // ---------------------------------------------------------------- build and exact evidence (T121–T130)
  section('Build and exact evidence: units, typecheck, frontend, checksums and replay, outage and recovery, no 5xx, synthetic fixtures, the golden triage history after restart, exact head')
  const allUnit = run('npm run test:unit')
  check('T121', 'Backend unit tests pass', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok, `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 10 A8.2 reducer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Backend typecheck clean', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint clean', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build clean', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = applied.filter((row) => {
    const blob = committedBlob(`backend/prisma/migrations/${row.name}/migration.sql`)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  check(
    'T125',
    'Prisma checksum and scratch replay correct',
    status.ok && replay.ok && applied.length === headMigrationDirs.length && same(applied.map((r) => r.name), headMigrationDirs.map((d) => d.split('/').pop())) && checksumMismatch.length === 0,
    checksumMismatch.length === 0 ? `all ${applied.length} committed migrations applied in order, each with the checksum of its committed file (A8.2's included); scratch replay ALL CHECKS PASS (T006)` : `checksum differs: ${checksumMismatch.map((r) => r.name).join(', ')}`,
  )
  await apiReady('the DB outage check')
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
  await waitFor(databaseUp, 60_000)
  check('T126', 'Health 200 / ready 503 / DB recovery', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  check('T127', 'Zero unexpected HTTP 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runEventOrgs = await prisma.$queryRawUnsafe<{ org: string; member: string | null }[]>(
    `SELECT e.organization_id::text AS org, u.email AS member FROM ${TABLE} e LEFT JOIN organization_memberships m ON m.id = e.assigned_member_id LEFT JOIN "user" u ON u.id = m.user_id WHERE e.recorded_at >= $1::timestamptz AND e.recorded_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  const runSources = await prisma.$queryRawUnsafe<{ kind: string; reference: string }[]>(`SELECT source_kind AS kind, source_reference AS reference FROM revenue_source_evidence WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, runStartedAt.toISOString(), chainStartedAt.toISOString())
  const secrets = [adminPassword, viewerPassword, admin.cookie, viewer.cookie, ...[B, M1, M2, M3, M4, NR, O, O2].map((m) => m.cookie)].filter((s) => s.length > 8)
  check(
    'T128',
    'Synthetic-only fixtures and tenant isolation',
    runEventOrgs.length >= 15 && runEventOrgs.every((e) => e.org === org && (e.member === null || e.member === adminEmail || /@reviewers\.sbn\.test$/.test(e.member))) && runSources.length > 0 && runSources.every((s) => s.kind === SYNTHETIC && s.reference.includes(runToken)) &&
      (await eventsOf(F.intakeId)).length === 0 && secrets.every((s) => !printed.join('\n').includes(s) && !chain.output.includes(s)),
    `the ${runEventOrgs.length} triage events this run recorded (before the nested chain) all belong to the synthetic Org A and name only synthetic members; Org B's intake has none; every source is INTERNAL_SYNTHETIC keyed by ${runId}; no password or cookie appears in any output`,
  )
  const historyAfter = await history(W)
  const goldenAfter = { history: withoutEvaluatedAt(historyAfter.body), disposition: withoutEvaluatedAt((await disposition(W)).body), audits: JSON.stringify(await Promise.all(historyAfter.body.items.map(async (e: any) => (await auditsOfEvent(e.triageEventId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))))) }
  progress(`golden triage: Claim W ${W.claimId}, intake ${W.intakeId}: classify(PROVENANCE_INTEGRITY, ELEVATED) → assign M1 → M1's role removed → reassign M2 → return(ASSIGNEE_UNAVAILABLE) → reclassify URGENT; TRIAGED, 5 events, 5 audits; Org B's Admin gets 404`)
  check('T129', 'Golden triage scenario byte-stable after restart', same(goldenAfter, goldenBefore), "after the nested chain, its database restart and an outage, W's five events, its disposition and their five audits read back identically")
  const headNow = git('rev-parse HEAD')
  check(
    'T130',
    'Two full 130-check runs: exact clean pushed HEAD',
    headNow === headAtStart && headNow === originA82 && headNow.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a82Branch}`) && !/ahead|behind/.test(tracking) && outOfScope.length === 0 && /^A82-\d{13}$/.test(runId) && existsSync(nestedLog),
    `all evidence corresponds to ${headNow} (= origin/${a82Branch}); ${tracking}; fresh runId ${runId}; nested output kept in backend/${nestedLog} (SHA-256 ${sha256Of(Buffer.from(chain.output)).slice(0, 16)}…); the two submitted runs must both state this HEAD`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] EXCEPTION TRIAGE ACCEPTANCE COMPLETE` : `[${TAG}] A8.2 FINAL FAIL`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[${TAG}] RUN ABORTED: ${error.message}`)
      console.log(`[${TAG}] No verdict was recorded for the remaining checks, so this run is not evidence of anything.`)
    } else {
      console.error(`[${TAG}] uncaught error (this itself is a FAIL):`, error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      console.log(`[${TAG}] the database container was left stopped; starting it again`)
      spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' })
    }
    await prisma.$disconnect()
  })
