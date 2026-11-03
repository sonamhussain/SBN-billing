import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordTriageEvent } from '../../modules/exception-triage/exception-triage.service.ts'
import { deriveInvestigation } from '../../modules/exception-investigation/exception-investigation.reducer.ts'
import { getInvestigationHistoryOf, getInvestigationSummaryOf, recordInvestigationEvent, recordInvestigationEventOn } from '../../modules/exception-investigation/exception-investigation.service.ts'
import {
  EVIDENCE_CONTRACT_OF,
  INVESTIGATION_CONTRACT_VERSION,
  evidenceKinds,
  findingCodes,
  investigationCodes,
  investigationEventCodes,
} from '../../modules/exception-investigation/exception-investigation.types.ts'

// A8.3 — focused acceptance for Exception Investigation Evidence & Finding History (A8-EXCEPTION-INVESTIGATION-1,
// T001–T130).
//
// Every Claim, freeze, source, case, assessment, A8.1 intake and A8.2 triage event is built through its owners exactly as
// the A8.1 and A8.2 suites build them: a Claim frozen twice without an A6.9 link is a genuine history contradiction, its
// intake is recorded through the A8.1 route, and it is classified and assigned through the A8.2 route. Every
// investigation event is recorded through the A8.3 route by the assigned member or, where a probe must pause or fail one
// writer, through the production A8.3 service in this process. Direct SQL writes are adversarial only, run against the
// live guards (or, to isolate one CHECK, with the triggers off), and are ALWAYS rolled back; a broken stored history is
// planted only inside such a transaction and the production read answers on THAT transaction. Synthetic users are
// provisioned per run through Better Auth's own server-side creation with a random password that is never printed.

const TAG = 'A8.3'
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

