import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordTriageEvent } from '../../modules/exception-triage/exception-triage.service.ts'
import { recordWorkEvent } from '../../modules/exception-remediation-work/exception-remediation-work.service.ts'
import { WORK_CODE_OF_ACTION } from '../../modules/exception-remediation-work/exception-remediation-work.types.ts'
import { deriveResolution } from '../../modules/exception-resolution/exception-resolution.reducer.ts'
import { getResolutionDispositionOf, getResolutionHistoryOf, recordResolutionEvent, recordResolutionEventOn } from '../../modules/exception-resolution/exception-resolution.service.ts'
import {
  PARENT_READ_PERMISSIONS,
  RESOLUTION_CONTRACT_VERSION,
  decisionCodes,
  requestReasonCodes,
  resolutionEventCodes,
  resolutionStates,
  returnReasonCodes,
} from '../../modules/exception-resolution/exception-resolution.types.ts'

// A8.7 — focused acceptance for the Internal Exception Resolution Decision (A8-RESOLUTION-DECISION-1, T001–T130).
//
// Every Claim, freeze, A8.1 intake, A8.2 triage event, A8.3 investigation event, A8.5 remediation event and A8.6 work
// event is built through its owners exactly as the A8.6 suite builds them: a Claim frozen twice without an A6.9 link is a
// genuine history contradiction, its intake is recorded through the A8.1 route, classified and assigned through the A8.2
// route, its assignee links the intake basis and records a finding through the A8.3 route, proposes an action through
// the A8.5 route and an independent reviewer approves it there, then the assignee reports the work through the A8.6 route
// and an independent verifier verifies it there. Every resolution event is recorded through the A8.7 route by the
// assignee or an independent decider or, where a probe must pause or fail one writer, through the production A8.7
// service in this process. Direct SQL writes are adversarial only, run against the live guards (or, to isolate one
// CHECK, with the triggers off), and are ALWAYS rolled back; a broken stored history is planted only inside such a
// transaction and the production reads answer on THAT transaction. Synthetic users are provisioned per run through
// Better Auth's own server-side creation with a random password that is never printed; one synthetic role, created and
// removed again by this run, proves each of the five upstream read permissions on its own. RESOLVED_INTERNAL is an
// internal decision only: nothing in this suite expects, or finds, anything executed, corrected, closed or paid.

const TAG = 'A8.7'
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

// Every `npm run` prepends its node_modules/.bin directories to PATH again, so each level of the nested regression
// chain makes PATH longer; a spawned command therefore gets PATH without the .bin entries npm added on the way here
// (npm adds exactly those back for the command it runs).
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

const gitArgs = (args: string[]) => (spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '').replace(/\s+$/, '')
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