const runId = `A83-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a83Branch = 'feature/a8-3-exception-investigation'
const a82Branch = 'feature/a8-2-exception-triage'
const a81Branch = 'feature/a8-1-exception-intake'
const a81FixBranch = 'fix/a8-1-harness-later-phase-recognition'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
const UPSTREAM_BRANCHES = [
  'feature/a6-10-a6-integration-acceptance', 'feature/a7-1-revenue-source-evidence', 'feature/a7-2-evidence-classification', 'feature/a7-3-adjudication-evidence-readiness',
  'feature/a7-4-revenue-evidence-case-assembly', 'feature/a7-5-case-closure-prerequisite-assessment', 'feature/a7-6-closure-basis-trace', 'feature/a7-7-revenue-evidence-timeline', a78Branch, a79Branch, a710Branch, a81Branch, a82Branch,
]
// The accepted A8.2 merge recorded in the register (§1 start gate).
const A82_MERGE = 'b7ccdc5d18f9029d0b6dc2f09521c549e2744abd'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/exception-investigation'
const FE_DIR = 'frontend/src/modules/exception-investigation'
const HARNESS_DIR = 'backend/src/integration/a8-exception-investigation'
const REGISTER_DOC = 'docs/A8_Exception_Investigation.md'
const MIGRATION_NAME = '20261103090000_a8_3_exception_investigation'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const TABLE = 'exception_investigation_events'
const TRIAGE_TABLE = 'exception_triage_events'
const INTAKE_TABLE = 'exception_intake_records'
const UNIT_TESTS = [`${MODULE_DIR}/exception-investigation.reducer.test.ts`, `${MODULE_DIR}/exception-investigation.validation.test.ts`]
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const CONTRACT = 'A8-EXCEPTION-INVESTIGATION-1'
const INTAKE_CONTRACT = 'A8-EXCEPTION-INTAKE-1'
const TRIAGE_CONTRACT = 'A8-EXCEPTION-TRIAGE-1'
const PREREQ_CONTRACT = 'A7-CLOSURE-PREREQ-1'
const TIMELINE_CONTRACT = 'A7-REVENUE-TIMELINE-1'
const EVENT_KEYS = [
  'investigationEventId', 'contractVersion', 'exceptionIntakeId', 'organizationId', 'claimId', 'sequence', 'eventCode', 'evidenceKind', 'evidenceRecordId', 'evidenceContractVersion',
  'evidenceBasisCode', 'linkedEvidenceEventId', 'findingCode', 'recordedByMembershipId', 'recordedByUserId', 'recordedAt',
]
const HISTORY_KEYS = ['contractVersion', 'exceptionIntakeId', 'items', 'evaluatedAt']
const SUMMARY_KEYS = ['contractVersion', 'exceptionIntakeId', 'investigationCode', 'evidenceLinks', 'findings', 'latestFinding', 'eventCount', 'lastSequence', 'evaluatedAt']
const COLUMNS = [
  'id', 'exception_intake_id', 'organization_id', 'claim_id', 'contract_version', 'sequence', 'event_code', 'evidence_kind', 'evidence_record_id', 'evidence_contract_version',
  'evidence_basis_code', 'linked_evidence_event_id', 'finding_code', 'recorded_by_membership_id', 'recorded_by_user_id', 'recorded_at', 'created_at',
]
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/shared/authorization/authorization.types.ts',
  'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'backend/src/modules/audit/audit.types.ts', 'frontend/src/developer/checkRegistry.tsx', REGISTER_DOC,
]
// Every table an investigation write could conceivably touch, in a fixed key order. A read or a refusal must leave every
// one as it was; a recorded event adds exactly one row here and one audit.
const COUNT_TABLES = [TABLE, TRIAGE_TABLE, INTAKE_TABLE, 'audit_events', 'claims', 'claim_freezes', 'claim_freeze_lifecycle_events', 'claim_correction_links', 'evidence_prereq_results', 'organization_memberships', 'membership_roles']

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

// The investigation replayed by THIS suite, independently of the module's reducer, from a history's items.
type HistoryItem = { investigationEventId: string; sequence: number; eventCode: string; evidenceKind: string | null; evidenceRecordId: string | null; evidenceContractVersion: string | null; evidenceBasisCode: string | null; linkedEvidenceEventId: string | null; findingCode: string | null }
function replayIndependently(items: HistoryItem[]) {
  const evidenceLinks = items
    .filter((item) => item.eventCode === 'LINK_EVIDENCE_REFERENCE')
    .map((item) => ({ investigationEventId: item.investigationEventId, sequence: item.sequence, evidenceKind: item.evidenceKind, evidenceRecordId: item.evidenceRecordId, evidenceContractVersion: item.evidenceContractVersion, evidenceBasisCode: item.evidenceBasisCode }))
  const findings = items
    .filter((item) => item.eventCode === 'RECORD_FINDING')
    .map((item) => ({ investigationEventId: item.investigationEventId, sequence: item.sequence, findingCode: item.findingCode, linkedEvidenceEventId: item.linkedEvidenceEventId }))
  return {
    investigationCode: findings.length > 0 ? 'FINDING_RECORDED' : evidenceLinks.length > 0 ? 'EVIDENCE_LINKED' : 'NOT_STARTED',
    evidenceLinks,
    findings,
    latestFinding: findings[findings.length - 1] ?? null,
    eventCount: items.length,
    lastSequence: items.length > 0 ? items[items.length - 1].sequence : null,
  }
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] A8.3 exception investigation evidence & finding history (${CONTRACT}) — run ${runId}`)
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

  // ---------------------------------------------------------------- start gate, ancestry and scope (T001–T010)
  section('Start gate, ancestry and scope: the accepted A8.2 merge, ancestry, one additive migration, Prisma, replay, the narrow permissions, three routes, earlier owners, diff scope')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a82Merge = mergeOf(a82Branch)
  const a81Merge = mergeOf(a81Branch)
  const a81FixMerge = mergeOf(a81FixBranch)
  const a710Merge = mergeOf(a710Branch)
  const upstreamMerges = UPSTREAM_BRANCHES.map((name) => ({ name, sha: mergeOf(name) }))
  check(
    'T001',
    'A8.2 FINAL PASS merge is an ancestor',
    branch === a83Branch && a82Merge === A82_MERGE && gitOk(`merge-base --is-ancestor ${a82Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; A8.2 merged as ${a82Merge.slice(0, 7) || 'NOT FOUND'} (the start gate's recorded ${A82_MERGE.slice(0, 7)}), an ancestor; latest main ${git('rev-parse --short origin/main')} contained; not stacked`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean tree and origin parity at exact HEAD', dirty.length === 0 && tracking.includes(`origin/${a83Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'A6.10/A7.1–A7.10/A8.1/A8.2 ancestry',
    upstreamMerges.every((m) => m.sha.length === 40 && gitOk(`merge-base --is-ancestor ${m.sha} HEAD`)) && a81FixMerge.length === 40 && gitOk(`merge-base --is-ancestor ${a81FixMerge} HEAD`),
    `A6.10, A7.1–A7.10, A8.1 (and its harness correction ${a81FixMerge.slice(0, 7)}) and A8.2 merges (${upstreamMerges.map((m) => m.sha.slice(0, 7)).join(', ')}) are all ancestors of HEAD`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  // A8.3's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge added
  // (the same values, literally, on its own branch). A later package's changes are that package's to prove.
  const ownMerge = branch === a83Branch ? '' : mergeOf(a83Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'
  const ownTip = ownMerge || 'HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = migrationDirsAt(ownTip)
  const ownBaseMigrationDirs = migrationDirsAt(ownBase)
  check(
    'T004',
    'Exactly one A8.3 additive migration',
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
    'Scratch replay equals HEAD migration count',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && /PASS {2}the A8\.3 tables are exactly exception_investigation_events/.test(replay.output) &&
      /PASS {2}exception_investigation_events_insert_guard_trg is present/.test(replay.output) && /PASS {2}one investigation event per \(intake, sequence\) and one link per \(intake, kind, record\) are unique/.test(replay.output) &&
      /PASS {2}the A8\.3 CHECKs pin A8-EXCEPTION-INVESTIGATION-1/.test(replay.output) && /PASS {2}exception_investigation_events carries exactly its 17 A8\.3 columns/.test(replay.output),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD; every A8.3 CHECK, unique index, trigger, column and RESTRICT key survives`,
  )
  const catalogueAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/authorization/authorization.types.ts`]).matchAll(/^\s+'([A-Za-z_]+\.[A-Za-z_]+)',/gm)].map((m) => m[1])
  const catalogueHead = catalogueAt(ownTip)
  const catalogueMain = catalogueAt(ownBase)
  const laterPermissions = ownMerge ? catalogueAt('HEAD').filter((c) => !catalogueHead.includes(c)) : []
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const knownException = ['exceptionIntake.create', 'exceptionIntake.read', 'exceptionTriage.read', 'exceptionTriage.record', 'exceptionInvestigation.read', 'exceptionInvestigation.record']
  check(
    'T007',
    'Narrow approved new permissions and grants',
    same(catalogueHead.filter((c) => !catalogueMain.includes(c)).sort(), ['exceptionInvestigation.read', 'exceptionInvestigation.record']) && catalogueMain.every((c) => catalogueHead.includes(c)) &&
      same(allCodes.filter((c) => /^exceptionInvestigation\./.test(c)).sort(), ['exceptionInvestigation.read', 'exceptionInvestigation.record']) && (await grantsOf('exceptionInvestigation.record')) === 'ORG_ADMIN' &&
      (await grantsOf('exceptionInvestigation.read')) === 'ORG_ADMIN,ORG_VIEWER' && (await grantsOf('exceptionTriage.record')) === 'ORG_ADMIN' && (await grantsOf('exceptionTriage.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('exceptionIntake.read')) === 'ORG_ADMIN,ORG_VIEWER' && !allCodes.some((c) => /^exception/i.test(c) && !knownException.includes(c) && !laterPermissions.includes(c)),
    'the catalogue adds exactly exceptionInvestigation.record (Admin) and exceptionInvestigation.read (Admin, Viewer); the A8.1 and A8.2 grants are unchanged; no permission removed; no resolve, escalate, close or export permission exists',
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
  const as = (cookie: string, extraHeaders: Record<string, string> = {}) => (init: RequestInit = {}) => ({ ...init, headers: { ...init.headers, 'Content-Type': 'application/json', Cookie: cookie, ...extraHeaders } })
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
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /exception_investigation_|exception_triage_|exception_intake_|claim_freeze|organization_memberships/.test(text)
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
    return { id: user.id as string, email, membershipId: membership.id as string, who: as(signed.cookie), cookie: signed.cookie }
  }
  // B approves home freezes; M1 is the worked scenario's first investigator, M2 its next one after a reassignment (and a
  // stale former assignee of K); M4 investigates the other intakes; M5 loses its role after an assignment; NR is a member
  // without any role; O and O2 belong to the other tenant.
  const B = await provisionMember('b')
  const M1 = await provisionMember('m1')
  const M2 = await provisionMember('m2')
  const M4 = await provisionMember('m4')
  const M5 = await provisionMember('m5')
  const NR = await provisionMember('norole', org, false)
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: two organizations; Claims frozen twice without a link, their A8.1 intakes and A8.2 assignments; a normal linked Claim with evidence, case and assessment')
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
  const runToken = runId.replace(/^A83-/, '')
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
  type Intake = { label: string; claimId: string; intakeId: string; organizationId: string; freezes: string[]; basisCode: string; basisRecordId: string }
  // A Claim frozen twice with no A6.9 link (a genuine contradiction the A7.7 owner refuses) and its A8.1 intake,
  // recorded through the A8.1 route; the intake's stored basis is what an INTAKE_BASIS link names.
  const intakeFor = async (label: string, world = home, who: Who = asAdmin): Promise<Intake> => {
    const claim = await world.series(label, 2)
    const res = await post(`/api/claims/${claim.claimId}/exception-intake`, timelineBody(claim.claimId), who)
    if (res.status !== 201) throw new Error(`fixture ${label}: the A8.1 intake was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return { label, claimId: claim.claimId, intakeId: res.body.exceptionIntakeId, organizationId: res.body.organizationId, freezes: claim.freezes, basisCode: res.body.basisCode, basisRecordId: res.body.basisRecordId }
  }
  const base = (k: { claimId: string; intakeId: string }) => `/api/claims/${k.claimId}/exceptions/${k.intakeId}`
  // A8.2 through its own route (the harness's Admin, or another tenant's Admin): classification, assignment, return.
  const triage = async (k: Intake, body: unknown, who: Who = asAdmin) => {
    const res = await post(`${base(k)}/triage-events`, body, who)
    if (res.status !== 201) throw new Error(`fixture ${k.label}: the A8.2 event ${JSON.stringify(body)} was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { triageEventId: string; sequence: number }
  }
  const classify = { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'PROVENANCE_INTEGRITY', priorityCode: 'ELEVATED' }
  const assignTo = (member: { membershipId: string }) => ({ eventCode: 'ASSIGN_OWNER', assignedMemberId: member.membershipId })
  const reassignTo = (member: { membershipId: string }) => ({ eventCode: 'REASSIGN_OWNER', assignedMemberId: member.membershipId })
  const giveBack = { eventCode: 'RETURN_TO_TRIAGE', reasonCode: 'ASSIGNEE_UNAVAILABLE' }
  // W — the worked scenario (§9) and the golden history; its first freeze also carries an A7.1 source, an A7.4 case and
  // an A7.5 assessment. X — a second copy of the scenario whose Claim then receives a later A6.9 correction. L —
  // refusals and a role removal. L0 — kept UNTRIAGED, then TRIAGED. S — direct SQL (never a committed event). J — failure
  // injection, retries and unknown outcomes. R — races. K — the A8.2 interplay (M2 assigned, then M4). F — the other
  // tenant's intake, with its own triage event and assessment.
  const W = await intakeFor('worked')
  await linkedSource(W.freezes[0], 'W1-E1')
  const CASE_W = await caseOf(W.freezes[0])
  const ASSESS_W = await assessmentOf(CASE_W.caseId)
  const X = await intakeFor('drift')
  const L = await intakeFor('refusal')
  const L0 = await intakeFor('untriaged')
  const S = await intakeFor('sql')
  const J = await intakeFor('inject')
  const R = await intakeFor('race')
  const K = await intakeFor('interplay')
  const F = await intakeFor('foreign', away, O.who)
  await linkedSource(F.freezes[0], 'F1-E1', O.who)
  const CASE_F = await caseOf(F.freezes[0], O.who)
  const ASSESS_F = await assessmentOf(CASE_F.caseId, O.who)
  // N — a normal linked Claim with evidence, a case and its assessment: no exception, read through A7.6–A7.9.
  const N = await home.series('normal', 2)
  if ((await post(`/api/claims/${N.claimId}/correction-links`, { priorSubmissionId: N.freezes[0], correctedSubmissionId: N.freezes[1], reasonCode: 'CORRECTED_CODING' })).status !== 201) throw new Error('fixture N: the A6.9 link was refused')
  await linkedSource(N.freezes[0], 'N1-E1')
  const CASE_N = await caseOf(N.freezes[0])
  const ASSESS_N = await assessmentOf(CASE_N.caseId)
  // The A8.2 assignments through the A8.2 route.
  const W_CLASSIFY = await triage(W, classify)
  const W_ASSIGN = await triage(W, assignTo(M1))
  for (const k of [X, L, S, J, R]) {
    await triage(k, classify)
    await triage(k, assignTo(M4))
  }
  await triage(K, classify)
  await triage(K, assignTo(M2))
  await triage(K, reassignTo(M4))
  await triage(F, classify, O.who)
  const F_ASSIGN = await triage(F, assignTo(O), O.who)
  const L_TRIAGE = (await get(`${base(L)}/triage-history`)).body.items as { triageEventId: string }[]
  const homeIntakes = [W, L, L0, S, J, R, K]
  const runClaims = [...homeIntakes.map((k) => k.claimId), N.claimId]
  progress(
    `fixtures ready: two synthetic AE-DU/DHA worlds; ${homeIntakes.length + 1} A8.1 intakes on contradicted Claims in Org A (basis ${W.basisCode}) and one in Org B; W assigned to M1, K to M4 after M2, X/L/S/J/R to M4, L0 untriaged; normal Claim N with case ${CASE_N.assemblyCode} and assessment ${ASSESS_N.assessmentCode}; W's assessment ${ASSESS_W.assessmentCode}`,
  )

  const inv = (k: { claimId: string; intakeId: string }, body: unknown, who: Who) => post(`${base(k)}/investigation-events`, body, who)
  const historyOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/investigation-history`, who)
  const summaryOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/investigation-summary`, who)
  const dispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/triage-disposition`)
  const linkBasis = (k: Intake) => ({ eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS', evidenceRecordId: k.basisRecordId, evidenceContractVersion: INTAKE_CONTRACT })
  const linkTriage = (triageEventId: string) => ({ eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'TRIAGE_EVENT', evidenceRecordId: triageEventId, evidenceContractVersion: TRIAGE_CONTRACT })
  const linkAssessment = (assessmentId: string) => ({ eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'A7_CASE_ASSESSMENT', evidenceRecordId: assessmentId, evidenceContractVersion: PREREQ_CONTRACT })
  const finding = (linkedEvidenceEventId: string, findingCode = 'EVIDENCE_CONFIRMS_RECORDED_CONFLICT') => ({ eventCode: 'RECORD_FINDING', linkedEvidenceEventId, findingCode })
  const eventsOf = (intakeId: string) => prisma.exceptionInvestigationEvent.findMany({ where: { exceptionIntakeId: intakeId }, orderBy: { sequence: 'asc' } })
  const auditsOfEvent = (eventId: string) => prisma.auditEvent.findMany({ where: { entityType: 'EXCEPTION_INVESTIGATION_EVENT', entityId: eventId } })
  const auditsOfIntake = (intakeId: string) => prisma.auditEvent.count({ where: { actionCode: 'exception_investigation.recorded', afterState: { path: ['exceptionIntakeId'], equals: intakeId } } })
  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const plus = (before: Record<string, number>, events: number) => ({ ...before, [TABLE]: before[TABLE] + events, audit_events: before.audit_events + events })
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const rowsHash = (intakeIds: string[]) => hashOf(`SELECT e.* FROM ${TABLE} e WHERE e.exception_intake_id = ANY($1::uuid[])`, intakeIds)
  const rowHash = (eventId: string) => hashOf(`SELECT e.* FROM ${TABLE} e WHERE e.id = $1::uuid`, eventId)
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
  // One direct event row of intake `k`: by default its valid first link — the intake's own basis — recorded through
  // M4's membership (the assignee of S, J, R, L and X).
  const rowOf = (k: Intake, o: Row = {}): Row => ({
    id: randomUUID(), exception_intake_id: k.intakeId, organization_id: k.organizationId, claim_id: k.claimId, contract_version: CONTRACT, sequence: 1, event_code: 'LINK_EVIDENCE_REFERENCE',
    evidence_kind: 'INTAKE_BASIS', evidence_record_id: k.basisRecordId, evidence_contract_version: INTAKE_CONTRACT, evidence_basis_code: k.basisCode, linked_evidence_event_id: null, finding_code: null,
    recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id, recorded_at: null, ...o,
  })
  const findingRow = (k: Intake, sequence: number, linkId: string, o: Row = {}) =>
    rowOf(k, { sequence, event_code: 'RECORD_FINDING', evidence_kind: null, evidence_record_id: null, evidence_contract_version: null, evidence_basis_code: null, linked_evidence_event_id: linkId, finding_code: 'EVIDENCE_INCONCLUSIVE', ...o })
  const insertRow = (tx: DbClient, row: Row) =>
    row.recorded_at === null
      ? tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, evidence_kind, evidence_record_id, evidence_contract_version, evidence_basis_code, linked_evidence_event_id, finding_code, recorded_by_membership_id, recorded_by_user_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8, $9::uuid, $10, $11, $12::uuid, $13, $14::uuid, $15::uuid)`,
          row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.evidence_kind, row.evidence_record_id, row.evidence_contract_version,
          row.evidence_basis_code, row.linked_evidence_event_id, row.finding_code, row.recorded_by_membership_id, row.recorded_by_user_id,
        )
      : tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, evidence_kind, evidence_record_id, evidence_contract_version, evidence_basis_code, linked_evidence_event_id, finding_code, recorded_by_membership_id, recorded_by_user_id, recorded_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8, $9::uuid, $10, $11, $12::uuid, $13, $14::uuid, $15::uuid, $16::timestamptz, $16::timestamptz)`,
          row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.evidence_kind, row.evidence_record_id, row.evidence_contract_version,
          row.evidence_basis_code, row.linked_evidence_event_id, row.finding_code, row.recorded_by_membership_id, row.recorded_by_user_id, row.recorded_at,
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
  // A stored history planted with the triggers off (and, where named, DDL such as a dropped CHECK or index) inside a
  // rolled-back transaction; the production reads answer on THAT transaction.
  const plantedRead = async (k: Intake, rows: Row[], ddl?: string) =>
    rolledBack(async (tx) => {
      if (ddl) await tx.$executeRawUnsafe(ddl)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const row of rows) await insertRow(tx, row)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      return { history: await getInvestigationHistoryOf(k.claimId, k.intakeId, tx), summary: await getInvestigationSummaryOf(k.claimId, k.intakeId, tx) }
    })
  const snap = async () => ({
    freezes: await hashOf(`SELECT f.*, m.id AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    lifecycle: await hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    links: await hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = ANY($1::uuid[])`, runClaims),
    sources: await hashOf(`SELECT r.* FROM revenue_source_evidence r JOIN claim_freezes f ON f.id = r.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    classifications: await hashOf(`SELECT c.* FROM source_evidence_classifications c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id JOIN claim_freezes f ON f.id = r.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    readiness: await hashOf(`SELECT g.* FROM evidence_gate_results g JOIN revenue_source_evidence r ON r.id = g.source_evidence_id JOIN claim_freezes f ON f.id = r.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    cases: await hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM evidence_case_snapshots h JOIN claim_freezes f ON f.id = h.claim_submission_id WHERE f.claim_id = ANY($1::uuid[]) UNION ALL SELECT e.id, row_to_json(e)::text FROM evidence_case_entries e JOIN evidence_case_snapshots h ON h.id = e.assembly_id JOIN claim_freezes f ON f.id = h.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])) x`, [...runClaims, F.claimId]),
    assessments: await hashOf(`SELECT a.* FROM evidence_prereq_results a JOIN evidence_case_snapshots h ON h.id = a.evidence_case_id JOIN claim_freezes f ON f.id = h.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    intakes: await intakeRowsHash([...runClaims, X.claimId, F.claimId]),
    intakeAudits: await hashOf(`SELECT a.id, a.action_code, a.entity_id, a.after_state, a.occurred_at FROM audit_events a WHERE a.entity_type = 'EXCEPTION_INTAKE' AND a.entity_id = ANY($1::uuid[])`, [...homeIntakes, X, F].map((k) => k.intakeId)),
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
  // Every A8.2 triage event that exists before the first investigation write: A8.3 must never change one of them.
  const triageIdsBefore = (await prisma.exceptionTriageEvent.findMany({ where: { exceptionIntakeId: { in: [...homeIntakes, X, F].map((k) => k.intakeId) } }, select: { id: true } })).map((row) => row.id)
  const triageHashBefore = await hashOf(`SELECT t.* FROM ${TRIAGE_TABLE} t WHERE t.id = ANY($1::uuid[])`, triageIdsBefore)

  // ---------------------------------------------------------------- wiring and scope (T008–T010)
  const routeCode = committedCode(`${MODULE_DIR}/exception-investigation.route.ts`)
  const missingClaim = { claimId: MISSING, intakeId: W.intakeId }
  const wiring = [await inv(missingClaim, linkBasis(W), M1.who), await historyOf(missingClaim), await summaryOf(missingClaim)]
  const absent = [
    await api('PATCH', `${base(W)}/investigation-events`, {}), await api('PUT', `${base(W)}/investigation-events`, {}), await api('DELETE', `${base(W)}/investigation-events`), await get(`${base(W)}/investigation-events`),
    await get(`${base(W)}/investigation-events/${MISSING}`), await api('PUT', `${base(W)}/investigation-summary`, {}), await post(`${base(W)}/investigation-summary`, {}), await post(`${base(W)}/investigation-history`, {}),
    await post(`${base(W)}/findings`, {}), await post(`${base(W)}/evidence-links`, {}), await post(`${base(W)}/resolve`, {}), await post(`${base(W)}/close`, {}), await post(`${base(W)}/investigation-complete`, {}),
    await get(`${base(W)}/investigation-current`), await get('/api/exception-investigations'), await get(`/api/claims/${W.claimId}/investigations`), await get('/api/investigation-events'),
  ]
  check(
    'T008',
    'Exactly three approved routes',
    wiring.every((r) => r.status === 404 && errorCode(r.body) === 'NOT_FOUND') && absent.every((r) => r.status === 404) &&
      (routeCode.match(/exceptionInvestigationRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 3 && /exceptionInvestigationRouter\.post\(`\$\{BASE\}\/investigation-events`/.test(routeCode) &&
      /exceptionInvestigationRouter\.get\(`\$\{BASE\}\/investigation-history`/.test(routeCode) && /exceptionInvestigationRouter\.get\(`\$\{BASE\}\/investigation-summary`/.test(routeCode) && /const BASE = '\/:claimId\/exceptions\/:exceptionIntakeId'/.test(routeCode),
    `the POST and both GETs answer a missing Claim with a privacy-safe 404; PATCH/PUT/DELETE, an event by id, a current selector, separate finding or link routes, resolve, close, a collection and cross-Claim searches are absent (${absent.map((r) => r.status).join('/')})`,
  )
  const contractConstantsAt = (ref: string) =>
    gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, 'backend/src/modules'])
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path) && !path.startsWith(`${MODULE_DIR}/`))
      .flatMap((path) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(/export const ([A-Z_]*CONTRACT_VERSION) = '([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`))
      .sort()
  const contractsOwn = contractConstantsAt(ownTip)
  const productDiff = ownChangedPaths.filter((p) => /^backend\/src\/modules\//.test(p) && !p.startsWith(`${MODULE_DIR}/`) && p !== 'backend/src/modules/audit/audit.types.ts')
  const ownEarlierSuites = ownChangedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`))
  const ownEarlierUnits = ownChangedPaths.filter((file) => /\.test\.tsx?$/.test(file) && !file.startsWith(`${MODULE_DIR}/`))
  check(
    'T009',
    'Earlier owners, migrations and tests unchanged',
    contractsOwn.length >= 21 && same(contractsOwn, contractConstantsAt(ownBase)) && productDiff.length === 0 && ownEarlierSuites.length === 0 && ownEarlierUnits.length === 0 &&
      ownPrismaStatus.every((s) => !/^M\tbackend\/prisma\/migrations\//.test(s)) && committedText(`${MODULE_DIR}/exception-investigation.types.ts`).includes(`INVESTIGATION_CONTRACT_VERSION = '${CONTRACT}'`),
    `all ${contractsOwn.length} A1–A8.2 owner contracts identical to main; no earlier module's code, integration suite, unit test or applied migration changed`,
  )
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${FE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file))
  const earlierSuites = changedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`))
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a9|dhpo|eclaimlink|remediat|resolution|escalat|export|work-queue|\bsla\b/i.test(file))
  check(
    'T010',
    'Changed-file allowlist excludes later phases',
    changedPaths.length > 0 && outOfScope.length === 0 && earlierSuites.length === 0 && laterDomain.length === 0,
    outOfScope.length + earlierSuites.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A8.3 module, page, harness, migration and register and the narrow shared additions; no earlier suite changed; no A8.4+ or A9 domain`
      : `unexpected: ${[...new Set([...outOfScope, ...earlierSuites, ...laterDomain])].join(', ').slice(0, 300)}`,
  )

  // ---------------------------------------------------------------- event contract and input validation (T011–T020)
  section('Event contract and input validation: the v1 literal and DTOs, strict link and finding keys, server-owned fields, malformed ids, unknown kinds, contracts and codes, narrative and injection')
  const countsAtStart = await counts()
  const notStartedW = { summary: await summaryOf(W), history: await historyOf(W), rows: (await eventsOf(W.intakeId)).length, disposition: (await dispositionOf(W)).body }
  const W1 = await inv(W, linkBasis(W), M1.who)
  const contractDef = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${TABLE}_contract_chk'`))[0]?.d ?? ''
  const historyW1 = await historyOf(W)
  const summaryW1 = await summaryOf(W)
  check(
    'T011',
    'Exact v1 contract and DTO shape',
    W1.status === 201 && W1.body.contractVersion === CONTRACT && INVESTIGATION_CONTRACT_VERSION === CONTRACT && same(Object.keys(W1.body), EVENT_KEYS) && same(Object.keys(historyW1.body), HISTORY_KEYS) &&
      same(Object.keys(summaryW1.body), SUMMARY_KEYS) && historyW1.body.contractVersion === CONTRACT && summaryW1.body.contractVersion === CONTRACT && contractDef.includes(`'${CONTRACT}'`) && /IS NOT NULL/.test(contractDef),
    `the first event on W carries ${CONTRACT} and exactly the ${EVENT_KEYS.length} event keys; the history and summary carry exactly theirs; the database CHECK pins the literal`,
  )
  const strictLink = [
    await inv(W, { ...linkBasis(W), findingCode: 'EVIDENCE_INCONCLUSIVE' }, M1.who), await inv(W, { ...linkBasis(W), linkedEvidenceEventId: W1.body.investigationEventId }, M1.who),
    await inv(W, { eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS', evidenceRecordId: W.basisRecordId }, M1.who), await inv(W, { eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS' }, M1.who),
    await inv(W, { ...linkBasis(W), evidenceRecordId: 42 }, M1.who), await inv(W, {}, M1.who), await inv(W, [linkBasis(W)], M1.who),
  ]
  check('T012', 'Strict link event keys', strictLink.every((r) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR') && (await eventsOf(W.intakeId)).length === 1, "a link with a finding field, a missing contract or record, a non-string record, an empty object or an array is a 400; nothing recorded")
  const strictFinding = [
    await inv(W, { ...finding(W1.body.investigationEventId), evidenceKind: 'INTAKE_BASIS' }, M1.who), await inv(W, { ...finding(W1.body.investigationEventId), evidenceRecordId: W.basisRecordId }, M1.who),
    await inv(W, { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: W1.body.investigationEventId }, M1.who), await inv(W, { eventCode: 'RECORD_FINDING', findingCode: 'EVIDENCE_INCONCLUSIVE' }, M1.who),
    await inv(W, { ...finding(W1.body.investigationEventId), findingCode: null }, M1.who),
  ]
  check('T013', 'Strict finding event keys', strictFinding.every((r) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR') && (await eventsOf(W.intakeId)).length === 1, 'a finding with an evidence field, without its link or its code, or with a null code is a 400; nothing recorded')
  const serverOwned = await Promise.all(
    ['id', 'investigationEventId', 'sequence', 'organizationId', 'claimId', 'exceptionIntakeId', 'recordedByUserId', 'recordedByMembershipId', 'actorUserId', 'recordedAt', 'contractVersion', 'evidenceBasisCode', 'investigationCode'].map((k) =>
      inv(W, { ...linkTriage(W_ASSIGN.triageEventId), [k]: k === 'sequence' ? 2 : k === 'recordedAt' ? '2020-01-01T00:00:00.000Z' : k === 'contractVersion' ? CONTRACT : k === 'evidenceBasisCode' ? 'UNLINKED_FROZEN_SUBMISSION' : k === 'investigationCode' ? 'FINDING_RECORDED' : MISSING }, M1.who),
    ),
  )
  const queried = await post(`${base(W)}/investigation-events?sequence=2`, linkTriage(W_ASSIGN.triageEventId), M1.who)
  check(
    'T014',
    'Reject client sequence, actor, organization and time',
    serverOwned.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && queried.status === 400 && (await eventsOf(W.intakeId)).length === 1,
    'an id, sequence, organization, Claim, intake, actor, membership, time, contract, basis code or state in the body, or a query parameter, is refused (400): the server owns them',
  )
  const badIds = ['not-a-uuid', MISSING.replace(/-/g, ''), `${MISSING}0`, encodeURIComponent("1' OR '1'='1")]
  const malformedClaim = [
    ...(await Promise.all(badIds.map((id) => inv({ claimId: id, intakeId: W.intakeId }, linkBasis(W), M1.who)))),
    ...(await Promise.all(badIds.map((id) => historyOf({ claimId: id, intakeId: W.intakeId })))),
    ...(await Promise.all(badIds.map((id) => summaryOf({ claimId: id, intakeId: W.intakeId })))),
  ]
  const malformedIntake = [
    ...(await Promise.all(badIds.map((id) => inv({ claimId: W.claimId, intakeId: id }, linkBasis(W), M1.who)))),
    ...(await Promise.all(badIds.map((id) => historyOf({ claimId: W.claimId, intakeId: id })))),
    ...(await Promise.all(badIds.map((id) => summaryOf({ claimId: W.claimId, intakeId: id })))),
  ]
  const malformedReference = [
    ...(await Promise.all(['not-a-uuid', `${W.basisRecordId}0`, W.basisRecordId.replace(/-/g, '')].map((id) => inv(W, { ...linkBasis(W), evidenceRecordId: id }, M1.who)))),
    ...(await Promise.all(['not-a-uuid', `${MISSING}0`].map((id) => inv(W, finding(id), M1.who)))),
  ]
  check(
    'T015',
    'Malformed Claim/intake/reference UUID safe 400',
    malformedClaim.every((r) => r.status === 400 && /invalid claim id/.test(errorMessage(r.body)) && !rawError(r.body)) && malformedIntake.every((r) => r.status === 400 && /invalid exception intake id/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      malformedReference.every((r) => r.status === 400 && /invalid (evidence record|linked evidence event) id/.test(errorMessage(r.body)) && !rawError(r.body)) && (await eventsOf(W.intakeId)).length === 1,
    `malformed and SQL-shaped Claim and intake ids on all three routes, and malformed evidence-record and linked-event ids, are each a safe 400 (${[...new Set([...malformedClaim, ...malformedIntake, ...malformedReference].map((r) => r.status))].join('/')})`,
  )
  const unknownKinds = await Promise.all(['EXTERNAL_URL', 'CLAIM_SUBMISSION', 'REVENUE_SOURCE_EVIDENCE', 'intake_basis', '', null, 7].map((kind) => inv(W, { ...linkBasis(W), evidenceKind: kind }, M1.who)))
  check('T016', 'Unknown evidence kind safe 400', unknownKinds.every((r) => r.status === 400 && /unknown evidence kind/.test(errorMessage(r.body)) && !rawError(r.body)), `only ${evidenceKinds.join(', ')} are accepted`)
  const wrongContracts = [
    await inv(W, { ...linkBasis(W), evidenceContractVersion: 'A8-EXCEPTION-INTAKE-2' }, M1.who), await inv(W, { ...linkBasis(W), evidenceContractVersion: TRIAGE_CONTRACT }, M1.who),
    await inv(W, { ...linkTriage(W_ASSIGN.triageEventId), evidenceContractVersion: 'A8-EXCEPTION-TRIAGE-2' }, M1.who), await inv(W, { ...linkTriage(W_ASSIGN.triageEventId), evidenceContractVersion: INTAKE_CONTRACT }, M1.who),
    await inv(W, { ...linkAssessment(ASSESS_W.assessmentId), evidenceContractVersion: 'A7-CLOSURE-PREREQ-2' }, M1.who), await inv(W, { ...linkAssessment(ASSESS_W.assessmentId), evidenceContractVersion: '' }, M1.who),
  ]
  check('T017', 'Future or wrong source contract refused', wrongContracts.every((r) => r.status === 400 && /is accepted only under/.test(errorMessage(r.body))) && (await eventsOf(W.intakeId)).length === 1, `each kind is accepted only under its one contract (${Object.values(EVIDENCE_CONTRACT_OF).join(', ')}); a future, older or another owner's contract is a 400`)
  const unknownEvents = await Promise.all(['RESOLVE_EXCEPTION', 'CLOSE', 'ASSIGN_OWNER', 'record_finding', '', 'INVESTIGATE'].map((eventCode) => inv(W, { eventCode }, M1.who)))
  const unknownFindings = await Promise.all(['PAYMENT_DENIED', 'RESOLVED', 'OVERPAID', 'evidence_inconclusive', '', 3].map((code) => inv(W, finding(W1.body.investigationEventId, code as string), M1.who)))
  check(
    'T018',
    'Unknown finding/event codes refused',
    unknownEvents.every((r) => r.status === 400 && /unknown investigation event code/.test(errorMessage(r.body))) && unknownFindings.every((r) => r.status === 400 && /unknown finding code/.test(errorMessage(r.body))) && (await eventsOf(W.intakeId)).length === 1,
    `only ${investigationEventCodes.join(', ')} and the findings ${findingCodes.join(', ')} are accepted`,
  )
  const narrative = await Promise.all(
    [
      { note: 'free text' }, { narrative: 'free text' }, { description: 'free text' }, { patientName: `${runId}-home-P` }, { dateOfBirth: '1990-01-01' }, { diagnosisCode: key('home-DXA') },
      { attachment: 'c3ludGhldGlj' }, { url: 'https://example.invalid/evidence' }, { payload: { a: 1 } }, { amount: '125.25' },
    ].map((extra) => inv(W, { ...finding(W1.body.investigationEventId), ...extra }, M1.who)),
  )
  check('T019', 'Uncontrolled narrative/PHI fields refused', narrative.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && (await eventsOf(W.intakeId)).length === 1, 'a note, narrative, description, patient name, birth date, diagnosis, attachment, URL, payload or amount is refused (400); nothing recorded')
  const injection = [
    await inv(W, { ...linkBasis(W), evidenceRecordId: "1' OR '1'='1" }, M1.who), await inv(W, { ...linkBasis(W), evidenceRecordId: '../../etc/passwd' }, M1.who), await inv(W, { ...linkBasis(W), evidenceRecordId: { $ne: null } }, M1.who),
    await inv(W, { ...linkBasis(W), evidenceKind: '../INTAKE_BASIS' }, M1.who), await inv(W, finding(W1.body.investigationEventId, "EVIDENCE_INCONCLUSIVE'; DROP TABLE claims; --"), M1.who),
    await inv(W, JSON.parse(`{"__proto__": {"eventCode": "RECORD_FINDING"}, "linkedEvidenceEventId": "${W1.body.investigationEventId}", "findingCode": "EVIDENCE_INCONCLUSIVE"}`), M1.who),
    await inv(W, JSON.parse(`{"eventCode": "RECORD_FINDING", "linkedEvidenceEventId": "${W1.body.investigationEventId}", "findingCode": "EVIDENCE_INCONCLUSIVE", "constructor": {"prototype": {"admin": true}}}`), M1.who),
  ]
  check(
    'T020',
    'SQL-shaped, prototype and traversal input refused',
    injection.every((r) => r.status === 400 && !rawError(r.body)) && (await eventsOf(W.intakeId)).length === 1 && (await unchanged(plus(countsAtStart, 1))),
    "SQL-, operator-, traversal- and prototype-shaped values are refused with a safe body; only W's one valid event and its audit exist",
  )

  // ---------------------------------------------------------------- permission and membership boundaries (T021–T030)
  section('Permission and membership boundaries: 401, Viewer 403, the assigned member 201, readers 200, foreign Claim, intake and reference = missing, stale or revoked members')
  check('T021', 'Anonymous POST 401', (await inv(W, finding(W1.body.investigationEventId), anonymous)).status === 401, 'no session: 401 before any lookup')
  check('T022', 'Anonymous GET 401', (await historyOf(W, anonymous)).status === 401 && (await summaryOf(W, anonymous)).status === 401, 'no session: 401 on the history and the summary')
  const viewerPost = await inv(W, finding(W1.body.investigationEventId), asViewer)
  check('T023', 'Viewer POST 403', viewerPost.status === 403 && (await eventsOf(W.intakeId)).length === 1, 'a Viewer (exceptionInvestigation.read only) is refused 403 and nothing is recorded')
  check(
    'T024',
    'Authorized assigned actor POST 201',
    W1.status === 201 && W1.body.recordedByMembershipId === M1.membershipId && W1.body.recordedByUserId === M1.id && W1.body.claimId === W.claimId && W1.body.organizationId === org && W1.body.exceptionIntakeId === W.intakeId && W1.body.sequence === 1,
    "M1, to whom A8.2 assigned W, records W's first event (201) as itself and through its own membership, numbered 1, in its own organization and Claim",
  )
  const viewerHistory = await historyOf(W, asViewer)
  check('T025', 'Authorized reader history 200', historyW1.status === 200 && historyW1.body.items.length === 1 && same(historyW1.body.items[0], W1.body) && viewerHistory.status === 200 && withoutEvaluatedAt(viewerHistory.body) === withoutEvaluatedAt(historyW1.body), "an Admin and a Viewer read W's history: exactly the recorded event")
  const viewerSummary = await summaryOf(W, asViewer)
  check('T026', 'Authorized reader summary 200', summaryW1.status === 200 && summaryW1.body.investigationCode === 'EVIDENCE_LINKED' && viewerSummary.status === 200 && withoutEvaluatedAt(viewerSummary.body) === withoutEvaluatedAt(summaryW1.body), 'an Admin and a Viewer read the same derived summary (EVIDENCE_LINKED)')
  const missingEnvelope = (r: { body: any }) => ({ ...r.body?.error, requestId: null })
  const foreignClaim = [await inv(F, linkBasis(F), asAdmin), await historyOf(F), await summaryOf(F)]
  const missingClaimReads = [await inv({ claimId: MISSING, intakeId: F.intakeId }, linkBasis(F), asAdmin), await historyOf({ claimId: MISSING, intakeId: F.intakeId }), await summaryOf({ claimId: MISSING, intakeId: F.intakeId })]
  check(
    'T027',
    'Foreign Claim equals missing 404',
    foreignClaim.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingClaimReads[i]))) && (await eventsOf(F.intakeId)).length === 0,
    "another organization's Claim and intake get exactly the missing-Claim envelope on all three routes; nothing recorded",
  )
  const foreignIntake = [await inv({ claimId: W.claimId, intakeId: F.intakeId }, linkBasis(W), M1.who), await historyOf({ claimId: W.claimId, intakeId: F.intakeId }), await summaryOf({ claimId: W.claimId, intakeId: F.intakeId })]
  const otherClaimIntake = [await inv({ claimId: W.claimId, intakeId: L.intakeId }, linkBasis(L), M1.who), await historyOf({ claimId: W.claimId, intakeId: L.intakeId })]
  const missingIntake = [await inv({ claimId: W.claimId, intakeId: MISSING }, linkBasis(W), M1.who), await historyOf({ claimId: W.claimId, intakeId: MISSING }), await summaryOf({ claimId: W.claimId, intakeId: MISSING })]
  check(
    'T028',
    'Foreign intake equals missing 404',
    foreignIntake.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[i]))) && otherClaimIntake.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[0]))) && (await eventsOf(L.intakeId)).length === 0,
    "another tenant's intake, or another Claim's intake of this tenant, named under W's Claim is exactly the missing-intake 404; nothing recorded",
  )
  const missingReference = await inv(W, linkTriage(MISSING), M1.who)
  const foreignReferences = [await inv(W, linkTriage(F_ASSIGN.triageEventId), M1.who), await inv(W, linkAssessment(ASSESS_F.assessmentId), M1.who), await inv(W, { ...linkBasis(W), evidenceRecordId: F.basisRecordId }, M1.who)]
  check(
    'T029',
    'Foreign reference equals missing 404',
    missingReference.status === 404 && foreignReferences.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingReference))) && (await eventsOf(W.intakeId)).length === 1,
    "the other tenant's triage event, assessment and intake basis, linked on W, are each exactly the missing-reference 404; nothing recorded",
  )
  const staleOnK = await inv(K, linkBasis(K), M2.who)
  const revokedOnK = await inv(K, linkBasis(K), NR.who)
  check(
    'T030',
    'Stale or revoked member denied before insert',
    staleOnK.status === 409 && errorCode(staleOnK.body) === 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE' && revokedOnK.status === 403 && (await eventsOf(K.intakeId)).length === 0 && !rawError(staleOnK.body),
    "M2, assigned K before A8.2 reassigned it to M4, is refused 409 (not the current assignee); a member without any role is refused 403; nothing recorded on K",
  )

  // ---------------------------------------------------------------- exact source evidence (T031–T040)
  section('Exact source evidence: the A8.1 basis, an A8.2 triage event and an A7.5 assessment of exactly this intake, Claim and organization; unsupported, missing, cross-Claim and cross-tenant references; no digest; later changes; no automatic import')
  const dispositionBeforeW2 = (await dispositionOf(W)).body
  const W2 = await inv(W, finding(W1.body.investigationEventId), M1.who)
  const basisJoin = (await prisma.$queryRawUnsafe<{ ok: boolean }[]>(
    `SELECT (e.evidence_record_id = i.basis_record_id AND e.evidence_basis_code = i.basis_code AND e.evidence_contract_version = i.contract_version) AS ok FROM ${TABLE} e JOIN ${INTAKE_TABLE} i ON i.id = e.exception_intake_id WHERE e.id = $1::uuid`,
    W1.body.investigationEventId,
  ))[0]
  check(
    'T031',
    'Link existing A8.1 parent basis exactly',
    W1.body.evidenceKind === 'INTAKE_BASIS' && W1.body.evidenceRecordId === W.basisRecordId && W1.body.evidenceBasisCode === W.basisCode && W.basisCode === 'UNLINKED_FROZEN_SUBMISSION' && W1.body.evidenceContractVersion === INTAKE_CONTRACT && basisJoin?.ok === true,
    `W's link names exactly its intake's stored basis record (${W.basisRecordId.slice(0, 8)}…, the latest unlinked freeze) and basis code ${W.basisCode} under ${INTAKE_CONTRACT}; the stored row equals the intake's own columns`,
  )
  const W3 = await inv(W, linkTriage(W_ASSIGN.triageEventId), M1.who)
  const otherIntakeTriage = await inv(W, linkTriage(L_TRIAGE[0].triageEventId), M1.who)
  check(
    'T032',
    'Triage event link belongs to same intake',
    W3.status === 201 && W3.body.sequence === 3 && W3.body.evidenceRecordId === W_ASSIGN.triageEventId && W3.body.evidenceBasisCode === null && otherIntakeTriage.status === 404 && same(missingEnvelope(otherIntakeTriage), missingEnvelope(missingReference)),
    "W's own A8.2 assignment event links (201, event 3); L's triage event of the same organization, named on W, is the missing-reference 404",
  )
  const W4 = await inv(W, linkAssessment(ASSESS_W.assessmentId), M1.who)
  const otherClaimAssessment = await inv(W, linkAssessment(ASSESS_N.assessmentId), M1.who)
  check(
    'T033',
    'A7 assessment link belongs to same Claim/org',
    W4.status === 201 && W4.body.sequence === 4 && W4.body.evidenceRecordId === ASSESS_W.assessmentId && W4.body.evidenceContractVersion === PREREQ_CONTRACT && otherClaimAssessment.status === 404,
    "the A7.5 assessment of W's own case links (201, event 4), verified through the A7.5 owner path; N's assessment (same organization, another Claim) is 404",
  )
  const unsupportedKinds = await Promise.all(['CLAIM_SUBMISSION', 'REVENUE_SOURCE_EVIDENCE', 'EVIDENCE_CASE', 'A7_CASE'].map((kind) => inv(W, { ...linkBasis(W), evidenceKind: kind }, M1.who)))
  const wrongOwner = [
    await inv(W, linkAssessment(W.freezes[0]), M1.who), await inv(W, linkAssessment(CASE_W.caseId), M1.who), await inv(W, { ...linkBasis(W), evidenceRecordId: W.intakeId }, M1.who),
    await inv(W, linkTriage(W.intakeId), M1.who), await inv(W, linkTriage(W1.body.investigationEventId), M1.who),
  ]
  check(
    'T034',
    'Refuse unsupported reference owner',
    unsupportedKinds.every((r) => r.status === 400) && wrongOwner.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingReference))) && (await eventsOf(W.intakeId)).length === 4,
    "an unapproved owner kind is a 400; a freeze or a case named as an assessment, the intake itself named as its basis, and an intake or an investigation event named as a triage event are each the missing-reference 404",
  )
  const missingRefs = [await inv(W, linkTriage(MISSING), M1.who), await inv(W, linkAssessment(MISSING), M1.who), await inv(W, { ...linkBasis(W), evidenceRecordId: MISSING }, M1.who)]
  check('T035', 'Refuse nonexistent reference', missingRefs.every((r) => r.status === 404 && errorCode(r.body) === 'NOT_FOUND' && same(missingEnvelope(r), missingEnvelope(missingReference))) && (await eventsOf(W.intakeId)).length === 4, 'a record that does not exist is a 404 under every kind, with one identical envelope; nothing recorded')
  const crossClaim = [otherClaimAssessment, otherIntakeTriage, await inv(W, { ...linkBasis(W), evidenceRecordId: L.basisRecordId }, M1.who)]
  const crossClaimDirect = [
    await directInsert([rowOf(S, { evidence_kind: 'A7_CASE_ASSESSMENT', evidence_record_id: ASSESS_N.assessmentId, evidence_contract_version: PREREQ_CONTRACT, evidence_basis_code: null })]),
    await directInsert([rowOf(S, { evidence_kind: 'TRIAGE_EVENT', evidence_record_id: L_TRIAGE[0].triageEventId, evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null })]),
    await directInsert([rowOf(S, { evidence_record_id: L.basisRecordId })]),
  ]
  check(
    'T036',
    'Refuse cross-Claim same-org reference',
    crossClaim.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingReference))) && crossClaimDirect.every((r) => r.refused && /exception_investigation_evidence/.test(r.message) && r.clean),
    "another Claim's assessment, triage event or intake basis of the same organization is the missing-reference 404 through the API, and refused by the evidence guard as a direct row",
  )
  const crossOrgDirect = [
    await directInsert([rowOf(S, { evidence_kind: 'A7_CASE_ASSESSMENT', evidence_record_id: ASSESS_F.assessmentId, evidence_contract_version: PREREQ_CONTRACT, evidence_basis_code: null })]),
    await directInsert([rowOf(S, { evidence_kind: 'TRIAGE_EVENT', evidence_record_id: F_ASSIGN.triageEventId, evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null })]),
    await directInsert([rowOf(S, { evidence_record_id: F.basisRecordId })]),
  ]
  check(
    'T037',
    'Refuse cross-organization reference',
    foreignReferences.every((r) => r.status === 404) && crossOrgDirect.every((r) => r.refused && /exception_investigation_evidence/.test(r.message) && r.clean) && (await eventsOf(W.intakeId)).length === 4,
    "the other tenant's assessment, triage event and intake basis are the missing-reference 404 (T029) and refused by the evidence guard as direct rows",
  )
  const wrongBasisCode = await directInsert([rowOf(S, { evidence_basis_code: 'ASSESSMENT_REVIEW_REQUIRED' })])
  check(
    'T038',
    'Owner digest is never invented',
    !COLUMNS.some((c) => /digest|fingerprint|sha|hash|manifest/.test(c)) && ![...deepKeys([W1.body, summaryW1.body])].some((k) => /digest|fingerprint|sha|hash|manifest/i.test(k)) && W3.body.evidenceBasisCode === null && W4.body.evidenceBasisCode === null &&
      W1.body.evidenceBasisCode === W.basisCode && wrongBasisCode.refused && /exception_investigation_evidence/.test(wrongBasisCode.message) && serverOwned.some((r) => r.status === 400),
    "no digest, fingerprint or hash column or key exists; the only copied fact is the intake's own basis code, taken from the A8.1 owner (a client value is refused, T014) and held equal to the intake by the database",
  )
  // §9 on X: a link of the basis and a finding, then a later A6.9 correction of X's Claim through its owner.
  const X1 = await inv(X, linkBasis(X), M4.who)
  const X2 = await inv(X, finding(X1.body.investigationEventId), M4.who)
  const xHashBefore = await rowsHash([X.intakeId])
  const xSummaryBefore = withoutEvaluatedAt((await summaryOf(X)).body)
  const xIntakeBefore = await intakeRowsHash([X.claimId])
  const xTimelineBefore = await get(`/api/claims/${X.claimId}/revenue-evidence-timeline`)
  const correction = await post(`/api/claims/${X.claimId}/correction-links`, { priorSubmissionId: X.freezes[0], correctedSubmissionId: X.freezes[1], reasonCode: 'CORRECTED_CODING' })
  const xTimelineAfter = await get(`/api/claims/${X.claimId}/revenue-evidence-timeline`)
  check(
    'T039',
    'Historical source truth preserved on later changes',
    X1.status === 201 && X2.status === 201 && correction.status === 201 && withoutEvaluatedAt(xTimelineAfter.body) !== withoutEvaluatedAt(xTimelineBefore.body) && (await rowsHash([X.intakeId])) === xHashBefore &&
      withoutEvaluatedAt((await summaryOf(X)).body) === xSummaryBefore && (await intakeRowsHash([X.claimId])) === xIntakeBefore,
    `a later A6.9 correction of X's Claim changed its A7.7 timeline (${xTimelineBefore.status} → ${xTimelineAfter.status}), yet X's intake, its basis link and its finding are byte-identical and the summary reads back the same`,
  )
  const sOwnerReads = [await get(`/api/claims/${S.claimId}/revenue-evidence-timeline`), await get(`/api/claims/${S.claimId}/revenue-evidence-delta`), await get(`/api/claims/${S.claimId}/revenue-evidence-continuity`), await get(`/api/claims/${S.claimId}/exception-intake`)]
  const sSummary = await summaryOf(S)
  const moduleCode = committedProductionCodeOf([MODULE_DIR]).code
  check(
    'T040',
    'No automatic evidence import from A7 gaps',
    sOwnerReads.every((r) => r.status < 500) && (await eventsOf(S.intakeId)).length === 0 && (await eventsOf(L0.intakeId)).length === 0 && (await eventsOf(K.intakeId)).length === 0 && sSummary.body.investigationCode === 'NOT_STARTED' &&
      !/revenue-timeline|revenue-delta|revenue-continuity|evidence-gate|evidence-classification|revenue-evidence\/|closure-basis-trace|setInterval|cron|enqueue/.test(moduleCode),
    "S, L0 and K — each an exception with A7 evidence absent and S read through A7.7–A7.9 and A8.1 — hold no investigation event and S derives NOT_STARTED; the module reads no A7 gap or timeline owner and schedules nothing",
  )

  // ---------------------------------------------------------------- legal investigation sequence (T041–T050)
  section('Legal investigation sequence on W: NOT_STARTED, links from an ASSIGNED intake, contiguous numbers, evidence before findings, controlled codes, appended findings, no assignment or resolution event')
  check(
    'T041',
    'Zero event history returns NOT_STARTED',
    notStartedW.rows === 0 && notStartedW.summary.status === 200 && notStartedW.summary.body.investigationCode === 'NOT_STARTED' && notStartedW.summary.body.eventCount === 0 && notStartedW.summary.body.lastSequence === null &&
      notStartedW.summary.body.latestFinding === null && same(notStartedW.summary.body.evidenceLinks, []) && same(notStartedW.summary.body.findings, []) && same(notStartedW.history.body.items, []),
    'before any event W has zero rows and derives NOT_STARTED with no link, no finding and no latest finding',
  )
  check('T042', 'LINK evidence from valid ASSIGNED intake', notStartedW.disposition.dispositionCode === 'ASSIGNED' && notStartedW.disposition.assignedMemberId === M1.membershipId && notStartedW.disposition.assigneeCurrentlyEligible === true && W1.status === 201 && W1.body.eventCode === 'LINK_EVIDENCE_REFERENCE', 'while A8.2 derives W ASSIGNED to M1 (eligible), M1 links evidence (201)')
  check('T043', 'First sequence is 1', W1.body.sequence === 1 && X1.body.sequence === 1, "W's and X's first events are each numbered 1 by the server")
  const W5 = await inv(W, finding(W4.body.investigationEventId, 'EVIDENCE_INCONCLUSIVE'), M1.who)
  const W2rowBefore = await rowHash(W2.body.investigationEventId)
  const W6 = await inv(W, finding(W1.body.investigationEventId, 'FURTHER_REVIEW_REQUIRED'), M1.who)
  const wSequences = (await eventsOf(W.intakeId)).map((e) => e.sequence)
  check('T044', 'Subsequent sequence contiguous', same(wSequences, [1, 2, 3, 4, 5, 6]) && same([W1, W2, W3, W4, W5, W6].map((r) => r.body.sequence), [1, 2, 3, 4, 5, 6]), "W's six events are numbered exactly 1..6 with no gap, each answered with its number")
  const L1 = await inv(L, finding(MISSING), M4.who)
  const L1b = await inv(L, finding(W1.body.investigationEventId), M4.who)
  check(
    'T045',
    'Finding without prior link refused',
    [L1, L1b].every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_INVESTIGATION_TRANSITION_REFUSED') && (await eventsOf(L.intakeId)).length === 0,
    "on L (assigned to M4, nothing linked yet) a finding naming no link, or W's link, is refused 409; nothing recorded",
  )
  check('T046', 'Finding names earlier link on same intake', W2.status === 201 && W2.body.sequence === 2 && W2.body.linkedEvidenceEventId === W1.body.investigationEventId && W2.body.findingCode === 'EVIDENCE_CONFIRMS_RECORDED_CONFLICT' && dispositionBeforeW2.assignedMemberId === M1.membershipId, "M1's controlled finding EVIDENCE_CONFIRMS_RECORDED_CONFLICT (event 2) names exactly link event 1 of W")
  const LLink = await inv(L, linkBasis(L), M4.who)
  const wrongLinks = [await inv(W, finding(W2.body.investigationEventId), M1.who), await inv(W, finding(LLink.body.investigationEventId), M1.who), await inv(W, finding(MISSING), M1.who)]
  check(
    'T047',
    'Finding references wrong link refused',
    LLink.status === 201 && wrongLinks.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_INVESTIGATION_TRANSITION_REFUSED') && (await eventsOf(W.intakeId)).length === 6,
    "a finding on W naming a finding event, L's link (another intake) or no event at all is refused 409; nothing recorded",
  )
  const uncontrolledFinding = await directInsert([findingRow(S, 1, MISSING, { finding_code: 'PAYMENT_DENIED' })], { triggersOff: true })
  const wFindings = (await eventsOf(W.intakeId)).filter((e) => e.eventCode === 'RECORD_FINDING')
  check(
    'T048',
    'Finding records controlled code only',
    wFindings.length === 3 && wFindings.every((e) => (findingCodes as readonly string[]).includes(e.findingCode ?? '')) && uncontrolledFinding.refused && /exception_investigation_events_shape_chk/.test(uncontrolledFinding.message) && unknownFindings.every((r) => r.status === 400),
    `W's findings carry only ${findingCodes.join(', ')}; an uncontrolled code is a 400 (T018) and refused by the shape CHECK as a direct row`,
  )
  const repeatLatest = await inv(W, finding(W1.body.investigationEventId, 'FURTHER_REVIEW_REQUIRED'), M1.who)
  const summaryW6 = await summaryOf(W)
  check(
    'T049',
    'Multiple valid appended findings preserve first',
    W5.status === 201 && W6.status === 201 && (await rowHash(W2.body.investigationEventId)) === W2rowBefore && summaryW6.body.findings.length === 3 && summaryW6.body.findings[0].investigationEventId === W2.body.investigationEventId &&
      summaryW6.body.latestFinding?.investigationEventId === W6.body.investigationEventId && repeatLatest.status === 409 && errorCode(repeatLatest.body) === 'EXCEPTION_INVESTIGATION_TRANSITION_REFUSED',
    'two later findings append (events 5 and 6); the first finding is byte-identical and still first; the latest is event 6; repeating it unchanged is refused 409',
  )
  const notInvestigation = await Promise.all(['ASSIGN_OWNER', 'REASSIGN_OWNER', 'RESOLVE_EXCEPTION', 'CLOSE_EXCEPTION', 'ESCALATE', 'INVESTIGATION_COMPLETE'].map((eventCode) => inv(W, { eventCode }, M1.who)))
  const resolveRow = await directInsert([rowOf(S, { event_code: 'RESOLVE_EXCEPTION' })], { triggersOff: true })
  check(
    'T050',
    'No assignment, resolution or closure event',
    notInvestigation.every((r) => r.status === 400 && /unknown investigation event code/.test(errorMessage(r.body))) && resolveRow.refused && /exception_investigation_events_event_code_chk/.test(resolveRow.message) &&
      !(investigationCodes as readonly string[]).some((c) => /RESOL|COMPLETE|CLOSED/.test(c)) && (await eventsOf(W.intakeId)).length === 6,
    `an assignment, reassignment, resolution, closure, escalation or completion event is a 400 and refused by the event-code CHECK as a direct row; the derived codes are only ${investigationCodes.join(', ')}`,
  )

  // ---------------------------------------------------------------- assignment eligibility and time (T051–T060)
  section('Assignment eligibility and time: the current assignee on every write, UNTRIAGED and TRIAGED refused, no impersonation, a role removed, a reassignment, a return, the intake and the chronology')
  const wRows = await eventsOf(W.intakeId)
  check(
    'T051',
    'Current assigned membership is valid on write',
    wRows.every((e) => e.recordedByMembershipId === M1.membershipId && e.recordedByUserId === M1.id) && dispositionBeforeW2.dispositionCode === 'ASSIGNED' && dispositionBeforeW2.assigneeCurrentlyEligible === true,
    "every one of W's six events is recorded through M1's membership — exactly the membership A8.2 holds W assigned to, eligible at the time",
  )
  const untriagedWrites = [await inv(L0, linkBasis(L0), M4.who), await inv(L0, linkBasis(L0), asAdmin)]
  check('T052', 'Unassigned intake write refused', untriagedWrites.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE') && (await eventsOf(L0.intakeId)).length === 0, 'on the UNTRIAGED L0 an eligible Admin and M4 are each refused 409; nothing recorded')
  await triage(L0, classify)
  const triagedWrites = [await inv(L0, linkBasis(L0), M4.who), await inv(L0, linkBasis(L0), asAdmin)]
  check('T053', 'TRIAGED not ASSIGNED write refused', triagedWrites.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE') && (await eventsOf(L0.intakeId)).length === 0, 'once L0 is TRIAGED but not ASSIGNED, the same writes are refused 409; nothing recorded')
  const impersonation = [await inv(W, linkAssessment(ASSESS_W.assessmentId), asAdmin), await inv(W, linkAssessment(ASSESS_W.assessmentId), M2.who), await inv(W, linkAssessment(ASSESS_W.assessmentId), M4.who)]
  const namingAnother = await inv(W, { ...linkTriage(W_CLASSIFY.triageEventId), recordedByMembershipId: M1.membershipId }, M2.who)
  check(
    'T054',
    'Another eligible Admin cannot impersonate',
    impersonation.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE') && namingAnother.status === 400 && (await eventsOf(W.intakeId)).length === 6,
    "the harness's Admin, M2 and M4 — each an eligible Admin — are refused 409 on W, which A8.2 holds assigned to M1; naming M1's membership in the body is a 400 (no Admin override, no impersonation)",
  )
  await triage(L, reassignTo(M5))
  const L5 = await inv(L, linkTriage(L_TRIAGE[0].triageEventId), M5.who)
  await prisma.membershipRole.deleteMany({ where: { membershipId: M5.membershipId } })
  const afterRemoval = await inv(L, linkTriage(L_TRIAGE[1].triageEventId), M5.who)
  const serviceRefusal = await prisma.$transaction((tx) => recordInvestigationEventOn(L.claimId, L.intakeId, linkTriage(L_TRIAGE[1].triageEventId), M5.id, tx))
  const lCount = (await eventsOf(L.intakeId)).length
  const directAfterRemoval = await directInsert([rowOf(L, { sequence: lCount + 1, evidence_kind: 'TRIAGE_EVENT', evidence_record_id: L_TRIAGE[1].triageEventId, evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null, recorded_by_membership_id: M5.membershipId, recorded_by_user_id: M5.id })])
  const lDispositionRemoved = (await dispositionOf(L)).body
  check(
    'T055',
    'Role removed after assignment denies new write',
    L5.status === 201 && afterRemoval.status === 403 && serviceRefusal.ok === false && serviceRefusal.code === 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE' && directAfterRemoval.refused && /exception_investigation_assignee/.test(directAfterRemoval.message) &&
      lDispositionRemoved.assignedMemberId === M5.membershipId && lDispositionRemoved.assigneeCurrentlyEligible === false && lCount === 2,
    "M5, reassigned L, recorded a link (201); once its role is removed its next write is 403, the service itself answers 409 (the A8.2 assignee is no longer eligible) and the database guard refuses the direct row; A8.2 still names M5, not eligible",
  )
  const wRowsHashBeforeReassign = await rowsHash([W.intakeId])
  const W_REASSIGN = await triage(W, reassignTo(M2))
  const W7 = await inv(W, finding(W3.body.investigationEventId, 'FURTHER_REVIEW_REQUIRED'), M2.who)
  const staleM1 = await inv(W, finding(W3.body.investigationEventId, 'EVIDENCE_INCONCLUSIVE'), M1.who)
  check(
    'T056',
    'Reassigned actor can append after accepted transition',
    W7.status === 201 && W7.body.sequence === 7 && W7.body.recordedByMembershipId === M2.membershipId && staleM1.status === 409 && errorCode(staleM1.body) === 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE',
    'after A8.2 reassigns W to M2, M2 appends a finding (event 7, through its own membership) and M1 — no longer the assignee — is refused 409',
  )
  const historyW7 = await historyOf(W)
  check(
    'T057',
    'Historical earlier actor unchanged after reassignment',
    (await rowsHash([W.intakeId.toString()])) !== wRowsHashBeforeReassign && (await hashOf(`SELECT e.* FROM ${TABLE} e WHERE e.exception_intake_id = $1::uuid AND e.sequence <= 6`, W.intakeId)) === wRowsHashBeforeReassign &&
      historyW7.body.items.slice(0, 6).every((e: any) => e.recordedByMembershipId === M1.membershipId && e.recordedByUserId === M1.id),
    "events 1–6 are byte-identical after the reassignment and still attribute M1; only event 7 was added",
  )
  const W_RETURN = await triage(W, giveBack)
  const afterReturn = await inv(W, finding(W4.body.investigationEventId, 'FURTHER_REVIEW_REQUIRED'), M2.who)
  await triage(L, reassignTo(M4))
  const lAfterValidReassign = await inv(L, linkTriage(L_TRIAGE[1].triageEventId), M4.who)
  check(
    'T058',
    'Return-to-triage denies writes',
    afterReturn.status === 409 && errorCode(afterReturn.body) === 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE' && (await eventsOf(W.intakeId)).length === 7 && lAfterValidReassign.status === 201 && lAfterValidReassign.body.recordedByMembershipId === M4.membershipId,
    "after A8.2 returns W to triage, M2's next write is refused 409 and nothing is recorded; on L a valid A8.2 reassignment (to M4) is what lets writes resume (201)",
  )
  check(
    'T059',
    'Source of A8.1 intake remains immutable',
    (await intakeRowsHash([...runClaims, X.claimId, F.claimId])) === ownerSnapshotBefore.intakes &&
      (await hashOf(`SELECT a.id, a.action_code, a.entity_id, a.after_state, a.occurred_at FROM audit_events a WHERE a.entity_type = 'EXCEPTION_INTAKE' AND a.entity_id = ANY($1::uuid[])`, [...homeIntakes, X, F].map((k) => k.intakeId))) === ownerSnapshotBefore.intakeAudits,
    'every A8.1 intake and intake audit of this run is byte-identical after all investigation writes so far',
  )
  const chronology = await prisma.$queryRawUnsafe<{ bad: bigint; findings: bigint }[]>(
    `SELECT count(*) FILTER (WHERE l.id IS NULL OR l.event_code <> 'LINK_EVIDENCE_REFERENCE' OR l.exception_intake_id <> f.exception_intake_id OR l.sequence >= f.sequence) AS bad, count(*) AS findings
     FROM ${TABLE} f LEFT JOIN ${TABLE} l ON l.id = f.linked_evidence_event_id WHERE f.event_code = 'RECORD_FINDING' AND f.recorded_at >= $1::timestamptz`,
    runStartedAt.toISOString(),
  )
  check('T060', 'Strict evidence-to-finding chronology persists', Number(chronology[0].findings) >= 5 && Number(chronology[0].bad) === 0, `every one of the ${Number(chronology[0].findings)} findings recorded this run names an earlier link event of its own intake`)

  // ---------------------------------------------------------------- database constraints and append-only (T061–T070)
  section('Database constraints and append-only on S (always rolled back): RESTRICT keys, coherence, the acting membership, unique keys, shape CHECKs, UPDATE, DELETE, TRUNCATE, sequence and evidence guards')
  const fks = await prisma.$queryRawUnsafe<{ name: string; del: string }[]>(`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid = '${TABLE}'::regclass ORDER BY conname`)
  const deleteIntake = await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${INTAKE_TABLE} WHERE id = $1::uuid`, X.intakeId))
  const deleteUser = await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id = $1::uuid`, M1.id))
  const deleteMembership = await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM organization_memberships WHERE id = $1::uuid`, M4.membershipId))
  check(
    'T061',
    'RESTRICT parent FK',
    fks.length === 6 && fks.every((fk) => fk.del === 'r') && [deleteIntake, deleteUser, deleteMembership].every((r) => !r.message.includes(NOT_COMMITTED) && /append-only|foreign key|23503/.test(r.message) && r.clean),
    `${fks.map((f) => f.name.replace(`${TABLE}_`, '')).join(', ')}: all ON DELETE RESTRICT; deleting a parent intake, a recording user or a recording membership is refused`,
  )
  const coherence = [await directInsert([rowOf(S, { organization_id: otherOrg })]), await directInsert([rowOf(S, { claim_id: W.claimId })])]
  check('T062', 'Claim/organization coherence DB guard', coherence.every((r) => r.refused && /exception_investigation_coherence/.test(r.message) && r.clean), 'a direct event under the other organization or another Claim than its parent intake is refused by the coherence guard')
  const membershipGuards = {
    mismatched: await directInsert([rowOf(S, { recorded_by_user_id: M2.id })]), foreign: await directInsert([rowOf(S, { recorded_by_membership_id: O.membershipId, recorded_by_user_id: O.id })]),
    missing: await directInsert([rowOf(S, { recorded_by_membership_id: MISSING })]), notAssignee: await directInsert([rowOf(S, { recorded_by_membership_id: M2.membershipId, recorded_by_user_id: M2.id })]),
    viewerMember: await directInsert([rowOf(S, { recorded_by_membership_id: (await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId: org, user: { email: viewerEmail } }, select: { id: true } })).id, recorded_by_user_id: (await prisma.user.findFirstOrThrow({ where: { email: viewerEmail }, select: { id: true } })).id })]),
  }
  check(
    'T063',
    'Recorded actor membership DB guard',
    [membershipGuards.mismatched, membershipGuards.foreign, membershipGuards.missing].every((r) => r.refused && /exception_investigation_member/.test(r.message)) && [membershipGuards.notAssignee, membershipGuards.viewerMember].every((r) => r.refused && /exception_investigation_assignee/.test(r.message)) &&
      Object.values(membershipGuards).every((r) => r.clean),
    "a membership of another user, the other tenant's membership or no membership is refused by the member guard; a real member of the organization who is not S's assignee (M2, the Viewer) by the assignee guard",
  )
  const duplicateKey = await directInsert([rowOf(S), rowOf(S, { evidence_kind: 'TRIAGE_EVENT', evidence_record_id: randomUUID(), evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null })], { triggersOff: true })
  const duplicateLink = await directInsert([rowOf(S), rowOf(S, { sequence: 2 })], { triggersOff: true })
  check(
    'T064',
    'Unique intake sequence constraint',
    duplicateKey.refused && /exception_investigation_events_sequence_key|23505/.test(duplicateKey.message) && duplicateLink.refused && /exception_investigation_events_link_key|23505/.test(duplicateLink.message),
    'with every trigger off a reused number is still refused by the unique (intake, sequence) index, and a record linked twice under one kind by the unique (intake, kind, record) index',
  )
  const shapes = [
    await directInsert([rowOf(S, { evidence_record_id: null })], { triggersOff: true }), await directInsert([rowOf(S, { finding_code: 'EVIDENCE_INCONCLUSIVE' })], { triggersOff: true }),
    await directInsert([rowOf(S, { evidence_basis_code: null })], { triggersOff: true }), await directInsert([rowOf(S, { evidence_contract_version: PREREQ_CONTRACT })], { triggersOff: true }),
    await directInsert([rowOf(S, { evidence_kind: 'TRIAGE_EVENT', evidence_contract_version: TRIAGE_CONTRACT })], { triggersOff: true }), await directInsert([rowOf(S, { evidence_kind: 'EXTERNAL_URL' })], { triggersOff: true }),
    await directInsert([findingRow(S, 1, MISSING, { evidence_kind: 'INTAKE_BASIS' })], { triggersOff: true }), await directInsert([findingRow(S, 1, MISSING, { linked_evidence_event_id: null })], { triggersOff: true }),
    await directInsert([findingRow(S, 1, MISSING, { finding_code: null })], { triggersOff: true }),
  ]
  const contractAlone = await directInsert([rowOf(S, { contract_version: 'A8-EXCEPTION-INVESTIGATION-2' })], { triggersOff: true })
  const zero = await directInsert([rowOf(S, { sequence: 0 })], { triggersOff: true })
  check(
    'T065',
    'Controlled event shape SQL CHECK',
    shapes.every((r) => r.refused && /exception_investigation_events_shape_chk/.test(r.message) && r.clean) && contractAlone.refused && /exception_investigation_events_contract_chk/.test(contractAlone.message) && zero.refused && /exception_investigation_events_sequence_chk/.test(zero.message),
    "a link without a record or with a finding, a basis link without its basis code or under another owner's contract, a triage link carrying a basis code, an unknown kind, and a finding with an evidence field, without its link or without its code are each refused by the shape CHECK; a future contract and number 0 by their CHECKs",
  )
  const wEventId = W1.body.investigationEventId as string
  const wHashFinal = await rowsHash([W.intakeId])
  const noop = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = sequence WHERE id = $1::uuid`, wEventId))
  const update = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET finding_code = 'EVIDENCE_INCONCLUSIVE' WHERE id = $1::uuid`, W2.body.investigationEventId))
  check('T066', 'Append-only UPDATE no-op refused', [noop, update].every((r) => /append-only/.test(r.message) && r.clean) && (await rowsHash([W.intakeId])) === wHashFinal, 'a no-op UPDATE and a real UPDATE of an investigation event are each refused (append-only); nothing changed')
  const deletion = await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, W6.body.investigationEventId))
  check('T067', 'DELETE refused', /append-only/.test(deletion.message) && deletion.clean && (await rowsHash([W.intakeId])) === wHashFinal, "deleting W's latest finding is refused (append-only); nothing changed")
  const truncation = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`))
  const cascade = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`))
  // A later owner's ON DELETE RESTRICT key into this table would make PostgreSQL refuse a plain TRUNCATE before any
  // trigger runs; TRUNCATE ... CASCADE still reaches this guard. Judged on behaviour: every wipe is refused.
  const referencedBy = await prisma.$queryRawUnsafe<{ del: string; self: boolean }[]>(`SELECT confdeltype::text AS del, conrelid = confrelid AS self FROM pg_constraint WHERE contype = 'f' AND confrelid = '${TABLE}'::regclass`)
  const truncationRefused = /append-only/.test(truncation.message) || (/cannot truncate a table referenced in a foreign key constraint/.test(truncation.message) && referencedBy.some((row) => !row.self) && referencedBy.every((row) => row.del === 'r'))
  check('T068', 'TRUNCATE refused', truncationRefused && truncation.clean && /append-only/.test(cascade.message) && cascade.clean && (await rowsHash([W.intakeId])) === wHashFinal, 'a TRUNCATE and a TRUNCATE … CASCADE of investigation events are each refused; nothing changed')
  const firstLinkId = randomUUID()
  const validRows = await directInsert([rowOf(S, { id: firstLinkId }), findingRow(S, 2, firstLinkId)])
  const gap = await directInsert([rowOf(S, { sequence: 2 })])
  const reuse = await directInsert([rowOf(S), rowOf(S, { evidence_kind: 'TRIAGE_EVENT', evidence_record_id: L_TRIAGE[0].triageEventId, evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null })])
  const lateW = await directInsert([findingRow(W, 3, W1.body.investigationEventId, { recorded_by_membership_id: M2.membershipId, recorded_by_user_id: M2.id })])
  check(
    'T069',
    'Gap or duplicate sequence direct insert refused',
    !validRows.refused && validRows.clean && gap.refused && /exception_investigation_sequence/.test(gap.message) && reuse.refused && /exception_investigation_sequence|exception_investigation_evidence/.test(reuse.message) && lateW.refused && lateW.clean,
    "a valid direct link and finding on S pass every guard and roll back; a first event numbered 2, a reused number 1 and a finding slotted into W's past are each refused",
  )
  const sTriage = (await get(`${base(S)}/triage-history`)).body.items as { triageEventId: string }[]
  const evidenceGuards = [
    await directInsert([rowOf(S, { evidence_record_id: W.basisRecordId })]), await directInsert([rowOf(S, { evidence_record_id: MISSING })]),
    await directInsert([rowOf(S, { evidence_kind: 'TRIAGE_EVENT', evidence_record_id: MISSING, evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null })]),
    await directInsert([rowOf(S, { evidence_kind: 'A7_CASE_ASSESSMENT', evidence_record_id: ASSESS_W.assessmentId, evidence_contract_version: PREREQ_CONTRACT, evidence_basis_code: null })]),
  ]
  const findingGuards = [await directInsert([rowOf(S, { id: firstLinkId }), findingRow(S, 2, W1.body.investigationEventId)]), await directInsert([rowOf(S, { id: firstLinkId }), findingRow(S, 2, MISSING)])]
  const repeatGuard = await directInsert([rowOf(S, { id: firstLinkId }), findingRow(S, 2, firstLinkId), findingRow(S, 3, firstLinkId)])
  const ownTriageOk = await directInsert([rowOf(S, { evidence_kind: 'TRIAGE_EVENT', evidence_record_id: sTriage[0].triageEventId, evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null })])
  check(
    'T070',
    'Foreign or future evidence direct insert refused',
    evidenceGuards.every((r) => r.refused && /exception_investigation_evidence/.test(r.message) && r.clean) && findingGuards.every((r) => r.refused && /exception_investigation_finding/.test(r.message) && r.clean) &&
      repeatGuard.refused && /exception_investigation_repeat/.test(repeatGuard.message) && !ownTriageOk.refused,
    "W's basis, a missing record, a missing triage event and another Claim's assessment named on S are refused by the evidence guard; a finding naming another intake's link or no event by the finding guard; an unchanged repeated finding by the repeat guard; S's own triage event passes",
  )

  // ---------------------------------------------------------------- atomicity, races and crash outcomes (T071–T080)
  section('Atomicity, races and crash outcomes: the Claim lock first, one SERIALIZABLE transaction, the A8.2 and owner reads on it, atomic event and audit, injected crashes, identical concurrent writers, retries, unknown commits')
  const serviceCode = committedCode(`${MODULE_DIR}/exception-investigation.service.ts`)
  const onTx = serviceCode.slice(serviceCode.indexOf('async function recordOnTransaction'), serviceCode.indexOf('async function reconcileUnknownOutcome'))
  const firstStatement = onTx.split('\n').slice(1).find((line) => line.trim().length > 0) ?? ''
  const holdLock = holdAt('exceptionInvestigation.claim_locked')
  const firstJ = recordInvestigationEvent(J.claimId, J.intakeId, linkBasis(J), M4.id)
  await Promise.race([holdLock.arrived, firstJ])
  const secondJ = recordInvestigationEvent(J.claimId, J.intakeId, linkTriage(sTriage[0].triageEventId), M4.id)
  const secondWaited = !(await settledWithin(secondJ, 1500))
  holdLock.release()
  const [j1, j2] = await Promise.all([firstJ, secondJ])
  clearConcurrencyProbes()
  check(
    'T071',
    'Claim lock acquired first',
    /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(firstStatement) && secondWaited && j1.ok && j1.value.sequence === 1 && j2.ok === false && j2.code === 'NOT_FOUND',
    "the Claim row lock is the first statement; while one write on J holds it a second waits, then is judged on the committed state (S's triage event named on J is the missing-reference 404)",
  )
  check(
    'T072',
    'SERIALIZABLE one transaction',
    /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && (serviceCode.match(/prisma\.\$transaction\(\(tx\) => recordOnTransaction\(/g) ?? []).length === 1 && /recordAuditEvent\(/.test(onTx) && /insertInvestigationEvent\(/.test(onTx),
    'the event and its audit are written by one recordOnTransaction inside one SERIALIZABLE transaction (proven atomic by T074–T076)',
  )
  const holdTriage = holdAt('exceptionTriage.inserted')
  const kReturn = recordTriageEvent(K.claimId, K.intakeId, giveBack, creatorId)
  await Promise.race([holdTriage.arrived, kReturn])
  const kInvestigation = recordInvestigationEvent(K.claimId, K.intakeId, linkBasis(K), M4.id)
  const kWaited = !(await settledWithin(kInvestigation, 1500))
  holdTriage.release()
  const [kReturned, kResult] = await Promise.all([kReturn, kInvestigation])
  clearConcurrencyProbes()
  check(
    'T073',
    'A8.2 and evidence owner reads same tx',
    /getExceptionIntakesOf\(claimId, tx\)/.test(serviceCode) && /getTriageDispositionOf\(claimId, parent\.exceptionIntakeId, tx\)/.test(serviceCode) && /getTriageHistoryOf\(intake\.claimId, intake\.exceptionIntakeId, tx\)/.test(serviceCode) &&
      /findAssessmentById\(request\.evidenceRecordId, tx\)/.test(serviceCode) && kWaited && kReturned.ok && kResult.ok === false && kResult.code === 'EXCEPTION_INVESTIGATION_NOT_ASSIGNEE' && (await eventsOf(K.intakeId)).length === 0,
    "every owner read runs on the write's own transaction; while an A8.2 return held K's Claim lock, M4's write waited, then re-read the committed disposition (TRIAGED) and was refused 409",
  )
  const holdInsert = holdAt('exceptionInvestigation.inserted')
  const committing = recordInvestigationEvent(J.claimId, J.intakeId, finding(j1.ok ? j1.value.investigationEventId : MISSING), M4.id)
  await Promise.race([holdInsert.arrived, committing])
  const during = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  holdInsert.release()
  const J2 = await committing
  clearConcurrencyProbes()
  const jEvents = await eventsOf(J.intakeId)
  const jAudit = J2.ok ? (await auditsOfEvent(J2.value.investigationEventId))[0] : undefined
  check(
    'T074',
    'Event and audit atomic commit',
    during.rows === 1 && during.audits === 1 && J2.ok && jEvents.length === 2 && (await auditsOfEvent(jEvents[1].id)).length === 1 && !!jAudit && jAudit.actionCode === 'exception_investigation.recorded' && jAudit.beforeState === null &&
      (jAudit.afterState as any)?.recordedAt === jEvents[1].recordedAt.toISOString() && jAudit.organizationId === J.organizationId && jAudit.actorUserId === M4.id,
    "while J's second event was uncommitted no other connection saw it or its audit; after commit exactly one of each, the audit holding the event's own database time, organization and actor",
  )
  const failAfterEvent = failOnce('exceptionInvestigation.inserted', 'injected failure after the investigation insert')
  const crashedEvent = await attemptAdversarial(() => recordInvestigationEvent(J.claimId, J.intakeId, finding(jEvents[0].id, 'EVIDENCE_INCONCLUSIVE'), M4.id))
  const afterCrash1 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  check('T075', 'Failure after event rolls both back', failAfterEvent.reached === 1 && /injected failure after the investigation insert/.test(crashedEvent) && afterCrash1.rows === 2 && afterCrash1.audits === 2, 'a failure right after the insert rolled back the whole transaction: no event, no audit, no retry')
  const failAfterAudit = failOnce('exceptionInvestigation.audited', 'injected failure after the investigation audit')
  const crashedAudit = await attemptAdversarial(() => recordInvestigationEvent(J.claimId, J.intakeId, finding(jEvents[0].id, 'EVIDENCE_INCONCLUSIVE'), M4.id))
  const afterCrash2 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T076', 'Failure after audit rolls both back', failAfterAudit.reached === 1 && /injected failure after the investigation audit/.test(crashedAudit) && afterCrash2.rows === 2 && afterCrash2.audits === 2, 'a failure after the audit rolled back both: no event, no audit, no retry')
  const linkRace = await Promise.all(Array.from({ length: 5 }, () => inv(R, linkBasis(R), M4.who)))
  const rLinkId = linkRace.find((r) => r.status === 201)?.body.investigationEventId ?? MISSING
  const findingRace = await Promise.all(Array.from({ length: 5 }, () => inv(R, finding(rLinkId, 'EVIDENCE_INCONCLUSIVE'), M4.who)))
  const isRefusedStep = (r: { status: number; body: any }) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_INVESTIGATION_TRANSITION_REFUSED'
  check(
    'T077',
    'Concurrent conflicting writers one legal event',
    linkRace.filter((r) => r.status === 201).length === 1 && linkRace.filter(isRefusedStep).length === 4 && findingRace.filter((r) => r.status === 201).length === 1 && findingRace.filter(isRefusedStep).length === 4 &&
      (await eventsOf(R.intakeId)).length === 2 && (await auditsOfIntake(R.intakeId)) === 2,
    `five identical links at once (${linkRace.map((r) => r.status).join('/')}) and then five identical findings at once (${findingRace.map((r) => r.status).join('/')}): one 201 and four 409 each; two events, two audits`,
  )
  const once = failOnce('exceptionInvestigation.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const retried = await recordInvestigationEvent(J.claimId, J.intakeId, finding(jEvents[0].id, 'FURTHER_REVIEW_REQUIRED'), M4.id)
  const always = failEveryTime('exceptionInvestigation.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const exhausted = await recordInvestigationEvent(J.claimId, J.intakeId, finding(jEvents[0].id, 'EVIDENCE_INCONCLUSIVE'), M4.id)
  clearConcurrencyProbes()
  check(
    'T078',
    'Serialized retry re-reads state',
    once.reached === 1 && retried.ok && retried.value.sequence === 3 && always.reached === 3 && exhausted.ok === false && exhausted.code === 'EXCEPTION_INVESTIGATION_CONFLICT' && /kept conflicting; nothing was recorded/.test(exhausted.message) &&
      (await eventsOf(J.intakeId)).length === 3 && /const MAX_INVESTIGATION_ATTEMPTS = 3/.test(serviceCode) && /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode),
    'one serialization failure is retried on a fresh transaction that re-reads the history and records exactly one event (3); failing every time, the writer stops after exactly 3 attempts with a 409 and nothing recorded',
  )
  const lost = failEveryTime('exceptionInvestigation.audited', 'Connection terminated unexpectedly')
  const unknownOutcome = await recordInvestigationEvent(J.claimId, J.intakeId, finding(jEvents[0].id, 'EVIDENCE_INCONCLUSIVE'), M4.id)
  const early = failEveryTime('exceptionInvestigation.claim_locked', 'Connection terminated unexpectedly')
  const earlyOutcome = await recordInvestigationEvent(J.claimId, J.intakeId, finding(jEvents[0].id, 'EVIDENCE_INCONCLUSIVE'), M4.id)
  clearConcurrencyProbes()
  check(
    'T079',
    'Unknown commit never blindly resends',
    lost.reached === 1 && unknownOutcome.ok === false && unknownOutcome.code === 'EXCEPTION_INVESTIGATION_CONFLICT' && /holds no event at sequence 4; nothing was recorded/.test(unknownOutcome.message) &&
      early.reached === 1 && earlyOutcome.ok === false && /failed before an event was written/.test(earlyOutcome.message) && (await eventsOf(J.intakeId)).length === 3 && /reconcileAttempt\(records, attempted\)/.test(serviceCode),
    "a connection lost after the audit is reconciled against the committed history (no event 4: nothing recorded) and a loss before the insert is reported as such; each reached once — never resubmitted, never reported as success (RECORDED and OTHER_EVENT are proven by the reducer's unit tests, T081)",
  )
  const runEvents = await prisma.exceptionInvestigationEvent.findMany({ where: { recordedAt: { gte: runStartedAt } }, select: { id: true } })
  const runAudits = await prisma.auditEvent.findMany({ where: { actionCode: 'exception_investigation.recorded', occurredAt: { gte: runStartedAt } }, select: { entityId: true } })
  const contiguous = async (k: Intake) => {
    const rows = await eventsOf(k.intakeId)
    return same(rows.map((e) => e.sequence), rows.map((_e, i) => i + 1)) && (await auditsOfIntake(k.intakeId)) === rows.length
  }
  check(
    'T080',
    'No orphan event or audit',
    runEvents.length >= 15 && runEvents.every((e) => runAudits.filter((a) => a.entityId === e.id).length === 1) && runAudits.every((a) => runEvents.some((e) => e.id === a.entityId)) &&
      (await contiguous(W)) && (await contiguous(X)) && (await contiguous(L)) && (await contiguous(J)) && (await contiguous(R)) && (await contiguous(K)),
    `${runEvents.length} events and ${runAudits.length} investigation audits this run pair one to one; W, X, L, J, R and K are each numbered 1..N with one audit per event after every race, crash and retry`,
  )

  // ---------------------------------------------------------------- determinism and read consistency (T081–T090)
  section('Determinism and read consistency: unit tests and 100 reductions, READ ONLY snapshot reads, no audit on GET, sequence order, two readers, time zones and locales, a database restart, stable actors, no stored pointer')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  const reducerCode = committedCode(`${MODULE_DIR}/exception-investigation.reducer.ts`)
  const wParent = { exceptionIntakeId: W.intakeId, organizationId: W.organizationId, claimId: W.claimId }
  const wStored = await eventsOf(W.intakeId)
  const derivations = new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveInvestigation(wParent, wStored))))
  check(
    'T081',
    '100 pure reductions same output',
    ownUnit.ok && /ℹ pass 11/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output) && derivations.size === 1 && !/prisma|await |async |Date\.now|Math\.random|new Date|from '\.\.\/\.\.\/shared/.test(reducerCode),
    "the 11 reducer and request tests pass (shapes, evidence before findings, links once per kind, read refusals, 100 derivations and the uncertain-outcome reconciliation); 100 derivations of W's stored history are identical; the reducer reads no database, clock or randomness",
  )
  const countsBeforeGet = await counts()
  for (const k of [W, L, J, R, X]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await summaryOf(k, who)
  }
  check(
    'T082',
    'Read-only GET enforces snapshot',
    (await unchanged(countsBeforeGet)) && /withReadSnapshot\(undefined, \(tx\) => getInvestigationHistoryOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode) && /withReadSnapshot\(undefined, \(tx\) => getInvestigationSummaryOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode),
    'twenty reads by an Admin and a Viewer changed no row; each read runs in one READ ONLY snapshot',
  )
  const auditsBeforeReads = await prisma.auditEvent.count()
  const readRefusals = [await historyOf(W, anonymous), await summaryOf(F), await historyOf({ claimId: W.claimId, intakeId: MISSING }), await get(`${base(W)}/investigation-summary?current=1`)]
  for (const k of [W, L, J, R, K, S, X]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await summaryOf(k, who)
  }
  await historyOf(F, O.who)
  await summaryOf(F, O2.who)
  check('T083', 'No audit on GET', (await prisma.auditEvent.count()) === auditsBeforeReads && readRefusals.map((r) => r.status).join('/') === '401/404/404/400', 'thirty reads in both tenants and four refused reads (401/404/404/400) wrote no audit')
  const repositoryCode = committedCode(`${MODULE_DIR}/exception-investigation.repository.ts`)
  const orderLinkId = randomUUID()
  const reversedTime = await plantedRead(S, [rowOf(S, { id: orderLinkId, recorded_at: new Date(Date.now() + 3_600_000).toISOString() }), findingRow(S, 2, orderLinkId, { recorded_at: new Date(Date.now() - 3_600_000).toISOString() })])
  const reversedItems = reversedTime.value?.history.ok ? reversedTime.value.history.value.items : []
  check(
    'T084',
    'Ordered by contiguous sequence not timestamp',
    /orderBy: \{ sequence: 'asc' \}/.test(repositoryCode) && !/orderBy: \{ recordedAt|orderBy: \[\{ recordedAt/.test(repositoryCode) && same(reversedItems.map((e) => e.sequence), [1, 2]) && reversedItems.length === 2 && reversedItems[1].recordedAt < reversedItems[0].recordedAt && reversedTime.clean,
    'a planted history (rolled back) whose event 2 carries an earlier time than event 1 reads back as 1, 2: the order is the server-owned sequence, never a time or an id',
  )
  const twoReaders = await Promise.all([W, L, X].map(async (k) => withoutEvaluatedAt((await historyOf(k)).body) === withoutEvaluatedAt((await historyOf(k, asViewer)).body) && withoutEvaluatedAt((await summaryOf(k)).body) === withoutEvaluatedAt((await summaryOf(k, asViewer)).body)))
  check('T085', 'Same facts across two authorized users', twoReaders.every(Boolean), "W's, L's and X's history and summary are identical for an Admin and a Viewer")
  // The reducer evaluated in separate processes under other time zones and locales. Node on Windows resolves only the
  // POSIX zone names below (each a different offset); LANG/LC_ALL may leave the process locale as the system's, which is
  // reported as observed.
  const probeFile = join(tmpdir(), `a83-locale-${runId}.mjs`)
  writeFileSync(
    probeFile,
    `import { deriveInvestigation } from ${JSON.stringify(pathToFileURL(resolve('src/modules/exception-investigation/exception-investigation.reducer.ts')).href)}\n` +
      `const input = JSON.parse(process.env.A83_IN ?? '{}')\n` +
      `const options = Intl.DateTimeFormat().resolvedOptions()\n` +
      `console.log(JSON.stringify({ zone: options.timeZone, locale: options.locale, derived: deriveInvestigation(input.parent, input.events) }))\n`,
  )
  const probeInput = JSON.stringify({ parent: wParent, events: wStored })
  const inProcess = JSON.stringify(deriveInvestigation(wParent, wStored))
  const probe = (envExtra: Record<string, string>) => {
    const out = spawnSync(process.execPath, [probeFile], { encoding: 'utf8', env: childEnv({ A83_IN: probeInput, ...envExtra }), maxBuffer: 16 * 1024 * 1024 })
    try {
      return JSON.parse((out.stdout ?? '').trim()) as { zone: string; locale: string; derived: unknown }
    } catch {
      return { zone: 'unavailable', locale: 'unavailable', derived: null }
    }
  }
  const zones = ['UTC', 'EST5EDT', 'CST6CDT', 'MST7MDT'].map((TZ) => probe({ TZ }))
  const locales = ['en_US.UTF-8', 'ar_AE.UTF-8', 'tr_TR.UTF-8', 'de_DE.UTF-8'].map((LANG) => probe({ LANG, LC_ALL: LANG }))
  try {
    unlinkSync(probeFile)
  } catch {
    // the probe file is temporary; leaving it changes nothing
  }
  check(
    'T086',
    'Timezone independence',
    new Set(zones.map((z) => z.zone)).size === 4 && zones.every((z) => JSON.stringify(z.derived) === inProcess) && historyW7.body.items.every((e: any) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.recordedAt)),
    `W's stored history derives byte-identically in processes running in ${zones.map((z) => z.zone).join(', ')}; every time is an ISO-8601 UTC instant`,
  )
  const accept = async (language: string) => ({ history: withoutEvaluatedAt((await historyOf(W, as(admin.cookie, { 'Accept-Language': language }))).body), summary: withoutEvaluatedAt((await summaryOf(W, as(admin.cookie, { 'Accept-Language': language }))).body) })
  const languages = await Promise.all(['en-US', 'ar-AE', 'tr-TR'].map(accept))
  check(
    'T087',
    'Locale independence',
    locales.every((l) => JSON.stringify(l.derived) === inProcess) && languages.every((l) => same(l, languages[0])) && !/toLocale|localeCompare|Intl\./.test(moduleCode),
    `W derives byte-identically in processes started with LANG/LC_ALL en_US, ar_AE, tr_TR and de_DE (resolved locale ${[...new Set(locales.map((l) => l.locale))].join(', ')}); the HTTP answers are identical for Accept-Language en-US, ar-AE and tr-TR; the module uses no locale-sensitive API`,
  )
  const goldenNow = async () => ({ history: withoutEvaluatedAt((await historyOf(W)).body), summary: withoutEvaluatedAt((await summaryOf(W)).body), rows: await rowsHash([W.intakeId]) })
  const beforeRestart = await goldenNow()
  const restartedDb = spawnSync('docker', ['restart', dbContainer], { encoding: 'utf8' }).status === 0
  await waitFor(databaseUp, 90_000)
  await apiReady('the reads after the database restart')
  const afterRestart = await goldenNow()
  check('T088', 'Restarted database returns identical facts', restartedDb && same(afterRestart, beforeRestart), "after the database container restarted, W's history, summary and stored rows read back identically")
  check(
    'T089',
    'Historical actor identity stable',
    historyW7.body.items.slice(0, 6).every((e: any) => e.recordedByMembershipId === M1.membershipId) && historyW7.body.items[6].recordedByMembershipId === M2.membershipId &&
      (await eventsOf(L.intakeId)).some((e) => e.recordedByMembershipId === M5.membershipId && e.recordedByUserId === M5.id),
    "after W's reassignment and return and M5's role removal, W still attributes events 1–6 to M1 and 7 to M2, and L still attributes M5's link to M5",
  )
  const fakeCurrent = [
    await inv(W, { ...finding(W1.body.investigationEventId), currentFinding: true }, M2.who), await inv(W, { ...finding(W1.body.investigationEventId), investigationCode: 'RESOLVED' }, M2.who),
    await get(`${base(W)}/investigation-summary?current=1`), await get(`${base(W)}/investigation-history?latest=1`), await get(`${base(W)}/investigation-summary?sequence=2`),
  ]
  const summaryNow = (await summaryOf(W)).body
  const mine = replayIndependently(historyW7.body.items)
  check(
    'T090',
    'No mutable current-state pointer',
    !COLUMNS.some((c) => /status|state|current|latest|resolved|complete/.test(c)) && fakeCurrent.every((r) => r.status === 400) &&
      same(mine, { investigationCode: summaryNow.investigationCode, evidenceLinks: summaryNow.evidenceLinks, findings: summaryNow.findings, latestFinding: summaryNow.latestFinding, eventCount: summaryNow.eventCount, lastSequence: summaryNow.lastSequence }),
    "no status, current, latest or completion column exists; a current pointer or code in a POST and a current/latest/sequence selector on a GET are refused (400); this suite's own replay of W's history gives exactly the derived summary",
  )

  // ---------------------------------------------------------------- privacy and nonduplication (T091–T100)
  section('Privacy and nonduplication: no PHI, member detail, money, payer, source bytes or narrative; every A8.1, A8.2, A6 and A7 record unchanged; no resolution, export or A9; no second intake or triage engine')
  const investigationText = JSON.stringify(await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${TABLE} WHERE claim_id = ANY($1::uuid[])`, [...runClaims, X.claimId]), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  const dtoKeys = [...deepKeys([historyW7.body, summaryNow, (await historyOf(L)).body, (await summaryOf(L)).body])]
  const dtoText = JSON.stringify([historyW7.body, summaryNow])
  check(
    'T091',
    'No patient/member/clinical value in DTO',
    !COLUMNS.some((c) => /patient|name|birth|email|phone|address|gender|diagnos|clinician|encounter/.test(c)) && !dtoKeys.some((k) => /patient|name|birth|email|diagnos|clinician|encounter/i.test(k)) &&
      ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), M1.email, M2.email, M4.email, 'Synthetic member'].some((value) => investigationText.includes(value) || dtoText.includes(value)),
    'no patient, member contact, clinical or encounter column or DTO key, and no such value in any stored event or answer: a member appears only as a membership id',
  )
  check(
    'T092',
    'No amount, currency or balance in DTO',
    !COLUMNS.some((c) => /amount|currency|price|balance|tariff/.test(c)) && !dtoKeys.some((k) => /amount|currency|price|balance|tariff/i.test(k)) && !/AED|125\.25|12\.125/.test(investigationText + dtoText),
    'no amount, currency, price or balance column, key or value',
  )
  const sendRoutes = await Promise.all([post(`${base(W)}/send`, {}), post(`${base(W)}/transmit`, {}), post(`/api/claims/${W.claimId}/payments`, {}), post(`${base(W)}/denial`, {})])
  check(
    'T093',
    'No payer/send/denial/payment claim',
    !COLUMNS.some((c) => /payer|payment|denial|outcome|remit|send|transmi/.test(c)) && !dtoKeys.some((k) => /payer|payment|denial|outcome|remit|financial/i.test(k)) && !(findingCodes as readonly string[]).some((c) => /DENI|PAID|PAY|OVERPA|UNDERPA|LOSS|LIABIL/.test(c)) && sendRoutes.every((r) => r.status === 404),
    'no payer, payment, denial or outcome column or key; no finding code asserts a denial, payment, loss or liability; no send, transmit, payment or denial route',
  )
  check(
    'T094',
    'No source bytes, attachment or free narrative',
    !COLUMNS.some((c) => /payload|bytes|attachment|file|url|narrative|description|note|comment|text|reference_text/.test(c)) && !dtoKeys.some((k) => /payload|bytes|attachment|file|url|narrative|description|note|comment/i.test(k)) && !investigationText.includes(ref('W1-E1')) && !investigationText.includes(ref('F1-E1')),
    "no payload, attachment, file, URL or free-text column or key; an A7.1 source reference never appears in a stored event: a link stores a pointer only",
  )
  const ownerSnapshotAfter = await snap()
  const ownerReadsAfter = await reads()
  progress(`investigation events this run: W ${(await eventsOf(W.intakeId)).length}, X ${(await eventsOf(X.intakeId)).length}, L ${(await eventsOf(L.intakeId)).length}, J ${(await eventsOf(J.intakeId)).length}, R ${(await eventsOf(R.intakeId)).length}, K ${(await eventsOf(K.intakeId)).length}, S ${(await eventsOf(S.intakeId)).length}, L0 ${(await eventsOf(L0.intakeId)).length}`)
  check('T095', 'Intake stored bytes unchanged', ownerSnapshotAfter.intakes === ownerSnapshotBefore.intakes && ownerSnapshotAfter.intakeAudits === ownerSnapshotBefore.intakeAudits && same(ownerReadsAfter.intakes, ownerReadsBefore.intakes), "every A8.1 intake and its audit is byte-identical, and W's intake list reads back identically")
  check('T096', 'A8.2 triage event bytes unchanged', (await hashOf(`SELECT t.* FROM ${TRIAGE_TABLE} t WHERE t.id = ANY($1::uuid[])`, triageIdsBefore)) === triageHashBefore && triageIdsBefore.length >= 16, `all ${triageIdsBefore.length} A8.2 triage events that existed before the first investigation write are byte-identical`)
  check('T097', 'A6 freeze/correction bytes unchanged', ownerSnapshotAfter.freezes === ownerSnapshotBefore.freezes && ownerSnapshotAfter.lifecycle === ownerSnapshotBefore.lifecycle && ownerSnapshotAfter.links === ownerSnapshotBefore.links, `each freeze, sealed manifest, lifecycle event and correction link of the ${runClaims.length} Claims (X's deliberate A6.9 correction aside) is byte-identical`)
  check(
    'T098',
    'A7 case/assessment bytes unchanged',
    ['sources', 'classifications', 'readiness', 'cases', 'assessments'].every((k) => (ownerSnapshotAfter as Record<string, string>)[k] === (ownerSnapshotBefore as Record<string, string>)[k]) &&
      withoutEvaluatedAt(ownerReadsAfter.trace) === withoutEvaluatedAt(ownerReadsBefore.trace) && withoutEvaluatedAt(ownerReadsAfter.timeline) === withoutEvaluatedAt(ownerReadsBefore.timeline) &&
      withoutEvaluatedAt(ownerReadsAfter.delta) === withoutEvaluatedAt(ownerReadsBefore.delta) && withoutEvaluatedAt(ownerReadsAfter.continuity) === withoutEvaluatedAt(ownerReadsBefore.continuity) && withoutEvaluatedAt(ownerReadsAfter.contradicted) === withoutEvaluatedAt(ownerReadsBefore.contradicted),
    "every A7.1 source, A7.2 classification, A7.3 readiness, A7.4 case and A7.5 assessment (linked or not, both tenants) is byte-identical, and N's A7.6–A7.9 reads and W's refused timeline read back identically",
  )
  // Tables that existed on main belong to earlier phases; only what this branch adds is judged. Later phases' tables are
  // those created by migrations committed after A8.3's own merge (none on its own branch).
  const tablesAt = (ref: string) => new Set(migrationDirsAt(ref).flatMap((dir) => [...gitArgs(['show', `${ref}:${dir}/migration.sql`]).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])))
  const mainTables = tablesAt(ownBase)
  const a83Tables = [...committedText(MIGRATION).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
  const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])) : [])
  const newTablesLike = async (pattern: string) => (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`, pattern)).map((r) => r.t).filter((t) => !mainTables.has(t) && !laterPhaseTables.has(t))
  const workflow = await Promise.all(['resolve', 'close', 'escalate', 'sla', 'export', 'audit-package', 'remediation', 'actions'].map((p) => post(`${base(W)}/${p}`, {})))
  const feCode = committedProductionCodeOf([FE_DIR]).code
  const moneyOrTransport = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|[Bb]alance|[Ll]edger|[Pp]ayment|[Rr]emittance|from 'node:(http|https|net|tls|dgram|fs)'|\bfetch\(|axios|enqueue|setInterval|worker_threads|cron|\bsla\b/
  check(
    'T099',
    'No A8 resolution/escalation/export or A9 transport',
    workflow.every((r) => r.status === 404) && same(a83Tables, [TABLE]) && mainTables.size > 50 && (await newTablesLike('(resolution|escalat|sla|deadline|export|package|archive|attachment|remediat|work_queue|outbox|transmission|acknowledg|remittance|payment|ledger|receivable|settle|_job)')).length === 0 &&
      !moneyOrTransport.test(moduleCode) && !/localStorage|sessionStorage|indexedDB|console\.|setInterval|setTimeout|navigator\.sendBeacon/.test(feCode) && !/console\.|logger\.|process\.stdout/.test(moduleCode),
    `no resolve, close, escalate, SLA, export, audit-package, remediation or action route; the A8.3 migration creates exactly ${TABLE}; no resolution, export, queue, transport or payment table; the module holds no money, network, file, queue or log logic and the page stores and logs nothing`,
  )
  const intakeCountNow = await prisma.exceptionIntakeRecord.count({ where: { claimId: { in: [...runClaims, X.claimId] } } })
  check(
    'T100',
    'No duplicate A8.1 intake or A8.2 owner engine',
    !/insertIntake|recordExceptionIntake|identityKeyOf|establishedBasis|insertTriageEvent|recordTriageEvent|applyTriageEvent|deriveTriageDisposition|assigneeEligible\(/.test(moduleCode) && /getTriageDispositionOf\(/.test(moduleCode) &&
      intakeCountNow === homeIntakes.length + 1 && !/INSERT INTO "exception_(intake_records|triage_events)"/.test(moduleCode),
    "the module never records or derives an intake or a triage disposition itself — it consumes the A8.1 and A8.2 owners' readers; this run's Claims still hold exactly their 8 intakes",
  )

  // ---------------------------------------------------------------- malformed history and source drift (T101–T110)
  section('Malformed history and source drift (planted, always rolled back): gaps, repeats, contracts, order, tenants and codes fail closed; stale members, later references and later source changes rewrite nothing')
  const refusedRead = (r: { value?: { history: any; summary: any }; clean: boolean }) =>
    r.value?.history.ok === false && r.value.history.code === 'EXCEPTION_INVESTIGATION_CONFLICT' && r.value.summary.ok === false && r.value.summary.code === 'EXCEPTION_INVESTIGATION_CONFLICT' && r.clean
  const gapped = await plantedRead(S, [rowOf(S), rowOf(S, { sequence: 3, evidence_kind: 'TRIAGE_EVENT', evidence_record_id: sTriage[0].triageEventId, evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null })])
  check('T101', 'Gap in event sequence fails closed', refusedRead(gapped), 'a planted history numbered 1, 3 makes the history and the summary refuse 409 — never repaired')
  const repeated = await plantedRead(S, [rowOf(S), rowOf(S, { evidence_kind: 'TRIAGE_EVENT', evidence_record_id: sTriage[0].triageEventId, evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null })], `DROP INDEX ${TABLE}_sequence_key`)
  check('T102', 'Repeated sequence fails closed', refusedRead(repeated), 'a planted history with two events numbered 1 (its unique index dropped inside the rolled-back transaction) makes both reads refuse 409')
  const futureContract = await plantedRead(S, [rowOf(S, { contract_version: 'A8-EXCEPTION-INVESTIGATION-2' })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_contract_chk`)
  check('T103', 'Unknown event contract fails closed', refusedRead(futureContract), 'a planted event under A8-EXCEPTION-INVESTIGATION-2 (its CHECK dropped) makes both reads refuse 409')
  const laterLinkId = randomUUID()
  const findingFirst = await plantedRead(S, [findingRow(S, 1, laterLinkId), rowOf(S, { id: laterLinkId, sequence: 2 })])
  check('T104', 'Finding before referenced evidence fails closed', refusedRead(findingFirst), 'a planted finding numbered 1 that names the link numbered 2 makes both reads refuse 409')
  const foreignRow = await plantedRead(S, [rowOf(S, { organization_id: otherOrg })])
  const mismatchedKind = await plantedRead(S, [rowOf(S, { evidence_contract_version: PREREQ_CONTRACT })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_shape_chk`)
  check('T105', 'Foreign source mapping fails closed', refusedRead(foreignRow) && refusedRead(mismatchedKind), "a planted row of the other tenant, and a basis link mapped to the A7.5 contract (its CHECK dropped), each make both reads refuse 409")
  const unknownCode = await plantedRead(S, [rowOf(S, { id: firstLinkId }), findingRow(S, 2, firstLinkId, { finding_code: 'CASE_CLOSED' })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_shape_chk`)
  check('T106', 'Unknown finding code fails closed', refusedRead(unknownCode), 'a planted finding CASE_CLOSED (its CHECK dropped) makes both reads refuse 409')
  const lHistory = await historyOf(L)
  check(
    'T107',
    'Stale membership does not rewrite history',
    lHistory.status === 200 && (await historyOf(W)).status === 200 && withoutEvaluatedAt((await historyOf(W)).body) === withoutEvaluatedAt(historyW7.body) &&
      lHistory.body.items.some((e: any) => e.recordedByMembershipId === M5.membershipId) && (await rowsHash([W.intakeId])) === wHashFinal,
    "W (whose investigators M1 and M2 are no longer assigned) and L (whose investigator M5 lost its role) still read 200 with every event attributed as recorded; no row changed",
  )
  check(
    'T108',
    'Later valid reference never changes earlier finding',
    (await rowHash(W2.body.investigationEventId)) === W2rowBefore && summaryNow.findings[0].investigationEventId === W2.body.investigationEventId && summaryNow.findings[0].linkedEvidenceEventId === W1.body.investigationEventId &&
      summaryNow.findings[0].findingCode === 'EVIDENCE_CONFIRMS_RECORDED_CONFLICT' && summaryNow.evidenceLinks.length === 3,
    "after two later links and three later findings, W's first finding is byte-identical, still names link 1 and still records EVIDENCE_CONFIRMS_RECORDED_CONFLICT",
  )
  const backInsert = await directInsert([rowOf(X, { sequence: 1, evidence_kind: 'TRIAGE_EVENT', evidence_record_id: (await get(`${base(X)}/triage-history`)).body.items[0].triageEventId, evidence_contract_version: TRIAGE_CONTRACT, evidence_basis_code: null })])
  check(
    'T109',
    'Later source mutation cannot fabricate prior evidence',
    (await rowsHash([X.intakeId])) === xHashBefore && withoutEvaluatedAt((await summaryOf(X)).body) === xSummaryBefore && backInsert.refused && /exception_investigation_sequence/.test(backInsert.message) && backInsert.clean,
    "after X's A6.9 correction its link and finding are unchanged, and evidence slotted in as X's event 1 is refused by the sequence guard: nothing is back-dated into the history",
  )
  const plantedRefusals = [gapped, repeated, futureContract, findingFirst, foreignRow, mismatchedKind, unknownCode]
  const httpRefusals = [staleOnK, afterReturn, wrongLinks[0], repeatLatest, missingReference, viewerPost]
  check(
    'T110',
    'All refusals return no partial trusted summary',
    plantedRefusals.every((r) => same(Object.keys(r.value?.history ?? {}).sort(), ['code', 'message', 'ok']) && same(Object.keys(r.value?.summary ?? {}).sort(), ['code', 'message', 'ok'])) &&
      httpRefusals.every((r) => same(Object.keys(r.body ?? {}), ['error']) && same(Object.keys(r.body?.error ?? {}).sort(), ['code', 'message', 'requestId']) && !rawError(r.body)),
    'every planted refusal answers only ok/code/message (no partial history or summary), and every HTTP refusal carries only code, message and requestId — no partial body, SQL, stack, table or guard name',
  )

  // ---------------------------------------------------------------- full upstream regressions (T111–T120)
  section('Full upstream regressions — A8.2 invoked, nesting A8.1 -> A7.10 -> A7.9 -> … -> A7.1 -> A6.10 -> … -> A1')
  await apiReady('the A8.2 and backward regression chain')
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const goldenBefore = { history: withoutEvaluatedAt((await historyOf(W)).body), summary: withoutEvaluatedAt((await summaryOf(W)).body), audits: JSON.stringify(await Promise.all(historyW7.body.items.map(async (e: any) => (await auditsOfEvent(e.investigationEventId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))))) }
  const chain = run('npm run test:a8:exception-triage')
  const nestedLog = `a83-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A8.2')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A8.2] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A8.2 asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD) and re-proves A8.1's
  // branch-only causes against its own branch. On A8.3 those statements are obsolete by design; every other A8.2 check
  // is substantive. T119 below proves each cause independently on this branch.
  const a82NonApplicable: Record<string, string> = {
    T001: "A8.2 'A8.1 accepted merge ancestor' requires the A8.2 feature branch; A8.3 is branched from the main that contains the A8.2 merge (T001 here)",
    T002: "A8.2 'Clean tree and origin parity' requires tracking origin/feature/a8-2-…; THIS branch's clean tree and parity are proved by T002 here",
    T010: "A8.2 'A8.2-only changed-file allowlist' lists the paths A8.2 was allowed to change; A8.3 legitimately changes its own (T010 here)",
    T120: "A8.2 'Every historical N/A branch-only reason proved' proves A8.1's branch-only causes against the A8.2 branch; on A8.3 they are re-proved here (T119)",
    T130: "A8.2 'Two full 130-check runs: exact clean pushed HEAD' compares HEAD with origin/feature/a8-2-…; THIS run's identity and pushed HEAD are proved by T130 here",
  }
  const undocumented = failing.filter((id) => !(id in a82NonApplicable))
  const summary = chain.output.match(/\[A8\.2\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.2\] RUN ABORTED|\[A8\.2\] uncaught error|\[A8\.2\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a82Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  check(
    'T111',
    'A8.2 substantive regression passes',
    ran && reconciled && undocumented.length === 0 && a82Passing === 130 - failing.length && a82Passing >= 125 &&
      ['T004', 'T005', 'T006', 'T007', 'T009', 'T051', 'T060', 'T067', 'T071', 'T100', 'T107', 'T108', 'T110', 'T111', 'T121', 'T125', 'T126', 'T127', 'T128', 'T129'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A8.2 suite did not complete'
      : !reconciled
        ? `A8.2 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A8.2 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A8\.2\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A8.2] automated summary: ', 'A8.2 ')}; all ${a82Passing} substantive checks PASS (its own-scope T004/T007/T009 and the later-phase-aware T107/T110 included) and every failure is documented`,
  )
  for (const id of Object.keys(a82NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A8.2 ${titleOf(row.line)}`, a82NonApplicable[id])
  }
  check('T112', 'A8.1 substantive regression passes', verdictOf('T111') === 'PASS', `A8.2 T111 (A8.1, with its own documented branch-only items) ${verdictOf('T111')}`)
  check('T113', 'A7.10 cumulative regression passes', verdictOf('T112') === 'PASS', `A8.2 T112 (A7.10 through A8.1) ${verdictOf('T112')}`)
  check('T114', 'A7.9–A7.6 substantive regressions pass', ['T113', 'T114', 'T115'].every((id) => verdictOf(id) === 'PASS'), `A8.2 T113 (A7.9) ${verdictOf('T113')}, T114 (A7.8–A7.7) ${verdictOf('T114')} and T115 (A7.6–A7.5) ${verdictOf('T115')}`)
  check('T115', 'A7.5–A7.1 substantive regressions pass', ['T115', 'T116', 'T117'].every((id) => verdictOf(id) === 'PASS'), `A8.2 T115 (A7.6–A7.5) ${verdictOf('T115')}, T116 (A7.4–A7.3) ${verdictOf('T116')} and T117 (A7.2–A7.1) ${verdictOf('T117')}`)
  check('T116', 'A6.10/A6.1–A6.9 substantive regressions pass', verdictOf('T118') === 'PASS', `A8.2 T118 (A6.10, which nests A6.9 → A6.1) ${verdictOf('T118')}`)
  check('T117', 'A5 substantive regressions pass', verdictOf('T119') === 'PASS', `A8.2 T119 (the chain reaching A5.10 → A5.1) ${verdictOf('T119')}`)
  check('T118', 'A1–A4 substantive regressions pass', verdictOf('T119') === 'PASS' && verdictOf('T121') === 'PASS', `A8.2 T119 (reaching A4 → A1) ${verdictOf('T119')}; A8.2 T121 (every A1–A8.2 unit suite) ${verdictOf('T121')}`)
  // Each documented A8.2 failure must fail for its branch-only reason, proved independently on this branch; A8.2
  // T120's unproven A8.1 items, A8.1 T110's A7.10 items and A7.10 T111's A7.9 items are re-proved against this branch.
  const originOf = (name: string) => gitArgs(['rev-parse', '--verify', '--quiet', `origin/${name}`])
  const originA83 = originOf(a83Branch)
  const nestedLine = (depth: string[], id: string) =>
    chain.output.split(/\r?\n/).find((line) => new RegExp(`^\\[A8\\.2\\] +${depth.map((tag) => `nested: \\[${tag.replace('.', '\\.')}\\] +`).join('')}${id} `).test(line)) ?? ''
  const listAfter = (line: string, label: RegExp) => ((line.match(label) ?? ['', ''])[1] ?? '').split(', ').filter(Boolean)
  // A suite lists its unexpected paths and, when package.json carries more than its one script, says so in words; a
  // list cut short may end in a prefix of a path.
  const inScope = (paths: string[]) => paths.length > 0 && paths.every((path, index) => changedPaths.includes(path) || (path === 'package.json beyond the one script' && changedPaths.includes('backend/package.json')) || (index === paths.length - 1 && changedPaths.some((p) => p.startsWith(path))))
  const a82Unexpected = listAfter(lineOfRow('T010'), /unexpected: (.*)$/)
  const unprovenA81 = listAfter(lineOfRow('T120'), /cause not proven for: (.*)$/)
  const a81Unexpected = listAfter(nestedLine(['A8.1'], 'T010'), /unexpected: (.*)$/)
  const unprovenA710 = listAfter(nestedLine(['A8.1'], 'T110'), /cause not proven for: (.*)$/)
  const a710Unexpected = listAfter(nestedLine(['A8.1', 'A7.10'], 'T010'), /unexpected: (.*)$/)
  const unprovenA79 = listAfter(nestedLine(['A8.1', 'A7.10'], 'T111'), /cause not proven for: (.*)$/).filter((id) => /^T\d{3}$/.test(id))
  const nestedA81Failures = chain.output.split(/\r?\n/).filter((line) => /^\[A8\.2\] +nested: \[A8\.1\] T\d{3} .* \.{3,} FAIL/.test(line)).length
  const nestedA710Failures = chain.output.split(/\r?\n/).filter((line) => /^\[A8\.2\] +nested: \[A8\.1\] +nested: \[A7\.10\] T\d{3} .* \.{3,} FAIL/.test(line)).length
  const a710SelfCount = Number((nestedLine(['A8.1', 'A7.10'], 'T130').match(/(\d+) of the 129 checks before this one PASS/) ?? [])[1] ?? -1)
  const a81SelfLine = nestedLine(['A8.1'], 'T130')
  const onThisBranch = branch === a83Branch && dirty.length === 0 && tracking.includes(`origin/${a83Branch}`) && !/ahead|behind/.test(tracking)
  const a710Causes: Record<string, boolean> = {
    T001: onThisBranch && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a710Unexpected) && outOfScope.length === 0,
    T111: unprovenA79.length > 0 && unprovenA79.every((id) => ['T001', 'T002', 'T010', 'T120', 'T130'].includes(id)) && originOf(a79Branch) === '' && originOf(a78Branch) === '' && onThisBranch && outOfScope.length === 0,
    T122: originOf(a710Branch) === '' && originA83 === headAtStart,
    T123: originOf(a710Branch) === '' && originA83 === headAtStart,
    T130: a710SelfCount === 129 - (nestedA710Failures - 1),
  }
  const a81Causes: Record<string, boolean> = {
    T001: onThisBranch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a81Unexpected) && outOfScope.length === 0,
    T110: unprovenA710.length > 0 && unprovenA710.every((id) => id in a710Causes && a710Causes[id]),
    T130: originA83 === headAtStart && originOf(a81Branch) !== headAtStart && /all evidence corresponds to/.test(a81SelfLine),
  }
  const causes: Record<string, boolean> = {
    T001: onThisBranch && a82Merge === A82_MERGE && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && a81FixMerge.length === 40 && gitOk(`merge-base --is-ancestor ${a81FixMerge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a82Unexpected) && outOfScope.length === 0,
    T120: unprovenA81.length > 0 && unprovenA81.every((id) => id in a81Causes && a81Causes[id]),
    T130: originA83 === headAtStart && originOf(a82Branch) !== headAtStart && failing.every((id) => id in a82NonApplicable),
  }
  const unprovenHere = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A8\.2\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T119',
    'Every historical branch-only N/A justified',
    ran && failing.every((id) => id in a82NonApplicable) && unprovenHere.length === 0 && naLines.length === nestedA81Failures && naLines.length >= 5 && naLines.every((line) => line.length > 80),
    unprovenHere.length === 0
      ? `each documented A8.2 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved independently here (A8.2 T120's A8.1 items ${unprovenA81.join(', ') || 'none'}, A8.1 T110's A7.10 items ${unprovenA710.join(', ') || 'none'} and A7.10 T111's A7.9 items ${unprovenA79.join(', ') || 'none'} re-proved); A8.2 itself justifies its ${naLines.length} A8.1 items`
      : `cause not proven for: ${unprovenHere.join(', ')}`,
  )
  const register = committedText(REGISTER_DOC)
  const typesText = committedText(`${MODULE_DIR}/exception-investigation.types.ts`)
  const vocabulary = [...investigationEventCodes, ...evidenceKinds, ...findingCodes, ...investigationCodes, ...Object.values(EVIDENCE_CONTRACT_OF), CONTRACT]
  check(
    'T120',
    'Approved contract, vocabulary and start gate recorded',
    register.includes(A82_MERGE) && a82Merge === A82_MERGE && register.includes(`(${CONTRACT})`) && vocabulary.every((code) => register.includes(`\`${code}\``) && typesText.includes(`'${code}'`)) && /D14–D22/.test(register) &&
      ['getTriageDispositionOf', 'getTriageHistoryOf', 'assigneeCurrentlyEligible', 'A8-EXCEPTION-TRIAGE-1'].every((text) => register.includes(text)),
    `the register records the start gate (A8.2 merge ${A82_MERGE.slice(0, 7)}, its contract, readers and eligibility), the decisions D14–D22, ${CONTRACT} and every one of the ${vocabulary.length} controlled codes and contracts, each identical in the module`,
  )

  // ---------------------------------------------------------------- build, replay and final evidence (T121–T130)
  section('Build, replay and final evidence: units, typecheck, frontend, checksums and replay, outage and recovery, no 5xx, synthetic fixtures, the worked investigation after the nested chain and a restart, exact head')
  const allUnit = run('npm run test:unit')
  check('T121', 'Backend unit suite passes', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok, `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 11 A8.3 reducer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Backend typecheck passes', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint passes', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend production build passes', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = applied.filter((row) => {
    const blob = committedBlob(`backend/prisma/migrations/${row.name}/migration.sql`)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  check(
    'T125',
    'All HEAD migrations and checksums replay',
    status.ok && replay.ok && applied.length === headMigrationDirs.length && same(applied.map((r) => r.name), headMigrationDirs.map((d) => d.split('/').pop())) && checksumMismatch.length === 0,
    checksumMismatch.length === 0 ? `all ${applied.length} committed migrations applied in order, each with the checksum of its committed file (A8.3's included); scratch replay ALL CHECKS PASS (T006)` : `checksum differs: ${checksumMismatch.map((r) => r.name).join(', ')}`,
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
  check('T126', 'Health/ready outage/recovery', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  check('T127', 'Zero unexpected HTTP 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runEventOrgs = await prisma.$queryRawUnsafe<{ org: string; member: string | null }[]>(
    `SELECT e.organization_id::text AS org, u.email AS member FROM ${TABLE} e JOIN organization_memberships m ON m.id = e.recorded_by_membership_id JOIN "user" u ON u.id = m.user_id WHERE e.recorded_at >= $1::timestamptz AND e.recorded_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  const runSources = await prisma.$queryRawUnsafe<{ kind: string; reference: string }[]>(`SELECT source_kind AS kind, source_reference AS reference FROM revenue_source_evidence WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, runStartedAt.toISOString(), chainStartedAt.toISOString())
  const secrets = [adminPassword, viewerPassword, admin.cookie, viewer.cookie, ...[B, M1, M2, M4, M5, NR, O, O2].map((m) => m.cookie)].filter((s) => s.length > 8)
  check(
    'T128',
    'Synthetic-only fixtures and safe logs',
    runEventOrgs.length >= 15 && runEventOrgs.every((e) => e.org === org && /@reviewers\.sbn\.test$/.test(e.member ?? '')) && runSources.length > 0 && runSources.every((s) => s.kind === SYNTHETIC && s.reference.includes(runToken)) &&
      (await eventsOf(F.intakeId)).length === 0 && secrets.every((s) => !printed.join('\n').includes(s) && !chain.output.includes(s)),
    `the ${runEventOrgs.length} investigation events this run recorded (before the nested chain) all belong to the synthetic Org A and were recorded only by synthetic members; Org B's intake has none; every source is INTERNAL_SYNTHETIC keyed by ${runId}; no password or cookie appears in any output`,
  )
  const historyAfter = await historyOf(W)
  const goldenAfter = { history: withoutEvaluatedAt(historyAfter.body), summary: withoutEvaluatedAt((await summaryOf(W)).body), audits: JSON.stringify(await Promise.all(historyAfter.body.items.map(async (e: any) => (await auditsOfEvent(e.investigationEventId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))))) }
  progress(
    `worked investigation: Claim W ${W.claimId}, intake ${W.intakeId} (A8.2: classify → assign M1): link basis ${W.basisCode} → finding EVIDENCE_CONFIRMS_RECORDED_CONFLICT on 1 → link triage event → link A7.5 assessment → finding EVIDENCE_INCONCLUSIVE on 4 → finding FURTHER_REVIEW_REQUIRED on 1 → (A8.2 reassign M2) finding FURTHER_REVIEW_REQUIRED on 3 by M2 → (A8.2 return: further writes refused); FINDING_RECORDED, 7 events, 7 audits; X's later A6.9 correction rewrote nothing`,
  )
  check('T129', 'Worked investigation survives nested replay and restart', same(goldenAfter, goldenBefore) && W_RETURN.sequence === 4 && W_REASSIGN.sequence === 3, "after the nested chain, its database restarts and an outage, W's seven events, its summary and their seven audits read back identically")
  const headNow = git('rev-parse HEAD')
  check(
    'T130',
    'Second independent 130/130 run at exact HEAD',
    headNow === headAtStart && headNow === originA83 && headNow.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a83Branch}`) && !/ahead|behind/.test(tracking) && outOfScope.length === 0 && /^A83-\d{13}$/.test(runId) && existsSync(nestedLog),
    `all evidence corresponds to ${headNow} (= origin/${a83Branch}); ${tracking}; fresh runId ${runId}; nested output kept in backend/${nestedLog} (SHA-256 ${sha256Of(Buffer.from(chain.output)).slice(0, 16)}…); the two submitted runs must both state this HEAD`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] EXCEPTION INVESTIGATION ACCEPTANCE COMPLETE` : `[${TAG}] A8.3 FINAL FAIL`)
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