const runId = `A87-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a87Branch = 'feature/a8-7-internal-exception-resolution'
const a86Branch = 'feature/a8-6-remediation-work-verification'
const a85Branch = 'feature/a8-5-exception-remediation'
const crgbBranch = 'feature/crg-01b-coding-validation-freeze'
const crgBranch = 'fix/crg-01-final-coding-release'
// The accepted A8.5 merge, the Checkpoint B merge, the accepted A8.6 merge and the clean main this branch was cut from,
// all recorded in the register (start gate).
const A85_MERGE = '0f8f9d3bc18347b1360b72b93056724b594a6e00'
const CRGB_MERGE = '4869df3c81ac4af5dcec988768666f7acd3d809e'
const A86_MERGE = '18de6c81f9f47374d011cfe9a688b500b8c17beb'
const MAIN_AT_START = '18de6c81f9f47374d011cfe9a688b500b8c17beb'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/exception-resolution'
const FE_DIR = 'frontend/src/modules/exception-resolution'
const HARNESS_DIR = 'backend/src/integration/a8-exception-resolution'
const REGISTER_DOC = 'docs/A8_Exception_Resolution.md'
const MIGRATION_NAME = '20261110090000_a8_7_exception_resolution'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const A86_MIGRATION = 'backend/prisma/migrations/20261107090000_a8_6_exception_remediation_work/migration.sql'
const A85_MIGRATION = 'backend/prisma/migrations/20261105090000_a8_5_exception_remediation/migration.sql'
const A83_MIGRATION = 'backend/prisma/migrations/20261103090000_a8_3_exception_investigation/migration.sql'
const TABLE = 'exception_resolution_events'
const WORK_TABLE = 'exception_remediation_work_events'
const REMEDIATION_TABLE = 'exception_remediation_events'
const INVESTIGATION_TABLE = 'exception_investigation_events'
const TRIAGE_TABLE = 'exception_triage_events'
const INTAKE_TABLE = 'exception_intake_records'
const UNIT_TESTS = [`${MODULE_DIR}/exception-resolution.reducer.test.ts`, `${MODULE_DIR}/exception-resolution.validation.test.ts`]
const CONTRACT = 'A8-RESOLUTION-DECISION-1'
const WORK_CONTRACT = 'A8-REMEDIATION-WORK-1'
const INTAKE_CONTRACT = 'A8-EXCEPTION-INTAKE-1'
const TIMELINE_CONTRACT = 'A7-REVENUE-TIMELINE-1'
const FIVE_READS = ['exceptionIntake.read', 'exceptionTriage.read', 'exceptionInvestigation.read', 'exceptionRemediation.read', 'exceptionRemediationWork.read']
const EVENT_KEYS = [
  'resolutionEventId', 'contractVersion', 'exceptionIntakeId', 'organizationId', 'claimId', 'sequence', 'eventCode', 'verificationEventId', 'requestEventId', 'reasonCode', 'decisionCode',
  'returnReasonCode', 'recordedByMembershipId', 'recordedByUserId', 'recordedAt',
]
const HISTORY_KEYS = ['contractVersion', 'exceptionIntakeId', 'items', 'evaluatedAt']
const DISPOSITION_KEYS = ['contractVersion', 'exceptionIntakeId', 'state', 'verificationEventId', 'request', 'decision', 'eventCount', 'lastSequence', 'evaluatedAt']
const REQUEST_KEYS = ['resolutionEventId', 'sequence', 'verificationEventId', 'reasonCode', 'requestedByMembershipId', 'requestedByUserId']
const DECISION_KEYS = ['resolutionEventId', 'sequence', 'requestEventId', 'decisionCode', 'returnReasonCode', 'decidedByMembershipId', 'decidedByUserId']
const AUDIT_KEYS = [
  'resolutionEventId', 'exceptionIntakeId', 'claimId', 'contractVersion', 'sequence', 'eventCode', 'verificationEventId', 'requestEventId', 'reasonCode', 'decisionCode', 'returnReasonCode',
  'recordedByMembershipId', 'recordedAt',
]
const COLUMNS = [
  'id', 'exception_intake_id', 'organization_id', 'claim_id', 'contract_version', 'sequence', 'event_code', 'verification_event_id', 'request_event_id', 'reason_code', 'decision_code',
  'return_reason_code', 'recorded_by_membership_id', 'recorded_by_user_id', 'recorded_at', 'created_at',
]
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/shared/authorization/authorization.types.ts',
  'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'backend/src/modules/audit/audit.types.ts', 'frontend/src/developer/checkRegistry.tsx', REGISTER_DOC,
]
// Every table a resolution write could conceivably touch, in a fixed key order. A read or a refusal must leave every one
// as it was; a recorded event adds exactly one row here and one audit.
const COUNT_TABLES = [
  TABLE, WORK_TABLE, REMEDIATION_TABLE, INVESTIGATION_TABLE, TRIAGE_TABLE, INTAKE_TABLE, 'audit_events', 'claims', 'claim_freezes', 'claim_freeze_lifecycle_events', 'claim_correction_links',
  'organization_memberships', 'membership_roles',
]
// The CRG-01 coding-release and validation tables and the A2 code masters: no resolution event selects, activates,
// imports or changes any of them.
const CODING_TABLES = [
  'crg_code_system_datasets', 'crg_code_system_rights', 'crg_release_imports', 'crg_release_code_memberships', 'crg_retirement_classifications', 'crg_validation_scopes', 'crg_validation_code_receipts',
  'crg_validation_receipt_manifests', 'procedure_codes', 'diagnosis_codes',
]
// The A7 historical records: a resolution event writes none of them.
const A7_TABLES = ['revenue_source_evidence', 'source_evidence_classifications', 'evidence_gate_results', 'evidence_case_snapshots', 'evidence_case_entries', 'evidence_prereq_results']

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

// The disposition replayed by THIS suite, independently of the module's reducer, from a history's items and the
// intake's verified A8.6 record as its owner reports it.
type HistoryItem = { resolutionEventId: string; sequence: number; eventCode: string; verificationEventId: string | null; requestEventId: string | null; decisionCode: string | null }
function replayIndependently(items: HistoryItem[], verificationEventId: string | null) {
  let state = 'NO_RESOLUTION_REQUEST'
  let request: HistoryItem | null = null
  let decision: HistoryItem | null = null
  for (const item of items) {
    if (item.eventCode === 'REQUEST_INTERNAL_RESOLUTION') {
      request = item
      state = 'AWAITING_RESOLUTION_DECISION'
    } else {
      decision = item
      state = item.decisionCode === 'CONFIRM_INTERNAL_RESOLUTION' ? 'RESOLVED_INTERNAL' : 'RETURNED_FOR_REWORK'
    }
  }
  return {
    state,
    verificationEventId,
    requestId: request?.resolutionEventId ?? null,
    decisionId: decision?.resolutionEventId ?? null,
    eventCount: items.length,
    lastSequence: items.length > 0 ? items[items.length - 1].sequence : null,
  }
}
const dispositionFacts = (d: any) => ({
  state: d?.state,
  verificationEventId: d?.verificationEventId ?? null,
  requestId: d?.request?.resolutionEventId ?? null,
  decisionId: d?.decision?.resolutionEventId ?? null,
  eventCount: d?.eventCount,
  lastSequence: d?.lastSequence,
})

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)
  // pg's concurrent-query deprecation, if it ever fires in this process (it is still printed); T125 requires none here
  // and none in any process of the nested chain.
  const driverWarnings: string[] = []
  process.on('warning', (warning) => {
    if (/Calling client\.query\(\) when the client is already executing a query/.test(warning.message)) driverWarnings.push(warning.message)
  })

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] A8.7 internal exception resolution decision (${CONTRACT}) — run ${runId}`)
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

  // A synthetic partial role left by an interrupted earlier run (T023) is removed before anything is judged.
  for (const role of await prisma.role.findMany({ where: { code: { startsWith: 'SYNTHETIC_A87_' } }, select: { id: true } })) {
    await prisma.membershipRole.deleteMany({ where: { roleId: role.id } })
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
    await prisma.role.delete({ where: { id: role.id } })
  }

  // ---------------------------------------------------------------- start, baseline and phase (T001–T010)
  section('Start, baseline and phase: the accepted A8.5 and A8.6 merges, the A8.4 closure, branch and parity, one additive migration, Prisma, replay, earlier versions and owners unchanged, three routes, diff scope')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const shortMain = git('rev-parse --short=7 origin/main')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a85Merge = mergeOf(a85Branch)
  const a86Merge = mergeOf(a86Branch)
  const crgbMerge = mergeOf(crgbBranch)
  const crgMerge = mergeOf(crgBranch)
  check(
    'T001',
    'A8.5 accepted merge is ancestor',
    branch === a87Branch && a85Merge === A85_MERGE && gitOk(`merge-base --is-ancestor ${a85Merge} HEAD`) && crgbMerge === CRGB_MERGE && gitOk(`merge-base --is-ancestor ${crgbMerge} HEAD`) &&
      crgMerge.length === 40 && gitOk(`merge-base --is-ancestor ${crgMerge} HEAD`) && gitOk(`merge-base --is-ancestor ${MAIN_AT_START} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; A8.5 merged as ${a85Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A85_MERGE.slice(0, 7)}), Checkpoint B as ${crgbMerge.slice(0, 7) || 'NOT FOUND'} and Checkpoint A as ${crgMerge.slice(0, 7) || 'NOT FOUND'}, all ancestors; cut from clean main ${MAIN_AT_START.slice(0, 7)}; latest main ${shortMain} contained; not stacked`,
  )
  check(
    'T002',
    'A8.6 accepted merge is ancestor',
    a86Merge === A86_MERGE && gitOk(`merge-base --is-ancestor ${a86Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${A85_MERGE} ${A86_MERGE}`),
    `A8.6 merged as ${a86Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A86_MERGE.slice(0, 7)}, accepted and closed at that merge), an ancestor of HEAD and a descendant of the A8.5 merge`,
  )
  const registerAtHead = committedText(REGISTER_DOC)
  const registerFlat = registerAtHead.replace(/\s+/g, ' ')
  const headTree = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter(Boolean)
  const a84Paths = headTree.filter((path) => /(^|[\\/_-])a8[-_]?4([\\/_.-]|$)/i.test(path))
  check(
    'T003',
    'A8.4 duplicate closure remains recorded',
    registerFlat.includes('On 2026-11-04 the architecture owner closed the earlier A8.4 specification as a duplicate of A8.3') && registerFlat.includes('No A8.4 code exists') && a84Paths.length === 0,
    a84Paths.length === 0 ? 'the register records the 2026-11-04 closure of A8.4 as a duplicate of A8.3; no A8.4 module, migration, suite or page exists at HEAD' : `A8.4 paths exist: ${a84Paths.join(', ').slice(0, 200)}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T004',
    'Clean branch and remote parity',
    branch === a87Branch && dirty.length === 0 && tracking.includes(`origin/${a87Branch}`) && !/ahead|behind/.test(tracking),
    dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  // A8.7's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge added
  // (the same values, literally, on its own branch). A later package's changes are that package's to prove.
  const ownMerge = branch === a87Branch ? '' : mergeOf(a87Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'
  const ownTip = ownMerge || 'HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = migrationDirsAt(ownTip)
  const ownBaseMigrationDirs = migrationDirsAt(ownBase)
  check(
    'T005',
    'One additive A8.7 migration only',
    same(ownPrismaStatus, [`A\t${MIGRATION}`, 'M\tbackend/prisma/schema.prisma']) && ownHeadMigrationDirs.length === ownBaseMigrationDirs.length + 1 && ownBaseMigrationDirs.every((dir) => ownHeadMigrationDirs.includes(dir)) &&
      ownHeadMigrationDirs[ownHeadMigrationDirs.length - 1].endsWith(MIGRATION_NAME),
    `exactly one migration added (${MIGRATION_NAME}, the newest in its own scope) and the schema extended; all ${ownBaseMigrationDirs.length} applied migrations before it untouched`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T006', 'Prisma validation, generation, status clean', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'the schema validates and generates; the working database is up to date with every migration (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check(
    'T007',
    'From-empty migration replay matches DB',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && /PASS {2}the A8\.7 tables are exactly exception_resolution_events/.test(replay.output) &&
      /PASS {2}exception_resolution_events_insert_guard_trg is present/.test(replay.output) && /PASS {2}one resolution event per \(intake, sequence\) and one decision per request are unique/.test(replay.output) &&
      /PASS {2}the A8\.7 CHECKs pin A8-RESOLUTION-DECISION-1/.test(replay.output) && /PASS {2}exception_resolution_events carries exactly its 16 A8\.7 columns/.test(replay.output) &&
      /PASS {2}the A8\.6 tables are exactly exception_remediation_work_events/.test(replay.output),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD; every A8.7 CHECK, unique index, trigger, column and RESTRICT key survives, as does every A8.6 one`,
  )
  const catalogueAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/authorization/authorization.types.ts`]).matchAll(/^\s+'([A-Za-z_]+\.[A-Za-z_]+)',/gm)].map((m) => m[1])
  const auditCodesAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/modules/audit/audit.types.ts`]).matchAll(/^\s+'([a-z_]+\.[a-z_]+)',/gm)].map((m) => m[1])
  const catalogueHead = catalogueAt(ownTip)
  const catalogueMain = catalogueAt(ownBase)
  const laterPermissions = ownMerge ? catalogueAt('HEAD').filter((c) => !catalogueHead.includes(c)) : []
  const auditHead = auditCodesAt(ownTip)
  const auditMain = auditCodesAt(ownBase)
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const RESOLUTION_PERMISSIONS = ['exceptionResolution.decide', 'exceptionResolution.read', 'exceptionResolution.request']
  const knownException = [
    'exceptionIntake.create', 'exceptionIntake.read', 'exceptionTriage.read', 'exceptionTriage.record', 'exceptionInvestigation.read', 'exceptionInvestigation.record', 'exceptionRemediation.propose',
    'exceptionRemediation.review', 'exceptionRemediation.read', 'exceptionRemediationWork.read', 'exceptionRemediationWork.record', 'exceptionRemediationWork.verify', ...RESOLUTION_PERMISSIONS,
  ]
  const contractConstantsAt = (ref: string) =>
    gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, 'backend/src/modules'])
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path) && !path.startsWith(`${MODULE_DIR}/`))
      .flatMap((path) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(/export const ([A-Z_0-9]*CONTRACT_VERSION[A-Z_0-9]*) = '([^']+)'/g)].map((m) => `${path}:${m[1]}=${m[2]}`))
      .sort()
  const errorCodesAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/errors/error.types.ts`]).matchAll(/^\s+'([A-Z_]+)',/gm)].map((m) => m[1])
  const contractsOwn = contractConstantsAt(ownTip)
  const errorsOwn = errorCodesAt(ownTip)
  const errorsBase = errorCodesAt(ownBase)
  const productDiff = ownChangedPaths.filter((p) => /^backend\/src\/modules\//.test(p) && !p.startsWith(`${MODULE_DIR}/`) && p !== 'backend/src/modules/audit/audit.types.ts')
  const ownEarlierSuites = ownChangedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`))
  const ownEarlierUnits = ownChangedPaths.filter((file) => /\.test\.tsx?$/.test(file) && !file.startsWith(`${MODULE_DIR}/`))
  check(
    'T008',
    'Old versions and owner modules unchanged',
    contractsOwn.length >= 23 && same(contractsOwn, contractConstantsAt(ownBase)) && productDiff.length === 0 && ownEarlierSuites.length === 0 && ownEarlierUnits.length === 0 &&
      ownPrismaStatus.every((s) => !/^M\tbackend\/prisma\/migrations\//.test(s)) && committedText(`${MODULE_DIR}/exception-resolution.types.ts`).includes(`RESOLUTION_CONTRACT_VERSION = '${CONTRACT}'`) &&
      errorsBase.every((c) => errorsOwn.includes(c)) &&
      same(errorsOwn.filter((c) => !errorsBase.includes(c)), [
        'EXCEPTION_RESOLUTION_NOT_ASSIGNEE', 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT', 'EXCEPTION_RESOLUTION_BASIS_NOT_VERIFIED', 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED', 'EXCEPTION_RESOLUTION_CONFLICT',
      ]) &&
      same(catalogueHead.filter((c) => !catalogueMain.includes(c)).sort(), RESOLUTION_PERMISSIONS) && catalogueMain.every((c) => catalogueHead.includes(c)) &&
      same(allCodes.filter((c) => /^exceptionResolution\./.test(c)).sort(), RESOLUTION_PERMISSIONS) &&
      (await grantsOf('exceptionResolution.request')) === 'ORG_ADMIN' && (await grantsOf('exceptionResolution.decide')) === 'ORG_ADMIN' && (await grantsOf('exceptionResolution.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('exceptionRemediationWork.record')) === 'ORG_ADMIN' && (await grantsOf('exceptionRemediationWork.verify')) === 'ORG_ADMIN' && (await grantsOf('exceptionRemediationWork.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('exceptionTriage.record')) === 'ORG_ADMIN' && !allCodes.some((c) => /^exception/i.test(c) && !knownException.includes(c) && !laterPermissions.includes(c)) &&
      same(auditHead.filter((c) => !auditMain.includes(c)), ['exception_resolution.recorded']) && auditMain.every((c) => auditHead.includes(c)),
    `all ${contractsOwn.length} A1–A8.6 and CRG owner contract literals identical to main; no earlier module's code, integration suite, unit test or applied migration changed; the error catalogue gains only the five A8.7 codes, the permission catalogue exactly exceptionResolution.request and .decide (Admin) and .read (Admin, Viewer), the audit catalogue exactly exception_resolution.recorded; every earlier grant is unchanged`,
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
  const viewerUser = await prisma.user.findFirstOrThrow({ where: { email: viewerEmail }, select: { id: true } })
  const viewerMembershipId = (await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId: org, userId: viewerUser.id }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  // Raw database text in a response body: SQL keywords, a stack frame or a physical table or guard name.
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /exception_resolution_|exception_remediation_|exception_investigation_|exception_triage_|exception_intake_|claim_freeze|organization_memberships/.test(text)
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
  // B approves home freezes; M1 is the worked scenario's assignee, A8.6 reporter and A8.7 requester; RV approves every
  // A8.5 proposal; VR and VR2 verify A8.6 work (VR also returns RT's request, as D5 allows); VR3 verifies H's work and
  // later loses its role; DR is the independent decider (never assigned); DR2 decides H and loses its role while it
  // does; M2 is K's former assignee and its assignee again after a concurrent reassignment; M4 owns the other intakes;
  // M5 loses its role while it requests on G; NR is a member without any role; PT holds a synthetic role this run
  // narrows one permission at a time; O and O2 belong to the other tenant. M1 also holds a second membership in the
  // other tenant (M1X), so the same user through another membership can be tried.
  const B = await provisionMember('b')
  const M1 = await provisionMember('m1')
  const RV = await provisionMember('rv')
  const VR = await provisionMember('vr')
  const VR2 = await provisionMember('vr2')
  const VR3 = await provisionMember('vr3')
  const DR = await provisionMember('dr')
  const DR2 = await provisionMember('dr2')
  const M2 = await provisionMember('m2')
  const M4 = await provisionMember('m4')
  const M5 = await provisionMember('m5')
  const NR = await provisionMember('norole', org, false)
  const PT = await provisionMember('partial', org, false)
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)
  const M1X = await prisma.organizationMembership.create({ data: { organizationId: otherOrg, userId: M1.id } })
  await prisma.membershipRole.create({ data: { membershipId: M1X.id, roleId: adminRole.id } })

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: two organizations; Claims frozen twice without a link, their A8.1 intakes, A8.2 assignments, A8.3 links and findings, A8.5 proposals approved by an independent reviewer and A8.6 work reports verified by an independent verifier')
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
    const validationFinding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
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
      const findings = [validationFinding('WARNING', { layer: 'CODING' }), ...activityIds.map((encounterActivityId) => validationFinding('PASS', { encounterActivityId })), validationFinding('PASS', { layer: 'CODING', encounterDiagnosisId })]
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
  const timelineBody = (claimId: string) => ({ sourceKind: 'REVENUE_TIMELINE', sourceRecordId: claimId, sourceContractVersion: TIMELINE_CONTRACT, exceptionReasonCode: 'PROVENANCE_CONFLICT' })
  type Intake = { label: string; claimId: string; intakeId: string; organizationId: string; freezes: string[]; basisCode: string; basisRecordId: string; status: number }
  // A Claim frozen twice with no A6.9 link (a genuine contradiction the A7.7 owner refuses) and its A8.1 intake,
  // recorded through the A8.1 route.
  const intakeFor = async (label: string, world = home, who: Who = asAdmin): Promise<Intake> => {
    const claim = await world.series(label, 2)
    const res = await post(`/api/claims/${claim.claimId}/exception-intake`, timelineBody(claim.claimId), who)
    if (res.status !== 201) throw new Error(`fixture ${label}: the A8.1 intake was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return { label, claimId: claim.claimId, intakeId: res.body.exceptionIntakeId, organizationId: res.body.organizationId, freezes: claim.freezes, basisCode: res.body.basisCode, basisRecordId: res.body.basisRecordId, status: res.status }
  }
  const base = (k: { claimId: string; intakeId: string }) => `/api/claims/${k.claimId}/exceptions/${k.intakeId}`
  // A8.2 through its own route (the harness's Admin, or another tenant's Admin): classification, assignment.
  const triage = async (k: Intake, body: unknown, who: Who = asAdmin) => {
    const res = await post(`${base(k)}/triage-events`, body, who)
    if (res.status !== 201) throw new Error(`fixture ${k.label}: the A8.2 event ${JSON.stringify(body)} was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { triageEventId: string; sequence: number }
  }
  const classify = { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'PROVENANCE_INTEGRITY', priorityCode: 'ELEVATED' }
  const assignTo = (member: { membershipId: string }) => ({ eventCode: 'ASSIGN_OWNER', assignedMemberId: member.membershipId })
  const reassignTo = (member: { membershipId: string }) => ({ eventCode: 'REASSIGN_OWNER', assignedMemberId: member.membershipId })
  // A8.3 through its own route by the assignee: the intake's basis linked, then one finding naming that link.
  type Investigated = { linkId: string; findingId: string; statuses: number[] }
  const investigate = async (k: Intake, who: Who, findingCode = 'FURTHER_REVIEW_REQUIRED'): Promise<Investigated> => {
    const link = await post(`${base(k)}/investigation-events`, { eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS', evidenceRecordId: k.basisRecordId, evidenceContractVersion: INTAKE_CONTRACT }, who)
    if (link.status !== 201) throw new Error(`fixture ${k.label}: the A8.3 link was refused with ${link.status} ${errorCode(link.body) ?? ''}`)
    const found = await post(`${base(k)}/investigation-events`, { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: link.body.investigationEventId, findingCode }, who)
    if (found.status !== 201) throw new Error(`fixture ${k.label}: the A8.3 finding was refused with ${found.status} ${errorCode(found.body) ?? ''}`)
    return { linkId: link.body.investigationEventId, findingId: found.body.investigationEventId, statuses: [link.status, found.status] }
  }
  // A8.5 through its own route: the assignee proposes one controlled action on its finding, and (unless `decision` is
  // null) an independent reviewer decides it.
  type Plan = { proposalId: string; actionCode: string; workCode: string; statuses: number[] }
  const planFor = async (k: Intake, finding: string, proposer: Who, actionCode: string, decision: 'APPROVE_PROPOSAL' | 'RETURN_PROPOSAL' | null = 'APPROVE_PROPOSAL', reviewer: Who = RV.who): Promise<Plan> => {
    const proposed = await post(`${base(k)}/remediation-events`, { eventCode: 'PROPOSE_ACTION', actionCode, findingEventId: finding, rationaleCode: 'INSUFFICIENT_EVIDENCE' }, proposer)
    if (proposed.status !== 201) throw new Error(`fixture ${k.label}: the A8.5 proposal was refused with ${proposed.status} ${errorCode(proposed.body) ?? ''}`)
    const statuses = [proposed.status]
    if (decision) {
      const decided = await post(`${base(k)}/remediation-events`, decision === 'APPROVE_PROPOSAL' ? { eventCode: 'REVIEW_ACTION', proposalEventId: proposed.body.remediationEventId, decisionCode: decision } : { eventCode: 'REVIEW_ACTION', proposalEventId: proposed.body.remediationEventId, decisionCode: decision, reviewReasonCode: 'WRONG_SCOPE' }, reviewer)
      if (decided.status !== 201) throw new Error(`fixture ${k.label}: the A8.5 decision was refused with ${decided.status} ${errorCode(decided.body) ?? ''}`)
      statuses.push(decided.status)
    }
    return { proposalId: proposed.body.remediationEventId, actionCode, workCode: WORK_CODE_OF_ACTION[actionCode as keyof typeof WORK_CODE_OF_ACTION], statuses }
  }
  // A8.6 through its own route: the assignee reports the work against the approved plan citing its finding, and (unless
  // `verdict` is null) an independent verifier verifies it there.
  type Work = { reportId: string; verificationId: string | null; statuses: number[] }
  const workFor = async (k: Intake, plan: Plan, finding: string, reporter: Who, verifier: Who | null, verdict: 'EVIDENCE_SUPPORTED' | 'EVIDENCE_NOT_VERIFIED' | null = 'EVIDENCE_SUPPORTED'): Promise<Work> => {
    const reported = await post(`${base(k)}/remediation-work-events`, { eventCode: 'RECORD_WORK_REPORT', approvedProposalEventId: plan.proposalId, workCode: plan.workCode, basisReferenceKind: 'INVESTIGATION_FINDING', basisReferenceId: finding }, reporter)
    if (reported.status !== 201) throw new Error(`fixture ${k.label}: the A8.6 report was refused with ${reported.status} ${errorCode(reported.body) ?? ''}`)
    const statuses = [reported.status]
    let verificationId: string | null = null
    if (verifier && verdict) {
      const body = verdict === 'EVIDENCE_SUPPORTED' ? { eventCode: 'VERIFY_WORK_REPORT', workReportEventId: reported.body.workEventId, verificationCode: verdict } : { eventCode: 'VERIFY_WORK_REPORT', workReportEventId: reported.body.workEventId, verificationCode: verdict, reasonCode: 'SOURCE_MISMATCH' }
      const verified = await post(`${base(k)}/remediation-work-events`, body, verifier)
      if (verified.status !== 201) throw new Error(`fixture ${k.label}: the A8.6 verification was refused with ${verified.status} ${errorCode(verified.body) ?? ''}`)
      statuses.push(verified.status)
      verificationId = verified.body.workEventId
    }
    return { reportId: reported.body.workEventId, verificationId, statuses }
  }
  // W — the worked scenario and the golden history (request by M1, confirmed by DR). RT — a request returned by VR (the
  // A8.6 verifier, as D5 allows). N — A8.6 NOT_VERIFIED. AW — an A8.6 report awaiting verification. U — an A8.5 proposal
  // awaiting review. UR — an A8.5 proposal returned. L0 — kept UNTRIAGED. S — direct SQL (never a committed resolution
  // event). J — failure injection, retries and unknown outcomes. AT — the atomic commit, the read during a write and the
  // unique collision. R — races. K — the A8.2 interplay (M2 assigned, then M4; reassigned to M2 concurrently later). G —
  // M5's role removal. Q — mixed concurrent operations. H — the A8.6 verifier's role removal, the decider's role removal
  // and a concurrent A8.2 return. F — the other tenant's intake, with its own triage, finding, approved plan and
  // verified work.
  const W = await intakeFor('worked')
  const RT = await intakeFor('returned-rework')
  const N = await intakeFor('notverified')
  const AW = await intakeFor('awaiting-work')
  const U = await intakeFor('unapproved')
  const UR = await intakeFor('plan-returned')
  const L0 = await intakeFor('untriaged')
  const S = await intakeFor('sql')
  const J = await intakeFor('inject')
  const AT = await intakeFor('atomic')
  const R = await intakeFor('race')
  const K = await intakeFor('interplay')
  const G = await intakeFor('revoked')
  const Q = await intakeFor('mixed')
  const H = await intakeFor('historical')
  const F = await intakeFor('foreign', away, O.who)
  const W_CLASSIFY = await triage(W, classify)
  const W_ASSIGN = await triage(W, assignTo(M1))
  for (const k of [RT, N, AW, U, UR, S, J, AT, R, Q, H]) {
    await triage(k, classify)
    await triage(k, assignTo(M4))
  }
  await triage(K, classify)
  await triage(K, assignTo(M2))
  await triage(K, reassignTo(M4))
  await triage(G, classify)
  await triage(G, assignTo(M5))
  await triage(F, classify, O.who)
  await triage(F, assignTo(O), O.who)
  const IW = await investigate(W, M1.who)
  const assigned: [Intake, Who][] = [[RT, M4.who], [N, M4.who], [AW, M4.who], [U, M4.who], [UR, M4.who], [S, M4.who], [J, M4.who], [AT, M4.who], [R, M4.who], [K, M4.who], [G, M5.who], [Q, M4.who], [H, M4.who], [F, O.who]]
  const investigated = new Map<string, Investigated>([[W.intakeId, IW]])
  for (const [k, who] of assigned) investigated.set(k.intakeId, await investigate(k, who))
  const findingOf = (k: Intake) => (investigated.get(k.intakeId) as Investigated).findingId
  const PW = await planFor(W, IW.findingId, M1.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PRT = await planFor(RT, findingOf(RT), M4.who, 'REVIEW_SOURCE_PROVENANCE')
  const PN = await planFor(N, findingOf(N), M4.who, 'REVIEW_SOURCE_PROVENANCE')
  const PAW = await planFor(AW, findingOf(AW), M4.who, 'REFER_FOR_POLICY_REVIEW')
  const PU = await planFor(U, findingOf(U), M4.who, 'REFER_FOR_POLICY_REVIEW', null)
  const PUR = await planFor(UR, findingOf(UR), M4.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', 'RETURN_PROPOSAL')
  const PS = await planFor(S, findingOf(S), M4.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PJ = await planFor(J, findingOf(J), M4.who, 'REFER_FOR_POLICY_REVIEW')
  const PAT = await planFor(AT, findingOf(AT), M4.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PR = await planFor(R, findingOf(R), M4.who, 'REVIEW_SOURCE_PROVENANCE')
  const PK = await planFor(K, findingOf(K), M4.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PG = await planFor(G, findingOf(G), M5.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PQ = await planFor(Q, findingOf(Q), M4.who, 'RECHECK_CODING_REFERENCE')
  const PH = await planFor(H, findingOf(H), M4.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PF = await planFor(F, findingOf(F), O.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', 'APPROVE_PROPOSAL', O2.who)
  const WW = await workFor(W, PW, IW.findingId, M1.who, VR.who)
  const WRT = await workFor(RT, PRT, findingOf(RT), M4.who, VR.who)
  const WN = await workFor(N, PN, findingOf(N), M4.who, VR.who, 'EVIDENCE_NOT_VERIFIED')
  const WAW = await workFor(AW, PAW, findingOf(AW), M4.who, null, null)
  const WS = await workFor(S, PS, findingOf(S), M4.who, VR.who)
  const WJ = await workFor(J, PJ, findingOf(J), M4.who, VR.who)
  const WAT = await workFor(AT, PAT, findingOf(AT), M4.who, VR2.who)
  const WR = await workFor(R, PR, findingOf(R), M4.who, VR.who)
  const WK = await workFor(K, PK, findingOf(K), M4.who, VR.who)
  const WG = await workFor(G, PG, findingOf(G), M5.who, VR.who)
  const WQ = await workFor(Q, PQ, findingOf(Q), M4.who, VR2.who)
  const WH = await workFor(H, PH, findingOf(H), M4.who, VR3.who)
  const WF = await workFor(F, PF, findingOf(F), O.who, O2.who)
  const VW = WW.verificationId as string
  const VRT = WRT.verificationId as string
  const VN = WN.verificationId as string
  const VS = WS.verificationId as string
  const VF = WF.verificationId as string
  const homeIntakes = [W, RT, N, AW, U, UR, L0, S, J, AT, R, K, G, Q, H]
  const runIntakes = [...homeIntakes, F]
  const runClaims = homeIntakes.map((k) => k.claimId)
  const verificationOfIntake = new Map<string, string | null>(
    [[W, WW], [RT, WRT], [N, WN], [AW, WAW], [S, WS], [J, WJ], [AT, WAT], [R, WR], [K, WK], [G, WG], [Q, WQ], [H, WH], [F, WF]].map(([k, w]) => [(k as Intake).intakeId, (w as Work).verificationId]),
  )
  const reportOfIntake = new Map<string, string>([[W, WW], [RT, WRT], [N, WN], [AW, WAW], [S, WS], [J, WJ], [AT, WAT], [R, WR], [K, WK], [G, WG], [Q, WQ], [H, WH], [F, WF]].map(([k, w]) => [(k as Intake).intakeId, (w as Work).reportId]))
  const verificationOf = (k: Intake) => verificationOfIntake.get(k.intakeId) ?? MISSING
  progress(
    `fixtures ready: two synthetic AE-DU/DHA worlds; ${homeIntakes.length} A8.1 intakes on contradicted Claims in Org A (basis ${W.basisCode}) and one in Org B; W assigned to M1, K to M4 after M2, G to M5, the others to M4, L0 untriaged; each assigned intake carries an A8.3 link and finding, an A8.5 proposal approved by RV (U awaiting review, UR returned) and, on an approved plan, an A8.6 report verified EVIDENCE_SUPPORTED (N not verified, AW awaiting verification)`,
  )

  const resolve = (k: { claimId: string; intakeId: string }, body: unknown, who: Who) => post(`${base(k)}/resolution-events`, body, who)
  const historyOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/resolution-history`, who)
  const dispositionOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/resolution-disposition`, who)
  const triageDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/triage-disposition`)
  const investigationSummaryOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/investigation-summary`)
  const remediationDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/remediation-disposition`)
  const workDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/remediation-work-disposition`)
  const workHistoryOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/remediation-work-history`)
  const requestOf = (verificationEventId: string) => ({ eventCode: 'REQUEST_INTERNAL_RESOLUTION', verificationEventId, reasonCode: 'VERIFIED_INTERNAL_WORK' })
  const confirmOf = (requestEventId: string) => ({ eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId, decisionCode: 'CONFIRM_INTERNAL_RESOLUTION' })
  const returnOf = (requestEventId: string, returnReasonCode = 'ADDITIONAL_WORK_REQUIRED') => ({ eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId, decisionCode: 'RETURN_FOR_REWORK', returnReasonCode })
  const eventsOf = (intakeId: string) => prisma.exceptionResolutionEvent.findMany({ where: { exceptionIntakeId: intakeId }, orderBy: { sequence: 'asc' } })
  const auditsOfEvent = (eventId: string) => prisma.auditEvent.findMany({ where: { entityType: 'EXCEPTION_RESOLUTION_EVENT', entityId: eventId } })
  const auditsOfIntake = (intakeId: string) => prisma.auditEvent.count({ where: { actionCode: 'exception_resolution.recorded', afterState: { path: ['exceptionIntakeId'], equals: intakeId } } })
  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const plus = (before: Record<string, number>, events: number) => ({ ...before, [TABLE]: before[TABLE] + events, audit_events: before.audit_events + events })
  const tableCounts = async (tables: string[]) => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${tables.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    return JSON.stringify(rows.map((row) => [row.t, Number(row.n)]))
  }
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const rowsHash = (intakeIds: string[]) => hashOf(`SELECT e.* FROM ${TABLE} e WHERE e.exception_intake_id = ANY($1::uuid[])`, intakeIds)
  const rowHash = (eventId: string) => hashOf(`SELECT e.* FROM ${TABLE} e WHERE e.id = $1::uuid`, eventId)
  const workHash = () => hashOf(`SELECT w.* FROM ${WORK_TABLE} w WHERE w.exception_intake_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId))
  const NOT_COMMITTED = 'ROLLED_BACK'
  // A rolled-back transaction: the mutation runs, its outcome is captured, then everything is undone. Every table must
  // read back exactly.
  const rolledBack = async <T>(job: (tx: DbClient) => Promise<T>): Promise<{ value?: T; message: string; clean: boolean }> => {
    const before = await counts()
    const out: { value?: T } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          out.value = await job(tx)
          throw new Error(NOT_COMMITTED)
        },
        { timeout: 60_000 },
      ),
    )
    return { ...out, message, clean: await unchanged(before) }
  }
  type Row = Partial<Record<string, string | number | null>>
  // One direct event row of intake `k`: by default its valid request — naming the intake's verified A8.6 work record —
  // recorded through M4's membership (the assignee of S). A decision defaults to DR's confirmation.
  const rowOf = (k: Intake, o: Row = {}): Row => ({
    id: randomUUID(), exception_intake_id: k.intakeId, organization_id: k.organizationId, claim_id: k.claimId, contract_version: CONTRACT, sequence: 1, event_code: 'REQUEST_INTERNAL_RESOLUTION',
    verification_event_id: verificationOf(k), request_event_id: null, reason_code: 'VERIFIED_INTERNAL_WORK', decision_code: null, return_reason_code: null,
    recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id, recorded_at: null, ...o,
  })
  const decideRow = (k: Intake, sequence: number, requestId: string, o: Row = {}) =>
    rowOf(k, {
      sequence, event_code: 'DECIDE_INTERNAL_RESOLUTION', verification_event_id: null, request_event_id: requestId, reason_code: null, decision_code: 'CONFIRM_INTERNAL_RESOLUTION', return_reason_code: null,
      recorded_by_membership_id: DR.membershipId, recorded_by_user_id: DR.id, ...o,
    })
  const insertRow = (tx: DbClient, row: Row) =>
    row.recorded_at === null
      ? tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, verification_event_id, request_event_id, reason_code, decision_code, return_reason_code, recorded_by_membership_id, recorded_by_user_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8::uuid, $9::uuid, $10, $11, $12, $13::uuid, $14::uuid)`,
          row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.verification_event_id, row.request_event_id, row.reason_code,
          row.decision_code, row.return_reason_code, row.recorded_by_membership_id, row.recorded_by_user_id,
        )
      : tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, verification_event_id, request_event_id, reason_code, decision_code, return_reason_code, recorded_by_membership_id, recorded_by_user_id, recorded_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8::uuid, $9::uuid, $10, $11, $12, $13::uuid, $14::uuid, $15::timestamptz, $15::timestamptz)`,
          row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.verification_event_id, row.request_event_id, row.reason_code,
          row.decision_code, row.return_reason_code, row.recorded_by_membership_id, row.recorded_by_user_id, row.recorded_at,
        )
  // An A8.6 work row planted with the triggers off (only inside a rolled-back transaction): a report and, unless the
  // verdict is null, a verification of it, on the plan named — so the A8.7 guard can be judged against an A8.6 history
  // the A8.6 guard itself would never accept.
  const plantWork = async (tx: DbClient, k: Intake, planId: string, finding: string, sequence: number, verdict: string | null, ids: { report: string; verification: string }) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO ${WORK_TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, approved_proposal_event_id, work_code, basis_reference_kind, basis_reference_id, basis_reference_contract_version, recorded_by_membership_id, recorded_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, 'RECORD_WORK_REPORT', $7::uuid, 'DOCUMENTATION_CHECK_REPORTED', 'INVESTIGATION_FINDING', $8::uuid, 'A8-EXCEPTION-INVESTIGATION-1', $9::uuid, $10::uuid)`,
      ids.report, k.intakeId, k.organizationId, k.claimId, WORK_CONTRACT, sequence, planId, finding, M4.membershipId, M4.id,
    )
    if (verdict)
      await tx.$executeRawUnsafe(
        `INSERT INTO ${WORK_TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, approved_proposal_event_id, work_report_event_id, verification_code, reason_code, recorded_by_membership_id, recorded_by_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, 'VERIFY_WORK_REPORT', $7::uuid, $8::uuid, $9, $10, $11::uuid, $12::uuid)`,
        ids.verification, k.intakeId, k.organizationId, k.claimId, WORK_CONTRACT, sequence + 1, planId, ids.report, verdict, verdict === 'EVIDENCE_SUPPORTED' ? null : 'SOURCE_MISMATCH', VR.membershipId, VR.id,
      )
  }
  // Direct rows in order, in one transaction that is always rolled back: against the live guards, or with the triggers
  // off (replica) so that only a CHECK, a unique index or a NOT NULL can refuse. `before` runs first with the triggers
  // off (a planted A8.6 history). Answers the first refusal.
  const directInsert = async (rows: Row[], options: { triggersOff?: boolean; before?: (tx: DbClient) => Promise<unknown> } = {}) => {
    const attempt = await rolledBack(async (tx) => {
      if (options.before) {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        await options.before(tx)
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      }
      if (options.triggersOff) await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const row of rows) await insertRow(tx, row)
    })
    return { refused: !attempt.message.includes(NOT_COMMITTED), message: attempt.message, clean: attempt.clean }
  }
  // A stored history planted with the triggers off (and, where named, DDL such as a dropped CHECK) inside a rolled-back
  // transaction; the production reads answer on THAT transaction.
  const plantedRead = async (k: Intake, rows: Row[], ddl?: string) =>
    rolledBack(async (tx) => {
      if (ddl) await tx.$executeRawUnsafe(ddl)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const row of rows) await insertRow(tx, row)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      return { history: await getResolutionHistoryOf(k.claimId, k.intakeId, tx), disposition: await getResolutionDispositionOf(k.claimId, k.intakeId, tx) }
    })
  const snap = async () => ({
    freezes: await hashOf(`SELECT f.*, m.id AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    lifecycle: await hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    links: await hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    claims: await hashOf(`SELECT c.* FROM claims c WHERE c.id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    encounters: await hashOf(`SELECT e.* FROM encounters e JOIN claims c ON c.encounter_id = e.id WHERE c.id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    intakes: await hashOf(`SELECT r.* FROM ${INTAKE_TABLE} r WHERE r.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    intakeAudits: await hashOf(`SELECT a.id, a.action_code, a.entity_id, a.after_state, a.occurred_at FROM audit_events a WHERE a.entity_type = 'EXCEPTION_INTAKE' AND a.entity_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId)),
    investigation: await hashOf(`SELECT e.* FROM ${INVESTIGATION_TABLE} e WHERE e.exception_intake_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId)),
    a7: await tableCounts(A7_TABLES),
    coding: await tableCounts(CODING_TABLES),
  })
  const ownerSnapshotBefore = await snap()
  // Every A8.2 triage event, A8.5 remediation event and A8.6 work event that exists before the first resolution write:
  // A8.7 must never change one of them (later A8.2 events in T085 are A8.2's own new events, judged there).
  const triageIdsBefore = (await prisma.exceptionTriageEvent.findMany({ where: { exceptionIntakeId: { in: runIntakes.map((k) => k.intakeId) } }, select: { id: true } })).map((row) => row.id)
  const triageHash = () => hashOf(`SELECT t.* FROM ${TRIAGE_TABLE} t WHERE t.id = ANY($1::uuid[])`, triageIdsBefore)
  const triageHashBefore = await triageHash()
  const remediationHash = () => hashOf(`SELECT r.* FROM ${REMEDIATION_TABLE} r WHERE r.exception_intake_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId))
  const remediationHashBefore = await remediationHash()
  const workHashBefore = await workHash()
  const wTriageBefore = withoutEvaluatedAt((await triageDispositionOf(W)).body)
  const wInvestigationBefore = withoutEvaluatedAt((await investigationSummaryOf(W)).body)
  const wRemediationBefore = withoutEvaluatedAt((await remediationDispositionOf(W)).body)
  const wWorkBefore = { disposition: withoutEvaluatedAt((await workDispositionOf(W)).body), history: withoutEvaluatedAt((await workHistoryOf(W)).body) }
  const wIntakesBefore = withoutEvaluatedAt((await get(`/api/claims/${W.claimId}/exception-intake`)).body)

  // D1/correction 2 — the five upstream read permissions, each on its own. PT holds one synthetic role granting exactly
  // what ORG_ADMIN grants; one permission at a time is taken from it and every A8.7 route is tried, then given back. The
  // role exists only for these calls and is removed again before anything else runs.
  const partialRole = await prisma.role.create({ data: { code: `SYNTHETIC_${runId.replace('-', '_')}_PARTIAL`, name: `Synthetic partial role ${runId}` } })
  const adminGrants = await prisma.rolePermission.findMany({ where: { roleId: adminRole.id }, select: { permissionId: true, permission: { select: { code: true } } } })
  const permissionIdOf = new Map(adminGrants.map((g) => [g.permission.code, g.permissionId]))
  await prisma.rolePermission.createMany({ data: adminGrants.map((g) => ({ roleId: partialRole.id, permissionId: g.permissionId })) })
  await prisma.membershipRole.create({ data: { membershipId: PT.membershipId, roleId: partialRole.id } })
  const withoutPermission = async <T>(code: string, job: () => Promise<T>): Promise<T> => {
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: partialRole.id, permissionId: permissionIdOf.get(code) as string } } })
    try {
      return await job()
    } finally {
      await prisma.rolePermission.create({ data: { roleId: partialRole.id, permissionId: permissionIdOf.get(code) as string } })
    }
  }
  const allFour = async () => [
    (await resolve(RT, requestOf(VRT), PT.who)).status, (await resolve(RT, confirmOf(MISSING), PT.who)).status, (await historyOf(RT, PT.who)).status, (await dispositionOf(RT, PT.who)).status,
  ]
  const partialControl = { request: await resolve(RT, requestOf(VRT), PT.who), decide: await resolve(RT, confirmOf(MISSING), PT.who), history: await historyOf(RT, PT.who), disposition: await dispositionOf(RT, PT.who) }
  const parentReadProof: { code: string; statuses: number[] }[] = []
  for (const code of FIVE_READS) parentReadProof.push({ code, statuses: await withoutPermission(code, allFour) })
  const ownPermissionProof = {
    request: await withoutPermission('exceptionResolution.request', async () => [(await resolve(RT, requestOf(VRT), PT.who)).status, (await resolve(RT, confirmOf(MISSING), PT.who)).status]),
    decide: await withoutPermission('exceptionResolution.decide', async () => [(await resolve(RT, confirmOf(MISSING), PT.who)).status, (await resolve(RT, requestOf(VRT), PT.who)).status]),
    read: await withoutPermission('exceptionResolution.read', async () => [(await historyOf(RT, PT.who)).status, (await dispositionOf(RT, PT.who)).status]),
  }
  await prisma.membershipRole.deleteMany({ where: { roleId: partialRole.id } })
  await prisma.rolePermission.deleteMany({ where: { roleId: partialRole.id } })
  await prisma.role.delete({ where: { id: partialRole.id } })
  const partialGone = (await prisma.role.count({ where: { code: { startsWith: 'SYNTHETIC_' } } })) === 0

  // ---------------------------------------------------------------- routes and scope (T009–T010)
  const routeCode = committedCode(`${MODULE_DIR}/exception-resolution.route.ts`)
  const typesCode = committedCode(`${MODULE_DIR}/exception-resolution.types.ts`)
  const missingClaim = { claimId: MISSING, intakeId: W.intakeId }
  const wiring = [await resolve(missingClaim, requestOf(VW), M1.who), await historyOf(missingClaim), await dispositionOf(missingClaim)]
  const absent = [
    await api('PATCH', `${base(W)}/resolution-events`, {}), await api('PUT', `${base(W)}/resolution-events`, {}), await api('DELETE', `${base(W)}/resolution-events`),
    await get(`${base(W)}/resolution-events`), await get(`${base(W)}/resolution-events/${MISSING}`), await api('PUT', `${base(W)}/resolution-disposition`, {}), await post(`${base(W)}/resolution-disposition`, {}),
    await post(`${base(W)}/resolution-history`, {}), await get(`${base(W)}/resolution-current`), await post(`${base(W)}/resolve`, {}), await post(`${base(W)}/close`, {}), await post(`${base(W)}/escalate`, {}),
    await post(`${base(W)}/sla`, {}), await post(`${base(W)}/export`, {}), await post(`${base(W)}/execute`, {}), await post(`${base(W)}/claim-correction`, {}), await post(`${base(W)}/payer-submission`, {}),
    await post(`${base(W)}/transmit`, {}), await get('/api/resolution-events'), await get('/api/exception-resolution'), await get(`/api/claims/${W.claimId}/resolution-events`), await get(`${base(W)}/resolution-queue`),
  ]
  check(
    'T009',
    'Only three routes, no later-phase route',
    wiring.every((r) => r.status === 404 && errorCode(r.body) === 'NOT_FOUND') && absent.every((r) => r.status === 404) &&
      (routeCode.match(/exceptionResolutionRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 3 && /exceptionResolutionRouter\.post\(`\$\{BASE\}\/resolution-events`, requireIds, \.\.\.canReadParents, requireEventPermission,/.test(routeCode) &&
      /exceptionResolutionRouter\.get\(`\$\{BASE\}\/resolution-history`, requireIds, \.\.\.canReadParents, canReadResolution,/.test(routeCode) &&
      /exceptionResolutionRouter\.get\(`\$\{BASE\}\/resolution-disposition`, requireIds, \.\.\.canReadParents, canReadResolution,/.test(routeCode) && /const BASE = '\/:claimId\/exceptions\/:exceptionIntakeId'/.test(routeCode) &&
      same([...PARENT_READ_PERMISSIONS], FIVE_READS) && FIVE_READS.every((p) => typesCode.includes(`'${p}'`)),
    `the POST and both GETs answer a missing Claim with a privacy-safe 404 and each carries the five upstream reads (${FIVE_READS.join(', ')}); PATCH/PUT/DELETE, an event by id, a current selector, resolve, close, escalate, SLA, export, execute, claim correction, payer and transmission routes, a collection and cross-Claim searches are absent (${absent.map((r) => r.status).join('/')})`,
  )
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${FE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file))
  const earlierSuites = changedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`))
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a9|dhpo|eclaimlink|coding-release|coding-validation|crg|escalat|export|queue|\bsla\b|execut|checkpoint-c/i.test(file))
  check(
    'T010',
    'Diff scope excludes CRG-B/C and A9',
    changedPaths.length > 0 && outOfScope.length === 0 && earlierSuites.length === 0 && laterDomain.length === 0,
    outOfScope.length + earlierSuites.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A8.7 module, page, harness, migration and register and the narrow shared additions; no earlier suite changed; no CRG, Checkpoint C, execution, queue, export or A9 domain`
      : `unexpected: ${[...new Set([...outOfScope, ...earlierSuites, ...laterDomain])].join(', ').slice(0, 300)}`,
  )

  // ---------------------------------------------------------------- request and version (T011–T020)
  section("Request and version on W: the v1 literal on rows and DTOs, strict request and decision keys, server-owned fields, malformed ids, uncontrolled codes, the conditional return reason, injection, free text and amounts")
  const countsAtStart = await counts()
  const noResolutionW = { disposition: await dispositionOf(W), history: await historyOf(W), rows: (await eventsOf(W.intakeId)).length }
  const noResolutionN = (await dispositionOf(N)).body
  const noResolutionAW = (await dispositionOf(AW)).body
  const noResolutionU = (await dispositionOf(U)).body
  const RQW = await resolve(W, requestOf(VW), M1.who)
  const RQW_ID = (RQW.body?.resolutionEventId ?? MISSING) as string
  const countsAfterRQW = await counts()
  const rqwHashBefore = await rowHash(RQW_ID)
  const contractDef = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${TABLE}_contract_chk'`))[0]?.d ?? ''
  const rqwRow = (await eventsOf(W.intakeId))[0]
  const historyRQW = await historyOf(W)
  const dispositionRQW = await dispositionOf(W)
  check(
    'T011',
    'Exact new contract in TS/SQL/DTO',
    RQW.status === 201 && RQW.body.contractVersion === CONTRACT && RESOLUTION_CONTRACT_VERSION === CONTRACT && rqwRow?.contractVersion === CONTRACT && same(Object.keys(RQW.body), EVENT_KEYS) &&
      same(Object.keys(historyRQW.body), HISTORY_KEYS) && same(Object.keys(dispositionRQW.body), DISPOSITION_KEYS) && same(Object.keys(dispositionRQW.body.request ?? {}), REQUEST_KEYS) &&
      historyRQW.body.contractVersion === CONTRACT && dispositionRQW.body.contractVersion === CONTRACT && contractDef.includes(`'${CONTRACT}'`) && /IS NOT NULL/.test(contractDef) &&
      committedText(MIGRATION).includes(`'${CONTRACT}'`),
    `W's request carries ${CONTRACT} on its stored row and in exactly the ${EVENT_KEYS.length} event keys; the history, the disposition and its request carry exactly theirs; the types file, the migration and the database CHECK pin the literal`,
  )
  const wRows = async () => (await eventsOf(W.intakeId)).length
  const isValidation = (r: { status: number; body: any }) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR'
  const missingRequestKeys = await Promise.all(
    ['verificationEventId', 'reasonCode'].map((field) => {
      const body: Record<string, unknown> = { ...requestOf(VW) }
      delete body[field]
      return resolve(W, body, M1.who)
    }),
  )
  const extraRequestKeys = await Promise.all([{ requestEventId: RQW_ID }, { decisionCode: 'CONFIRM_INTERNAL_RESOLUTION' }, { returnReasonCode: 'INSUFFICIENT_SUPPORT' }, { extra: 1 }].map((extra) => resolve(W, { ...requestOf(VW), ...extra }, M1.who)))
  const oddBodies = [await resolve(W, [requestOf(VW)], M1.who), await resolve(W, {}, M1.who), await resolve(W, 7, M1.who), await resolve(W, 'REQUEST_INTERNAL_RESOLUTION', M1.who), await resolve(W, null, M1.who)]
  const nullService = await recordResolutionEvent(W.claimId, W.intakeId, null, M1.id)
  check(
    'T012',
    'Strict request shape rejects extras',
    missingRequestKeys.every((r) => isValidation(r) && /missing field/.test(errorMessage(r.body))) && extraRequestKeys.every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) &&
      oddBodies.every((r) => r.status === 400 && !rawError(r.body)) && nullService.ok === false && nullService.code === 'VALIDATION_ERROR' && (await wRows()) === 1,
    `a request without its verification or reason is a 400 (missing field); with a decision field or an unknown property a 400 (unsupported field); an array, empty, numeric, string or null body is a 400 (${oddBodies.map((r) => r.status).join('/')}) and the service itself refuses null; nothing recorded`,
  )
  const strictDecision = [
    await resolve(W, { ...confirmOf(RQW_ID), returnReasonCode: 'INSUFFICIENT_SUPPORT' }, DR.who), await resolve(W, { ...confirmOf(RQW_ID), returnReasonCode: null }, DR.who),
    await resolve(W, { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId: RQW_ID, decisionCode: 'RETURN_FOR_REWORK' }, DR.who), await resolve(W, { ...returnOf(RQW_ID), returnReasonCode: null }, DR.who),
    await resolve(W, { ...confirmOf(RQW_ID), verificationEventId: VW }, DR.who), await resolve(W, { ...confirmOf(RQW_ID), reasonCode: 'VERIFIED_INTERNAL_WORK' }, DR.who),
    await resolve(W, { eventCode: 'DECIDE_INTERNAL_RESOLUTION', decisionCode: 'CONFIRM_INTERNAL_RESOLUTION' }, DR.who),
  ]
  check(
    'T013',
    'Strict decision shape with conditional reason',
    strictDecision.every(isValidation) && /unsupported field/.test(errorMessage(strictDecision[0].body)) && /unsupported field/.test(errorMessage(strictDecision[1].body)) && /missing field/.test(errorMessage(strictDecision[2].body)) &&
      /controlled return reason code/.test(errorMessage(strictDecision[3].body)) && /unsupported field/.test(errorMessage(strictDecision[4].body)) && /missing field/.test(errorMessage(strictDecision[6].body)) && (await wRows()) === 1,
    'a confirmation carrying any return reason field (even null), a return without a reason or with a null one, a decision naming a verification or a request reason, and one without its request are each a 400; nothing recorded',
  )
  const serverOwned = await Promise.all(
    ['id', 'resolutionEventId', 'sequence', 'organizationId', 'claimId', 'exceptionIntakeId', 'recordedByUserId', 'recordedByMembershipId', 'actorUserId', 'recordedAt', 'createdAt', 'contractVersion', 'state', 'status', 'outcome', 'current', 'latest'].map((k) =>
      resolve(W, { ...requestOf(VW), [k]: k === 'sequence' ? 2 : k === 'recordedAt' || k === 'createdAt' ? '2020-01-01T00:00:00.000Z' : k === 'contractVersion' ? CONTRACT : k === 'state' ? 'RESOLVED_INTERNAL' : k === 'status' || k === 'outcome' ? 'RESOLVED' : k === 'current' || k === 'latest' ? true : MISSING }, M1.who),
    ),
  )
  const queried = await post(`${base(W)}/resolution-events?sequence=2`, requestOf(VW), M1.who)
  check(
    'T014',
    'Client actor/org/Claim/clock refused',
    serverOwned.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && queried.status === 400 && (await wRows()) === 1,
    'an id, sequence, organization, Claim, intake, actor, membership, time, contract, state, status, outcome, current or latest selector in the body, or a query parameter, is refused (400): the server owns them',
  )
  const badIds = ['not-a-uuid', MISSING.replace(/-/g, ''), `${MISSING}0`, encodeURIComponent("1' OR '1'='1")]
  const malformedClaim = [
    ...(await Promise.all(badIds.map((id) => resolve({ claimId: id, intakeId: W.intakeId }, requestOf(VW), M1.who)))),
    ...(await Promise.all(badIds.map((id) => historyOf({ claimId: id, intakeId: W.intakeId })))),
    ...(await Promise.all(badIds.map((id) => dispositionOf({ claimId: id, intakeId: W.intakeId })))),
  ]
  const malformedIntake = [
    ...(await Promise.all(badIds.map((id) => resolve({ claimId: W.claimId, intakeId: id }, requestOf(VW), M1.who)))),
    ...(await Promise.all(badIds.map((id) => historyOf({ claimId: W.claimId, intakeId: id })))),
    ...(await Promise.all(badIds.map((id) => dispositionOf({ claimId: W.claimId, intakeId: id })))),
  ]
  check(
    'T015',
    'Malformed Claim/intake UUID rejected',
    malformedClaim.every((r) => r.status === 400 && /invalid claim id/.test(errorMessage(r.body)) && !rawError(r.body)) && malformedIntake.every((r) => r.status === 400 && /invalid exception intake id/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      (await wRows()) === 1,
    'malformed and SQL-shaped Claim and intake ids on all three routes are each a safe 400; nothing recorded',
  )
  const malformedVerification = await Promise.all(['not-a-uuid', `${MISSING}0`, MISSING.replace(/-/g, ''), 7].map((id) => resolve(W, { ...requestOf(VW), verificationEventId: id }, M1.who)))
  const malformedRequestId = await Promise.all(['not-a-uuid', `${MISSING}0`, ''].map((id) => resolve(W, confirmOf(id), DR.who)))
  check(
    'T016',
    'Malformed request/verification UUID rejected',
    malformedVerification.every((r) => r.status === 400 && /invalid verification event id/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      malformedRequestId.every((r) => r.status === 400 && /invalid request event id/.test(errorMessage(r.body)) && !rawError(r.body)) && (await wRows()) === 1,
    'malformed verification ids on a request and malformed request ids on a decision are each a safe 400; nothing recorded',
  )
  const unknownEvents = await Promise.all(['RESOLVE_EXCEPTION', 'CLOSE_EXCEPTION', 'EXECUTE_ACTION', 'request_internal_resolution', '', null, 7].map((eventCode) => resolve(W, { ...requestOf(VW), eventCode }, M1.who)))
  check('T017', 'Unknown event code rejected', unknownEvents.every((r) => r.status === 400 && /unknown resolution event code/.test(errorMessage(r.body)) && !rawError(r.body)) && (await wRows()) === 1, `only ${resolutionEventCodes.join(', ')} are accepted`)
  const unknownDecisions = await Promise.all(['RESOLVED', 'CLOSE', 'APPROVE_PROPOSAL', 'confirm_internal_resolution', '', null].map((decisionCode) => resolve(W, { ...confirmOf(RQW_ID), decisionCode }, DR.who)))
  check('T018', 'Unknown decision code rejected', unknownDecisions.every((r) => isValidation(r) && /unknown decision code/.test(errorMessage(r.body))) && (await wRows()) === 1, `only ${decisionCodes.join(', ')} are accepted`)
  const unknownRequestReasons = await Promise.all(['PAID', 'BECAUSE', 'verified_internal_work', '', null].map((reasonCode) => resolve(W, { ...requestOf(VW), reasonCode }, M1.who)))
  const unknownReturnReasons = await Promise.all(['BECAUSE', 'PAYER_DENIED', 'insufficient_support', '', 7].map((code) => resolve(W, returnOf(RQW_ID, code as string), DR.who)))
  check(
    'T019',
    'Unknown reason/return reason rejected',
    unknownRequestReasons.every((r) => isValidation(r) && /unknown request reason code/.test(errorMessage(r.body))) && unknownReturnReasons.every((r) => isValidation(r) && /controlled return reason code/.test(errorMessage(r.body))) && (await wRows()) === 1,
    `a request reason is only ${requestReasonCodes.join(', ')}; a return reason only ${returnReasonCodes.join(', ')}`,
  )
  const injection = [
    await resolve(W, requestOf("1' OR '1'='1"), M1.who), await resolve(W, { ...requestOf(VW), verificationEventId: { $ne: null } }, M1.who),
    await resolve(W, { ...requestOf(VW), reasonCode: "VERIFIED_INTERNAL_WORK'; DROP TABLE claims; --" }, M1.who), await resolve(W, { ...confirmOf(RQW_ID), decisionCode: '../CONFIRM_INTERNAL_RESOLUTION' }, DR.who),
    await resolve(W, JSON.parse(`{"__proto__": {"eventCode": "REQUEST_INTERNAL_RESOLUTION"}, "verificationEventId": "${VW}", "reasonCode": "VERIFIED_INTERNAL_WORK"}`), M1.who),
    await resolve(W, JSON.parse(`{"eventCode": "REQUEST_INTERNAL_RESOLUTION", "verificationEventId": "${VW}", "reasonCode": "VERIFIED_INTERNAL_WORK", "constructor": {"prototype": {"admin": true}}}`), M1.who),
  ]
  const freeText = await Promise.all(
    [
      { note: 'free text' }, { narrative: 'free text' }, { comment: 'free text' }, { description: 'free text' }, { patientName: `${runId}-home-P` }, { diagnosisCode: key('home-DXA') },
      { amount: '125.25' }, { currencyCode: 'AED' }, { url: 'https://example.invalid/evidence' }, { attachment: 'c3ludGhldGlj' }, { payload: { a: 1 } }, { payerId: MISSING },
    ].map((extra) => resolve(W, { ...requestOf(VW), ...extra }, M1.who)),
  )
  check(
    'T020',
    'Free-text, PHI, injection, amount rejected',
    injection.every((r) => r.status === 400 && !rawError(r.body)) && freeText.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && (await wRows()) === 1 &&
      (await unchanged(plus(countsAtStart, 1))),
    "SQL-, operator-, traversal- and prototype-shaped values, and a note, narrative, comment, description, patient name, diagnosis, amount, currency, URL, attachment, payload or payer are refused with a safe 400; only W's one valid request and its audit exist",
  )

  // ---------------------------------------------------------------- access and tenancy (T021–T030)
  section('Access and tenancy: 401 before lookup, Viewer and role-less 403, the five upstream reads each on their own, the current assignee requests from the session, stale assignees refused, foreign Claim, intake and basis = missing, the decider independent and authorized now')
  const anonPost = [await resolve(W, requestOf(VW), anonymous), await resolve({ claimId: MISSING, intakeId: MISSING }, requestOf(VW), anonymous), await resolve(W, confirmOf(RQW_ID), anonymous)]
  check('T021', 'Anonymous POST 401 before lookup', anonPost.every((r) => r.status === 401) && (await wRows()) === 1, 'no session: 401 on W (a request and a decision) and on a missing Claim alike (the lookup never ran)')
  const anonGet = [await historyOf(W, anonymous), await dispositionOf(W, anonymous), await historyOf({ claimId: MISSING, intakeId: MISSING }, anonymous), await dispositionOf({ claimId: MISSING, intakeId: MISSING }, anonymous)]
  check('T022', 'Anonymous GETs 401', anonGet.every((r) => r.status === 401), 'no session: 401 on the history and the disposition of W and of a missing Claim')
  const noPermission = [await resolve(W, requestOf(VW), asViewer), await resolve(W, confirmOf(RQW_ID), asViewer), await resolve(W, requestOf(VW), NR.who), await resolve(W, confirmOf(RQW_ID), NR.who)]
  const parentProofOk = parentReadProof.length === 5 && parentReadProof.every((p) => same(p.statuses, [403, 403, 403, 403]))
  const controlOk =
    partialControl.request.status === 409 && errorCode(partialControl.request.body) === 'EXCEPTION_RESOLUTION_NOT_ASSIGNEE' && partialControl.decide.status === 409 &&
    errorCode(partialControl.decide.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED' && partialControl.history.status === 200 && partialControl.disposition.status === 200
  check(
    'T023',
    'Viewer POST 403',
    noPermission.every((r) => r.status === 403) && parentProofOk && controlOk && same(ownPermissionProof.request, [403, 409]) && same(ownPermissionProof.decide, [403, 409]) && partialGone && (await wRows()) === 1,
    `a Viewer (exceptionResolution.read only) and a role-less member are refused 403 on a request and a decision; a member holding everything else but one upstream read is refused 403 on every route for each of the five (${parentReadProof.map((p) => `${p.code}: ${p.statuses.join('/')}`).join('; ')}), without exceptionResolution.request 403 on a request and without .decide 403 on a decision, while with all of them the routes admit it (${partialControl.request.status}/${partialControl.decide.status}/${partialControl.history.status}/${partialControl.disposition.status}); the synthetic role is gone`,
  )
  check(
    'T024',
    'Requester holds current eligible assignment',
    RQW.status === 201 && RQW.body.recordedByMembershipId === M1.membershipId && RQW.body.recordedByUserId === M1.id && RQW.body.claimId === W.claimId && RQW.body.organizationId === org &&
      RQW.body.exceptionIntakeId === W.intakeId && RQW.body.sequence === 1 && RQW.body.eventCode === 'REQUEST_INTERNAL_RESOLUTION' && RQW.body.verificationEventId === VW && RQW.body.reasonCode === 'VERIFIED_INTERNAL_WORK' &&
      RQW.body.requestEventId === null && RQW.body.decisionCode === null && RQW.body.returnReasonCode === null,
    "M1, to whom A8.2 assigned W, requests (201) as itself through its own membership, numbered 1, naming W's EVIDENCE_SUPPORTED A8.6 verification with VERIFIED_INTERNAL_WORK",
  )
  const notAssignee = [
    await resolve(RT, requestOf(VRT), M1.who), await resolve(RT, requestOf(VRT), VR.who), await resolve(RT, requestOf(VRT), asAdmin), await resolve(RT, requestOf(VRT), DR.who),
    await resolve(L0, requestOf(MISSING), M4.who), await resolve(L0, requestOf(MISSING), asAdmin), await resolve(K, requestOf(verificationOf(K)), M2.who),
  ]
  check(
    'T025',
    'Stale/reassigned requester 409',
    notAssignee.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_NOT_ASSIGNEE' && !rawError(r.body)) && (await eventsOf(RT.intakeId)).length === 0 &&
      (await eventsOf(L0.intakeId)).length === 0 && (await eventsOf(K.intakeId)).length === 0,
    "M1, the A8.6 verifier, the harness's Admin and a decider on RT (assigned to M4), M4 and the Admin on the UNTRIAGED L0, and M2 on K (reassigned from M2 to M4: a stale assignee) are each refused 409 NOT_ASSIGNEE; nothing recorded",
  )
  const deciderWithoutPermission = [await recordResolutionEvent(W.claimId, W.intakeId, confirmOf(RQW_ID), NR.id), await recordResolutionEvent(W.claimId, W.intakeId, confirmOf(RQW_ID), viewerUser.id)]
  check(
    'T026',
    'Reviewer holds explicit permission now',
    deciderWithoutPermission.every((r) => r.ok === false && r.code === 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT') && noPermission[1].status === 403 && noPermission[3].status === 403 &&
      same(ownPermissionProof.decide, [403, 409]) && (await wRows()) === 1,
    'a Viewer and a role-less member deciding are 403 at the route, a member without exceptionResolution.decide is 403 (T023), and the service itself refuses (409) a decider without the decide permission now; nothing recorded',
  )
  const selfRoute = await resolve(W, confirmOf(RQW_ID), M1.who)
  const selfService = await recordResolutionEvent(W.claimId, W.intakeId, returnOf(RQW_ID), M1.id)
  check(
    'T027',
    'Reviewer differs by user and membership',
    selfRoute.status === 409 && errorCode(selfRoute.body) === 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT' && selfService.ok === false && selfService.code === 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT' && (await wRows()) === 1,
    "M1 confirming its own request is refused 409 through the route and returning it through the service; the same user through another membership is refused by the guard and the reducer (T065); nothing recorded",
  )
  const missingEnvelope = (r: { body: any }) => ({ ...r.body?.error, requestId: null })
  const foreignClaim = [await resolve(F, requestOf(VF), asAdmin), await historyOf(F), await dispositionOf(F)]
  const missingClaimReads = [await resolve({ claimId: MISSING, intakeId: F.intakeId }, requestOf(VF), asAdmin), await historyOf({ claimId: MISSING, intakeId: F.intakeId }), await dispositionOf({ claimId: MISSING, intakeId: F.intakeId })]
  check(
    'T028',
    'Foreign Claim safe 404',
    foreignClaim.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingClaimReads[i]))) && (await eventsOf(F.intakeId)).length === 0,
    "another organization's Claim and intake get exactly the missing-Claim envelope on all three routes; nothing recorded",
  )
  const foreignIntake = [await resolve({ claimId: W.claimId, intakeId: F.intakeId }, requestOf(VF), M1.who), await historyOf({ claimId: W.claimId, intakeId: F.intakeId }), await dispositionOf({ claimId: W.claimId, intakeId: F.intakeId })]
  const otherClaimIntake = [await resolve({ claimId: W.claimId, intakeId: RT.intakeId }, requestOf(VRT), M4.who), await historyOf({ claimId: W.claimId, intakeId: RT.intakeId })]
  const missingIntake = [await resolve({ claimId: W.claimId, intakeId: MISSING }, requestOf(VW), M1.who), await historyOf({ claimId: W.claimId, intakeId: MISSING }), await dispositionOf({ claimId: W.claimId, intakeId: MISSING })]
  const missingBasis = await resolve(RT, requestOf(MISSING), M4.who)
  const foreignBasis = [await resolve(RT, requestOf(VF), M4.who), await resolve(RT, requestOf(reportOfIntake.get(F.intakeId) as string), M4.who)]
  check(
    'T029',
    'Foreign intake/basis safe 404',
    foreignIntake.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[i]))) && otherClaimIntake.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[0]))) &&
      missingBasis.status === 404 && foreignBasis.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingBasis)) && !JSON.stringify(r.body).includes(VF) && !rawError(r.body)) &&
      (await eventsOf(RT.intakeId)).length === 0,
    "another tenant's intake, or another Claim's intake of this tenant, named under W's Claim is exactly the missing-intake 404; on RT, the other tenant's A8.6 verification and report are exactly the missing-verification 404 and the body names nothing of the other tenant; nothing recorded",
  )
  const sameOrgReads = [await historyOf(W), await dispositionOf(W), await historyOf(W, asViewer), await dispositionOf(W, asViewer), await historyOf(W, VR.who), await dispositionOf(N, asViewer)]
  const readProofOk = parentReadProof.every((p) => p.statuses[2] === 403 && p.statuses[3] === 403) && same(ownPermissionProof.read, [403, 403])
  check(
    'T030',
    'Authorized Admin/Viewer GET parity',
    sameOrgReads.every((r) => r.status === 200 && r.body.contractVersion === CONTRACT) && sameOrgReads[0].body.items.length === 1 && sameOrgReads[1].body.state === 'AWAITING_RESOLUTION_DECISION' &&
      withoutEvaluatedAt(sameOrgReads[0].body) === withoutEvaluatedAt(sameOrgReads[2].body) && withoutEvaluatedAt(sameOrgReads[1].body) === withoutEvaluatedAt(sameOrgReads[3].body) && readProofOk,
    "the Admin, a Viewer and another member of Org A read W's history and disposition (and N's) with 200 and identical bodies; W holds its one request, awaiting a decision; without any one of the five upstream reads, or without exceptionResolution.read, both reads are 403",
  )

  // ---------------------------------------------------------------- owner evidence (T031–T040)
  section('Owner evidence: NO_RESOLUTION_REQUEST is zero rows, only the exact A8.6 EVIDENCE_SUPPORTED verification on the approved A8.5 plan of exactly this intake, an A8.6 historical fact read as recorded, no CRG side effect')
  check(
    'T031',
    'No events means NO_RESOLUTION_REQUEST',
    noResolutionW.rows === 0 && noResolutionW.disposition.status === 200 && noResolutionW.disposition.body.state === 'NO_RESOLUTION_REQUEST' && noResolutionW.disposition.body.eventCount === 0 &&
      noResolutionW.disposition.body.lastSequence === null && noResolutionW.disposition.body.request === null && noResolutionW.disposition.body.decision === null &&
      noResolutionW.disposition.body.verificationEventId === VW && same(noResolutionW.history.body.items, []) && noResolutionN.state === 'NO_RESOLUTION_REQUEST' && noResolutionN.verificationEventId === null &&
      noResolutionAW.verificationEventId === null && noResolutionU.verificationEventId === null && !COLUMNS.some((c) => /state|status|current|latest/.test(c)),
    "before any event W has zero rows and derives NO_RESOLUTION_REQUEST naming its verified A8.6 record (a resolution is never inferred from the verification); N (NOT_VERIFIED), AW (awaiting verification) and U (plan awaiting review) name none; the table has no state, status, current or latest column",
  )
  // A planted A8.6 history (triggers off, rolled back) whose verification is EVIDENCE_SUPPORTED but sits on a plan that
  // A8.5 never approved: the A8.7 guard must still refuse a request naming it, and the service on that same transaction.
  const plantedPlan = async (k: Intake, plan: Plan) => {
    const ids = { report: randomUUID(), verification: randomUUID() }
    const guard = await directInsert([rowOf(k, { verification_event_id: ids.verification })], { before: (tx) => plantWork(tx, k, plan.proposalId, findingOf(k), 1, 'EVIDENCE_SUPPORTED', ids) })
    const service = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await plantWork(tx, k, plan.proposalId, findingOf(k), 1, 'EVIDENCE_SUPPORTED', ids)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      return recordResolutionEventOn(k.claimId, k.intakeId, requestOf(ids.verification), M4.id, tx)
    })
    return { guard, service: service.value, clean: service.clean }
  }
  const pendingPlan = await plantedPlan(U, PU)
  const returnedPlan = await plantedPlan(UR, PUR)
  const plantedRefused = (p: { guard: { refused: boolean; message: string; clean: boolean }; service?: { ok: boolean; code?: string }; clean: boolean }) =>
    p.guard.refused && /exception_resolution_basis/.test(p.guard.message) && p.guard.clean && p.service?.ok === false && /^EXCEPTION_RESOLUTION_(CONFLICT|BASIS_NOT_VERIFIED)$/.test(p.service.code ?? '') && p.clean
  const onUnapproved = [await resolve(U, requestOf(MISSING), M4.who), await resolve(U, requestOf(VW), M4.who)]
  check(
    'T032',
    'A8.5 exact approved proposal required',
    onUnapproved.every((r) => r.status === 404 && !rawError(r.body)) && plantedRefused(pendingPlan) && noResolutionU.verificationEventId === null && (await eventsOf(U.intakeId)).length === 0,
    "U's plan awaits A8.5 review, so it has no A8.6 work: a request on U naming a missing or W's verification is a 404; a verification planted on U's unapproved plan is refused by the basis guard and the service refuses it too (409); nothing recorded",
  )
  const onReturned = [await resolve(UR, requestOf(MISSING), M4.who), await resolve(UR, requestOf(VS), M4.who)]
  check(
    'T033',
    'Returned or pending proposal not enough',
    onReturned.every((r) => r.status === 404 && !rawError(r.body)) && plantedRefused(returnedPlan) && (await dispositionOf(UR)).body.verificationEventId === null && (await eventsOf(UR.intakeId)).length === 0,
    "UR's A8.5 proposal was returned: a request on UR is a 404 and a verification planted on its returned plan is refused by the basis guard and by the service (409); with U (pending, T032) neither state supports a request",
  )
  const basisJoin = (await prisma.$queryRawUnsafe<{ code: string; verdict: string; ok: boolean; plan: string; approved: boolean }[]>(
    `SELECT v.event_code AS code, v.verification_code AS verdict, (v.exception_intake_id = e.exception_intake_id AND v.claim_id = e.claim_id AND v.organization_id = e.organization_id) AS ok,
            v.approved_proposal_event_id::text AS plan,
            EXISTS (SELECT 1 FROM ${REMEDIATION_TABLE} r WHERE r.proposal_event_id = v.approved_proposal_event_id AND r.decision_code = 'APPROVE_PROPOSAL') AS approved
     FROM ${TABLE} e JOIN ${WORK_TABLE} v ON v.id = e.verification_event_id WHERE e.id = $1::uuid`,
    RQW_ID,
  ))[0]
  check(
    'T034',
    'A8.6 verified work same intake and Claim',
    basisJoin?.code === 'VERIFY_WORK_REPORT' && basisJoin.verdict === 'EVIDENCE_SUPPORTED' && basisJoin.ok === true && basisJoin.plan === PW.proposalId && basisJoin.approved === true && WW.statuses.every((s) => s === 201),
    "W's stored request joins, through its RESTRICT key, A8.6's EVIDENCE_SUPPORTED VERIFY_WORK_REPORT of the same intake, Claim and organization, whose plan is W's approved A8.5 proposal",
  )
  const notVerified = [
    await resolve(N, requestOf(VN), M4.who), await resolve(N, requestOf(reportOfIntake.get(N.intakeId) as string), M4.who), await resolve(AW, requestOf(reportOfIntake.get(AW.intakeId) as string), M4.who),
  ]
  check(
    'T035',
    'EVIDENCE_NOT_VERIFIED cannot support request',
    notVerified.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_BASIS_NOT_VERIFIED' && !rawError(r.body)) && (await eventsOf(N.intakeId)).length === 0 && (await eventsOf(AW.intakeId)).length === 0,
    "N's EVIDENCE_NOT_VERIFIED verification and its report, and AW's report still awaiting verification, are each refused 409 BASIS_NOT_VERIFIED; nothing recorded",
  )
  // The A8.6 verifier of H loses its role: A8.6's finding is a recorded fact, never recomputed from present permissions.
  const hWorkBefore = { disposition: withoutEvaluatedAt((await workDispositionOf(H)).body), rows: await hashOf(`SELECT w.* FROM ${WORK_TABLE} w WHERE w.exception_intake_id = $1::uuid`, H.intakeId) }
  await prisma.membershipRole.deleteMany({ where: { membershipId: VR3.membershipId } })
  const hWorkAfter = { disposition: withoutEvaluatedAt((await workDispositionOf(H)).body), rows: await hashOf(`SELECT w.* FROM ${WORK_TABLE} w WHERE w.exception_intake_id = $1::uuid`, H.intakeId) }
  const RQH = await resolve(H, requestOf(verificationOf(H)), M4.who)
  check(
    'T036',
    'A8.6 evidence source remains recorded fact',
    hWorkAfter.disposition === hWorkBefore.disposition && hWorkAfter.rows === hWorkBefore.rows && JSON.parse(hWorkAfter.disposition).state === 'VERIFIED_INTERNAL_WORK' && RQH.status === 201 &&
      RQH.body.verificationEventId === verificationOf(H),
    "after VR3, who verified H's work, lost its role, H's A8.6 rows and disposition read back identically (VERIFIED_INTERNAL_WORK, as recorded) and M4's request naming that verification is recorded (201)",
  )
  const substituted = [await resolve(RT, requestOf(VW), M4.who), await resolve(RT, requestOf(VS), M4.who)]
  const substitutedDirect = await directInsert([rowOf(S, { verification_event_id: VW })])
  check(
    'T037',
    'No substituted work from another plan',
    substituted.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingBasis))) && substitutedDirect.refused && /exception_resolution_basis/.test(substitutedDirect.message) && substitutedDirect.clean &&
      (await eventsOf(RT.intakeId)).length === 0,
    "W's and S's verified work (other intakes, other approved plans) named on RT are exactly the missing-verification 404, and W's verification named by a direct row on S is refused by the basis guard",
  )
  const rqwAudit = (await auditsOfEvent(RQW_ID))[0]
  check(
    'T038',
    'Request exact verification ID preserved',
    RQW.body.verificationEventId === VW && rqwRow?.verificationEventId === VW && (rqwAudit?.afterState as any)?.verificationEventId === VW && dispositionRQW.body.request?.verificationEventId === VW &&
      dispositionRQW.body.verificationEventId === VW && JSON.parse(wWorkBefore.disposition).verification?.workEventId === VW,
    "W's verification.workEventId as A8.6 reports it is exactly the id answered, stored, audited and derived for W's request",
  )
  check(
    'T039',
    'Historical A8.5 and A8.6 rows unchanged',
    (await remediationHash()) === remediationHashBefore && (await workHash()) === workHashBefore && withoutEvaluatedAt((await remediationDispositionOf(W)).body) === wRemediationBefore &&
      withoutEvaluatedAt((await workDispositionOf(W)).body) === wWorkBefore.disposition && withoutEvaluatedAt((await workHistoryOf(W)).body) === wWorkBefore.history,
    "after the requests every A8.5 and A8.6 event of this run's intakes is byte-identical, and W's A8.5 disposition (APPROVED_FOR_PLANNING), A8.6 disposition (VERIFIED_INTERNAL_WORK) and A8.6 history read back the same",
  )
  const moduleCodeEarly = committedProductionCodeOf([MODULE_DIR]).code
  check(
    'T040',
    'No CRG release-selection side effect',
    (await snap()).coding === ownerSnapshotBefore.coding && !/coding-release|codingRelease|coding-validation|codingValidation|crg_|code_system|procedure-code|diagnosis-code/.test(moduleCodeEarly),
    'every CRG-01 coding-release and validation table (scopes, receipts, manifests, rights, imports, memberships) and the A2 code masters hold exactly the rows they held; the module reads and writes no coding owner',
  )

  // ---------------------------------------------------------------- legal transitions (T041–T050)
  section('Legal transitions on W and RT: the eligible request, the awaiting state, one pending request, an independent confirmation, a return with its reason, both terminal in v1')
  const countsBeforeRT = await counts()
  const RQRT = await resolve(RT, requestOf(VRT), M4.who)
  const RQRT_ID = (RQRT.body?.resolutionEventId ?? MISSING) as string
  const countsAfterRT = await counts()
  const rqrtAudits = await auditsOfEvent(RQRT_ID)
  check(
    'T041',
    'Eligible request records 201',
    RQRT.status === 201 && RQRT.body.sequence === 1 && RQRT.body.recordedByMembershipId === M4.membershipId && RQRT.body.verificationEventId === VRT && same(countsAfterRT, plus(countsBeforeRT, 1)) &&
      rqrtAudits.length === 1 && rqrtAudits[0].actionCode === 'exception_resolution.recorded' && rqrtAudits[0].organizationId === org && rqrtAudits[0].actorUserId === M4.id && rqrtAudits[0].beforeState === null,
    "M4, RT's current assignee, requests (201, event 1) naming RT's verified work; exactly one resolution row and one audit (exception_resolution.recorded, Org A, actor M4) were added and nothing else changed",
  )
  const dispositionRT = (await dispositionOf(RT)).body
  check(
    'T042',
    'Request enters awaiting state',
    dispositionRT.state === 'AWAITING_RESOLUTION_DECISION' && dispositionRT.request?.resolutionEventId === RQRT_ID && dispositionRT.decision === null && dispositionRT.eventCount === 1 &&
      dispositionRQW.body.state === 'AWAITING_RESOLUTION_DECISION' && dispositionRQW.body.request?.resolutionEventId === RQW_ID,
    'RT and W each derive AWAITING_RESOLUTION_DECISION naming their request, with no decision',
  )
  const secondPending = await resolve(W, requestOf(VW), M1.who)
  const secondDirect = await directInsert([rowOf(S), rowOf(S, { sequence: 2 })])
  check(
    'T043',
    'One pending request only',
    secondPending.status === 409 && errorCode(secondPending.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED' && /already awaits a decision/.test(errorMessage(secondPending.body)) && (await wRows()) === 1 &&
      secondDirect.refused && /exception_resolution_transition: a resolution request of this intake already awaits a decision/.test(secondDirect.message) && secondDirect.clean,
    "a second request on W while its request awaits a decision is refused 409, and a second direct request row on S by the guard; nothing recorded",
  )
  const duplicateRT = await resolve(RT, requestOf(VRT), M4.who)
  const rqrtHash = await rowHash(RQRT_ID)
  const selfRT = await resolve(RT, confirmOf(RQRT_ID), M4.who)
  const wrongRequest = [await resolve(W, confirmOf(MISSING), DR.who), await resolve(W, confirmOf(RQRT_ID), DR.who), await resolve(W, confirmOf(VW), DR.who)]
  const confirmWithReason = await resolve(W, { ...confirmOf(RQW_ID), returnReasonCode: 'ADDITIONAL_WORK_REQUIRED' }, DR.who)
  const countsBeforeDecision = await counts()
  const DCW = await resolve(W, confirmOf(RQW_ID), DR.who)
  const DCW_ID = (DCW.body?.resolutionEventId ?? MISSING) as string
  const countsAfterDecision = await counts()
  const dispositionDCW = (await dispositionOf(W)).body
  check(
    'T044',
    'Independent review confirms internally',
    DCW.status === 201 && DCW.body.sequence === 2 && DCW.body.requestEventId === RQW_ID && DCW.body.decisionCode === 'CONFIRM_INTERNAL_RESOLUTION' && DCW.body.recordedByMembershipId === DR.membershipId &&
      DCW.body.recordedByUserId === DR.id && dispositionDCW.state === 'RESOLVED_INTERNAL' && dispositionDCW.decision?.resolutionEventId === DCW_ID && same(Object.keys(dispositionDCW.decision ?? {}), DECISION_KEYS) &&
      same(countsAfterDecision, plus(countsBeforeDecision, 1)),
    "DR, holding the decide permission and not the requester, confirms W's request (event 2); W derives RESOLVED_INTERNAL — an internal decision only; exactly one row and one audit were added",
  )
  const dcwRow = (await eventsOf(W.intakeId))[1]
  check(
    'T045',
    'Approval requires no return reason',
    isValidation(confirmWithReason) && DCW.body.returnReasonCode === null && dcwRow?.returnReasonCode === null && dispositionDCW.decision?.returnReasonCode === null,
    "a confirmation carrying a return reason is a 400; W's confirmation has no return reason in its answer, its stored row or its disposition",
  )
  const returnWithout = [await resolve(RT, { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId: RQRT_ID, decisionCode: 'RETURN_FOR_REWORK' }, VR.who), await resolve(RT, returnOf(RQRT_ID, 'BECAUSE'), VR.who)]
  const countsBeforeReturn = await counts()
  const RTD = await resolve(RT, returnOf(RQRT_ID, 'SOURCE_INTEGRITY_CONCERN'), VR.who)
  const RTD_ID = (RTD.body?.resolutionEventId ?? MISSING) as string
  const countsAfterReturn = await counts()
  const dispositionRTD = (await dispositionOf(RT)).body
  check(
    'T046',
    'Return requires controlled reason',
    returnWithout.every(isValidation) && RTD.status === 201 && RTD.body.decisionCode === 'RETURN_FOR_REWORK' && RTD.body.returnReasonCode === 'SOURCE_INTEGRITY_CONCERN' && RTD.body.recordedByMembershipId === VR.membershipId &&
      dispositionRTD.state === 'RETURNED_FOR_REWORK' && dispositionRTD.decision?.returnReasonCode === 'SOURCE_INTEGRITY_CONCERN' && same(countsAfterReturn, plus(countsBeforeReturn, 1)),
    "a return without a reason or with an uncontrolled one is a 400; VR — RT's A8.6 verifier, independent of the requester M4 (D5) — returns RT's request with SOURCE_INTEGRITY_CONCERN (201); RT derives RETURNED_FOR_REWORK",
  )
  const rtWorkNow = (await workDispositionOf(RT)).body
  check(
    'T047',
    'Return does not imply resolution',
    dispositionRTD.state === 'RETURNED_FOR_REWORK' && dispositionRTD.state !== 'RESOLVED_INTERNAL' && dispositionRTD.request?.resolutionEventId === RQRT_ID && rtWorkNow.state === 'VERIFIED_INTERNAL_WORK' &&
      (await remediationDispositionOf(RT)).body.state === 'APPROVED_FOR_PLANNING' && same(countsAfterReturn, plus(countsBeforeReturn, 1)),
    "RT's return is never a resolution: the returned request stays the recorded one; RT's A8.6 work stays VERIFIED_INTERNAL_WORK and its A8.5 plan APPROVED_FOR_PLANNING; only the return's row and audit were added",
  )
  const afterReturn = [await resolve(RT, requestOf(VRT), M4.who), await resolve(RT, confirmOf(RQRT_ID), DR.who)]
  const afterReturnDirect = await directInsert([rowOf(RT, { sequence: 3 })])
  check(
    'T048',
    'Request after return refused 409 in v1',
    afterReturn.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED' && /RETURNED_FOR_REWORK, which is terminal in v1/.test(errorMessage(r.body))) &&
      afterReturnDirect.refused && /exception_resolution_transition: the resolution request of this intake was decided/.test(afterReturnDirect.message) && afterReturnDirect.clean && (await eventsOf(RT.intakeId)).length === 2 &&
      (await dispositionOf(RT)).body.state === 'RETURNED_FOR_REWORK',
    "architecture owner correction 1: RETURNED_FOR_REWORK is terminal in v1 — a new request on RT after its return (its assignee, its verified work) and a further decision are each refused 409, and a direct third row by the guard; rework needs a separately approved future version",
  )
  const replayW = await resolve(W, requestOf(VW), M1.who)
  const replayRT = await resolve(RT, requestOf(VRT), M4.who)
  check(
    'T049',
    'Same report replay refused',
    [replayW, replayRT].every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED' && r.body?.resolutionEventId === undefined) && duplicateRT.status === 409 &&
      (await rowHash(RQRT_ID)) === rqrtHash && (await rowHash(RQW_ID)) === rqwHashBefore,
    "re-sending W's and RT's exact requests (and RT's while it awaited a decision) is a 409, never a replayed 201; both request rows are byte-identical",
  )
  const afterResolved = [await resolve(W, requestOf(VW), M1.who), await resolve(W, confirmOf(RQW_ID), DR.who), await resolve(W, returnOf(RQW_ID), VR.who)]
  const afterResolvedDirect = await directInsert([rowOf(W, { sequence: 3, recorded_by_membership_id: M1.membershipId, recorded_by_user_id: M1.id })])
  check(
    'T050',
    'Confirmed decision terminal in v1',
    afterResolved.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED' && /RESOLVED_INTERNAL, which is terminal in v1/.test(errorMessage(r.body))) &&
      afterResolvedDirect.refused && /exception_resolution_transition: the resolution request of this intake was decided/.test(afterResolvedDirect.message) && (await wRows()) === 2,
    'after RESOLVED_INTERNAL a new request, a second confirmation and a return are each refused 409 and a direct third row by the guard; reopening is a future versioned decision',
  )

  // ---------------------------------------------------------------- illegal transitions (T051–T060)
  section('Illegal transitions: a decision without a request, duplicates, self-review, the wrong request, a repeated review, a basis that does not hold, work that is not the verification, nothing implied by A8.6, nothing written on a refusal')
  const countsBeforeIllegal = await counts()
  const noRequest = [await resolve(S, confirmOf(MISSING), DR.who), await resolve(S, confirmOf(VS), DR.who), await resolve(S, returnOf(MISSING), DR.who)]
  check(
    'T051',
    'Decide without request 409',
    noRequest.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED' && /no resolution request of this exception awaits a decision/.test(errorMessage(r.body))) && (await eventsOf(S.intakeId)).length === 0,
    'a confirmation or a return on S, which holds verified work but no request, is refused 409 (naming no event or its A8.6 verification); nothing recorded',
  )
  check(
    'T052',
    'Duplicate request while awaiting 409',
    duplicateRT.status === 409 && errorCode(duplicateRT.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED' && /already awaits a decision/.test(errorMessage(duplicateRT.body)) && duplicateRT.body?.resolutionEventId === undefined,
    "an exact duplicate of RT's request while it awaited a decision was refused 409 and answered no event",
  )
  check(
    'T053',
    'Self-review 409',
    [selfRoute, selfRT].every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT' && /never decided by its own requester/.test(errorMessage(r.body))) && selfService.ok === false,
    "M1 deciding its own request on W (route and service) and M4 deciding its own on RT are each refused 409 REVIEWER_NOT_INDEPENDENT",
  )
  check(
    'T054',
    'Review of wrong request 409',
    wrongRequest.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED' && /names exactly the request that awaits a decision/.test(errorMessage(r.body))),
    "while W's request awaited a decision, a confirmation naming no event, RT's request (another intake) or W's A8.6 verification was refused 409",
  )
  const repeated = [await resolve(W, confirmOf(RQW_ID), VR2.who), await resolve(RT, returnOf(RQRT_ID), DR.who)]
  check(
    'T055',
    'Repeated review 409',
    repeated.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED') && (await wRows()) === 2 && (await eventsOf(RT.intakeId)).length === 2,
    "a second decision of W's confirmed request (another decider) and of RT's returned request is refused 409; nothing recorded",
  )
  // A request planted on N naming its EVIDENCE_NOT_VERIFIED verification (triggers off, rolled back): no decision may
  // follow it — the guard refuses a direct decision and the service refuses on that transaction.
  const plantedN = randomUUID()
  const noBasisDirect = await directInsert([decideRow(N, 2, plantedN)], { before: (tx) => insertRow(tx, rowOf(N, { id: plantedN, verification_event_id: VN })) })
  const noBasisService = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
    await insertRow(tx, rowOf(N, { id: plantedN, verification_event_id: VN }))
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return recordResolutionEventOn(N.claimId, N.intakeId, confirmOf(plantedN), DR.id, tx)
  })
  check(
    'T056',
    'Decision with no valid verified evidence 409',
    noBasisDirect.refused && /exception_resolution_basis: the request's recorded A8\.6 verification is no longer the intake's verified basis/.test(noBasisDirect.message) && noBasisDirect.clean &&
      noBasisService.value?.ok === false && noBasisService.value.code === 'EXCEPTION_RESOLUTION_CONFLICT' && noBasisService.clean,
    "a request planted on N naming its NOT_VERIFIED verification cannot be decided: a direct decision is refused by the basis re-check (D6) and the service answers 409 (an inconsistent history); the reducer's own D6 refusal is proven by its unit tests (T091)",
  )
  check(
    'T057',
    'Request after internal resolution 409',
    afterResolved[0].status === 409 && /RESOLVED_INTERNAL, which is terminal in v1/.test(errorMessage(afterResolved[0].body)) && afterResolvedDirect.refused && afterResolvedDirect.clean,
    "M1's new request on W after RESOLVED_INTERNAL was refused 409 and a direct one by the guard (T050)",
  )
  const wrongWork = [await resolve(S, requestOf(reportOfIntake.get(S.intakeId) as string), M4.who), await resolve(S, requestOf(PS.proposalId), M4.who), await resolve(S, requestOf(findingOf(S)), M4.who)]
  const wrongWorkDirect = await directInsert([rowOf(S, { verification_event_id: reportOfIntake.get(S.intakeId) as string })])
  check(
    'T058',
    'Incorrect work-to-plan mapping 409',
    wrongWork[0].status === 409 && errorCode(wrongWork[0].body) === 'EXCEPTION_RESOLUTION_BASIS_NOT_VERIFIED' && [wrongWork[1], wrongWork[2]].every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingBasis))) &&
      wrongWorkDirect.refused && /exception_resolution_basis/.test(wrongWorkDirect.message) && (await eventsOf(S.intakeId)).length === 0,
    "on S, its A8.6 report (not its verification) is refused 409 BASIS_NOT_VERIFIED, its A8.5 proposal and A8.3 finding are the missing-verification 404, and a direct row naming the report is refused by the basis guard",
  )
  const untouchedIntakes = [S, J, AT, R, K, G, Q]
  const autoRows = await prisma.exceptionResolutionEvent.count({ where: { exceptionIntakeId: { in: untouchedIntakes.map((k) => k.intakeId) } } })
  const workModuleCode = committedProductionCodeOf(['backend/src/modules/exception-remediation-work']).code
  check(
    'T059',
    'No implicit close/resolve from A8.6',
    autoRows === 0 && (await Promise.all(untouchedIntakes.map(async (k) => (await dispositionOf(k)).body.state === 'NO_RESOLUTION_REQUEST'))).every(Boolean) && !/exception-resolution|exceptionResolution/.test(workModuleCode),
    `the ${untouchedIntakes.length} intakes whose A8.6 work is VERIFIED_INTERNAL_WORK but on which nobody requested hold no resolution event and derive NO_RESOLUTION_REQUEST; the A8.6 module knows nothing of A8.7`,
  )
  check(
    'T060',
    'Refused attempts create no event or audit',
    (await unchanged(countsBeforeIllegal)) && [...noRequest, ...repeated, ...wrongWork].every((r) => r.status >= 400) && noBasisDirect.clean && wrongWorkDirect.clean,
    'every refusal in this section (decisions without a request, repeated reviews, the wrong work, planted bases) left every counted table, the audit included, exactly as it was',
  )

  // ---------------------------------------------------------------- direct SQL safety on S (T061–T070, always rolled back)
  section('Direct SQL safety on S (always rolled back): RESTRICT keys, valid direct rows, forged linkage, forged actors and deciders, foreign or ambiguous A8.6 basis, shape CHECKs with triggers off, sequence, UPDATE/DELETE/TRUNCATE, the unique decision')
  const fksOf = (table: string) => prisma.$queryRawUnsafe<{ name: string; del: string }[]>(`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid = '${table}'::regclass ORDER BY conname`)
  const fks = await fksOf(TABLE)
  const parentDeletes = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${INTAKE_TABLE} WHERE id = $1::uuid`, W.intakeId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${WORK_TABLE} WHERE id = $1::uuid`, VW)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id = $1::uuid`, DR.id)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM organization_memberships WHERE id = $1::uuid`, M1.membershipId)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM claims WHERE id = $1::uuid`, W.claimId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, RQW_ID)),
  ]
  // The verification key with every trigger off: only the RESTRICT key itself can refuse.
  const restrictAlone = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE ${WORK_TABLE} DISABLE TRIGGER USER`)
    await tx.$executeRawUnsafe(`DELETE FROM ${WORK_TABLE} WHERE id = $1::uuid`, VW)
  })
  check(
    'T061',
    'All foreign keys RESTRICT',
    fks.length === 7 && fks.every((fk) => fk.del === 'r') && parentDeletes.every((r) => !r.message.includes(NOT_COMMITTED) && /append-only|foreign key|23503|claims cannot be deleted/.test(r.message) && r.clean) &&
      /foreign key|23503/.test(restrictAlone.message) && /exception_resolution_events_verification_event_id_fkey/.test(restrictAlone.message) && restrictAlone.clean,
    `${fks.map((f) => f.name.replace(`${TABLE}_`, '')).join(', ')}: all ON DELETE RESTRICT; deleting W's intake, its A8.6 verification, a deciding user, a requesting membership, the Claim (A6's own guard first) or the request itself is refused; with the A8.6 triggers disabled the verification is still held by the RESTRICT key alone`,
  )
  const rS = randomUUID()
  const validDirect = [
    await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS)]),
    await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS, { decision_code: 'RETURN_FOR_REWORK', return_reason_code: 'INSUFFICIENT_SUPPORT', recorded_by_membership_id: VR.membershipId, recorded_by_user_id: VR.id })]),
    await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS, { recorded_by_membership_id: RV.membershipId, recorded_by_user_id: RV.id })]),
  ]
  check('T062', 'Valid direct events work then rollback', validDirect.every((r) => !r.refused && r.clean) && (await eventsOf(S.intakeId)).length === 0, "a valid direct request and decision (a confirmation by DR, a return with its reason by S's A8.6 verifier, a confirmation by the A8.5 approver) pass every guard on S and roll back; S holds no committed event")
  const forgedLinkage = [await directInsert([rowOf(S, { organization_id: otherOrg })]), await directInsert([rowOf(S, { claim_id: W.claimId })]), await directInsert([rowOf(S, { exception_intake_id: RT.intakeId })])]
  check('T063', 'Forged tenant/Claim/intake refused', forgedLinkage.every((r) => r.refused && /exception_resolution_coherence/.test(r.message) && r.clean), 'a direct event under the other organization, another Claim or another intake than its own is refused by the coherence guard')
  const forgedActors = {
    mismatched: await directInsert([rowOf(S, { recorded_by_user_id: M2.id })]), foreign: await directInsert([rowOf(S, { recorded_by_membership_id: O.membershipId, recorded_by_user_id: O.id })]),
    missing: await directInsert([rowOf(S, { recorded_by_membership_id: MISSING })]), otherTenantOfUser: await directInsert([rowOf(S, { recorded_by_membership_id: M1X.id, recorded_by_user_id: M1.id })]),
    notAssignee: await directInsert([rowOf(S, { recorded_by_membership_id: M2.membershipId, recorded_by_user_id: M2.id })]),
    viewerRequester: await directInsert([rowOf(S, { recorded_by_membership_id: viewerMembershipId, recorded_by_user_id: viewerUser.id })]),
  }
  check(
    'T064',
    'Forged user/membership refused',
    [forgedActors.mismatched, forgedActors.foreign, forgedActors.missing, forgedActors.otherTenantOfUser].every((r) => r.refused && /exception_resolution_member/.test(r.message)) &&
      [forgedActors.notAssignee, forgedActors.viewerRequester].every((r) => r.refused && /exception_resolution_assignee/.test(r.message)) && Object.values(forgedActors).every((r) => r.clean),
    "a membership of another user, the other tenant's, M1's own membership in the other tenant or none is refused by the member guard; a requester who is not S's assignee (M2, the Viewer) by the assignee guard",
  )
  const selfDirect = {
    sameMember: await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })]),
    otherMembership: await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS, { recorded_by_membership_id: DR.membershipId, recorded_by_user_id: M4.id })]),
    otherTenantMembership: await directInsert([decideRow(H, 2, RQH.body?.resolutionEventId ?? MISSING, { recorded_by_membership_id: M1X.id, recorded_by_user_id: M1.id })]),
    viewerDecider: await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS, { recorded_by_membership_id: viewerMembershipId, recorded_by_user_id: viewerUser.id })]),
    rolelessDecider: await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS, { recorded_by_membership_id: NR.membershipId, recorded_by_user_id: NR.id })]),
  }
  const selfPlanted = await plantedRead(S, [rowOf(S, { id: rS }), decideRow(S, 2, rS, { recorded_by_membership_id: DR.membershipId, recorded_by_user_id: M4.id })])
  check(
    'T065',
    'Direct self-review refused',
    selfDirect.sameMember.refused && /exception_resolution_reviewer: a resolution request is never decided by its own requester/.test(selfDirect.sameMember.message) &&
      [selfDirect.otherMembership, selfDirect.otherTenantMembership].every((r) => r.refused && /exception_resolution_member/.test(r.message)) &&
      [selfDirect.viewerDecider, selfDirect.rolelessDecider].every((r) => r.refused && /exception_resolution_reviewer: the decider's roles must grant exceptionResolution\.decide/.test(r.message)) &&
      Object.values(selfDirect).every((r) => r.clean) && selfPlanted.value?.history.ok === false && selfPlanted.value.disposition.ok === false && selfPlanted.clean,
    "on S a direct self-decision is refused by the reviewer guard and the requester's user acting through DR's membership by the member guard, as is M1 deciding H through its membership of the other tenant; a Viewer or role-less decider by the decide-permission guard; a planted decision by the requester's user under another membership fails the whole read (409)",
  )
  const ambiguous = { report: randomUUID(), verification: randomUUID() }
  const foreignWork = [
    await directInsert([rowOf(S, { verification_event_id: VW })]), await directInsert([rowOf(S, { verification_event_id: VF })]), await directInsert([rowOf(S, { verification_event_id: VN })]),
    await directInsert([rowOf(S, { verification_event_id: reportOfIntake.get(S.intakeId) as string })]), await directInsert([rowOf(S, { verification_event_id: MISSING })]),
  ]
  const ambiguousBasis = await directInsert([rowOf(S)], { before: (tx) => plantWork(tx, S, PS.proposalId, findingOf(S), 3, 'EVIDENCE_SUPPORTED', ambiguous) })
  check(
    'T066',
    'Foreign A8.6 work reference refused',
    foreignWork.every((r) => r.refused && /exception_resolution_basis|foreign key|23503/.test(r.message) && r.clean) && foreignWork.slice(0, 4).every((r) => /exception_resolution_basis/.test(r.message)) &&
      ambiguousBasis.refused && /exception_resolution_basis/.test(ambiguousBasis.message) && ambiguousBasis.clean,
    "on S, W's verification (another intake), the other tenant's, N's NOT_VERIFIED verification, S's own report and a missing event are each refused by the basis guard (or the key); with a second A8.6 verification planted on S, even S's own verification is refused — which verification is authoritative would be ambiguous",
  )
  const off = { triggersOff: true }
  const shapes = [
    await directInsert([rowOf(S, { verification_event_id: null })], off), await directInsert([rowOf(S, { reason_code: null })], off), await directInsert([rowOf(S, { reason_code: 'BECAUSE' })], off),
    await directInsert([rowOf(S, { request_event_id: MISSING })], off), await directInsert([rowOf(S, { decision_code: 'CONFIRM_INTERNAL_RESOLUTION' })], off), await directInsert([rowOf(S, { return_reason_code: 'INSUFFICIENT_SUPPORT' })], off),
    await directInsert([decideRow(S, 1, MISSING, { request_event_id: null })], off), await directInsert([decideRow(S, 1, MISSING, { verification_event_id: VS })], off),
    await directInsert([decideRow(S, 1, MISSING, { reason_code: 'VERIFIED_INTERNAL_WORK' })], off), await directInsert([decideRow(S, 1, MISSING, { return_reason_code: 'INSUFFICIENT_SUPPORT' })], off),
    await directInsert([decideRow(S, 1, MISSING, { decision_code: 'RETURN_FOR_REWORK' })], off), await directInsert([decideRow(S, 1, MISSING, { decision_code: 'RETURN_FOR_REWORK', return_reason_code: 'BECAUSE' })], off),
    await directInsert([decideRow(S, 1, MISSING, { decision_code: 'RESOLVED' })], off), await directInsert([decideRow(S, 1, MISSING, { decision_code: null })], off),
  ]
  const eventCodeAlone = await directInsert([rowOf(S, { event_code: 'RESOLVE_EXCEPTION' })], off)
  const contractAlone = await directInsert([rowOf(S, { contract_version: 'A8-RESOLUTION-DECISION-2' })], off)
  check(
    'T067',
    'Contract/event/shape CHECK effective',
    shapes.every((r) => r.refused && /exception_resolution_events_shape_chk/.test(r.message) && r.clean) && eventCodeAlone.refused && /exception_resolution_events_event_code_chk/.test(eventCodeAlone.message) &&
      contractAlone.refused && /exception_resolution_events_contract_chk/.test(contractAlone.message),
    'with every trigger off, a request without its verification or reason, with an uncontrolled reason or any decision field, and a decision without its request, with a request field, a confirmation with a return reason, a return without or with an uncontrolled reason, or an unknown or missing decision code are refused by the shape CHECK; an unknown event and a future contract by theirs',
  )
  const firstTwo = await directInsert([rowOf(S, { sequence: 2 })])
  const reusedLive = await directInsert([rowOf(S, { id: rS }), decideRow(S, 1, rS)])
  const zero = await directInsert([rowOf(S, { sequence: 0 })], off)
  const reusedOff = await directInsert([rowOf(S), rowOf(S)], off)
  check(
    'T068',
    'Sequence gap/duplicate refused',
    firstTwo.refused && /exception_resolution_sequence/.test(firstTwo.message) && reusedLive.refused && /exception_resolution_sequence/.test(reusedLive.message) && zero.refused && /exception_resolution_events_sequence_chk/.test(zero.message) &&
      reusedOff.refused && /exception_resolution_events_sequence_key|23505/.test(reusedOff.message) && [firstTwo, reusedLive, zero, reusedOff].every((r) => r.clean),
    'a first event numbered 2 and a reused number 1 are refused by the sequence guard; number 0 by its CHECK and, with every trigger off, a reused number by the unique (intake, sequence) index',
  )
  const wHash = await rowsHash([W.intakeId])
  const mutations = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = sequence WHERE id = $1::uuid`, RQW_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET decision_code = 'RETURN_FOR_REWORK', return_reason_code = 'INSUFFICIENT_SUPPORT' WHERE id = $1::uuid`, DCW_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, DCW_ID)),
  ]
  const truncation = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`))
  const cascade = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`))
  // A later owner's ON DELETE RESTRICT key into this table would make PostgreSQL refuse a plain TRUNCATE before any
  // trigger runs; TRUNCATE ... CASCADE still reaches this guard. Judged on behaviour: every wipe is refused.
  const referencedBy = await prisma.$queryRawUnsafe<{ del: string; self: boolean }[]>(`SELECT confdeltype::text AS del, conrelid = confrelid AS self FROM pg_constraint WHERE contype = 'f' AND confrelid = '${TABLE}'::regclass`)
  const truncationRefused = /append-only/.test(truncation.message) || (/cannot truncate a table referenced in a foreign key constraint/.test(truncation.message) && referencedBy.some((row) => !row.self) && referencedBy.every((row) => row.del === 'r'))
  check(
    'T069',
    'No-op UPDATE, DELETE and TRUNCATE refused',
    mutations.every((r) => /append-only/.test(r.message) && r.clean) && truncationRefused && truncation.clean && /append-only/.test(cascade.message) && cascade.clean && (await rowsHash([W.intakeId])) === wHash,
    "a no-op UPDATE of W's request, turning its confirmation into a return, deleting it, a TRUNCATE and a TRUNCATE … CASCADE are each refused (append-only); nothing changed",
  )
  const bypass = {
    uniqueDecision: await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS), decideRow(S, 3, rS, { decision_code: 'RETURN_FOR_REWORK', return_reason_code: 'INSUFFICIENT_SUPPORT' })], off),
    secondDecision: await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS), decideRow(S, 3, rS, { recorded_by_membership_id: VR2.membershipId, recorded_by_user_id: VR2.id })]),
    afterDecision: await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, rS, { decision_code: 'RETURN_FOR_REWORK', return_reason_code: 'ADDITIONAL_WORK_REQUIRED' }), rowOf(S, { sequence: 3 })]),
    otherRequest: await directInsert([rowOf(S, { id: rS }), decideRow(S, 2, RQW_ID)]),
  }
  check(
    'T070',
    'Second review unique key holds w/o triggers',
    bypass.uniqueDecision.refused && /exception_resolution_events_request_event_id_key|23505/.test(bypass.uniqueDecision.message) && bypass.secondDecision.refused &&
      /exception_resolution_transition: the resolution request of this intake was decided/.test(bypass.secondDecision.message) && bypass.afterDecision.refused &&
      /exception_resolution_transition: the resolution request of this intake was decided/.test(bypass.afterDecision.message) && bypass.otherRequest.refused &&
      /exception_resolution_transition: a decision names exactly the resolution request that awaits a decision/.test(bypass.otherRequest.message) && Object.values(bypass).every((r) => r.clean),
    "with every trigger off a second decision of one request is still refused by the unique (request) index; live, a second decision, a new request after a return (terminal in v1) and a decision of W's request on S are refused by the guard",
  )

  // ---------------------------------------------------------------- atomicity and audit (T071–T080), J's and AT's writers
  section("Atomicity and audit on J and AT: one event and one audit commit together, crashes after the insert and after the audit, a retry after a proven rollback, database time, metadata only, no audit on reads or refusals, no backdating, no orphan, the cited basis unchanged")
  const serviceCode = committedCode(`${MODULE_DIR}/exception-resolution.service.ts`)
  const onTx = serviceCode.slice(serviceCode.indexOf('async function recordOnTransaction'), serviceCode.indexOf('async function reconcileUnknownOutcome'))
  const firstStatement = onTx.split('\n').slice(1).find((line) => /^\s*(if|const|await|return)\b/.test(line)) ?? ''
  // T081's writers first: one request holds J's Claim lock while a second request waits.
  const holdLock = holdAt('exceptionResolution.claim_locked')
  const firstJ = recordResolutionEvent(J.claimId, J.intakeId, requestOf(verificationOf(J)), M4.id)
  await Promise.race([holdLock.arrived, firstJ])
  const secondJ = recordResolutionEvent(J.claimId, J.intakeId, requestOf(verificationOf(J)), M4.id)
  const secondWaited = !(await settledWithin(secondJ, 1500))
  holdLock.release()
  const [j1, j2] = await Promise.all([firstJ, secondJ])
  clearConcurrencyProbes()
  const RJ1 = j1.ok ? j1.value.resolutionEventId : MISSING
  // T071 and T087 on AT: while AT's request is inserted but uncommitted, no other connection sees it or its audit, and
  // a read answers the committed history at once.
  const holdInsert = holdAt('exceptionResolution.inserted')
  const committing = recordResolutionEvent(AT.claimId, AT.intakeId, requestOf(verificationOf(AT)), M4.id)
  await Promise.race([holdInsert.arrived, committing])
  const during = { rows: (await eventsOf(AT.intakeId)).length, audits: await auditsOfIntake(AT.intakeId) }
  const readDuring = dispositionOf(AT)
  const readReturned = await settledWithin(readDuring, 5000)
  const readDuringBody = (await readDuring).body
  holdInsert.release()
  const RAT = await committing
  clearConcurrencyProbes()
  const atRows = await eventsOf(AT.intakeId)
  const ratAudit = RAT.ok ? (await auditsOfEvent(RAT.value.resolutionEventId))[0] : undefined
  check(
    'T071',
    'Event plus one audit atomic',
    during.rows === 0 && during.audits === 0 && RAT.ok && atRows.length === 1 && (await auditsOfIntake(AT.intakeId)) === 1 && !!ratAudit && ratAudit.actionCode === 'exception_resolution.recorded' &&
      ratAudit.beforeState === null && (ratAudit.afterState as any)?.recordedAt === atRows[0].recordedAt.toISOString() && ratAudit.organizationId === AT.organizationId && ratAudit.actorUserId === M4.id,
    "while M4's request on AT was uncommitted no other connection saw it or its audit; after commit exactly one of each, the audit holding the event's own database time, organization and actor",
  )
  const confirmJ = confirmOf(RJ1)
  const failAfterInsert = failOnce('exceptionResolution.inserted', 'injected failure after the resolution insert')
  const crashedInsert = await attemptAdversarial(() => recordResolutionEvent(J.claimId, J.intakeId, confirmJ, DR.id))
  const afterCrash1 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T072', 'Crash after insert before audit rolls back', failAfterInsert.reached === 1 && /injected failure after the resolution insert/.test(crashedInsert) && afterCrash1.rows === 1 && afterCrash1.audits === 1, 'a failure right after the decision insert on J rolled back the whole transaction: no event, no audit, no retry')
  const failAfterAudit = failOnce('exceptionResolution.audited', 'injected failure after the resolution audit')
  const crashedAudit = await attemptAdversarial(() => recordResolutionEvent(J.claimId, J.intakeId, confirmJ, DR.id))
  const afterCrash2 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T073', 'Crash after audit before commit rolls back', failAfterAudit.reached === 1 && /injected failure after the resolution audit/.test(crashedAudit) && afterCrash2.rows === 1 && afterCrash2.audits === 1, 'a failure after the audit rolled back both: no event, no audit, no retry')
  // T088 and T089's writers: exhausted retries and unknown outcomes on J, before its one accepted retry.
  const always = failEveryTime('exceptionResolution.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const exhausted = await recordResolutionEvent(J.claimId, J.intakeId, confirmJ, DR.id)
  const lost = failEveryTime('exceptionResolution.audited', 'Connection terminated unexpectedly')
  const unknownOutcome = await recordResolutionEvent(J.claimId, J.intakeId, confirmJ, DR.id)
  const early = failEveryTime('exceptionResolution.claim_locked', 'Connection terminated unexpectedly')
  const earlyOutcome = await recordResolutionEvent(J.claimId, J.intakeId, confirmJ, DR.id)
  clearConcurrencyProbes()
  const jBeforeRetry = (await eventsOf(J.intakeId)).length
  const once = failOnce('exceptionResolution.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const DJ = await recordResolutionEvent(J.claimId, J.intakeId, confirmJ, DR.id)
  clearConcurrencyProbes()
  check(
    'T074',
    'Confirmed rollback retry records exactly once',
    once.reached === 1 && DJ.ok && DJ.value.sequence === 2 && jBeforeRetry === 1 && (await eventsOf(J.intakeId)).length === 2 && (await auditsOfIntake(J.intakeId)) === 2,
    "one provably aborted serialization failure is retried on a fresh transaction that re-reads the history and records DR's confirmation exactly once (event 2) with one audit",
  )
  // T088's unique collision on AT's decision, retried on a fresh transaction.
  const atBeforeUnique = (await eventsOf(AT.intakeId)).length
  const uniqueOnce = failOnce('exceptionResolution.inserted', 'duplicate key value violates unique constraint "exception_resolution_events_sequence_key"')
  const DAT = await recordResolutionEvent(AT.claimId, AT.intakeId, returnOf(RAT.ok ? RAT.value.resolutionEventId : MISSING, 'INSUFFICIENT_SUPPORT'), DR.id)
  clearConcurrencyProbes()
  const runEventsSoFar = await prisma.exceptionResolutionEvent.findMany({ where: { recordedAt: { gte: runStartedAt } } })
  const runAuditsSoFar = await prisma.auditEvent.findMany({ where: { actionCode: 'exception_resolution.recorded', occurredAt: { gte: runStartedAt } } })
  const auditOf = (eventId: string) => runAuditsSoFar.filter((a) => a.entityId === eventId)
  const timeRows = await prisma.$queryRawUnsafe<{ n: bigint; differ: bigint; early: bigint }[]>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE recorded_at <> created_at) AS differ, count(*) FILTER (WHERE recorded_at < $1::timestamptz) AS early FROM ${TABLE} WHERE exception_intake_id = ANY($2::uuid[])`,
    runStartedAt.toISOString(), runIntakes.map((k) => k.intakeId),
  )
  const pastTime = await directInsert([rowOf(S, { recorded_at: '2020-01-01T00:00:00.000Z' })])
  const futureTime = await directInsert([rowOf(S, { recorded_at: new Date(Date.now() + 86_400_000).toISOString() })])
  const retime = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET recorded_at = recorded_at - interval '1 day' WHERE id = $1::uuid`, RQW_ID))
  check(
    'T075',
    'Database event time only',
    Number(timeRows[0].n) >= 8 && Number(timeRows[0].differ) === 0 && Number(timeRows[0].early) === 0 && [pastTime, futureTime].every((r) => r.refused && /exception_resolution_time/.test(r.message) && r.clean) &&
      /append-only/.test(retime.message) && retime.clean && runEventsSoFar.every((e) => (auditOf(e.id)[0]?.afterState as any)?.recordedAt === e.recordedAt.toISOString()),
    "every event this run was recorded and created at the database's own transaction time (equal, never before the run); a past or future time in a direct row is refused by the time guard and re-timing an event is refused (append-only); each audit carries the event's own time",
  )
  const auditText = JSON.stringify(runAuditsSoFar.map((a) => a.afterState))
  check(
    'T076',
    'Audit metadata safe and tenant scoped',
    runEventsSoFar.length >= 8 && runAuditsSoFar.length === runEventsSoFar.length &&
      runEventsSoFar.every((e) => {
        const audits = auditOf(e.id)
        const after = audits[0]?.afterState as any
        return audits.length === 1 && audits[0].organizationId === e.organizationId && audits[0].actorUserId === e.recordedByUserId && audits[0].entityType === 'EXCEPTION_RESOLUTION_EVENT' && audits[0].beforeState === null &&
          same(Object.keys(after ?? {}).sort(), [...AUDIT_KEYS].sort()) && after?.recordedByMembershipId === e.recordedByMembershipId && after?.exceptionIntakeId === e.exceptionIntakeId && after?.claimId === e.claimId &&
          after?.verificationEventId === e.verificationEventId && after?.requestEventId === e.requestEventId
      }) &&
      ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), 'AED', '125.25', M1.email, DR.email, 'Synthetic member', 'Synthetic finding.'].some((value) => auditText.includes(value)),
    `each of the ${runEventsSoFar.length} resolution events this run has exactly one metadata-only audit — exactly ${AUDIT_KEYS.length} keys — under its own organization, acting user and membership, intake, Claim, verification and request, holding no patient, diagnosis, member contact, source text, amount or currency`,
  )
  const auditsBeforeReads = await prisma.auditEvent.count()
  const countsBeforeReads = await counts()
  for (const k of [W, RT, J, S, N]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await dispositionOf(k, who)
  }
  const readRefusals = [
    await historyOf(W, anonymous), await dispositionOf(F), await historyOf({ claimId: W.claimId, intakeId: MISSING }), await get(`${base(W)}/resolution-disposition?current=1`), await resolve(W, requestOf(VW), asViewer),
    await resolve(RT, requestOf(MISSING), M4.who), await resolve(S, confirmOf(MISSING), DR.who), await resolve(W, requestOf(VW), M1.who), await resolve(W, { eventCode: 'NOPE' }, M1.who),
  ]
  check(
    'T077',
    'No audit for reads or refusals',
    (await prisma.auditEvent.count()) === auditsBeforeReads && (await unchanged(countsBeforeReads)) && readRefusals.map((r) => r.status).join('/') === '401/404/404/400/403/404/409/409/400',
    `twenty reads by an Admin and a Viewer and nine refused requests (${readRefusals.map((r) => r.status).join('/')}) wrote no audit and changed no row`,
  )
  const wHashBeforeBackfill = await rowsHash([W.intakeId])
  const backfill = [
    await directInsert([decideRow(W, 2, RQW_ID, { decision_code: 'RETURN_FOR_REWORK', return_reason_code: 'INSUFFICIENT_SUPPORT', recorded_by_membership_id: VR.membershipId, recorded_by_user_id: VR.id })]),
    await directInsert([rowOf(W, { sequence: 3, recorded_by_membership_id: M1.membershipId, recorded_by_user_id: M1.id })]),
  ]
  const rewrite = [await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = 9 WHERE id = $1::uuid`, DCW_ID)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, RQW_ID))]
  check(
    'T078',
    'No backdated insert',
    backfill[0].refused && /exception_resolution_sequence/.test(backfill[0].message) && backfill[1].refused && /exception_resolution_transition: the resolution request of this intake was decided/.test(backfill[1].message) &&
      rewrite.every((r) => /append-only/.test(r.message) && r.clean) && backfill.every((r) => r.clean) && (await rowsHash([W.intakeId])) === wHashBeforeBackfill,
    "a return slotted into W's past is refused by the sequence guard, a request appended after its decision by the terminal guard; renumbering W's decision and deleting its request are refused (append-only); W's rows are byte-identical",
  )
  const contiguous = async (k: Intake) => {
    const rows = await eventsOf(k.intakeId)
    return same(rows.map((e) => e.sequence), rows.map((_e, i) => i + 1)) && (await auditsOfIntake(k.intakeId)) === rows.length
  }
  const orphanAudits = runAuditsSoFar.filter((a) => !runEventsSoFar.some((e) => e.id === a.entityId))
  check(
    'T079',
    'No orphan audit and no orphan event',
    runEventsSoFar.every((e) => auditOf(e.id).length === 1) && orphanAudits.length === 0 && (await contiguous(W)) && (await contiguous(RT)) && (await contiguous(J)) && (await contiguous(AT)) && (await contiguous(H)),
    `${runEventsSoFar.length} events and ${runAuditsSoFar.length} resolution audits this run pair one to one; no audit names a missing event; W, RT, J, AT and H are numbered 1..N with one audit each, after every crash and retry`,
  )
  const citedNow = await hashOf(`SELECT w.* FROM ${WORK_TABLE} w WHERE w.id IN (SELECT e.verification_event_id FROM ${TABLE} e WHERE e.exception_intake_id = ANY($1::uuid[]))`, runIntakes.map((k) => k.intakeId))
  const citedCount = (await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(DISTINCT verification_event_id) AS n FROM ${TABLE} WHERE exception_intake_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId)))[0].n
  check(
    'T080',
    'Historical provenance unchanged after writes',
    (await workHash()) === workHashBefore && (await remediationHash()) === remediationHashBefore && (await snap()).investigation === ownerSnapshotBefore.investigation && citedNow.length === 64 && Number(citedCount) >= 5 &&
      withoutEvaluatedAt((await workHistoryOf(W)).body) === wWorkBefore.history,
    `after every resolution write, crash and retry, all ${Number(citedCount)} A8.6 verifications cited by this run's requests — and every A8.6, A8.5 and A8.3 event of this run's intakes — are byte-identical to before the first resolution write; W's A8.6 history reads back the same`,
  )

  // ---------------------------------------------------------------- concurrency (T081–T090)
  section('Concurrency: the Claim lock first in one SERIALIZABLE transaction shared by every owner read, simultaneous requests and decisions, a concurrent reassignment and return, a permission revocation, a read during a write, bounded retries, unknown commits')
  check(
    'T081',
    'Claim NOWAIT lock FIRST',
    /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(firstStatement) && secondWaited && j1.ok && j1.value.sequence === 1 && j2.ok === false && j2.code === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED',
    "the Claim row NOWAIT lock is the first statement of the write; while one request on J held it a second waited, then was judged on the committed state (a request already awaits a decision: 409)",
  )
  // An A8.6 write on R while an A8.7 request holds R's Claim: it waits for the same lock and is judged afterwards.
  const holdR = holdAt('exceptionResolution.claim_locked')
  const rRequest = recordResolutionEvent(R.claimId, R.intakeId, requestOf(verificationOf(R)), M4.id)
  await Promise.race([holdR.arrived, rRequest])
  const rWork = recordWorkEvent(R.claimId, R.intakeId, { eventCode: 'VERIFY_WORK_REPORT', workReportEventId: reportOfIntake.get(R.intakeId), verificationCode: 'EVIDENCE_SUPPORTED' }, VR2.id)
  const rWorkWaited = !(await settledWithin(rWork, 1500))
  holdR.release()
  const [rRequested, rWorkResult] = await Promise.all([rRequest, rWork])
  clearConcurrencyProbes()
  check(
    'T082',
    'SERIALIZABLE transaction shared by owners',
    /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && (serviceCode.match(/prisma\.\$transaction\(\(tx\) => recordOnTransaction\(/g) ?? []).length === 1 &&
      [/getExceptionIntakesOf\(claimId, tx\)/, /getTriageDispositionOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getInvestigationHistoryOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getRemediationDispositionOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getWorkDispositionOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getWorkHistoryOf\(claimId, parent\.exceptionIntakeId, tx\)/].every((p) => p.test(serviceCode)) &&
      /recordAuditEvent\(/.test(onTx) && /insertResolutionEvent\(/.test(onTx) && rWorkWaited && rRequested.ok && rWorkResult.ok === false,
    "one SERIALIZABLE transaction re-reads the A8.1, A8.2, A8.3, A8.5 and A8.6 owners on the same client and writes the event and its audit; an A8.6 verification attempt on R while R's request held the Claim waited for that lock and was then refused by A8.6 (its work already verified)",
  )
  const requestRace = await Promise.all(Array.from({ length: 5 }, () => resolve(Q, requestOf(verificationOf(Q)), M4.who)))
  const isRefusedStep = (r: { status: number; body: any }) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED'
  const RQQ_ID = (requestRace.find((r) => r.status === 201)?.body.resolutionEventId ?? MISSING) as string
  check(
    'T083',
    'Concurrent same requests: one winner',
    requestRace.filter((r) => r.status === 201).length === 1 && requestRace.filter(isRefusedStep).length === 4 && (await eventsOf(Q.intakeId)).length === 1 && (await auditsOfIntake(Q.intakeId)) === 1 &&
      (await dispositionOf(Q)).body.request?.resolutionEventId === RQQ_ID,
    `five identical requests on Q at once (${requestRace.map((r) => r.status).join('/')}): one 201 and four 409; one event, one audit, and it is the pending request`,
  )
  const mixed = await Promise.all([
    resolve(Q, requestOf(verificationOf(Q)), M4.who), resolve(Q, confirmOf(RQQ_ID), DR.who), resolve(Q, returnOf(RQQ_ID, 'INSUFFICIENT_SUPPORT'), VR.who),
    resolve(Q, confirmOf(RQQ_ID), RV.who), resolve(Q, returnOf(RQQ_ID, 'ADDITIONAL_WORK_REQUIRED'), VR2.who), resolve(Q, requestOf(verificationOf(Q)), M4.who),
  ])
  const qRows = await eventsOf(Q.intakeId)
  const qHistory = (await historyOf(Q)).body
  const qDisposition = (await dispositionOf(Q)).body
  const qBasis = { verificationEventId: verificationOf(Q), workReportEventId: reportOfIntake.get(Q.intakeId) as string, approvedProposalEventId: PQ.proposalId }
  const qDerived = deriveResolution({ exceptionIntakeId: Q.intakeId, organizationId: Q.organizationId, claimId: Q.claimId }, qBasis, qRows)
  check(
    'T084',
    'Concurrent competing requests serialize',
    mixed.every((r) => r.status === 201 || isRefusedStep(r)) && mixed.filter((r) => r.status === 201).length === 1 && qRows.length === 2 && qDerived.ok && (await contiguous(Q)) &&
      same(replayIndependently(qHistory.items, verificationOf(Q)), dispositionFacts(qDisposition)) && qDisposition.state === (qDerived.ok ? qDerived.value.state : 'none') && ['RESOLVED_INTERNAL', 'RETURNED_FOR_REWORK'].includes(qDisposition.state),
    `after Q's request, two requests, two confirmations and two returns at once (${mixed.map((r) => r.status).join('/')}) left 2 events numbered 1..N, one audit each, a history the reducer accepts and a terminal disposition (${qDisposition.state}) this suite's own replay reproduces; every other request was a 409`,
  )
  // DR2 loses its role while its decision of H's request holds H's Claim lock (H is still assigned to M4).
  const holdDR2 = holdAt('exceptionResolution.claim_locked')
  const dr2Decision = recordResolutionEvent(H.claimId, H.intakeId, confirmOf(RQH.body?.resolutionEventId ?? MISSING), DR2.id)
  await Promise.race([holdDR2.arrived, dr2Decision])
  await prisma.membershipRole.deleteMany({ where: { membershipId: DR2.membershipId } })
  holdDR2.release()
  const dr2Result = await dr2Decision
  clearConcurrencyProbes()
  const dr2Http = await resolve(H, confirmOf(RQH.body?.resolutionEventId ?? MISSING), DR2.who)
  const dr2Direct = await directInsert([decideRow(H, 2, RQH.body?.resolutionEventId ?? MISSING, { recorded_by_membership_id: DR2.membershipId, recorded_by_user_id: DR2.id })])
  const holdTriage = holdAt('exceptionTriage.inserted')
  const kReassign = recordTriageEvent(K.claimId, K.intakeId, reassignTo(M2), creatorId)
  await Promise.race([holdTriage.arrived, kReassign])
  const kRequest = recordResolutionEvent(K.claimId, K.intakeId, requestOf(verificationOf(K)), M4.id)
  const kWaited = !(await settledWithin(kRequest, 1500))
  holdTriage.release()
  const [kReassigned, kResult] = await Promise.all([kReassign, kRequest])
  clearConcurrencyProbes()
  const kByM2 = await resolve(K, requestOf(verificationOf(K)), M2.who)
  // A concurrent A8.2 return of H to triage while DR's decision of H's request waits: no longer assigned.
  const holdReturn = holdAt('exceptionTriage.inserted')
  const hReturn = recordTriageEvent(H.claimId, H.intakeId, { eventCode: 'RETURN_TO_TRIAGE', reasonCode: 'ASSIGNEE_UNAVAILABLE' }, creatorId)
  await Promise.race([holdReturn.arrived, hReturn])
  const hDecision = recordResolutionEvent(H.claimId, H.intakeId, confirmOf(RQH.body?.resolutionEventId ?? MISSING), DR.id)
  const hWaited = !(await settledWithin(hDecision, 1500))
  holdReturn.release()
  const [hReturned, hResult] = await Promise.all([hReturn, hDecision])
  clearConcurrencyProbes()
  check(
    'T085',
    'Reviewer-versus-assignee change rechecks',
    kWaited && kReassigned.ok && kResult.ok === false && kResult.code === 'EXCEPTION_RESOLUTION_NOT_ASSIGNEE' && kByM2.status === 201 && kByM2.body.recordedByMembershipId === M2.membershipId && kByM2.body.sequence === 1 &&
      hWaited && hReturned.ok && hResult.ok === false && hResult.code === 'EXCEPTION_RESOLUTION_TRANSITION_REFUSED' && /not assigned now/.test(hResult.message) && (await eventsOf(H.intakeId)).length === 1,
    "while an A8.2 reassignment of K to M2 held K's Claim lock, M4's request waited, re-read the committed disposition and was refused 409 (no longer the assignee), then M2 requested (201); while an A8.2 return of H to triage held H's lock, DR's decision waited and was refused 409 (no longer assigned)",
  )
  const holdG = holdAt('exceptionResolution.claim_locked')
  const gRequest = recordResolutionEvent(G.claimId, G.intakeId, requestOf(verificationOf(G)), M5.id)
  await Promise.race([holdG.arrived, gRequest])
  await prisma.membershipRole.deleteMany({ where: { membershipId: M5.membershipId } })
  holdG.release()
  const gResult = await gRequest
  clearConcurrencyProbes()
  const gHttp = await resolve(G, requestOf(verificationOf(G)), M5.who)
  const gDirect = await directInsert([rowOf(G, { recorded_by_membership_id: M5.membershipId, recorded_by_user_id: M5.id })])
  const gTriage = (await triageDispositionOf(G)).body
  check(
    'T086',
    'Role removal before commit refuses',
    gResult.ok === false && gResult.code === 'EXCEPTION_RESOLUTION_NOT_ASSIGNEE' && gHttp.status === 403 && gDirect.refused && /exception_resolution_assignee/.test(gDirect.message) && gDirect.clean &&
      gTriage.assignedMemberId === M5.membershipId && gTriage.assigneeCurrentlyEligible === false && (await eventsOf(G.intakeId)).length === 0 &&
      dr2Result.ok === false && dr2Result.code === 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT' && dr2Http.status === 403 && dr2Direct.refused && /exception_resolution_reviewer/.test(dr2Direct.message) && dr2Direct.clean &&
      (await eventsOf(H.intakeId)).length === 1,
    "M5's role was removed while its request on G held the Claim lock: refused 409 (no current permission), its next request 403 and a direct row refused by the assignee guard; DR2's role was removed while its decision of H held the lock: refused 409, then 403, and a direct row refused by the reviewer guard; nothing recorded",
  )
  check(
    'T087',
    'Read during uncommitted write sees old',
    readReturned && readDuringBody?.state === 'NO_RESOLUTION_REQUEST' && readDuringBody?.eventCount === 0 && RAT.ok && (await dispositionOf(AT)).body.eventCount === 2,
    "while M4's request on AT was inserted but uncommitted, a read returned at once with the committed history (NO_RESOLUTION_REQUEST, 0 events) — never the uncommitted event, never blocked by the writer",
  )
  check(
    'T088',
    'Bounded fresh retries for confirmed errors',
    always.reached === 3 && exhausted.ok === false && exhausted.code === 'EXCEPTION_RESOLUTION_CONFLICT' && /kept conflicting; nothing was recorded/.test(exhausted.message) && /const MAX_RESOLUTION_ATTEMPTS = 3/.test(serviceCode) &&
      /deadlock detected/.test(serviceCode) && /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode) && uniqueOnce.reached === 1 && DAT.ok && DAT.value.sequence === atBeforeUnique + 1 && /isUniqueViolation\(error\)/.test(serviceCode),
    `a serialization failure on every attempt stops after exactly 3 fresh transactions with a 409 and nothing recorded; a deadlock is retried the same way; a unique (intake, sequence) collision is retried on a fresh transaction and AT's return is recorded once as event ${atBeforeUnique + 1}; busy locks are waited for within the 30 s budget`,
  )
  check(
    'T089',
    'Unknown outcome never blindly retried',
    lost.reached === 1 && unknownOutcome.ok === false && unknownOutcome.code === 'EXCEPTION_RESOLUTION_CONFLICT' && /holds no event at sequence 2; nothing was recorded/.test(unknownOutcome.message) &&
      early.reached === 1 && earlyOutcome.ok === false && /failed before an event was written/.test(earlyOutcome.message) && jBeforeRetry === 1 && /reconcileAttempt\(records, attempted\)/.test(serviceCode),
    "a connection lost after the audit is reconciled against the committed history (no event 2: nothing recorded) and a loss before the insert is reported as such; each reached once — never resubmitted, never a 201 (RECORDED and OTHER_EVENT are proven by the reducer's unit tests, T091)",
  )
  const allRunEvents = await prisma.exceptionResolutionEvent.findMany({ where: { exceptionIntakeId: { in: runIntakes.map((k) => k.intakeId) } } })
  const withEvents = runIntakes.filter((k) => allRunEvents.some((e) => e.exceptionIntakeId === k.intakeId))
  check(
    'T090',
    'Sequences contiguous and audit exactly once',
    withEvents.length >= 8 && (await Promise.all(withEvents.map(contiguous))).every(Boolean),
    `every one of the ${withEvents.length} intakes with resolution events (${withEvents.map((k) => k.label).join(', ')}) is numbered exactly 1..N with exactly one audit per event`,
  )

  // ---------------------------------------------------------------- reducer and read (T091–T100)
  section('Reducer and read: unit tests over every state/event pair, 100 derivations, an independent replay, malformed, gapped and misnumbered histories, an unknown contract, READ ONLY snapshot reads, database read time, two readers')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  const reducerCode = committedCode(`${MODULE_DIR}/exception-resolution.reducer.ts`)
  const reducerTests = committedText(`${MODULE_DIR}/exception-resolution.reducer.test.ts`)
  check(
    'T091',
    'Pure reducer tests all allowed/forbidden pairs',
    ownUnit.ok && /ℹ pass 11/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output) && /every illegal state\/event pair is refused/.test(reducerTests) && /RETURNED_FOR_REWORK is terminal in v1/.test(reducerTests) &&
      /on the same approved A8\.5 plan/.test(reducerTests) && !/prisma|await |async |Date\.now|Math\.random|new Date|from '\.\.\/\.\.\/shared/.test(reducerCode),
    'the 11 reducer and request tests pass (the verified basis on its approved plan, the worked scenarios, the terminal return, every illegal state/event pair including the D6 re-check, exact shapes, whole histories and the unknown-outcome reconciliation); the reducer reads no database, clock or randomness',
  )
  const parentOf = (k: Intake) => ({ exceptionIntakeId: k.intakeId, organizationId: k.organizationId, claimId: k.claimId })
  const basisOfIntake = (k: Intake, plan: Plan) => ({ verificationEventId: verificationOf(k), workReportEventId: reportOfIntake.get(k.intakeId) as string, approvedProposalEventId: plan.proposalId })
  const wStored = await eventsOf(W.intakeId)
  const wBasis = basisOfIntake(W, PW)
  const derivations = new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveResolution(parentOf(W), wBasis, wStored))))
  const wDerived = deriveResolution(parentOf(W), wBasis, wStored)
  check('T092', '100 repeated derives deterministic', derivations.size === 1 && wDerived.ok && wDerived.value.state === 'RESOLVED_INTERNAL', "100 derivations of W's stored history against its verified basis are byte-identical (RESOLVED_INTERNAL)")
  const replayed: [Intake, string | null][] = [[W, VW], [RT, VRT], [J, verificationOf(J)], [AT, verificationOf(AT)], [R, verificationOf(R)], [K, verificationOf(K)], [Q, verificationOf(Q)], [H, verificationOf(H)], [S, VS], [G, verificationOf(G)], [N, null], [AW, null]]
  const replays = await Promise.all(replayed.map(async ([k, basisId]) => same(replayIndependently((await historyOf(k)).body.items, basisId), dispositionFacts((await dispositionOf(k)).body))))
  check('T093', 'Independent replay equals disposition', replays.every(Boolean), "this suite's own replay of W's, RT's, J's, AT's, R's, K's, Q's, H's, S's, G's, N's and AW's histories gives exactly each derived disposition")
  const refusedRead = (r: { value?: { history: any; disposition: any }; clean: boolean }) =>
    r.value?.history.ok === false && r.value.history.code === 'EXCEPTION_RESOLUTION_CONFLICT' && r.value.disposition.ok === false && r.value.disposition.code === 'EXCEPTION_RESOLUTION_CONFLICT' && r.clean
  const corruptShape = await plantedRead(S, [rowOf(S, { reason_code: 'BECAUSE' })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_shape_chk`)
  const plantedSelf = await plantedRead(S, [rowOf(S, { id: rS }), decideRow(S, 2, rS, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })])
  const foreignPlanted = await plantedRead(S, [rowOf(S, { organization_id: otherOrg })])
  const otherBasisPlanted = await plantedRead(S, [rowOf(S, { verification_event_id: VW })])
  check(
    'T094',
    'Corrupt event shape 409',
    refusedRead(corruptShape) && refusedRead(plantedSelf) && refusedRead(foreignPlanted) && refusedRead(otherBasisPlanted),
    "a planted uncontrolled reason (its CHECK dropped), a planted self-decision, a planted row of the other tenant and a planted request naming another intake's verified work each make the history and the disposition refuse 409 — never repaired, never partial",
  )
  const gapped = await plantedRead(S, [rowOf(S, { id: rS }), decideRow(S, 3, rS)])
  check('T095', 'Gapped history 409', refusedRead(gapped), 'a planted history numbered 1, 3 makes both reads refuse 409')
  const wrongFirst = await plantedRead(S, [rowOf(S, { sequence: 2 })])
  check('T096', 'Wrong starting sequence 409', refusedRead(wrongFirst), 'a planted history whose first event is numbered 2 makes both reads refuse 409')
  const futureContract = await plantedRead(S, [rowOf(S, { contract_version: 'A8-RESOLUTION-DECISION-2' })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_contract_chk`)
  check('T097', 'Unknown contract 409', refusedRead(futureContract), 'a planted history under A8-RESOLUTION-DECISION-2 (its CHECK dropped) makes both reads refuse 409')
  const countsBeforeGet = await counts()
  for (const k of [W, RT, J, Q, K]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await dispositionOf(k, who)
  }
  const selectors = [await get(`${base(W)}/resolution-history?latest=1`), await get(`${base(W)}/resolution-disposition?state=RESOLVED_INTERNAL`)]
  const snapshotCode = committedCode('backend/src/shared/database/read-snapshot.ts')
  check(
    'T098',
    'READ ONLY snapshot no writes',
    (await unchanged(countsBeforeGet)) && selectors.every((r) => r.status === 400) && /SET TRANSACTION READ ONLY/.test(snapshotCode) &&
      /withReadSnapshot\(undefined, \(tx\) => getResolutionHistoryOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode) && /withReadSnapshot\(undefined, \(tx\) => getResolutionDispositionOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode),
    'twenty reads by an Admin and a Viewer changed no row; each runs in one READ ONLY snapshot that also reads the A8.1–A8.6 owners; a query selector is refused (400)',
  )
  const dbNow = async () => (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts.getTime()
  const beforeRead = await dbNow()
  const readAgain = (await dispositionOf(W)).body
  const historyAgain = (await historyOf(W)).body
  const afterRead = await dbNow()
  const evaluated = [Date.parse(readAgain.evaluatedAt), Date.parse(historyAgain.evaluatedAt)]
  check(
    'T099',
    'DB evaluatedAt and immutable event time',
    evaluated.every((t) => t >= beforeRead - 1 && t <= afterRead + 1) && evaluated[1] >= evaluated[0] && historyAgain.items.every((item: any, i: number) => item.recordedAt === wStored[i].recordedAt.toISOString()) &&
      historyAgain.items[0].recordedAt === RQW.body.recordedAt && historyAgain.items[1].recordedAt === DCW.body.recordedAt,
    "each read's evaluatedAt lies between two database clock readings around it; every event's recordedAt is its stored database time and W's request and decision still read exactly as answered when recorded",
  )
  const twoReaders = await Promise.all([W, RT, J, Q, K, H].map(async (k) => withoutEvaluatedAt((await historyOf(k)).body) === withoutEvaluatedAt((await historyOf(k, asViewer)).body) && withoutEvaluatedAt((await dispositionOf(k)).body) === withoutEvaluatedAt((await dispositionOf(k, asViewer)).body)))
  check('T100', 'Admin/Viewer reads equal', twoReaders.every(Boolean), "W's, RT's, J's, Q's, K's and H's history and disposition are identical for an Admin and a Viewer (no authorization context in the body)")

  // ---------------------------------------------------------------- non-leakage and Dubai (T101–T110)
  section('Non-leakage and Dubai: every A8.1–A8.3, A8.5, A8.6, A6 and A7 record unchanged; no payer, financial, DRG or coding-release fact; nothing executed or corrected; no SLA, queue, escalation or closure; no browser storage, transport, log or PHI')
  const moduleCode = committedProductionCodeOf([MODULE_DIR]).code
  const feCode = committedProductionCodeOf([FE_DIR]).code
  const ownerSnapshotNow = await snap()
  const untouched = (paths: string[]) => gitArgs(['diff', '--name-only', ownRange, '--', ...paths.map((p) => `:/${p}`)]) === ''
  check(
    'T101',
    'A8.1–A8.3 records untouched',
    untouched(['backend/src/modules/exception-intake', 'backend/src/modules/exception-triage', 'backend/src/modules/exception-investigation', A83_MIGRATION]) && ownerSnapshotNow.intakes === ownerSnapshotBefore.intakes &&
      ownerSnapshotNow.intakeAudits === ownerSnapshotBefore.intakeAudits && (await triageHash()) === triageHashBefore && triageIdsBefore.length >= 30 && ownerSnapshotNow.investigation === ownerSnapshotBefore.investigation &&
      withoutEvaluatedAt((await get(`/api/claims/${W.claimId}/exception-intake`)).body) === wIntakesBefore && withoutEvaluatedAt((await triageDispositionOf(W)).body) === wTriageBefore &&
      withoutEvaluatedAt((await investigationSummaryOf(W)).body) === wInvestigationBefore,
    `the A8.1, A8.2 and A8.3 modules and the A8.3 migration are unchanged; every intake and its audit, all ${triageIdsBefore.length} triage events that existed before the first resolution write and every A8.3 event of this run are byte-identical; W's intake list, triage disposition and investigation summary read back the same`,
  )
  check(
    'T102',
    'A8.5 approved plan untouched',
    untouched(['backend/src/modules/exception-remediation', A85_MIGRATION]) && (await remediationHash()) === remediationHashBefore && withoutEvaluatedAt((await remediationDispositionOf(W)).body) === wRemediationBefore &&
      JSON.parse(wRemediationBefore).state === 'APPROVED_FOR_PLANNING',
    "the A8.5 module and migration are unchanged; every A8.5 event of this run's intakes is byte-identical and W's A8.5 disposition still reads APPROVED_FOR_PLANNING (planning only)",
  )
  check(
    'T103',
    'A8.6 work history untouched',
    untouched(['backend/src/modules/exception-remediation-work', A86_MIGRATION]) && (await workHash()) === workHashBefore && withoutEvaluatedAt((await workDispositionOf(W)).body) === wWorkBefore.disposition &&
      withoutEvaluatedAt((await workHistoryOf(W)).body) === wWorkBefore.history,
    "the A8.6 module and migration are unchanged; every A8.6 event of this run's intakes is byte-identical (the concurrent A8.6 attempt on R was refused by A8.6, T082) and W's A8.6 disposition and history read back the same",
  )
  check(
    'T104',
    'A6 frozen bytes/digests untouched',
    untouched(['backend/src/modules/claim-submission', 'backend/src/modules/claim-payload', 'backend/src/modules/claim-evidence', 'backend/src/modules/claim-lifecycle', 'backend/src/modules/claim-correction']) &&
      ownerSnapshotNow.freezes === ownerSnapshotBefore.freezes && ownerSnapshotNow.lifecycle === ownerSnapshotBefore.lifecycle && ownerSnapshotNow.links === ownerSnapshotBefore.links,
    `the A6 owners are unchanged; each freeze, sealed manifest, lifecycle event and correction link of the ${runClaims.length + 1} run Claims is byte-identical`,
  )
  const A7_MODULES = ['revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'closure-basis-trace', 'revenue-timeline', 'revenue-delta', 'revenue-continuity'].map((m) => `backend/src/modules/${m}`)
  check('T105', 'A7 evidence and cases untouched', untouched(A7_MODULES) && ownerSnapshotNow.a7 === ownerSnapshotBefore.a7, 'the A7 owners are unchanged; the A7 evidence, classification, gate, case and prerequisite tables hold exactly the rows they held')
  const dtoKeys = [...deepKeys([(await historyOf(W)).body, (await dispositionOf(W)).body, (await historyOf(RT)).body, (await dispositionOf(RT)).body])]
  const allCodes87 = [...resolutionEventCodes, ...requestReasonCodes, ...decisionCodes, ...returnReasonCodes, ...resolutionStates]
  const paymentRoutes = await Promise.all([post(`/api/claims/${W.claimId}/payments`, {}), post(`${base(W)}/remittance`, {}), post(`${base(W)}/adjudication`, {}), post(`${base(W)}/send`, {})])
  check(
    'T106',
    'No payer or financial assertions',
    !COLUMNS.some((c) => /payer|payment|remit|adjudic|denial|amount|currency|outcome/.test(c)) && !dtoKeys.some((k) => /payer|payment|remit|adjudic|denial|amount|currency|outcome|financial/i.test(k)) &&
      !allCodes87.some((c) => /PAID|DENI|PAYMENT|PAYER|REMIT|ADJUDIC|SETTL|WRITE_OFF|REFUND|ACKNOWLEDG/.test(c)) && paymentRoutes.every((r) => r.status === 404),
    'no payer, payment, remittance, adjudication, denial, amount or outcome column, key or code; no payment, remittance, adjudication or send route; RESOLVED_INTERNAL is not a payer acknowledgement',
  )
  check(
    'T107',
    'No DRG or coding release activation',
    ownerSnapshotNow.coding === ownerSnapshotBefore.coding && untouched(['backend/src/modules/coding-release', 'backend/src/modules/coding-validation']) &&
      !/coding-release|codingRelease|coding-validation|codingValidation|crg_|code_system|procedure-code|diagnosis-code|drg|tariff/i.test(moduleCode) && !COLUMNS.some((c) => /drg|code_system|release|tariff/.test(c)),
    "every CRG-01 coding-release and validation table and the A2 code masters hold exactly the rows they held; the CRG modules are unchanged; the module reads no coding, DRG or tariff owner",
  )
  const inserts = [...moduleCode.matchAll(/INSERT INTO "?([a-z_]+)"?/g)].map((m) => m[1])
  const executeRoutes = await Promise.all(['execute', 'apply', 'correct', 'patch-claim', 'encounter-correction', 'claim-correction'].map((p) => post(`${base(W)}/${p}`, {})))
  check(
    'T108',
    'No execution or claim correction',
    ownerSnapshotNow.claims === ownerSnapshotBefore.claims && ownerSnapshotNow.encounters === ownerSnapshotBefore.encounters && same(inserts, [TABLE]) &&
      !/UPDATE "|DELETE FROM|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\.create\(|\.createMany\(/.test(moduleCode) && executeRoutes.every((r) => r.status === 404),
    "every run Claim and Encounter row is byte-identical; the module's only write is its own append-only INSERT (and the audit through its owner) — no UPDATE, DELETE or other create; no execute, apply or correct route",
  )
  const tablesAt = (ref: string) => new Set(migrationDirsAt(ref).flatMap((dir) => [...gitArgs(['show', `${ref}:${dir}/migration.sql`]).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])))
  const mainTables = tablesAt(ownBase)
  const a87Tables = [...committedText(MIGRATION).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
  // Tables that existed on main belong to earlier phases; only what this branch adds is judged. Later phases' tables are
  // those created by migrations committed after A8.7's own merge (none on its own branch).
  const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])) : [])
  const newTablesLike = async (pattern: string) => (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`, pattern)).map((r) => r.t).filter((t) => !mainTables.has(t) && !laterPhaseTables.has(t))
  const workflow = await Promise.all(['close', 'closure', 'escalate', 'sla', 'queue', 'complete', 'reopen'].map((p) => post(`${base(W)}/${p}`, {})))
  const searches = await Promise.all(['/api/exception-resolution', '/api/resolution-events', '/api/resolution-queue', `/api/organizations/${org}/resolution-events`, `/api/claims/${W.claimId}/resolution-events`].map((p) => get(p)))
  check(
    'T109',
    'No SLA/queue/escalation/closure',
    workflow.every((r) => r.status === 404) && searches.every((r) => r.status === 404) && same(a87Tables, [TABLE]) && mainTables.size > 50 && (await newTablesLike('(closure|escalat|sla|deadline|due_|queue|outbox|_job)')).length === 0 &&
      (moduleCode.match(/findMany\(/g) ?? []).length === 1 && /findMany\(\{ where: \{ exceptionIntakeId \}/.test(moduleCode) && !COLUMNS.some((c) => /sla|deadline|due|queue|clos|escal/.test(c)) &&
      !allCodes87.some((c) => /SLA|DEADLINE|QUEUE|OVERDUE|CLOSE|ESCALAT|REOPEN/.test(c)),
    `no close, escalate, SLA, queue, complete or reopen route, no organization-wide list or search, table, column or code; the A8.7 migration creates exactly ${TABLE} and the module's one list read is one intake's events`,
  )
  const storedText = JSON.stringify(await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${TABLE} WHERE claim_id = ANY($1::uuid[])`, runClaims), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  const dtoText = JSON.stringify([(await historyOf(W)).body, (await dispositionOf(W)).body, (await historyOf(RT)).body, (await dispositionOf(Q)).body])
  const repositoryCode = committedCode(`${MODULE_DIR}/exception-resolution.repository.ts`)
  check(
    'T110',
    'No browser storage, transport, logs or PHI',
    !COLUMNS.some((c) => /patient|name|birth|email|phone|address|diagnos|clinician|encounter|amount|currency|payer|narrative|note|text|payload|hash|digest|status|current|latest/.test(c)) &&
      !dtoKeys.some((k) => /patient|name|birth|email|diagnos|clinician|encounter|amount|currency|payer|narrative|note|payload|hash|digest/i.test(k)) &&
      ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), key('home-PA'), 'AED', '125.25', '12.125', M1.email, DR.email, 'Synthetic member', 'Synthetic finding.'].some((value) => storedText.includes(value) || dtoText.includes(value) || auditText.includes(value)) &&
      !/from 'node:(http|https|net|tls|dgram|fs|child_process)'|\bfetch\(|axios|console\.|logger\.|process\.stdout|enqueue|setInterval|worker_threads|cron/.test(moduleCode) &&
      !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|setInterval|setTimeout|navigator\.sendBeacon|WebSocket|EventSource/.test(feCode) && !/method: '(POST|PUT|PATCH|DELETE)'/.test(feCode) &&
      /orderBy: \{ sequence: 'asc' \}/.test(repositoryCode) && !/findFirst\(/.test(moduleCode),
    'no patient, member contact, clinical, diagnosis, amount, currency, payer, narrative, payload, digest or status column or DTO key, and no such value in any stored event, answer or audit; the module logs nothing and opens no network, file or queue; the page only reads, stores nothing and logs nothing; events are read in their server-owned sequence only',
  )

  // ---------------------------------------------------------------- backward regressions (T111–T120)
  section('Backward regressions — A8.6 invoked, nesting A8.5 -> A8.3 -> A8.2 -> A8.1 -> A7.10 -> … -> A7.1 -> A6.10 -> … -> A5 -> A1')
  await apiReady('the A8.6 and backward regression chain')
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const goldenNow = async () => {
    const history = (await historyOf(W)).body
    return {
      history: withoutEvaluatedAt(history),
      disposition: withoutEvaluatedAt((await dispositionOf(W)).body),
      audits: JSON.stringify(await Promise.all(history.items.map(async (e: any) => (await auditsOfEvent(e.resolutionEventId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))))),
      rows: await rowsHash(runIntakes.map((k) => k.intakeId)),
    }
  }
  const goldenBefore = await goldenNow()
  const chain = run('npm run test:a8:remediation-work')
  const nestedLog = `a87-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A8.6')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A8.6] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A8.6 asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD, its own two runs) and re-proves
  // A8.5's branch-only causes against its own branch. On A8.7 those statements are obsolete by design; every other A8.6
  // check is substantive. T120 below proves each cause independently on this branch, down to A7.9.
  const a86NonApplicable: Record<string, string> = {
    T001: "A8.6 'A8.5 exact accepted merge is ancestor; clean main' requires the A8.6 feature branch name; A8.7 is cut from the main that contains A8.5, Checkpoint B and A8.6 (T001 and T002 here)",
    T003: "A8.6 'Clean tracked tree; HEAD matches remote branch' requires the A8.6 feature branch; THIS branch's clean tree and parity are proved by T004 and T129 here",
    T010: "A8.6 'Diff allowlist A8.6 only; no A9/CRG-B change' lists the paths A8.6 was allowed to change; A8.7 legitimately changes its own (T010 here)",
    T110: "A8.6 'No substantive failure relabeled N/A' proves A8.5's branch-only causes against the A8.6 branch; here every one is re-proved on this branch, down to A7.9 (T120)",
    T127: "A8.6 'Git status clean; remote parity exact' compares HEAD with origin/feature/a8-6-…; THIS branch's parity is proved by T004 and T129 here",
    T129: "A8.6 'Second independent run at same exact HEAD' is the identity of A8.6's own two submitted runs; THIS run's identity is proved by T128 and T129 here",
  }
  const undocumented = failing.filter((id) => !(id in a86NonApplicable))
  const summary = chain.output.match(/\[A8\.6\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.6\] RUN ABORTED|\[A8\.6\] uncaught error|\[A8\.6\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const a86Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  check(
    'T111',
    'A8.6 substantive nested checks pass',
    ran && reconciled && undocumented.length === 0 && a86Passing === 130 - failing.length && a86Passing >= 124 &&
      ['T002', 'T004', 'T005', 'T006', 'T007', 'T008', 'T009', 'T011', 'T051', 'T059', 'T061', 'T071', 'T081', 'T091', 'T092', 'T109', 'T111', 'T112', 'T113', 'T114', 'T117', 'T118', 'T119', 'T120', 'T124', 'T128', 'T130'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A8.6 suite did not complete'
      : !reconciled
        ? `A8.6 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A8.6 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A8\.6\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A8.6] automated summary: ', 'A8.6 ')}; all ${a86Passing} substantive checks PASS (its own-scope T004/T007/T009, its RESTRICT-aware T051/T059 and later-phase-aware T092 included) and every failure is documented`,
  )
  check('T112', 'A8.5 substantive nested checks pass', verdictOf('T101') === 'PASS', `A8.6 T101 (A8.5, with its own documented branch-only items) ${verdictOf('T101')}`)
  check('T113', 'A8.3 substantive nested checks pass', verdictOf('T103') === 'PASS', `A8.6 T103 (A8.3) ${verdictOf('T103')}`)
  check('T114', 'A8.2 substantive nested checks pass', verdictOf('T104') === 'PASS', `A8.6 T104 (A8.2 and A8.1) ${verdictOf('T104')}`)
  check('T115', 'A8.1 substantive nested checks pass', ['T104', 'T102'].every((id) => verdictOf(id) === 'PASS') && a84Paths.length === 0, `A8.6 T104 (A8.2 and A8.1) ${verdictOf('T104')} and T102 (the A8.4 closure) ${verdictOf('T102')}`)
  check('T116', 'A7.1–A7.10 substantive chain pass', verdictOf('T105') === 'PASS', `A8.6 T105 (A7.10 and A7.1–A7.9) ${verdictOf('T105')}`)
  check('T117', 'A6.1–A6.10 substantive chain pass', verdictOf('T106') === 'PASS', `A8.6 T106 (A6.10, which nests A6.9 → A6.1) ${verdictOf('T106')}`)
  check('T118', 'A5.1–A5.10 substantive chain pass', verdictOf('T107') === 'PASS', `A8.6 T107 (the chain reaching A5.10 → A5.1) ${verdictOf('T107')}`)
  const a3Scope = run('npm run test:a3:scope')
  check('T119', 'A1–A4 owners pass', verdictOf('T108') === 'PASS' && a3Scope.ok, `A8.6 T108 (A4 → A1, A3 included, and A2) ${verdictOf('T108')}; the A3.9 scope suite over this branch's files ${a3Scope.ok ? 'PASS' : 'FAIL'}`)
  let naPrinted = 0
  for (const id of Object.keys(a86NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) {
      notApplicableCheck(`T120/${id}`, `A8.6 ${titleOf(row.line)}`, a86NonApplicable[id])
      naPrinted += 1
    }
  }
  // Each documented failure must fail for its branch-only cause, proved independently on this branch from its own line
  // and this branch's state, all the way down: A8.6 T110's A8.5 items, A8.5 T110's A8.3 items, A8.3 T119's A8.2 items,
  // A8.2 T120's A8.1 items, A8.1 T110's A7.10 items and A7.10 T111's A7.9 items, down to A7.9 T120's A7.8 items. A depth
  // may fail only with its documented branch-only items, each exactly once; every item its aggregator names must fail at
  // the next depth.
  const headSha = git('rev-parse HEAD')
  const originHead = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a87Branch}`])
  const shortMainDefault = git('rev-parse --short origin/main')
  const thisBranchClean = (line: string) => line.includes(`## ${a87Branch}...origin/${a87Branch}`) && !/ahead|behind/.test(line.split(`## ${a87Branch}...origin/${a87Branch}`)[1]?.split(';')[0] ?? 'ahead')
  const NESTED_BRANCH_ONLY: { tag: string; aggregator: string; ids: string[] }[] = [
    { tag: 'A8.5', aggregator: 'T110', ids: ['T001', 'T003', 'T010', 'T110', 'T127', 'T129'] },
    { tag: 'A8.3', aggregator: 'T119', ids: ['T001', 'T002', 'T010', 'T119', 'T130'] },
    { tag: 'A8.2', aggregator: 'T120', ids: ['T001', 'T002', 'T010', 'T120', 'T130'] },
    { tag: 'A8.1', aggregator: 'T110', ids: ['T001', 'T002', 'T010', 'T110', 'T130'] },
    { tag: 'A7.10', aggregator: 'T111', ids: ['T001', 'T002', 'T010', 'T111', 'T122', 'T123', 'T130'] },
    { tag: 'A7.9', aggregator: 'T120', ids: ['T001', 'T002', 'T010', 'T120', 'T130'] },
  ]
  const A78_BRANCH_ONLY = ['T001', 'T002', 'T010', 'T120', 'T130']
  const escapeTag = (tag: string) => tag.replace(/[.-]/g, (c) => `\\${c}`)
  const nestedFails = (depth: number) => {
    const pattern = new RegExp(`^\\[A8\\.6\\] +${NESTED_BRANCH_ONLY.slice(0, depth + 1).map((d) => `nested: \\[${escapeTag(d.tag)}\\] +`).join('')}(T\\d{3}) .* \\.{3,} FAIL - (.*)$`)
    return chain.output.split(/\r?\n/).map((line) => line.match(pattern)).filter((m): m is RegExpMatchArray => m !== null).map((m) => ({ id: m[1], detail: m[2] }))
  }
  const listAfter = (text: string, label: RegExp) => ((text.match(label) ?? ['', ''])[1] ?? '').split(', ').map((s) => s.trim()).filter(Boolean)
  const detailOf = (line: string) => (line.match(/ \.{3,} FAIL - (.*)$/) ?? ['', ''])[1]
  // A nested line is cut at a fixed width, so only its last listed path may be a prefix.
  const pathsInScope = (paths: string[]) => paths.length > 0 && paths.every((p, i) => changedPaths.includes(p) || (i === paths.length - 1 && changedPaths.some((c) => c.startsWith(p))))
  const nestedDepthProved = (depth: number, named: string[]): boolean => {
    const level = NESTED_BRANCH_ONLY[depth]
    const fails = nestedFails(depth)
    const ids = fails.map((f) => f.id)
    return fails.length > 0 && new Set(ids).size === ids.length && named.length > 0 && new Set(named).size === named.length && named.every((id) => ids.includes(id)) && ids.every((id) => level.ids.includes(id)) && fails.every((f) => nestedItemProved(depth, f.id, f.detail, fails.length))
  }
  const ancestorsNamed = (detail: string) => /\bas [0-9a-f]{7,40}\b/.test(detail) && [...detail.matchAll(/\bas ([0-9a-f]{7,40})\b/g)].every((m) => gitOk(`merge-base --is-ancestor ${m[1]} HEAD`))
  const nestedItemProved = (depth: number, id: string, detail: string, count: number): boolean => {
    const level = NESTED_BRANCH_ONLY[depth]
    if (id === level.aggregator) {
      const unproven = listAfter(detail, /^cause not proven for: (.*)$/)
      return depth === NESTED_BRANCH_ONLY.length - 1 ? unproven.length > 0 && new Set(unproven).size === unproven.length && unproven.every((x) => A78_BRANCH_ONLY.includes(x)) : nestedDepthProved(depth + 1, unproven)
    }
    if (id === 'T010') return outOfScope.length === 0 && pathsInScope(listAfter(detail, /^unexpected: (.*)$/))
    if (depth === 0) {
      // A8.5's own items: its base, its branch, its parity and its run identity, each naming THIS branch and HEAD.
      if (id === 'T001') return /^A8\.3 merged as [0-9a-f]{7} .*an ancestor/.test(detail) && detail.includes(`latest main ${shortMainDefault} contained`) && ancestorsNamed(detail)
      if (id === 'T003') return detail.startsWith(`branch ${a87Branch}; working tree clean;`) && thisBranchClean(detail)
      if (id === 'T127') return originHead === headSha && detail.includes(`HEAD ${headSha}`) && thisBranchClean(detail) && /the tree is clean after every check/.test(detail)
      if (id === 'T129') return originHead === headSha && detail.includes(`HEAD ${headSha.slice(0, 12)}`)
      return false
    }
    if (id === 'T001') return detail.startsWith(`branch ${a87Branch};`) && detail.includes(`latest main ${shortMain}`) && ancestorsNamed(detail)
    if (id === 'T002') return detail.startsWith('working tree clean;') && thisBranchClean(detail)
    // T122, T123 and T130 are the identity of the historical branch's own runs: here they name THIS exact pushed HEAD.
    const counted = detail.match(/^(\d+) of the 129 checks before this one PASS, (\d+) FAIL/)
    return originHead === headSha && (detail.includes(headSha) || thisBranchClean(detail)) && (!counted || (Number(counted[2]) === count - 1 && Number(counted[1]) === 129 - (count - 1)))
  }
  const a86Line = (id: string) => rows.find((r) => r.id === id && r.verdict === 'FAIL')?.line ?? ''
  const causes: Record<string, () => boolean> = {
    T001: () => /A8\.5 merged as [0-9a-f]{7} /.test(a86Line('T001')) && a86Line('T001').includes(`latest main ${shortMainDefault} contained`) && gitOk(`merge-base --is-ancestor ${A85_MERGE} HEAD`) && gitOk(`merge-base --is-ancestor ${A86_MERGE} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    T003: () => a86Line('T003').includes(`branch ${a87Branch}`) && a86Line('T003').includes('working tree clean') && thisBranchClean(a86Line('T003')),
    T010: () => outOfScope.length === 0 && pathsInScope(listAfter(detailOf(a86Line('T010')), /^unexpected: (.*)$/)),
    T110: () => originHead === headSha && nestedDepthProved(0, listAfter(detailOf(a86Line('T110')), /^cause not proven for: (.*)$/)),
    T127: () => a86Line('T127').includes(`HEAD ${headSha}`) && thisBranchClean(a86Line('T127')) && /the tree is clean after every check/.test(a86Line('T127')),
    T129: () => originHead === headSha && a86Line('T129').includes(`HEAD ${headSha.slice(0, 12)}`),
  }
  const unprovenHere = failing.filter((id) => !(id in causes) || !causes[id]())
  // Every original nested FAIL result is kept verbatim with its N/A category. An N/A may only be a BRANCH item (branch
  // name or base ancestry), a HEAD item (clean tree, origin parity, or a run's own identity at its exact HEAD), a SCOPE
  // item (the paths that package was allowed to change) or an AGGREGATE item (a suite's own "every branch-only N/A
  // justified" check, whose items are each re-proved above). Any other kind fails T120.
  type Category = 'BRANCH' | 'HEAD' | 'SCOPE' | 'AGGREGATE'
  const ownLevelCategory: Record<string, Category> = { T001: 'BRANCH', T003: 'BRANCH', T010: 'SCOPE', T110: 'AGGREGATE', T127: 'HEAD', T129: 'HEAD' }
  const categoryOf = (tags: string[], id: string): Category | null => {
    if (tags.length === 0) return ownLevelCategory[id] ?? null
    if (tags.length > NESTED_BRANCH_ONLY.length || tags.some((tag, i) => tag !== NESTED_BRANCH_ONLY[i].tag)) return null
    const level = NESTED_BRANCH_ONLY[tags.length - 1]
    if (!level.ids.includes(id)) return null
    if (tags.length === 1) return ownLevelCategory[id] ?? null
    return id === 'T001' ? 'BRANCH' : id === 'T010' ? 'SCOPE' : id === level.aggregator ? 'AGGREGATE' : ['T002', 'T122', 'T123', 'T130'].includes(id) ? 'HEAD' : null
  }
  const nestedEvidence = chain.output
    .split(/\r?\n/)
    .map((line) => ({ line, m: line.match(/^\[([^\]]+)\]((?: +nested: \[[^\]]+\])*) +(\S+) .* \.{3,} FAIL - /) }))
    .filter((x): x is { line: string; m: RegExpMatchArray } => x.m !== null && x.m[1] === 'A8.6')
    .map(({ line, m }) => {
      const tags = [...m[2].matchAll(/nested: \[([^\]]+)\]/g)].map((t) => t[1])
      return { line, tags, id: m[3], category: categoryOf(tags, m[3]), reason: tags.length === 0 ? (a86NonApplicable[m[3]] ?? '') : '' }
    })
  const uncategorized = nestedEvidence.filter((e) => e.category === null)
  const evidenceLog = `a87-nested-evidence-${runId}.log`
  const evidenceText = [
    `A8.7 — nested regression evidence, run ${runId} at HEAD ${headSha}`,
    'Every original nested FAIL result, verbatim, with its N/A category (BRANCH | HEAD | SCOPE | AGGREGATE); a top-level item also carries its reason.',
    `The full nested output is kept in ${nestedLog}.`,
    '',
    ...nestedEvidence.flatMap((e) => [`[${e.category ?? 'UNCATEGORIZED'}] ${e.line}`, ...(e.reason ? [`    reason: ${e.reason}`] : [])]),
    '',
  ].join('\n')
  writeFileSync(evidenceLog, evidenceText)
  const categoryCounts = (['BRANCH', 'HEAD', 'SCOPE', 'AGGREGATE'] as Category[]).map((c) => `${nestedEvidence.filter((e) => e.category === c).length} ${c}`).join(', ')
  check(
    'T120',
    'Branch-only historical N/A individually proven',
    ran && undocumented.length === 0 && unprovenHere.length === 0 && failing.length > 0 && naPrinted === failing.length && failing.every((id) => a86NonApplicable[id].length > 80) && uncategorized.length === 0 &&
      failing.every((id) => nestedEvidence.some((e) => e.tags.length === 0 && e.id === id)) && existsSync(evidenceLog),
    undocumented.length > 0
      ? `undocumented A8.6 failures: ${undocumented.join(', ')}`
      : unprovenHere.length > 0
        ? `cause not proven for: ${unprovenHere.join(', ')}`
        : uncategorized.length > 0
          ? `not a branch, HEAD or scope item: ${uncategorized.map((e) => [...e.tags, e.id].join('>')).join(', ').slice(0, 300)}`
          : `each documented A8.6 failure (${failing.join(', ')}) is printed individually with its reason and fails only for its branch-only cause, proved on this branch from its own line — T110's A8.5 items re-proved at every depth down to A7.9; all ${nestedEvidence.length} original nested FAIL lines kept verbatim in backend/${evidenceLog} — ${categoryCounts}, no other kind`,
  )

  // ---------------------------------------------------------------- build and exact-head evidence (T121–T130)
  section('Build and exact-head evidence: units, typecheck, frontend lint and build, the replay and the constraint catalog, outage and recovery, no 5xx, the synthetic worked workflow, reviewer separation, two runs at the exact pushed HEAD, the handoff')
  const allUnit = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  check('T121', 'Unit suite and backend typecheck pass', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && typecheck.ok, `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 11 A8.7 reducer and request tests; backend typecheck clean, including this harness`)
  const lint = run('npm run lint --prefix ../frontend')
  const build = run('npm run build --prefix ../frontend')
  check('T122', 'Frontend lint/build pass', lint.ok && build.ok, `frontend lint clean; ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = applied.filter((row) => {
    const blob = committedBlob(`backend/prisma/migrations/${row.name}/migration.sql`)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  const restrictLines = (replay.output.match(/PASS {2}exception_resolution_events_\w+_fkey is present after a clean replay/g) ?? []).length
  const catalog = {
    indexes: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT indexname AS n FROM pg_indexes WHERE tablename = '${TABLE}' ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    checks: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT conname AS n FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND contype = 'c' ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    triggers: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT tgname AS n FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND NOT tgisinternal ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    foreignKeys: (await fksOf(TABLE)).map((r) => `${r.name.replace(`${TABLE}_`, '')}:${r.del === 'r' ? 'RESTRICT' : r.del}`),
  }
  const generatedAgain = run('npm run db:generate')
  check(
    'T123',
    'Migration replay constraints truth pass',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && restrictLines === 7 && /PASS {2}exception_resolution_events_append_only_trg is present/.test(replay.output) &&
      /PASS {2}exception_resolution_events_no_truncate_trg is present/.test(replay.output) && /PASS {2}exception_resolution_events_shape_chk is present/.test(replay.output) &&
      status.ok && /Database schema is up to date/.test(status.output) && applied.length === headMigrationDirs.length && same(applied.map((r) => r.name), headMigrationDirs.map((d) => d.split('/').pop())) &&
      checksumMismatch.length === 0 && generatedAgain.ok && git('status --porcelain') === '' &&
      same(catalog.indexes, ['claim_id_idx', 'organization_id_idx', 'pkey', 'recorded_by_membership_id_idx', 'recorded_by_user_id_idx', 'request_event_id_key', 'sequence_key', 'verification_event_id_idx']) &&
      same(catalog.checks, ['contract_chk', 'event_code_chk', 'sequence_chk', 'shape_chk']) && same(catalog.triggers, ['append_only_trg', 'insert_guard_trg', 'no_truncate_trg']) && catalog.foreignKeys.length === 7 &&
      catalog.foreignKeys.every((fk) => fk.endsWith(':RESTRICT')),
    `scratch replay from empty: ${appliedCount} migrations, ALL CHECKS PASS, all ${restrictLines} RESTRICT keys and every trigger and CHECK survive; exactly the ${headMigrationDirs.length} committed migrations are applied, in order, each with its committed checksum; live catalog — indexes ${catalog.indexes.join(', ')}; CHECKs ${catalog.checks.join(', ')}; triggers ${catalog.triggers.join(', ')}; keys ${catalog.foreignKeys.join(', ')}`,
  )
  const agree = async (k: Intake) => {
    const items = (await historyOf(k)).body.items as any[]
    const d = (await dispositionOf(k)).body
    const last = items[items.length - 1]
    return d.eventCount === items.length && d.lastSequence === (last?.sequence ?? null) &&
      (last?.eventCode === 'REQUEST_INTERNAL_RESOLUTION' ? d.request?.resolutionEventId === last.resolutionEventId && d.decision === null : last ? d.decision?.resolutionEventId === last.resolutionEventId : d.state === 'NO_RESOLUTION_REQUEST')
  }
  const agreeAll = async () => (await Promise.all([W, RT, N, AW, U, UR, S, J, AT, R, K, G, Q, H].map(agree))).every(Boolean)
  const rowsBeforeOutage = await rowsHash(runIntakes.map((k) => k.intakeId))
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
  check(
    'T124',
    'Database outage/ready recovery truthful',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered && (await rowsHash(runIntakes.map((k) => k.intakeId))) === rowsBeforeOutage && (await agreeAll()),
    "up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200; every resolution row of this run hashes exactly as before the outage and history and disposition agree for every intake after the restart",
  )
  // No pg "client.query() while already executing" deprecation in this process or in any process of the nested chain
  // (its output carries each suite's stderr).
  const nestedDriverWarnings = (chain.output.match(/Calling client\.query\(\) when the client is already executing a query/g) ?? []).length
  check(
    'T125',
    'No unexpected HTTP 5xx',
    serverErrors === 0 && connectionResets === 0 && driverWarnings.length === 0 && nestedDriverWarnings === 0,
    `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run; ${driverWarnings.length + nestedDriverWarnings} pg client.query() deprecation warnings in this process and the nested chain`,
  )
  const runEventMembers = await prisma.$queryRawUnsafe<{ org: string; member: string | null }[]>(
    `SELECT e.organization_id::text AS org, u.email AS member FROM ${TABLE} e JOIN organization_memberships m ON m.id = e.recorded_by_membership_id JOIN "user" u ON u.id = m.user_id WHERE e.recorded_at >= $1::timestamptz AND e.recorded_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  const goldenAfter = await goldenNow()
  const finalHistory = (await historyOf(W)).body
  progress(
    `worked resolution: Claim W ${W.claimId}, intake ${W.intakeId} (A8.2 classify → assign M1; A8.3 link → finding; A8.5 REQUEST_INTERNAL_DOCUMENTATION_CHECK by M1 → APPROVE_PROPOSAL by RV; A8.6 DOCUMENTATION_CHECK_REPORTED by M1 → EVIDENCE_SUPPORTED by VR): request VERIFIED_INTERNAL_WORK by M1 → CONFIRM_INTERNAL_RESOLUTION by DR; RESOLVED_INTERNAL (internal only), 2 events, 2 audits; nothing executed, corrected, closed or paid`,
  )
  check(
    'T126',
    'Synthetic-only fixtures and example',
    W.status === 201 && W_CLASSIFY.sequence === 1 && W_ASSIGN.sequence === 2 && IW.statuses.every((s) => s === 201) && same(PW.statuses, [201, 201]) && same(WW.statuses, [201, 201]) && [RQW, DCW].every((r) => r.status === 201) &&
      same(finalHistory.items.map((e: any) => [e.sequence, e.eventCode, e.decisionCode, e.recordedByMembershipId]), [[1, 'REQUEST_INTERNAL_RESOLUTION', null, M1.membershipId], [2, 'DECIDE_INTERNAL_RESOLUTION', 'CONFIRM_INTERNAL_RESOLUTION', DR.membershipId]]) &&
      same(goldenAfter, goldenBefore) && runEventMembers.length >= 12 && runEventMembers.every((e) => e.org === org && /@reviewers\.sbn\.test$/.test(e.member ?? '')) && (await eventsOf(F.intakeId)).length === 0 &&
      (await snap()).claims === ownerSnapshotBefore.claims,
    `W was built entirely through its owners' routes — A6 Claim frozen twice, A8.1 intake, A8.2 classify and assign to M1, A8.3 link and finding, A8.5 proposal by M1 and approval by RV, A8.6 report by M1 and verification by VR — then requested by M1 and confirmed by DR; after the nested chain its history, disposition, audits and every run row read back identically; all ${runEventMembers.length} resolution events this run belong to the synthetic Org A and were recorded by synthetic members only; Org B's intake has none and no Claim changed`,
  )
  const wAudits = await Promise.all([RQW_ID, DCW_ID].map(async (id) => (await auditsOfEvent(id))[0]))
  const rtAudits = await Promise.all([RQRT_ID, RTD_ID].map(async (id) => (await auditsOfEvent(id))[0]))
  check(
    'T127',
    'Reviewer separation proven DB and service',
    wAudits[0]?.actorUserId === M1.id && wAudits[1]?.actorUserId === DR.id && (wAudits[0]?.afterState as any)?.recordedByMembershipId === M1.membershipId && (wAudits[1]?.afterState as any)?.recordedByMembershipId === DR.membershipId &&
      (wAudits[1]?.afterState as any)?.requestEventId === RQW_ID && rtAudits[0]?.actorUserId === M4.id && rtAudits[1]?.actorUserId === VR.id && (rtAudits[1]?.afterState as any)?.returnReasonCode === 'SOURCE_INTEGRITY_CONCERN' &&
      selfService.ok === false && selfRoute.status === 409 && selfDirect.sameMember.refused && selfDirect.otherMembership.refused && selfPlanted.value?.history.ok === false,
    "W's request audit names M1 and its confirmation DR (different user and membership, naming the exact request); RT's request names M4 and its return VR with its reason; self-review is refused by the service and route (T027, T053) and by the database guard and the read (T065)",
  )
  const headNow = git('rev-parse HEAD')
  const checksBefore128 = passed + failed
  const earlierRuns = readdirSync('.')
    .filter((name) => /^a87-nested-A87-\d{13}\.log$/.test(name) && name !== nestedLog)
    .filter((name) => readFileSync(name, 'utf8').includes(`[A8.6] HEAD ${headNow}`))
    .map((name) => name.replace(/^a87-nested-|\.log$/g, ''))
  const runIntakeIds = new Set(runIntakes.map((k) => k.intakeId))
  check(
    'T128',
    'Two independent 130/130 runs exact HEAD',
    checksBefore128 === 127 && /^A87-\d{13}$/.test(runId) && !earlierRuns.includes(runId) && headNow === headAtStart && headNow === originHead && runEventsSoFar.every((e) => runIntakeIds.has(e.exceptionIntakeId)) &&
      runEventMembers.every((e) => /@reviewers\.sbn\.test$/.test(e.member ?? '')),
    `run ${runId} at ${headNow}: all 127 checks before this one executed (${passed} PASS) with fixtures and members it created itself; ${earlierRuns.length > 0 ? `earlier kept run(s) at this HEAD: ${earlierRuns.join(', ')}` : 'no earlier run at this HEAD is kept here, so this is the first'}; the two submitted runs must both state HEAD ${headNow.slice(0, 12)} with different runIds`,
  )
  check(
    'T129',
    'Clean remote HEAD, full logs and hashes',
    headNow === headAtStart && headNow === originHead && headNow.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a87Branch}`) && !/ahead|behind/.test(tracking) && outOfScope.length === 0 &&
      existsSync(nestedLog) && existsSync(evidenceLog),
    `HEAD ${headNow} = origin/${a87Branch}; ${tracking}; the tree is clean after every check (the nested logs are ignored output); nested output kept in backend/${nestedLog} (SHA-256 ${sha256Of(Buffer.from(chain.output))}), nested evidence in backend/${evidenceLog} (SHA-256 ${sha256Of(Buffer.from(evidenceText))})`,
  )
  const typesText = committedText(`${MODULE_DIR}/exception-resolution.types.ts`)
  const vocabulary = [...resolutionEventCodes, ...requestReasonCodes, ...decisionCodes, ...returnReasonCodes, ...resolutionStates, CONTRACT]
  check(
    'T130',
    'Owner handoff: no execution, closure or A9',
    registerFlat.includes('## Out of scope (handoff)') && registerFlat.includes('executing any A8.5 action') && registerFlat.includes('broader exception closure') && registerFlat.includes('internal decision only') &&
      registerFlat.includes('RETURNED_FOR_REWORK` is terminal in v1') && registerFlat.includes('all five upstream read permissions') && registerFlat.includes('A9') &&
      registerAtHead.includes(A85_MERGE) && registerAtHead.includes(A86_MERGE) && registerAtHead.includes(`(${CONTRACT})`) && vocabulary.every((code) => registerAtHead.includes(`\`${code}\``) && typesText.includes(`'${code}'`)) &&
      ['getExceptionIntakesOf', 'getTriageDispositionOf', 'getInvestigationHistoryOf', 'getRemediationDispositionOf', 'getWorkDispositionOf', 'getWorkHistoryOf', 'assigneeCurrentlyEligible', 'getResolutionDispositionOf'].every((t) => registerAtHead.includes(t)),
    `the register records the start gate (A8.5 merge ${A85_MERGE.slice(0, 7)}, A8.6 merge ${A86_MERGE.slice(0, 7)} = main at start), both architecture-owner corrections, the owner readers, ${CONTRACT} and all ${vocabulary.length} controlled codes (each identical in the module), RESOLVED_INTERNAL as an internal decision only, and execution, rework, closure, CRG activation and A9 as later, separately approved work`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] EXCEPTION RESOLUTION ACCEPTANCE COMPLETE` : `[${TAG}] A8.7 FINAL FAIL`)
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
    // The synthetic partial role of this run exists only for the five-permission proof; if a run stopped inside it,
    // it is removed here so no later check ever sees it.
    try {
      const leftover = await prisma.role.findMany({ where: { code: { startsWith: 'SYNTHETIC_A87_' } }, select: { id: true } })
      for (const role of leftover) {
        await prisma.membershipRole.deleteMany({ where: { roleId: role.id } })
        await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
        await prisma.role.delete({ where: { id: role.id } })
      }
    } catch {
      // the database may be unreachable; the next run removes it before anything else
    }
    await prisma.$disconnect()
  })
