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
import { recordResolutionEvent } from '../../modules/exception-resolution/exception-resolution.service.ts'
import { WORK_CODE_OF_ACTION } from '../../modules/exception-remediation-work/exception-remediation-work.types.ts'
import { deriveEscalation } from '../../modules/exception-escalation/exception-escalation.reducer.ts'
import { getEscalationDispositionOf, getEscalationHistoryOf, recordEscalationEvent, recordEscalationEventOn } from '../../modules/exception-escalation/exception-escalation.service.ts'
import {
  ESCALATION_CONTRACT_VERSION,
  PARENT_READ_PERMISSIONS,
  escalationEventCodes,
  escalationReasonCodes,
  escalationStates,
  followupCodes,
  returnReasonCodes,
  sourceEventKinds,
} from '../../modules/exception-escalation/exception-escalation.types.ts'

// A8.8 — focused acceptance for Exception Escalation & Follow-up Governance (A8-ESCALATION-1, T001–T130).
//
// Every Claim, freeze, A8.1 intake, A8.2 triage event, A8.3 investigation event, A8.5 remediation event, A8.6 work event
// and A8.7 resolution event is built through its owners exactly as the A8.7 suite builds them: a Claim frozen twice
// without an A6.9 link is a genuine history contradiction, its intake is recorded through the A8.1 route, classified and
// assigned through the A8.2 route, its assignee links the intake basis and records a finding through the A8.3 route,
// proposes an action through the A8.5 route and an independent reviewer approves it there, reports the work through the
// A8.6 route and an independent verifier verifies it there, and (where an intake needs an A8.7 state) requests an
// internal resolution through the A8.7 route that an independent decider confirms or returns there. Every escalation
// event is recorded through the A8.8 route by the escalator, the nominated member or an independent reviewer or, where a
// probe must pause or fail one writer, through the production A8.8 service in this process. Direct SQL writes are
// adversarial only, run against the live guards (or, to isolate one CHECK, with the triggers off), and are ALWAYS rolled
// back; a broken stored history is planted only inside such a transaction and the production reads answer on THAT
// transaction. Synthetic users are provisioned per run through Better Auth's own server-side creation with a random
// password that is never printed; one synthetic role, created and removed again by this run, proves each of the six
// upstream read permissions on its own. Escalation is an internal handoff only: nothing in this suite expects, or finds,
// anything resolved, closed, reassigned, executed, corrected or paid.

const TAG = 'A8.8'
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

const runId = `A88-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a88Branch = 'feature/a8-8-exception-escalation-followup'
const a87Branch = 'feature/a8-7-internal-exception-resolution'
const a86Branch = 'feature/a8-6-remediation-work-verification'
const a85Branch = 'feature/a8-5-exception-remediation'
const crgbBranch = 'feature/crg-01b-coding-validation-freeze'
const crgBranch = 'fix/crg-01-final-coding-release'
// The accepted A8.5, Checkpoint B, A8.6 and A8.7 merges and the clean main this branch was cut from, all recorded in
// the register (start gate). A8.7's merge holds exactly the tree of its accepted HEAD.
const A85_MERGE = '0f8f9d3bc18347b1360b72b93056724b594a6e00'
const CRGB_MERGE = '4869df3c81ac4af5dcec988768666f7acd3d809e'
const A86_MERGE = '18de6c81f9f47374d011cfe9a688b500b8c17beb'
const A87_MERGE = '8af18916428bf173d87c33653ed8350c75c1edcb'
const A87_ACCEPTED_HEAD = '194430b10df41148774d380625772b15cc218577'
const MAIN_AT_START = A87_MERGE
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/exception-escalation'
const FE_DIR = 'frontend/src/modules/exception-escalation'
const HARNESS_DIR = 'backend/src/integration/a8-exception-escalation'
const REGISTER_DOC = 'docs/A8_Exception_Escalation.md'
const MIGRATION_NAME = '20261111090000_a8_8_exception_escalation'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const A87_MIGRATION = 'backend/prisma/migrations/20261110090000_a8_7_exception_resolution/migration.sql'
const A86_MIGRATION = 'backend/prisma/migrations/20261107090000_a8_6_exception_remediation_work/migration.sql'
const A85_MIGRATION = 'backend/prisma/migrations/20261105090000_a8_5_exception_remediation/migration.sql'
const A83_MIGRATION = 'backend/prisma/migrations/20261103090000_a8_3_exception_investigation/migration.sql'
// The one earlier suite this package corrects (at the head developer's decision, in this PR): A6.10's T087 judges every
// column that existed when A6.10 merged exactly as before, and leaves a later phase's own columns to that phase.
const A610_SUITE = 'backend/src/integration/a6-phase-closure/a6-phase-closure.integration.ts'
const TABLE = 'exception_escalation_events'
const RESOLUTION_TABLE = 'exception_resolution_events'
const WORK_TABLE = 'exception_remediation_work_events'
const REMEDIATION_TABLE = 'exception_remediation_events'
const INVESTIGATION_TABLE = 'exception_investigation_events'
const TRIAGE_TABLE = 'exception_triage_events'
const INTAKE_TABLE = 'exception_intake_records'
const UNIT_TESTS = [`${MODULE_DIR}/exception-escalation.reducer.test.ts`, `${MODULE_DIR}/exception-escalation.validation.test.ts`]
const CONTRACT = 'A8-ESCALATION-1'
const INTAKE_CONTRACT = 'A8-EXCEPTION-INTAKE-1'
const TIMELINE_CONTRACT = 'A7-REVENUE-TIMELINE-1'
const SIX_READS = ['exceptionIntake.read', 'exceptionTriage.read', 'exceptionInvestigation.read', 'exceptionRemediation.read', 'exceptionRemediationWork.read', 'exceptionResolution.read']
const EVENT_KEYS = [
  'escalationEventId', 'contractVersion', 'exceptionIntakeId', 'organizationId', 'claimId', 'sequence', 'eventCode', 'reasonCode', 'targetMemberId', 'referencedEscalationEventId',
  'acknowledgementEventId', 'followupCode', 'sourceEventId', 'sourceEventKind', 'returnReasonCode', 'recordedByMembershipId', 'recordedByUserId', 'recordedAt',
]
const HISTORY_KEYS = ['contractVersion', 'exceptionIntakeId', 'items', 'evaluatedAt']
const DISPOSITION_KEYS = ['contractVersion', 'exceptionIntakeId', 'state', 'escalation', 'acknowledgement', 'followups', 'returned', 'eventCount', 'lastSequence', 'evaluatedAt']
const ESCALATION_KEYS = ['escalationEventId', 'sequence', 'reasonCode', 'targetMemberId', 'escalatedByMembershipId', 'escalatedByUserId']
const ACK_KEYS = ['acknowledgementEventId', 'sequence', 'acknowledgedByMembershipId', 'acknowledgedByUserId']
const FOLLOWUP_KEYS = ['followupEventId', 'sequence', 'followupCode', 'sourceEventId', 'sourceEventKind', 'recordedByMembershipId', 'recordedByUserId']
const RETURN_KEYS = ['returnEventId', 'sequence', 'returnReasonCode', 'returnedByMembershipId', 'returnedByUserId']
const AUDIT_KEYS = [
  'escalationEventId', 'exceptionIntakeId', 'claimId', 'contractVersion', 'sequence', 'eventCode', 'reasonCode', 'targetMemberId', 'referencedEscalationEventId', 'acknowledgementEventId',
  'followupCode', 'sourceEventId', 'sourceEventKind', 'returnReasonCode', 'recordedByMembershipId', 'recordedAt',
]
const COLUMNS = [
  'id', 'exception_intake_id', 'organization_id', 'claim_id', 'contract_version', 'sequence', 'event_code', 'reason_code', 'target_member_id', 'escalation_event_id', 'acknowledgement_event_id',
  'followup_code', 'source_event_id', 'source_event_kind', 'return_reason_code', 'recorded_by_membership_id', 'recorded_by_user_id', 'recorded_at', 'created_at',
]
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/shared/authorization/authorization.types.ts',
  'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'backend/src/modules/audit/audit.types.ts', 'frontend/src/developer/checkRegistry.tsx', REGISTER_DOC,
]
// Every table an escalation write could conceivably touch, in a fixed key order. A read or a refusal must leave every
// one as it was; a recorded event adds exactly one row here and one audit.
const COUNT_TABLES = [
  TABLE, RESOLUTION_TABLE, WORK_TABLE, REMEDIATION_TABLE, INVESTIGATION_TABLE, TRIAGE_TABLE, INTAKE_TABLE, 'audit_events', 'claims', 'claim_freezes', 'claim_freeze_lifecycle_events',
  'claim_correction_links', 'organization_memberships', 'membership_roles',
]
// The CRG-01 coding-release and validation tables and the A2 code masters: no escalation event selects, activates,
// imports or changes any of them.
const CODING_TABLES = [
  'crg_code_system_datasets', 'crg_code_system_rights', 'crg_release_imports', 'crg_release_code_memberships', 'crg_retirement_classifications', 'crg_validation_scopes', 'crg_validation_code_receipts',
  'crg_validation_receipt_manifests', 'procedure_codes', 'diagnosis_codes',
]
// The A7 historical records: an escalation event writes none of them.
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

// The disposition replayed by THIS suite, independently of the module's reducer, from a history's items.
type HistoryItem = { escalationEventId: string; sequence: number; eventCode: string; targetMemberId: string | null; followupCode: string | null; sourceEventId: string | null; returnReasonCode: string | null }
function replayIndependently(items: HistoryItem[]) {
  let state = 'NO_ESCALATION'
  let escalationId: string | null = null
  let ackId: string | null = null
  let returnId: string | null = null
  const followupIds: string[] = []
  for (const item of items) {
    if (item.eventCode === 'ESCALATE_FOR_REVIEW') {
      escalationId = item.escalationEventId
      state = 'AWAITING_ACKNOWLEDGEMENT'
    } else if (item.eventCode === 'ACKNOWLEDGE_ESCALATION') {
      ackId = item.escalationEventId
      state = 'FOLLOWUP_ACTIVE'
    } else if (item.eventCode === 'RECORD_FOLLOWUP') {
      followupIds.push(item.escalationEventId)
    } else {
      returnId = item.escalationEventId
      state = 'RETURNED_TO_OWNER'
    }
  }
  return { state, escalationId, ackId, followupIds, returnId, eventCount: items.length, lastSequence: items.length > 0 ? items[items.length - 1].sequence : null }
}
const dispositionFacts = (d: any) => ({
  state: d?.state,
  escalationId: d?.escalation?.escalationEventId ?? null,
  ackId: d?.acknowledgement?.acknowledgementEventId ?? null,
  followupIds: (d?.followups ?? []).map((f: any) => f.followupEventId),
  returnId: d?.returned?.returnEventId ?? null,
  eventCount: d?.eventCount,
  lastSequence: d?.lastSequence,
})

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)
  // pg's concurrent-query deprecation, if it ever fires in this process (it is still printed); T127 requires none here
  // and none in any process of the nested chain.
  const driverWarnings: string[] = []
  process.on('warning', (warning) => {
    if (/Calling client\.query\(\) when the client is already executing a query/.test(warning.message)) driverWarnings.push(warning.message)
  })

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] A8.8 exception escalation and follow-up governance (${CONTRACT}) — run ${runId}`)
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
  for (const role of await prisma.role.findMany({ where: { code: { startsWith: 'SYNTHETIC_A88_' } }, select: { id: true } })) {
    await prisma.membershipRole.deleteMany({ where: { roleId: role.id } })
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
    await prisma.role.delete({ where: { id: role.id } })
  }

  // ---------------------------------------------------------------- start, scope and baseline (T001–T010)
  section('Start, scope and baseline: the accepted A8.5, A8.6 and A8.7 merges, the A8.4 closure, branch and parity, one additive migration, Prisma, replay, earlier contracts unchanged, diff scope')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const shortMain = git('rev-parse --short=7 origin/main')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a85Merge = mergeOf(a85Branch)
  const a86Merge = mergeOf(a86Branch)
  const a87Merge = mergeOf(a87Branch)
  const crgbMerge = mergeOf(crgbBranch)
  const crgMerge = mergeOf(crgBranch)
  check(
    'T001',
    'A8.5 accepted merge SHA confirmed',
    branch === a88Branch && a85Merge === A85_MERGE && gitOk(`merge-base --is-ancestor ${a85Merge} HEAD`) && crgbMerge === CRGB_MERGE && gitOk(`merge-base --is-ancestor ${crgbMerge} HEAD`) &&
      crgMerge.length === 40 && gitOk(`merge-base --is-ancestor ${crgMerge} HEAD`) && gitOk(`merge-base --is-ancestor ${MAIN_AT_START} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; A8.5 merged as ${a85Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A85_MERGE.slice(0, 7)}), Checkpoint B as ${crgbMerge.slice(0, 7) || 'NOT FOUND'} and Checkpoint A as ${crgMerge.slice(0, 7) || 'NOT FOUND'}, all ancestors; cut from clean main ${MAIN_AT_START.slice(0, 7)}; latest main ${shortMain} contained; not stacked`,
  )
  check(
    'T002',
    'A8.6 accepted merge SHA confirmed',
    a86Merge === A86_MERGE && gitOk(`merge-base --is-ancestor ${a86Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${A85_MERGE} ${A86_MERGE}`),
    `A8.6 merged as ${a86Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A86_MERGE.slice(0, 7)}), an ancestor of HEAD and a descendant of the A8.5 merge`,
  )
  check(
    'T003',
    'A8.7 accepted merge SHA confirmed',
    a87Merge === A87_MERGE && gitOk(`merge-base --is-ancestor ${a87Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${A86_MERGE} ${A87_MERGE}`) && gitArgs(['rev-parse', `${A87_MERGE}^2`]) === A87_ACCEPTED_HEAD &&
      gitArgs(['rev-parse', `${A87_MERGE}^{tree}`]) === gitArgs(['rev-parse', `${A87_ACCEPTED_HEAD}^{tree}`]),
    `A8.7 merged as ${a87Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A87_MERGE.slice(0, 7)}, FINAL PASS), an ancestor of HEAD and a descendant of the A8.6 merge; its tree is exactly the accepted HEAD ${A87_ACCEPTED_HEAD.slice(0, 7)}`,
  )
  const registerAtHead = committedText(REGISTER_DOC)
  const registerFlat = registerAtHead.replace(/\s+/g, ' ')
  const headTree = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter(Boolean)
  const a84Paths = headTree.filter((path) => /(^|[\\/_-])a8[-_]?4([\\/_.-]|$)/i.test(path))
  check(
    'T004',
    'A8.4 duplicate closed and no code',
    registerFlat.includes('On 2026-11-04 the architecture owner closed the earlier A8.4 specification as a duplicate of A8.3') && registerFlat.includes('No A8.4 code exists') && a84Paths.length === 0,
    a84Paths.length === 0 ? 'the register records the 2026-11-04 closure of A8.4 as a duplicate of A8.3; no A8.4 module, migration, suite or page exists at HEAD' : `A8.4 paths exist: ${a84Paths.join(', ').slice(0, 200)}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T005',
    'Feature from clean synchronized main',
    branch === a88Branch && dirty.length === 0 && tracking.includes(`origin/${a88Branch}`) && !/ahead|behind/.test(tracking) && gitArgs(['merge-base', 'HEAD', 'origin/main']) === gitArgs(['rev-parse', 'origin/main']),
    dirty.length === 0 ? `working tree clean; ${tracking}; origin/main ${shortMain} is the merge base (synchronized)` : `uncommitted: ${dirty.length} path(s)`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  // A8.8's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge added
  // (the same values, literally, on its own branch). A later package's changes are that package's to prove.
  const ownMerge = branch === a88Branch ? '' : mergeOf(a88Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'
  const ownTip = ownMerge || 'HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = migrationDirsAt(ownTip)
  const ownBaseMigrationDirs = migrationDirsAt(ownBase)
  check(
    'T006',
    'Only one new A8.8 migration',
    same(ownPrismaStatus, [`A\t${MIGRATION}`, 'M\tbackend/prisma/schema.prisma']) && ownHeadMigrationDirs.length === ownBaseMigrationDirs.length + 1 && ownBaseMigrationDirs.every((dir) => ownHeadMigrationDirs.includes(dir)) &&
      ownHeadMigrationDirs[ownHeadMigrationDirs.length - 1].endsWith(MIGRATION_NAME),
    `exactly one migration added (${MIGRATION_NAME}, the newest in its own scope) and the schema extended; all ${ownBaseMigrationDirs.length} applied migrations before it untouched`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T007', 'Prisma validate and generate pass', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'the schema validates and generates; the working database is up to date with every migration (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check(
    'T008',
    'Fresh scratch migration replay passes',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && /PASS {2}the A8\.8 tables are exactly exception_escalation_events/.test(replay.output) &&
      /PASS {2}exception_escalation_events_insert_guard_trg is present/.test(replay.output) && /PASS {2}one escalation event per \(intake, sequence\), one escalation, acknowledgement and return per intake/.test(replay.output) &&
      /PASS {2}the A8\.8 CHECKs pin A8-ESCALATION-1/.test(replay.output) && /PASS {2}exception_escalation_events carries exactly its 19 A8\.8 columns/.test(replay.output) &&
      /PASS {2}the A8\.7 tables are exactly exception_resolution_events/.test(replay.output),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD; every A8.8 CHECK, unique index, trigger, column and RESTRICT key survives, as does every A8.7 one`,
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
  const ESCALATION_PERMISSIONS = ['exceptionEscalation.handle', 'exceptionEscalation.raise', 'exceptionEscalation.read', 'exceptionEscalation.review']
  const knownException = [
    'exceptionIntake.create', 'exceptionIntake.read', 'exceptionTriage.read', 'exceptionTriage.record', 'exceptionInvestigation.read', 'exceptionInvestigation.record', 'exceptionRemediation.propose',
    'exceptionRemediation.review', 'exceptionRemediation.read', 'exceptionRemediationWork.read', 'exceptionRemediationWork.record', 'exceptionRemediationWork.verify', 'exceptionResolution.request',
    'exceptionResolution.decide', 'exceptionResolution.read', ...ESCALATION_PERMISSIONS,
  ]
  const contractConstantsAt = (ref: string) =>
    gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, 'backend/src/modules'])
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path) && !path.startsWith(`${MODULE_DIR}/`))
      .flatMap((path) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(/export const ([A-Z_0-9]*CONTRACT_VERSION[A-Z_0-9]*) = '([^']+)'/g)].map((m) => `${path}:${m[1]}=${m[2]}`))
      .sort()
  const errorCodesAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/errors/error.types.ts`]).matchAll(/^\s+'([A-Z_]+)',/gm)].map((m) => m[1])
  // Every applied migration before A8.8, hashed at its own base and at its own tip: none may change.
  const migrationBytesAt = (ref: string, dirs: string[]) => sha256Of(Buffer.from(dirs.map((dir) => gitArgs(['show', `${ref}:${dir}/migration.sql`])).join('\n')))
  const contractsOwn = contractConstantsAt(ownTip)
  const errorsOwn = errorCodesAt(ownTip)
  const errorsBase = errorCodesAt(ownBase)
  const productDiff = ownChangedPaths.filter((p) => /^backend\/src\/modules\//.test(p) && !p.startsWith(`${MODULE_DIR}/`) && p !== 'backend/src/modules/audit/audit.types.ts')
  const ownEarlierSuites = ownChangedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`) && file !== A610_SUITE)
  // The A6.10 correction, as code lines (comments and blank lines aside, order aside: the later-phase rule moved up):
  // exactly one line removed and one added, the old T087 column filter and the same filter excluding later-phase
  // tables; every A6.10 check id and title is unchanged.
  const codeLines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('//'))
  const multisetMinus = (a: string[], b: string[]) => {
    const left = [...b]
    return a.filter((line) => {
      const at = left.indexOf(line)
      if (at === -1) return true
      left.splice(at, 1)
      return false
    })
  }
  const a610Base = gitArgs(['show', `${ownBase}:${A610_SUITE}`])
  const a610Tip = gitArgs(['show', `${ownTip}:${A610_SUITE}`])
  const a610Removed = multisetMinus(codeLines(a610Base), codeLines(a610Tip))
  const a610Added = multisetMinus(codeLines(a610Tip), codeLines(a610Base))
  const a610Checks = (text: string) => [...text.matchAll(/check\(\s*'(T\d{3})',\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`)
  const a610Correction =
    !ownChangedPaths.includes(A610_SUITE) ||
    (a610Removed.length === 1 && a610Added.length === 1 && /^const sendColumns = allColumns\.filter\(\(c\) => .*\.test\(c\)\)$/.test(a610Removed[0]) &&
      a610Added[0] === a610Removed[0].replace(/\.test\(c\)\)$/, ".test(c) && !laterPhaseTables.has(c.split('.')[0]))") && same(a610Checks(a610Base), a610Checks(a610Tip)) && a610Checks(a610Tip).length >= 120)
  const ownEarlierUnits = ownChangedPaths.filter((file) => /\.test\.tsx?$/.test(file) && !file.startsWith(`${MODULE_DIR}/`))
  check(
    'T009',
    'Earlier contract hashes unchanged',
    contractsOwn.length >= 24 && same(contractsOwn, contractConstantsAt(ownBase)) && productDiff.length === 0 && ownEarlierSuites.length === 0 && a610Correction && ownEarlierUnits.length === 0 &&
      ownPrismaStatus.every((s) => !/^M\tbackend\/prisma\/migrations\//.test(s)) && migrationBytesAt(ownBase, ownBaseMigrationDirs) === migrationBytesAt(ownTip, ownBaseMigrationDirs) &&
      committedText(`${MODULE_DIR}/exception-escalation.types.ts`).includes(`ESCALATION_CONTRACT_VERSION = '${CONTRACT}'`) && errorsBase.every((c) => errorsOwn.includes(c)) &&
      same(errorsOwn.filter((c) => !errorsBase.includes(c)), [
        'EXCEPTION_ESCALATION_NOT_ASSIGNEE', 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE', 'EXCEPTION_ESCALATION_NOT_INDEPENDENT', 'EXCEPTION_ESCALATION_TRANSITION_REFUSED', 'EXCEPTION_ESCALATION_CONFLICT',
        'UNSUPPORTED_REFERENCE',
      ]) &&
      same(catalogueHead.filter((c) => !catalogueMain.includes(c)).sort(), ESCALATION_PERMISSIONS) && catalogueMain.every((c) => catalogueHead.includes(c)) &&
      same(allCodes.filter((c) => /^exceptionEscalation\./.test(c)).sort(), ESCALATION_PERMISSIONS) &&
      (await grantsOf('exceptionEscalation.raise')) === 'ORG_ADMIN' && (await grantsOf('exceptionEscalation.handle')) === 'ORG_ADMIN' && (await grantsOf('exceptionEscalation.review')) === 'ORG_ADMIN' &&
      (await grantsOf('exceptionEscalation.read')) === 'ORG_ADMIN,ORG_VIEWER' && (await grantsOf('exceptionResolution.request')) === 'ORG_ADMIN' && (await grantsOf('exceptionResolution.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('exceptionTriage.record')) === 'ORG_ADMIN' && !allCodes.some((c) => /^exception/i.test(c) && !knownException.includes(c) && !laterPermissions.includes(c)) &&
      same(auditHead.filter((c) => !auditMain.includes(c)), ['exception_escalation.recorded']) && auditMain.every((c) => auditHead.includes(c)),
    `all ${contractsOwn.length} A1–A8.7 and CRG owner contract literals identical to main and every one of the ${ownBaseMigrationDirs.length} earlier migrations byte-identical; no earlier module's code or unit test changed, and of the earlier suites only A6.10's T087 column filter (one line: later-phase tables excluded; every A6.10 check id and title unchanged); the error catalogue gains only the five A8.8 codes and UNSUPPORTED_REFERENCE, the permission catalogue exactly exceptionEscalation.raise, .handle and .review (Admin) and .read (Admin, Viewer), the audit catalogue exactly exception_escalation.recorded; every earlier grant is unchanged`,
  )
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${FE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file) && file !== A610_SUITE)
  const earlierSuites = changedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`) && file !== A610_SUITE)
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a9|dhpo|eclaimlink|coding-release|coding-validation|crg|closure|reopen|queue|\bsla\b|execut|checkpoint-c/i.test(file) && file !== A610_SUITE)
  check(
    'T010',
    'Diff scope excludes CRG and A9',
    changedPaths.length > 0 && outOfScope.length === 0 && earlierSuites.length === 0 && laterDomain.length === 0,
    outOfScope.length + earlierSuites.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A8.8 module, page, harness, migration and register and the narrow shared additions and the one A6.10 T087 correction (T009); no other earlier suite changed; no CRG, Checkpoint C, closure, queue, execution or A9 domain`
      : `unexpected: ${[...new Set([...outOfScope, ...earlierSuites, ...laterDomain])].join(', ').slice(0, 300)}`,
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
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /exception_escalation_|exception_resolution_|exception_remediation_|exception_investigation_|exception_triage_|exception_intake_|claim_freeze|organization_memberships/.test(text)
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
  // B approves home freezes; M1 is the worked scenario's assignee, A8.6 reporter, A8.7 requester and escalator; M4 owns
  // the other intakes; M2 is K's former assignee and its assignee again after a concurrent reassignment; M5 loses its
  // role while it escalates G; T is the nominated member of every escalation but H's; T3 is H's nominated member and
  // loses its role while it follows up; RV approves every A8.5 proposal; VR verifies every A8.6 report; DR decides every
  // A8.7 request; RW and RW2 return escalations (independent of the escalator, the target and the assignee); NR is a
  // member without any role; PT holds a synthetic role this run narrows one permission at a time; O and O2 belong to the
  // other tenant. M1 also holds a second membership in the other tenant (M1X), so the same user through another
  // membership can be tried.
  const B = await provisionMember('b')
  const M1 = await provisionMember('m1')
  const M2 = await provisionMember('m2')
  const M4 = await provisionMember('m4')
  const M5 = await provisionMember('m5')
  const T = await provisionMember('t')
  const T3 = await provisionMember('t3')
  const RV = await provisionMember('rv')
  const VR = await provisionMember('vr')
  const DR = await provisionMember('dr')
  const RW = await provisionMember('rw')
  const RW2 = await provisionMember('rw2')
  const NR = await provisionMember('norole', org, false)
  const PT = await provisionMember('partial', org, false)
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)
  const M1X = await prisma.organizationMembership.create({ data: { organizationId: otherOrg, userId: M1.id } })
  await prisma.membershipRole.create({ data: { membershipId: M1X.id, roleId: adminRole.id } })

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: two organizations; Claims frozen twice without a link, their A8.1 intakes, A8.2 assignments, A8.3 links and findings, A8.5 approved plans, A8.6 verified work and A8.7 resolution states (none, pending, returned for rework, resolved)')
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
  const returnToTriage = { eventCode: 'RETURN_TO_TRIAGE', reasonCode: 'ASSIGNEE_UNAVAILABLE' }
  // A8.3 through its own route by the assignee: the intake's basis linked, then one finding naming that link.
  type Investigated = { linkId: string; findingId: string; statuses: number[] }
  const investigate = async (k: Intake, who: Who, findingCode = 'FURTHER_REVIEW_REQUIRED'): Promise<Investigated> => {
    const link = await post(`${base(k)}/investigation-events`, { eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS', evidenceRecordId: k.basisRecordId, evidenceContractVersion: INTAKE_CONTRACT }, who)
    if (link.status !== 201) throw new Error(`fixture ${k.label}: the A8.3 link was refused with ${link.status} ${errorCode(link.body) ?? ''}`)
    const found = await post(`${base(k)}/investigation-events`, { eventCode: 'RECORD_FINDING', linkedEvidenceEventId: link.body.investigationEventId, findingCode }, who)
    if (found.status !== 201) throw new Error(`fixture ${k.label}: the A8.3 finding was refused with ${found.status} ${errorCode(found.body) ?? ''}`)
    return { linkId: link.body.investigationEventId, findingId: found.body.investigationEventId, statuses: [link.status, found.status] }
  }
  // A8.5 through its own route: the assignee proposes one controlled action on its finding and RV approves it.
  type Plan = { proposalId: string; workCode: string; statuses: number[] }
  const planFor = async (k: Intake, finding: string, proposer: Who, actionCode = 'REQUEST_INTERNAL_DOCUMENTATION_CHECK'): Promise<Plan> => {
    const proposed = await post(`${base(k)}/remediation-events`, { eventCode: 'PROPOSE_ACTION', actionCode, findingEventId: finding, rationaleCode: 'INSUFFICIENT_EVIDENCE' }, proposer)
    if (proposed.status !== 201) throw new Error(`fixture ${k.label}: the A8.5 proposal was refused with ${proposed.status} ${errorCode(proposed.body) ?? ''}`)
    const decided = await post(`${base(k)}/remediation-events`, { eventCode: 'REVIEW_ACTION', proposalEventId: proposed.body.remediationEventId, decisionCode: 'APPROVE_PROPOSAL' }, RV.who)
    if (decided.status !== 201) throw new Error(`fixture ${k.label}: the A8.5 approval was refused with ${decided.status} ${errorCode(decided.body) ?? ''}`)
    return { proposalId: proposed.body.remediationEventId, workCode: WORK_CODE_OF_ACTION[actionCode as keyof typeof WORK_CODE_OF_ACTION], statuses: [proposed.status, decided.status] }
  }
  // A8.6 through its own route: the assignee reports the work against the approved plan citing its finding, and VR
  // verifies it EVIDENCE_SUPPORTED there.
  type Work = { reportId: string; verificationId: string; statuses: number[] }
  const workFor = async (k: Intake, plan: Plan, finding: string, reporter: Who): Promise<Work> => {
    const reported = await post(`${base(k)}/remediation-work-events`, { eventCode: 'RECORD_WORK_REPORT', approvedProposalEventId: plan.proposalId, workCode: plan.workCode, basisReferenceKind: 'INVESTIGATION_FINDING', basisReferenceId: finding }, reporter)
    if (reported.status !== 201) throw new Error(`fixture ${k.label}: the A8.6 report was refused with ${reported.status} ${errorCode(reported.body) ?? ''}`)
    const verified = await post(`${base(k)}/remediation-work-events`, { eventCode: 'VERIFY_WORK_REPORT', workReportEventId: reported.body.workEventId, verificationCode: 'EVIDENCE_SUPPORTED' }, VR.who)
    if (verified.status !== 201) throw new Error(`fixture ${k.label}: the A8.6 verification was refused with ${verified.status} ${errorCode(verified.body) ?? ''}`)
    return { reportId: reported.body.workEventId, verificationId: verified.body.workEventId, statuses: [reported.status, verified.status] }
  }
  // A8.7 through its own route: the assignee requests an internal resolution on the verified work; DR decides it.
  const resolutionPost = (k: Intake, body: unknown, who: Who) => post(`${base(k)}/resolution-events`, body, who)
  const requestResolution = async (k: Intake, work: Work, who: Who) => {
    const res = await resolutionPost(k, { eventCode: 'REQUEST_INTERNAL_RESOLUTION', verificationEventId: work.verificationId, reasonCode: 'VERIFIED_INTERNAL_WORK' }, who)
    if (res.status !== 201) throw new Error(`fixture ${k.label}: the A8.7 request was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.resolutionEventId as string
  }
  const decideResolution = async (k: Intake, requestEventId: string, decision: 'CONFIRM_INTERNAL_RESOLUTION' | 'RETURN_FOR_REWORK') => {
    const body = decision === 'CONFIRM_INTERNAL_RESOLUTION'
      ? { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId, decisionCode: decision }
      : { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId, decisionCode: decision, returnReasonCode: 'ADDITIONAL_WORK_REQUIRED' }
    const res = await resolutionPost(k, body, DR.who)
    if (res.status !== 201) throw new Error(`fixture ${k.label}: the A8.7 decision was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.resolutionEventId as string
  }
  // W — the worked scenario and the golden history: A8.7 RETURNED_FOR_REWORK, then escalated by M1 to T, acknowledged,
  // two follow-ups and a return by RW. RS — A8.7 RESOLVED_INTERNAL. PD — an A8.7 request awaiting a decision, returned
  // later. EP — an escalation open when an A8.7 request becomes pending, then returned. ER — an escalation open when A8.7
  // confirms the resolution. S — full pipeline, direct SQL only (never a committed escalation event). N0 — no A8.5/A8.6
  // work (A8.7 NO_RESOLUTION_REQUEST), the protocol intake. L0 — kept UNTRIAGED. TR — returned to triage while its
  // escalation is open, then assigned again. J — failure injection, retries and unknown outcomes. AT — the atomic
  // commit, the read during a write and the unique collision. RC — races. K — the A8.2 interplay (M2 assigned, then M4,
  // reassigned to M2 concurrently, later to T and back). G — M5's role removal. H — T3's role removal. F — the other
  // tenant's intake, with its own triage and finding.
  const W = await intakeFor('worked')
  const RS = await intakeFor('resolved')
  const PD = await intakeFor('pending')
  const EP = await intakeFor('escalated-pending')
  const ER = await intakeFor('escalated-resolved')
  const S = await intakeFor('sql')
  const N0 = await intakeFor('no-work')
  const L0 = await intakeFor('untriaged')
  const TR = await intakeFor('returned-triage')
  const J = await intakeFor('inject')
  const AT = await intakeFor('atomic')
  const RC = await intakeFor('race')
  const K = await intakeFor('interplay')
  const G = await intakeFor('revoked')
  const H = await intakeFor('handler-revoked')
  const F = await intakeFor('foreign', away, O.who)
  const W_CLASSIFY = await triage(W, classify)
  const W_ASSIGN = await triage(W, assignTo(M1))
  for (const k of [RS, PD, EP, ER, S, N0, TR, J, AT, RC, H]) {
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
  const assigned: [Intake, Who][] = [[RS, M4.who], [PD, M4.who], [EP, M4.who], [ER, M4.who], [S, M4.who], [N0, M4.who], [TR, M4.who], [J, M4.who], [AT, M4.who], [RC, M4.who], [K, M4.who], [G, M5.who], [H, M4.who], [F, O.who]]
  const investigated = new Map<string, Investigated>([[W.intakeId, IW]])
  for (const [k, who] of assigned) investigated.set(k.intakeId, await investigate(k, who))
  const inv = (k: Intake) => investigated.get(k.intakeId) as Investigated
  const PW = await planFor(W, IW.findingId, M1.who)
  const WW = await workFor(W, PW, IW.findingId, M1.who)
  const plans = new Map<string, Plan>([[W.intakeId, PW]])
  const works = new Map<string, Work>([[W.intakeId, WW]])
  for (const k of [RS, PD, EP, ER, S]) {
    const plan = await planFor(k, inv(k).findingId, M4.who)
    plans.set(k.intakeId, plan)
    works.set(k.intakeId, await workFor(k, plan, inv(k).findingId, M4.who))
  }
  const work = (k: Intake) => works.get(k.intakeId) as Work
  const RQ_W = await requestResolution(W, WW, M1.who)
  const RD_W = await decideResolution(W, RQ_W, 'RETURN_FOR_REWORK')
  const RQ_RS = await requestResolution(RS, work(RS), M4.who)
  const RD_RS = await decideResolution(RS, RQ_RS, 'CONFIRM_INTERNAL_RESOLUTION')
  const RQ_PD = await requestResolution(PD, work(PD), M4.who)
  const homeIntakes = [W, RS, PD, EP, ER, S, N0, L0, TR, J, AT, RC, K, G, H]
  const runIntakes = [...homeIntakes, F]
  const runClaims = homeIntakes.map((k) => k.claimId)
  progress(
    `fixtures ready: two synthetic AE-DU/DHA worlds; ${homeIntakes.length} A8.1 intakes on contradicted Claims in Org A (basis ${W.basisCode}) and one in Org B; W assigned to M1, K to M4 after M2, G to M5, the others to M4, L0 untriaged; each assigned intake carries an A8.3 link and finding; W, RS, PD, EP, ER and S an A8.5 plan approved by RV and A8.6 work verified by VR; A8.7: W RETURNED_FOR_REWORK, RS RESOLVED_INTERNAL, PD AWAITING_RESOLUTION_DECISION, every other NO_RESOLUTION_REQUEST`,
  )

  const escalationPost = (k: { claimId: string; intakeId: string }, body: unknown, who: Who) => post(`${base(k)}/escalation-events`, body, who)
  const historyOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/escalation-history`, who)
  const dispositionOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/escalation-disposition`, who)
  const triageDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/triage-disposition`)
  const investigationSummaryOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/investigation-summary`)
  const remediationDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/remediation-disposition`)
  const workDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/remediation-work-disposition`)
  const resolutionDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/resolution-disposition`)
  const resolutionHistoryOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/resolution-history`)
  const escalateOf = (member: { membershipId: string } | string, reasonCode = 'NEEDS_SUPERVISOR_REVIEW') => ({ eventCode: 'ESCALATE_FOR_REVIEW', reasonCode, targetMemberId: typeof member === 'string' ? member : member.membershipId })
  const ackOf = (escalationEventId: string) => ({ eventCode: 'ACKNOWLEDGE_ESCALATION', escalationEventId })
  const followupOf = (acknowledgementEventId: string, sourceEventId: string, followupCode = 'SOURCE_RECHECK_RECORDED') => ({ eventCode: 'RECORD_FOLLOWUP', acknowledgementEventId, followupCode, sourceEventId })
  const returnOf = (escalationEventId: string, returnReasonCode = 'FOLLOWUP_RECORDED') => ({ eventCode: 'RETURN_TO_OWNER', escalationEventId, returnReasonCode })
  const eventsOf = (intakeId: string) => prisma.exceptionEscalationEvent.findMany({ where: { exceptionIntakeId: intakeId }, orderBy: { sequence: 'asc' } })
  const auditsOfEvent = (eventId: string) => prisma.auditEvent.findMany({ where: { entityType: 'EXCEPTION_ESCALATION_EVENT', entityId: eventId } })
  const auditsOfIntake = (intakeId: string) => prisma.auditEvent.count({ where: { actionCode: 'exception_escalation.recorded', afterState: { path: ['exceptionIntakeId'], equals: intakeId } } })
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
  const ownerHash = (table: string) => hashOf(`SELECT t.* FROM ${table} t WHERE t.exception_intake_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId))
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
  // One direct event row of intake `k`: by default its valid escalation by M4 (the assignee of S) to T. The other event
  // kinds default to their valid shape by their valid actor: an acknowledgement and follow-ups by T, a return by RW.
  const rowOf = (k: Intake, o: Row = {}): Row => ({
    id: randomUUID(), exception_intake_id: k.intakeId, organization_id: k.organizationId, claim_id: k.claimId, contract_version: CONTRACT, sequence: 1, event_code: 'ESCALATE_FOR_REVIEW',
    reason_code: 'NEEDS_SUPERVISOR_REVIEW', target_member_id: T.membershipId, escalation_event_id: null, acknowledgement_event_id: null, followup_code: null, source_event_id: null,
    source_event_kind: null, return_reason_code: null, recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id, recorded_at: null, ...o,
  })
  const ackRow = (k: Intake, sequence: number, escalationId: string, o: Row = {}) =>
    rowOf(k, { sequence, event_code: 'ACKNOWLEDGE_ESCALATION', reason_code: null, target_member_id: null, escalation_event_id: escalationId, recorded_by_membership_id: T.membershipId, recorded_by_user_id: T.id, ...o })
  const followupRow = (k: Intake, sequence: number, ackId: string, sourceId: string, kind: string, o: Row = {}) =>
    rowOf(k, {
      sequence, event_code: 'RECORD_FOLLOWUP', reason_code: null, target_member_id: null, acknowledgement_event_id: ackId, followup_code: 'SOURCE_RECHECK_RECORDED', source_event_id: sourceId,
      source_event_kind: kind, recorded_by_membership_id: T.membershipId, recorded_by_user_id: T.id, ...o,
    })
  const returnRow = (k: Intake, sequence: number, escalationId: string, o: Row = {}) =>
    rowOf(k, { sequence, event_code: 'RETURN_TO_OWNER', reason_code: null, target_member_id: null, escalation_event_id: escalationId, return_reason_code: 'FOLLOWUP_RECORDED', recorded_by_membership_id: RW.membershipId, recorded_by_user_id: RW.id, ...o })
  const COLUMN_LIST = 'id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, reason_code, target_member_id, escalation_event_id, acknowledgement_event_id, followup_code, source_event_id, source_event_kind, return_reason_code, recorded_by_membership_id, recorded_by_user_id'
  const VALUES = '$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8, $9::uuid, $10::uuid, $11::uuid, $12, $13::uuid, $14, $15, $16::uuid, $17::uuid'
  const insertRow = (tx: DbClient, row: Row) => {
    const values = [
      row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.reason_code, row.target_member_id, row.escalation_event_id,
      row.acknowledgement_event_id, row.followup_code, row.source_event_id, row.source_event_kind, row.return_reason_code, row.recorded_by_membership_id, row.recorded_by_user_id,
    ]
    return row.recorded_at === null
      ? tx.$executeRawUnsafe(`INSERT INTO ${TABLE} (${COLUMN_LIST}) VALUES (${VALUES})`, ...values)
      : tx.$executeRawUnsafe(`INSERT INTO ${TABLE} (${COLUMN_LIST}, recorded_at, created_at) VALUES (${VALUES}, $18::timestamptz, $18::timestamptz)`, ...values, row.recorded_at)
  }
  // Direct rows in order, in one transaction that is always rolled back: against the live guards, or with the triggers
  // off (replica) so that only a CHECK, a unique index or a NOT NULL can refuse. `before` runs first. Answers the first
  // refusal.
  const directInsert = async (rows: Row[], options: { triggersOff?: boolean; before?: (tx: DbClient) => Promise<unknown> } = {}) => {
    const attempt = await rolledBack(async (tx) => {
      if (options.before) await options.before(tx)
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
      return { history: await getEscalationHistoryOf(k.claimId, k.intakeId, tx), disposition: await getEscalationDispositionOf(k.claimId, k.intakeId, tx) }
    })
  const snap = async () => ({
    freezes: await hashOf(`SELECT f.*, m.id AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    lifecycle: await hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    links: await hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    claims: await hashOf(`SELECT c.* FROM claims c WHERE c.id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    encounters: await hashOf(`SELECT e.* FROM encounters e JOIN claims c ON c.encounter_id = e.id WHERE c.id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    intakes: await hashOf(`SELECT r.* FROM ${INTAKE_TABLE} r WHERE r.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    intakeAudits: await hashOf(`SELECT a.id, a.action_code, a.entity_id, a.after_state, a.occurred_at FROM audit_events a WHERE a.entity_type = 'EXCEPTION_INTAKE' AND a.entity_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId)),
    investigation: await ownerHash(INVESTIGATION_TABLE),
    remediation: await ownerHash(REMEDIATION_TABLE),
    work: await ownerHash(WORK_TABLE),
    a7: await tableCounts(A7_TABLES),
    coding: await tableCounts(CODING_TABLES),
  })
  const ownerSnapshotBefore = await snap()
  // Every A8.2 triage and A8.7 resolution event that exists before the first escalation write: A8.8 must never change
  // one of them (later A8.2 and A8.7 events are their owners' own new events, judged where they are made).
  const triageIdsBefore = (await prisma.exceptionTriageEvent.findMany({ where: { exceptionIntakeId: { in: runIntakes.map((k) => k.intakeId) } }, select: { id: true } })).map((row) => row.id)
  const triageHash = () => hashOf(`SELECT t.* FROM ${TRIAGE_TABLE} t WHERE t.id = ANY($1::uuid[])`, triageIdsBefore)
  const triageHashBefore = await triageHash()
  const resolutionIdsBefore = (await prisma.exceptionResolutionEvent.findMany({ where: { exceptionIntakeId: { in: runIntakes.map((k) => k.intakeId) } }, select: { id: true } })).map((row) => row.id)
  const resolutionHash = () => hashOf(`SELECT r.* FROM ${RESOLUTION_TABLE} r WHERE r.id = ANY($1::uuid[])`, resolutionIdsBefore)
  const resolutionHashBefore = await resolutionHash()
  const wTriageBefore = withoutEvaluatedAt((await triageDispositionOf(W)).body)
  const wInvestigationBefore = withoutEvaluatedAt((await investigationSummaryOf(W)).body)
  const wRemediationBefore = withoutEvaluatedAt((await remediationDispositionOf(W)).body)
  const wWorkBefore = withoutEvaluatedAt((await workDispositionOf(W)).body)
  const wResolutionBefore = { disposition: withoutEvaluatedAt((await resolutionDispositionOf(W)).body), history: withoutEvaluatedAt((await resolutionHistoryOf(W)).body) }
  const wIntakesBefore = withoutEvaluatedAt((await get(`/api/claims/${W.claimId}/exception-intake`)).body)

  // D2 — the six upstream read permissions, each on its own. PT holds one synthetic role granting exactly what
  // ORG_ADMIN grants; one permission at a time is taken from it and every A8.8 route is tried, then given back. The role
  // exists only for these calls and is removed again before anything else runs. With exceptionResolution.read taken, PT
  // is also nominated (D3: an ineligible target).
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
  const allRoutes = async () => [
    (await escalationPost(N0, escalateOf(T), PT.who)).status, (await escalationPost(N0, ackOf(MISSING), PT.who)).status, (await escalationPost(N0, returnOf(MISSING), PT.who)).status,
    (await historyOf(N0, PT.who)).status, (await dispositionOf(N0, PT.who)).status,
  ]
  const partialControl = {
    escalate: await escalationPost(N0, escalateOf(T), PT.who), ack: await escalationPost(N0, ackOf(MISSING), PT.who), giveBack: await escalationPost(N0, returnOf(MISSING), PT.who),
    history: await historyOf(N0, PT.who), disposition: await dispositionOf(N0, PT.who),
  }
  const parentReadProof: { code: string; statuses: number[] }[] = []
  for (const code of SIX_READS) parentReadProof.push({ code, statuses: await withoutPermission(code, allRoutes) })
  const ownPermissionProof = {
    raise: await withoutPermission('exceptionEscalation.raise', async () => [(await escalationPost(N0, escalateOf(T), PT.who)).status, (await escalationPost(N0, ackOf(MISSING), PT.who)).status]),
    handle: await withoutPermission('exceptionEscalation.handle', async () => [
      (await escalationPost(N0, ackOf(MISSING), PT.who)).status, (await escalationPost(N0, followupOf(MISSING, inv(N0).findingId), PT.who)).status, (await escalationPost(N0, escalateOf(T), PT.who)).status,
    ]),
    review: await withoutPermission('exceptionEscalation.review', async () => [(await escalationPost(N0, returnOf(MISSING), PT.who)).status, (await escalationPost(N0, ackOf(MISSING), PT.who)).status]),
    read: await withoutPermission('exceptionEscalation.read', async () => [(await historyOf(N0, PT.who)).status, (await dispositionOf(N0, PT.who)).status]),
  }
  const partialTarget = await withoutPermission('exceptionResolution.read', () => escalationPost(N0, escalateOf(PT), M4.who))
  await prisma.membershipRole.deleteMany({ where: { roleId: partialRole.id } })
  await prisma.rolePermission.deleteMany({ where: { roleId: partialRole.id } })
  await prisma.role.delete({ where: { id: partialRole.id } })
  const partialGone = (await prisma.role.count({ where: { code: { startsWith: 'SYNTHETIC_' } } })) === 0

  // ---------------------------------------------------------------- protocol and DTOs (T011–T020)
  section('Protocol and DTOs on N0: the v1 literal on rows and DTOs, strict escalation, acknowledgement, follow-up and return keys, server-owned fields, malformed ids, uncontrolled codes, no client state or current selector, injection, PHI and free text')
  const countsAtStart = await counts()
  const noEscalationW = { disposition: await dispositionOf(W), history: await historyOf(W), rows: (await eventsOf(W.intakeId)).length }
  const noEscalationRS = (await dispositionOf(RS)).body
  const E_N0 = await escalationPost(N0, escalateOf(T, 'EVIDENCE_INCOMPLETE'), M4.who)
  const E_N0_ID = (E_N0.body?.escalationEventId ?? MISSING) as string
  const en0HashBefore = await rowHash(E_N0_ID)
  const contractDef = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${TABLE}_contract_chk'`))[0]?.d ?? ''
  const en0Row = (await eventsOf(N0.intakeId))[0]
  const historyEN0 = await historyOf(N0)
  const dispositionEN0 = await dispositionOf(N0)
  check(
    'T011',
    'Version literal exact in TS/SQL/DTO',
    E_N0.status === 201 && E_N0.body.contractVersion === CONTRACT && ESCALATION_CONTRACT_VERSION === CONTRACT && en0Row?.contractVersion === CONTRACT && same(Object.keys(E_N0.body), EVENT_KEYS) &&
      same(Object.keys(historyEN0.body), HISTORY_KEYS) && same(Object.keys(dispositionEN0.body), DISPOSITION_KEYS) && same(Object.keys(dispositionEN0.body.escalation ?? {}), ESCALATION_KEYS) &&
      historyEN0.body.contractVersion === CONTRACT && dispositionEN0.body.contractVersion === CONTRACT && contractDef.includes(`'${CONTRACT}'`) && /IS NOT NULL/.test(contractDef) &&
      committedText(MIGRATION).includes(`'${CONTRACT}'`),
    `N0's escalation carries ${CONTRACT} on its stored row and in exactly the ${EVENT_KEYS.length} event keys; the history, the disposition and its escalation carry exactly theirs; the types file, the migration and the database CHECK pin the literal`,
  )
  const n0Rows = async () => (await eventsOf(N0.intakeId)).length
  const isValidation = (r: { status: number; body: any }) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR'
  const without = (body: Record<string, unknown>, field: string) => {
    const copy: Record<string, unknown> = { ...body }
    delete copy[field]
    return copy
  }
  const missingKeys = async (body: Record<string, unknown>, who: Who) => Promise.all(Object.keys(body).filter((k) => k !== 'eventCode').map((field) => escalationPost(N0, without(body, field), who)))
  const extraKeys = async (body: Record<string, unknown>, extras: Record<string, unknown>[], who: Who) => Promise.all(extras.map((extra) => escalationPost(N0, { ...body, ...extra }, who)))
  const strictEscalation = [...(await missingKeys(escalateOf(T), M4.who))]
  const extraEscalation = await extraKeys(escalateOf(T), [{ escalationEventId: E_N0_ID }, { returnReasonCode: 'FOLLOWUP_RECORDED' }, { followupCode: 'SOURCE_RECHECK_RECORDED' }, { extra: 1 }], M4.who)
  const oddBodies = [await escalationPost(N0, [escalateOf(T)], M4.who), await escalationPost(N0, {}, M4.who), await escalationPost(N0, 7, M4.who), await escalationPost(N0, 'ESCALATE_FOR_REVIEW', M4.who), await escalationPost(N0, null, M4.who)]
  const nullService = await recordEscalationEvent(N0.claimId, N0.intakeId, null, M4.id)
  check(
    'T012',
    'Escalation keys strict, missing refused',
    strictEscalation.every((r) => isValidation(r) && /missing field/.test(errorMessage(r.body))) && extraEscalation.every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) &&
      oddBodies.every((r) => r.status === 400 && !rawError(r.body)) && nullService.ok === false && nullService.code === 'VALIDATION_ERROR' && (await n0Rows()) === 1,
    `an escalation without its reason or target is a 400 (missing field); with an acknowledgement, follow-up or return field or an unknown property a 400 (unsupported field); an array, empty, numeric, string or null body is a 400 (${oddBodies.map((r) => r.status).join('/')}) and the service itself refuses null; nothing recorded`,
  )
  const strictAck = [...(await missingKeys(ackOf(E_N0_ID), T.who)), ...(await extraKeys(ackOf(E_N0_ID), [{ targetMemberId: T.membershipId }, { reasonCode: 'NEEDS_SUPERVISOR_REVIEW' }, { acknowledgementEventId: E_N0_ID }, { extra: 1 }], T.who))]
  check(
    'T013',
    'Acknowledgement keys strict',
    strictAck.every(isValidation) && /missing field/.test(errorMessage(strictAck[0].body)) && strictAck.slice(1).every((r) => /unsupported field/.test(errorMessage(r.body))) && (await n0Rows()) === 1,
    'an acknowledgement without its escalation, or with a target, reason, acknowledgement or unknown field, is a 400; nothing recorded',
  )
  const strictFollowup = [
    ...(await missingKeys(followupOf(MISSING, inv(N0).findingId), T.who)),
    ...(await extraKeys(followupOf(MISSING, inv(N0).findingId), [{ sourceEventKind: 'INVESTIGATION_FINDING' }, { escalationEventId: E_N0_ID }, { returnReasonCode: 'FOLLOWUP_RECORDED' }, { extra: 1 }], T.who)),
  ]
  check(
    'T014',
    'Follow-up keys strict',
    strictFollowup.slice(0, 3).every((r) => isValidation(r) && /missing field/.test(errorMessage(r.body))) && strictFollowup.slice(3).every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) && (await n0Rows()) === 1,
    'a follow-up without its acknowledgement, code or source is a 400 (missing field); one naming a source kind (the server owns it), an escalation, a return reason or an unknown field a 400 (unsupported field); nothing recorded',
  )
  const strictReturn = [
    ...(await missingKeys(returnOf(E_N0_ID), RW.who)), ...(await extraKeys(returnOf(E_N0_ID), [{ acknowledgementEventId: E_N0_ID }, { reasonCode: 'NEEDS_SUPERVISOR_REVIEW' }, { extra: 1 }], RW.who)),
    await escalationPost(N0, returnOf(E_N0_ID, 'CLOSED'), RW.who), await escalationPost(N0, returnOf(E_N0_ID, 'RESOLVED_INTERNAL'), RW.who), await escalationPost(N0, { ...returnOf(E_N0_ID), returnReasonCode: null }, RW.who),
  ]
  check(
    'T015',
    'Return keys and reason strict',
    strictReturn.slice(0, 2).every((r) => isValidation(r) && /missing field/.test(errorMessage(r.body))) && strictReturn.slice(2, 5).every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) &&
      strictReturn.slice(5).every((r) => isValidation(r) && /unknown return reason code/.test(errorMessage(r.body))) && (await n0Rows()) === 1,
    `a return without its escalation or reason, with an acknowledgement, reason or unknown field, or with a reason outside ${returnReasonCodes.join(', ')} (CLOSED, RESOLVED_INTERNAL, null) is a 400; nothing recorded`,
  )
  const serverOwned = await Promise.all(
    ['id', 'escalationEventId', 'sequence', 'organizationId', 'claimId', 'exceptionIntakeId', 'recordedByUserId', 'recordedByMembershipId', 'actorUserId', 'recordedAt', 'createdAt', 'contractVersion', 'targetUserId', 'sourceEventKind'].map((k) =>
      escalationPost(RC, { ...escalateOf(T), [k]: k === 'sequence' ? 2 : k === 'recordedAt' || k === 'createdAt' ? '2020-01-01T00:00:00.000Z' : k === 'contractVersion' ? CONTRACT : k === 'sourceEventKind' ? 'WORK_REPORT' : MISSING }, M4.who),
    ),
  )
  const queried = await post(`${base(RC)}/escalation-events?sequence=2`, escalateOf(T), M4.who)
  check(
    'T016',
    'Server-owned actor/tenant/time/sequence',
    serverOwned.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && queried.status === 400 && E_N0.body.recordedByMembershipId === M4.membershipId && E_N0.body.recordedByUserId === M4.id &&
      E_N0.body.organizationId === org && E_N0.body.claimId === N0.claimId && E_N0.body.sequence === 1 && (await eventsOf(RC.intakeId)).length === 0,
    "an id, sequence, organization, Claim, intake, actor, membership, time, contract, target user or source kind in the body, or a query parameter, is refused (400); N0's escalation took its actor, membership, organization, Claim and number 1 from the server",
  )
  const badIds = ['not-a-uuid', MISSING.replace(/-/g, ''), `${MISSING}0`, encodeURIComponent("1' OR '1'='1")]
  const malformedPath = [
    ...(await Promise.all(badIds.map((id) => escalationPost({ claimId: id, intakeId: N0.intakeId }, escalateOf(T), M4.who)))), ...(await Promise.all(badIds.map((id) => historyOf({ claimId: id, intakeId: N0.intakeId })))),
    ...(await Promise.all(badIds.map((id) => dispositionOf({ claimId: N0.claimId, intakeId: id })))), ...(await Promise.all(badIds.map((id) => escalationPost({ claimId: N0.claimId, intakeId: id }, escalateOf(T), M4.who)))),
  ]
  const malformedBodyIds = [
    await escalationPost(N0, escalateOf('not-a-uuid'), M4.who), await escalationPost(N0, ackOf(`${MISSING}0`), T.who), await escalationPost(N0, followupOf(MISSING, 'x'), T.who),
    await escalationPost(N0, followupOf('x', MISSING), T.who), await escalationPost(N0, returnOf(''), RW.who), await escalationPost(N0, { ...escalateOf(T), targetMemberId: 7 }, M4.who),
  ]
  check(
    'T017',
    'Malformed path IDs safe 400',
    malformedPath.every((r) => r.status === 400 && /invalid (claim|exception intake) id/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      malformedBodyIds.every((r) => r.status === 400 && /invalid (target member|escalation event|acknowledgement event|source event) id/.test(errorMessage(r.body)) && !rawError(r.body)) && (await n0Rows()) === 1,
    'malformed and SQL-shaped Claim and intake ids on all three routes, and malformed target, escalation, acknowledgement and source ids in the body, are each a safe 400; nothing recorded',
  )
  const unknownEvents = await Promise.all(['ESCALATE', 'CLOSE_EXCEPTION', 'RESOLVE_EXCEPTION', 'REOPEN', 'escalate_for_review', '', null, 7].map((eventCode) => escalationPost(N0, { ...escalateOf(T), eventCode }, M4.who)))
  const unknownReasons = await Promise.all(['URGENT', 'MEDICAL_EMERGENCY', 'PAYER_DENIED', 'needs_supervisor_review', ''].map((reasonCode) => escalationPost(N0, escalateOf(T, reasonCode), M4.who)))
  const unknownFollowups = await Promise.all(['DONE', 'CLOSED', 'CODE_SET_IMPORTED', 'source_recheck_recorded', ''].map((followupCode) => escalationPost(N0, followupOf(MISSING, inv(N0).findingId, followupCode), T.who)))
  check(
    'T018',
    'Unknown event and controlled code 400',
    unknownEvents.every((r) => isValidation(r) && /unknown escalation event code/.test(errorMessage(r.body))) && unknownReasons.every((r) => isValidation(r) && /unknown escalation reason code/.test(errorMessage(r.body))) &&
      unknownFollowups.every((r) => isValidation(r) && /unknown follow-up code/.test(errorMessage(r.body))) && (await n0Rows()) === 1,
    `only ${escalationEventCodes.join(', ')}; reasons only ${escalationReasonCodes.join(', ')}; follow-up codes only ${followupCodes.join(', ')} (an emergency, payer or code-set value is refused)`,
  )
  const stateFields = await Promise.all(['state', 'status', 'outcome', 'current', 'latest', 'priority', 'dueAt', 'slaHours', 'closed'].map((field) => escalationPost(RC, { ...escalateOf(T), [field]: field === 'current' || field === 'latest' || field === 'closed' ? true : 'X' }, M4.who)))
  const selectorReads = [
    await get(`${base(N0)}/escalation-history?latest=1`), await get(`${base(N0)}/escalation-disposition?state=FOLLOWUP_ACTIVE`), await get(`${base(N0)}/escalation-current`), await get(`${base(N0)}/escalation-events`),
    await get(`${base(N0)}/escalation-events/${E_N0_ID}`), await api('PATCH', `${base(N0)}/escalation-events`, {}), await api('PUT', `${base(N0)}/escalation-events`, {}), await api('DELETE', `${base(N0)}/escalation-events`),
  ]
  check(
    'T019',
    'No client state/current selectors',
    stateFields.every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) && selectorReads.slice(0, 2).every((r) => r.status === 400) && selectorReads.slice(2).every((r) => r.status === 404) &&
      !COLUMNS.some((c) => /state|status|current|latest|priority|due|sla/.test(c)) && (await eventsOf(RC.intakeId)).length === 0,
    'a state, status, outcome, current, latest, priority, due date, SLA or closed field is refused (400); a latest or state query selector is a 400; a current selector, an event collection, an event by id and PATCH/PUT/DELETE do not exist (404); the table has no state, current, priority or due column',
  )
  const injection = [
    await escalationPost(N0, escalateOf("1' OR '1'='1"), M4.who), await escalationPost(N0, { ...escalateOf(T), targetMemberId: { $ne: null } }, M4.who),
    await escalationPost(N0, { ...escalateOf(T), reasonCode: "NEEDS_SUPERVISOR_REVIEW'; DROP TABLE claims; --" }, M4.who), await escalationPost(N0, { ...ackOf(E_N0_ID), escalationEventId: '../escalation' }, T.who),
    await escalationPost(N0, JSON.parse(`{"__proto__": {"eventCode": "ESCALATE_FOR_REVIEW"}, "reasonCode": "NEEDS_SUPERVISOR_REVIEW", "targetMemberId": "${T.membershipId}"}`), M4.who),
    await escalationPost(N0, JSON.parse(`{"eventCode": "ESCALATE_FOR_REVIEW", "reasonCode": "NEEDS_SUPERVISOR_REVIEW", "targetMemberId": "${T.membershipId}", "constructor": {"prototype": {"admin": true}}}`), M4.who),
  ]
  const freeText = await Promise.all(
    [
      { note: 'free text' }, { narrative: 'free text' }, { comment: 'free text' }, { reasonText: 'free text' }, { patientName: `${runId}-home-P` }, { diagnosisCode: key('home-DXA') },
      { amount: '125.25' }, { currencyCode: 'AED' }, { url: 'https://example.invalid/evidence' }, { attachment: 'c3ludGhldGlj' }, { payload: { a: 1 } }, { payerId: MISSING },
    ].map((extra) => escalationPost(N0, { ...followupOf(MISSING, inv(N0).findingId), ...extra }, T.who)),
  )
  check(
    'T020',
    'Injected, PHI, free-text fields refused',
    injection.every((r) => r.status === 400 && !rawError(r.body)) && freeText.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && (await n0Rows()) === 1 && (await unchanged(plus(countsAtStart, 1))),
    "SQL-, operator-, traversal- and prototype-shaped values, and a note, narrative, comment, reason text, patient name, diagnosis, amount, currency, URL, attachment, payload or payer are refused with a safe 400; only N0's one valid escalation and its audit exist",
  )

  // ---------------------------------------------------------------- identity and authorization (T021–T030)
  section('Identity and authorization: 401 before lookup, Viewer and role-less 403, the six upstream reads each on their own, the current assignee escalates from the session, stale assignees refused, an eligible same-organization target, only the nominated member acknowledges, an independent reviewer returns, foreign Claim and intake = missing')
  const anonPost = [await escalationPost(N0, escalateOf(T), anonymous), await escalationPost({ claimId: MISSING, intakeId: MISSING }, escalateOf(T), anonymous), await escalationPost(N0, ackOf(E_N0_ID), anonymous)]
  check('T021', 'Anonymous POST 401 before lookup', anonPost.every((r) => r.status === 401) && (await n0Rows()) === 1, 'no session: 401 on N0 (an escalation and an acknowledgement) and on a missing Claim alike (the lookup never ran)')
  const anonGet = [await historyOf(N0, anonymous), await dispositionOf(N0, anonymous), await historyOf({ claimId: MISSING, intakeId: MISSING }, anonymous), await dispositionOf({ claimId: MISSING, intakeId: MISSING }, anonymous)]
  check('T022', 'Anonymous GET 401 before lookup', anonGet.every((r) => r.status === 401), 'no session: 401 on the history and the disposition of N0 and of a missing Claim')
  const noPermission = [
    await escalationPost(N0, escalateOf(T), asViewer), await escalationPost(N0, ackOf(E_N0_ID), asViewer), await escalationPost(N0, returnOf(E_N0_ID), asViewer),
    await escalationPost(N0, escalateOf(T), NR.who), await escalationPost(N0, ackOf(E_N0_ID), NR.who), await escalationPost(N0, returnOf(E_N0_ID), NR.who),
  ]
  const parentProofOk = parentReadProof.length === 6 && parentReadProof.every((p) => same(p.statuses, [403, 403, 403, 403, 403]))
  const controlOk =
    partialControl.escalate.status === 409 && errorCode(partialControl.escalate.body) === 'EXCEPTION_ESCALATION_NOT_ASSIGNEE' && partialControl.ack.status === 409 && errorCode(partialControl.ack.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' &&
    partialControl.giveBack.status === 409 && partialControl.history.status === 200 && partialControl.disposition.status === 200
  check(
    'T023',
    'Viewer cannot write 403',
    noPermission.every((r) => r.status === 403) && parentProofOk && controlOk && same(ownPermissionProof.raise, [403, 409]) && same(ownPermissionProof.handle, [403, 403, 409]) && same(ownPermissionProof.review, [403, 409]) &&
      same(ownPermissionProof.read, [403, 403]) && partialGone && (await n0Rows()) === 1,
    `a Viewer (exceptionEscalation.read only) and a role-less member are refused 403 on an escalation, an acknowledgement and a return; a member holding everything else but one upstream read is refused 403 on every route for each of the six (${parentReadProof.map((p) => `${p.code}: ${p.statuses.join('/')}`).join('; ')}); without .raise an escalation, without .handle an acknowledgement and follow-up, without .review a return and without .read both reads are 403, while with all of them the routes admit it (${partialControl.escalate.status}/${partialControl.ack.status}/${partialControl.giveBack.status}/${partialControl.history.status}/${partialControl.disposition.status}); the synthetic role is gone`,
  )
  check(
    'T024',
    'Valid current assignee may escalate',
    E_N0.status === 201 && E_N0.body.recordedByMembershipId === M4.membershipId && E_N0.body.recordedByUserId === M4.id && E_N0.body.exceptionIntakeId === N0.intakeId && E_N0.body.eventCode === 'ESCALATE_FOR_REVIEW' &&
      E_N0.body.reasonCode === 'EVIDENCE_INCOMPLETE' && E_N0.body.targetMemberId === T.membershipId && E_N0.body.referencedEscalationEventId === null && E_N0.body.acknowledgementEventId === null &&
      E_N0.body.followupCode === null && E_N0.body.sourceEventId === null && E_N0.body.returnReasonCode === null,
    "M4, to whom A8.2 assigned N0, escalates it (201) as itself through its own membership, numbered 1, with EVIDENCE_INCOMPLETE, nominating T",
  )
  const notAssignee = [
    await escalationPost(RC, escalateOf(T), M1.who), await escalationPost(RC, escalateOf(T), asAdmin), await escalationPost(RC, escalateOf(M4), T.who), await escalationPost(L0, escalateOf(T), M4.who),
    await escalationPost(L0, escalateOf(T), asAdmin), await escalationPost(K, escalateOf(T), M2.who), await escalationPost(G, escalateOf(T), M4.who),
  ]
  check(
    'T025',
    'Stale or reassigned assignee refused',
    notAssignee.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_NOT_ASSIGNEE' && !rawError(r.body)) && (await eventsOf(RC.intakeId)).length === 0 && (await eventsOf(L0.intakeId)).length === 0 &&
      (await eventsOf(K.intakeId)).length === 0 && (await eventsOf(G.intakeId)).length === 0,
    "M1, the harness's Admin and T on RC (assigned to M4), M4 and the Admin on the UNTRIAGED L0, M2 on K (reassigned from M2 to M4: a stale assignee) and M4 on G (assigned to M5) are each refused 409 NOT_ASSIGNEE; nothing recorded",
  )
  const ineligibleTargets = [await escalationPost(RC, escalateOf(NR), M4.who), await escalationPost(RC, escalateOf(viewerMembershipId), M4.who)]
  const missingTarget = await escalationPost(RC, escalateOf(MISSING), M4.who)
  const foreignTargets = [await escalationPost(RC, escalateOf(O), M4.who), await escalationPost(RC, escalateOf(M1X.id), M4.who)]
  const selfTarget = await escalationPost(RC, escalateOf(M4), M4.who)
  check(
    'T026',
    'Target must be same-org eligible member',
    [...ineligibleTargets, partialTarget].every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE' && !rawError(r.body)) && missingTarget.status === 404 &&
      foreignTargets.every((r) => r.status === 404 && same({ ...r.body?.error, requestId: null }, { ...missingTarget.body?.error, requestId: null }) && !JSON.stringify(r.body).includes(O.membershipId)) &&
      selfTarget.status === 409 && errorCode(selfTarget.body) === 'EXCEPTION_ESCALATION_NOT_INDEPENDENT' && (await eventsOf(RC.intakeId)).length === 0 && (await n0Rows()) === 1,
    "nominating a role-less member, the Viewer (no handle permission) or a member lacking one upstream read (exceptionResolution.read) is refused 409 TARGET_NOT_ELIGIBLE; the other tenant's member, M1's own membership in the other tenant and a missing member are the identical 404; nominating the escalator itself is 409 NOT_INDEPENDENT; nothing recorded",
  )
  const wrongAcknowledgers = [await escalationPost(N0, ackOf(E_N0_ID), RW.who), await escalationPost(N0, ackOf(E_N0_ID), asAdmin)]
  const A_N0 = await escalationPost(N0, ackOf(E_N0_ID), T.who)
  const A_N0_ID = (A_N0.body?.escalationEventId ?? MISSING) as string
  check(
    'T027',
    'Only nominated member acknowledges',
    wrongAcknowledgers.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE' && /only the nominated member acknowledges/.test(errorMessage(r.body))) && A_N0.status === 201 &&
      A_N0.body.recordedByMembershipId === T.membershipId && A_N0.body.recordedByUserId === T.id && A_N0.body.referencedEscalationEventId === E_N0_ID && A_N0.body.sequence === 2,
    "RW and the harness's Admin acknowledging N0's escalation (both hold the handle permission) are refused 409; T, the nominated member, acknowledges it (201, event 2, naming the escalation)",
  )
  const FU_N0 = await escalationPost(N0, followupOf(A_N0_ID, inv(N0).findingId), T.who)
  const FU_N0_ID = (FU_N0.body?.escalationEventId ?? MISSING) as string
  const notIndependent = [await escalationPost(N0, returnOf(E_N0_ID), M4.who), await escalationPost(N0, returnOf(E_N0_ID), T.who)]
  const reviewerNoPermission = [await recordEscalationEvent(N0.claimId, N0.intakeId, returnOf(E_N0_ID), viewerUser.id), await recordEscalationEvent(N0.claimId, N0.intakeId, returnOf(E_N0_ID), NR.id)]
  check(
    'T028',
    'Independent return reviewer required',
    FU_N0.status === 201 && notIndependent.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_NOT_INDEPENDENT' && /independent of its escalator and its nominated member/.test(errorMessage(r.body))) &&
      reviewerNoPermission.every((r) => r.ok === false && r.code === 'EXCEPTION_ESCALATION_NOT_INDEPENDENT') && noPermission[2].status === 403 && same(ownPermissionProof.review, [403, 409]) && (await n0Rows()) === 3,
    "after T's follow-up on N0, a return by M4 (the escalator and current assignee) or by T (the nominated member) is refused 409 NOT_INDEPENDENT; a Viewer and a role-less member are 403 at the route and refused by the service itself (no review permission); a return by the current assignee alone is refused on K (T086); nothing more recorded",
  )
  const missingEnvelope = (r: { body: any }) => ({ ...r.body?.error, requestId: null })
  const foreignClaim = [await escalationPost(F, escalateOf(T), asAdmin), await historyOf(F), await dispositionOf(F)]
  const missingClaimReads = [await escalationPost({ claimId: MISSING, intakeId: F.intakeId }, escalateOf(T), asAdmin), await historyOf({ claimId: MISSING, intakeId: F.intakeId }), await dispositionOf({ claimId: MISSING, intakeId: F.intakeId })]
  const foreignIntake = [await escalationPost({ claimId: N0.claimId, intakeId: F.intakeId }, escalateOf(T), M4.who), await historyOf({ claimId: N0.claimId, intakeId: F.intakeId }), await dispositionOf({ claimId: N0.claimId, intakeId: F.intakeId })]
  const otherClaimIntake = [await escalationPost({ claimId: N0.claimId, intakeId: RC.intakeId }, escalateOf(T), M4.who), await historyOf({ claimId: N0.claimId, intakeId: RC.intakeId })]
  const missingIntake = [await escalationPost({ claimId: N0.claimId, intakeId: MISSING }, escalateOf(T), M4.who), await historyOf({ claimId: N0.claimId, intakeId: MISSING }), await dispositionOf({ claimId: N0.claimId, intakeId: MISSING })]
  check(
    'T029',
    'Foreign Claim/intake safe 404',
    foreignClaim.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingClaimReads[i]))) && foreignIntake.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[i]))) &&
      otherClaimIntake.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[0]))) && (await eventsOf(F.intakeId)).length === 0 && (await eventsOf(RC.intakeId)).length === 0,
    "another organization's Claim and intake get exactly the missing-Claim envelope on all three routes; the other tenant's intake, or another Claim's intake of this tenant, named under N0's Claim is exactly the missing-intake 404; nothing recorded",
  )
  const sameOrgReads = [await historyOf(N0), await dispositionOf(N0), await historyOf(N0, asViewer), await dispositionOf(N0, asViewer), await historyOf(N0, RW.who), await dispositionOf(RS, asViewer)]
  const readProofOk = parentReadProof.every((p) => p.statuses[3] === 403 && p.statuses[4] === 403) && same(ownPermissionProof.read, [403, 403])
  check(
    'T030',
    'Admin/Viewer reads agree',
    sameOrgReads.every((r) => r.status === 200 && r.body.contractVersion === CONTRACT) && sameOrgReads[0].body.items.length === 3 && sameOrgReads[1].body.state === 'FOLLOWUP_ACTIVE' &&
      withoutEvaluatedAt(sameOrgReads[0].body) === withoutEvaluatedAt(sameOrgReads[2].body) && withoutEvaluatedAt(sameOrgReads[1].body) === withoutEvaluatedAt(sameOrgReads[3].body) &&
      withoutEvaluatedAt(sameOrgReads[0].body) === withoutEvaluatedAt(sameOrgReads[4].body) && readProofOk,
    "the Admin, a Viewer and another member of Org A read N0's history and disposition (and RS's) with 200 and identical bodies; N0 holds its escalation, acknowledgement and one follow-up (FOLLOWUP_ACTIVE); without any one of the six upstream reads, or without exceptionEscalation.read, both reads are 403",
  )

  // ---------------------------------------------------------------- owner basis (T031–T040)
  section('Owner basis: NO_ESCALATION is zero rows; the A8.7 gate (resolved never escalated, nothing while a decision is pending, RETURNED_FOR_REWORK qualifies); the current A8.2 assignment; the A8.3, A8.5, A8.6 and A8.7 records read as recorded, never duplicated or rewritten; nothing automatic; an inconsistent owner fails closed')
  check(
    'T031',
    'Zero rows derives NO_ESCALATION',
    noEscalationW.rows === 0 && noEscalationW.disposition.status === 200 && noEscalationW.disposition.body.state === 'NO_ESCALATION' && noEscalationW.disposition.body.eventCount === 0 &&
      noEscalationW.disposition.body.lastSequence === null && noEscalationW.disposition.body.escalation === null && noEscalationW.disposition.body.acknowledgement === null &&
      same(noEscalationW.disposition.body.followups, []) && noEscalationW.disposition.body.returned === null && same(noEscalationW.history.body.items, []) && noEscalationRS.state === 'NO_ESCALATION' &&
      !COLUMNS.some((c) => /state|status|current|latest/.test(c)),
    'before any event W (A8.7 RETURNED_FOR_REWORK) and RS (A8.7 RESOLVED_INTERNAL) have zero rows and derive NO_ESCALATION (an escalation is never inferred from another owner); the table has no state, status, current or latest column',
  )
  const resolvedRoute = await escalationPost(RS, escalateOf(T), M4.who)
  const resolvedService = await recordEscalationEvent(RS.claimId, RS.intakeId, escalateOf(T, 'POLICY_GUIDANCE_REQUIRED'), M4.id)
  const resolvedDirect = await directInsert([rowOf(RS)])
  check(
    'T032',
    'A8.7 RESOLVED_INTERNAL blocks escalation',
    (await resolutionDispositionOf(RS)).body.state === 'RESOLVED_INTERNAL' && resolvedRoute.status === 409 && errorCode(resolvedRoute.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' &&
      /RESOLVED_INTERNAL under A8\.7; a resolved exception is never escalated/.test(errorMessage(resolvedRoute.body)) && resolvedService.ok === false && resolvedService.code === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' &&
      resolvedDirect.refused && /exception_escalation_transition: the exception is RESOLVED_INTERNAL under A8\.7/.test(resolvedDirect.message) && resolvedDirect.clean && (await eventsOf(RS.intakeId)).length === 0,
    "RS is RESOLVED_INTERNAL under A8.7: its assignee's escalation is refused 409 through the route and the service, and a direct row by the database guard; nothing recorded",
  )
  // EP: an escalation is opened and acknowledged; then an A8.7 request becomes pending on it.
  const E_EP = await escalationPost(EP, escalateOf(T), M4.who)
  const A_EP = await escalationPost(EP, ackOf(E_EP.body?.escalationEventId ?? MISSING), T.who)
  const RQ_EP = await requestResolution(EP, work(EP), M4.who)
  const pendingRefused = [await escalationPost(PD, escalateOf(T), M4.who), await escalationPost(EP, followupOf(A_EP.body?.escalationEventId ?? MISSING, inv(EP).findingId), T.who)]
  const pendingDirect = await directInsert([rowOf(PD)])
  check(
    'T033',
    'A8.7 pending decision blocks escalation',
    (await resolutionDispositionOf(PD)).body.state === 'AWAITING_RESOLUTION_DECISION' && E_EP.status === 201 && A_EP.status === 201 &&
      pendingRefused.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /awaits a decision/.test(errorMessage(r.body))) && pendingDirect.refused &&
      /exception_escalation_transition: an A8\.7 resolution request awaits a decision/.test(pendingDirect.message) && pendingDirect.clean && (await eventsOf(PD.intakeId)).length === 0 && (await eventsOf(EP.intakeId)).length === 2,
    "while PD's A8.7 request awaits a decision its escalation is refused 409 (and a direct row by the guard); EP was escalated and acknowledged, then M4 requested an A8.7 resolution: T's follow-up on EP is refused 409 while that request is pending (D1: one governed review at a time)",
  )
  // W (A8.7 RETURNED_FOR_REWORK) is escalated; PD's and EP's requests are returned by DR, after which both move on.
  const countsBeforeEW = await counts()
  const E_W = await escalationPost(W, escalateOf(T), M1.who)
  const E_W_ID = (E_W.body?.escalationEventId ?? MISSING) as string
  const ewHashAtCreation = await rowHash(E_W_ID)
  const countsAfterEW = await counts()
  const dispositionEW = (await dispositionOf(W)).body
  await decideResolution(PD, RQ_PD, 'RETURN_FOR_REWORK')
  await decideResolution(EP, RQ_EP, 'RETURN_FOR_REWORK')
  const E_PD = await escalationPost(PD, escalateOf(T, 'POLICY_GUIDANCE_REQUIRED'), M4.who)
  const FU_EP = await escalationPost(EP, followupOf(A_EP.body?.escalationEventId ?? MISSING, inv(EP).findingId), T.who)
  check(
    'T034',
    'A8.7 returned-for-rework can qualify',
    wResolutionBefore.disposition.includes('"state":"RETURNED_FOR_REWORK"') && E_W.status === 201 && E_W.body.recordedByMembershipId === M1.membershipId && E_W.body.sequence === 1 && E_PD.status === 201 && FU_EP.status === 201 &&
      (await resolutionDispositionOf(PD)).body.state === 'RETURNED_FOR_REWORK' && (await resolutionDispositionOf(EP)).body.state === 'RETURNED_FOR_REWORK',
    "W's A8.7 request was RETURNED_FOR_REWORK (terminal in v1): M1, its assignee, escalates it (201) — the governed path for an exception that still needs attention; once DR returned PD's and EP's requests, PD's escalation and T's follow-up on EP are recorded (201)",
  )
  const E_TR = await escalationPost(TR, escalateOf(T), M4.who)
  const A_TR = await escalationPost(TR, ackOf(E_TR.body?.escalationEventId ?? MISSING), T.who)
  const A_TR_ID = (A_TR.body?.escalationEventId ?? MISSING) as string
  await triage(TR, returnToTriage)
  const trPaused = [await escalationPost(TR, followupOf(A_TR_ID, inv(TR).findingId), T.who), await escalationPost(L0, escalateOf(T), M4.who)]
  const trDirect = await directInsert([followupRow(TR, 3, A_TR_ID, inv(TR).findingId, 'INVESTIGATION_FINDING')])
  await triage(TR, assignTo(M4))
  const FU_TR = await escalationPost(TR, followupOf(A_TR_ID, inv(TR).findingId), T.who)
  check(
    'T035',
    'A8.2 assignment required now',
    E_TR.status === 201 && A_TR.status === 201 && trPaused[0].status === 409 && errorCode(trPaused[0].body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /not assigned now/.test(errorMessage(trPaused[0].body)) &&
      trPaused[1].status === 409 && errorCode(trPaused[1].body) === 'EXCEPTION_ESCALATION_NOT_ASSIGNEE' && trDirect.refused && /exception_escalation_transition: the exception is not assigned/.test(trDirect.message) &&
      trDirect.clean && FU_TR.status === 201 && FU_TR.body.sequence === 3,
    "TR was escalated and acknowledged, then returned to triage by A8.2: T's follow-up is refused 409 (not assigned now) and a direct row by the guard; L0 (never assigned) cannot be escalated; once A8.2 assigned TR again the same follow-up is recorded (201, event 3): a reassignment never cancels an escalation (D4)",
  )
  const moduleCodeEarly = committedProductionCodeOf([MODULE_DIR]).code
  const fuN0Row = (await eventsOf(N0.intakeId))[2]
  check(
    'T036',
    'A8.3 owner evidence not duplicated',
    (await ownerHash(INVESTIGATION_TABLE)) === ownerSnapshotBefore.investigation && fuN0Row?.sourceEventId === inv(N0).findingId && fuN0Row?.sourceEventKind === 'INVESTIGATION_FINDING' &&
      !COLUMNS.some((c) => /finding_code|evidence_kind|evidence_record|basis_code/.test(c)) && !/exceptionInvestigationEvent|recordInvestigationEvent|INSERT INTO "exception_investigation/.test(moduleCodeEarly) &&
      withoutEvaluatedAt((await investigationSummaryOf(W)).body) === wInvestigationBefore,
    "every A8.3 event of this run is byte-identical; a follow-up stores only the cited A8.3 event's id and its server-owned kind (N0's finding: INVESTIGATION_FINDING), never its finding code, evidence kind or record; the module writes no A8.3 record and W's investigation summary reads the same",
  )
  check(
    'T037',
    'A8.5 plan historical facts unchanged',
    (await ownerHash(REMEDIATION_TABLE)) === ownerSnapshotBefore.remediation && withoutEvaluatedAt((await remediationDispositionOf(W)).body) === wRemediationBefore && JSON.parse(wRemediationBefore).state === 'APPROVED_FOR_PLANNING' &&
      !/recordRemediationEvent|exceptionRemediationEvent\.|INSERT INTO "exception_remediation_events/.test(moduleCodeEarly),
    "every A8.5 event of this run is byte-identical; W's A8.5 disposition still reads APPROVED_FOR_PLANNING: A8.8 reads the plan, never approves it again",
  )
  check(
    'T038',
    'A8.6 work verification not rewritten',
    (await ownerHash(WORK_TABLE)) === ownerSnapshotBefore.work && withoutEvaluatedAt((await workDispositionOf(W)).body) === wWorkBefore && JSON.parse(wWorkBefore).state === 'VERIFIED_INTERNAL_WORK' &&
      !/recordWorkEvent|exceptionRemediationWorkEvent\.|INSERT INTO "exception_remediation_work/.test(moduleCodeEarly),
    "every A8.6 event of this run is byte-identical; W's A8.6 disposition still reads VERIFIED_INTERNAL_WORK as recorded; the module never re-verifies or writes an A8.6 record",
  )
  const quietIntakes = [RS, S, J, AT, RC, G, H]
  const autoRows = await prisma.exceptionEscalationEvent.count({ where: { exceptionIntakeId: { in: quietIntakes.map((k) => k.intakeId) } } })
  const otherOwnersCode = committedProductionCodeOf(['backend/src/modules/exception-resolution', 'backend/src/modules/exception-remediation-work', 'backend/src/modules/exception-triage', 'backend/src/modules/exception-investigation']).code
  check(
    'T039',
    'No automatic event from other owner',
    autoRows === 0 && (await Promise.all(quietIntakes.map(async (k) => (await dispositionOf(k)).body.state === 'NO_ESCALATION'))).every(Boolean) && !/exception-escalation|exceptionEscalation/.test(otherOwnersCode) &&
      !/setInterval|setTimeout\([^)]*escalat|cron|enqueue/.test(moduleCodeEarly),
    `the ${quietIntakes.length} intakes on which nobody escalated (RS resolved under A8.7, the others with recorded A8.3/A8.6 work) hold no escalation event and derive NO_ESCALATION; no other owner knows A8.8, and nothing escalates on a timer`,
  )
  // An owner history planted inconsistent (triggers off, rolled back): the A8.8 write on that transaction fails closed.
  const plantResolution = (tx: DbClient, k: Intake, sequence: number) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${RESOLUTION_TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, request_event_id, decision_code, recorded_by_membership_id, recorded_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'A8-RESOLUTION-DECISION-1', $5::int, 'DECIDE_INTERNAL_RESOLUTION', $6::uuid, 'CONFIRM_INTERNAL_RESOLUTION', $7::uuid, $8::uuid)`,
      randomUUID(), k.intakeId, k.organizationId, k.claimId, sequence, MISSING, DR.membershipId, DR.id,
    )
  const inconsistentResolution = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
    await plantResolution(tx, RC, 2)
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return recordEscalationEventOn(RC.claimId, RC.intakeId, escalateOf(T), M4.id, tx)
  })
  const inconsistentTriage = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
    await tx.$executeRawUnsafe(
      `INSERT INTO ${TRIAGE_TABLE} SELECT (jsonb_populate_record(NULL::${TRIAGE_TABLE}, to_jsonb(t) || jsonb_build_object('id', gen_random_uuid(), 'sequence', t.sequence + 5))).* FROM ${TRIAGE_TABLE} t WHERE t.exception_intake_id = $1::uuid ORDER BY t.sequence DESC LIMIT 1`,
      RC.intakeId,
    )
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return recordEscalationEventOn(RC.claimId, RC.intakeId, escalateOf(T), M4.id, tx)
  })
  check(
    'T040',
    'Inconsistent upstream chain fails closed',
    inconsistentResolution.value?.ok === false && inconsistentResolution.value.code === 'EXCEPTION_ESCALATION_CONFLICT' && inconsistentResolution.clean && inconsistentTriage.value?.ok === false &&
      /^(EXCEPTION_ESCALATION_CONFLICT|EXCEPTION_ESCALATION_NOT_ASSIGNEE)$/.test(inconsistentTriage.value.code) && inconsistentTriage.clean && (await eventsOf(RC.intakeId)).length === 0,
    `with an A8.7 history planted out of sequence on RC the A8.7 owner cannot be read and RC's escalation fails closed (409 CONFLICT); with an A8.2 history planted with a gap the triage owner cannot establish the assignment and the escalation is refused (${inconsistentTriage.value?.ok === false ? inconsistentTriage.value.code : 'recorded'}); both rolled back, nothing recorded`,
  )

  // ---------------------------------------------------------------- legal event transitions (T041–T050)
  section("Legal transitions on W (A8.7 RETURNED_FOR_REWORK): the escalation awaits the nominated member, an independent acknowledgement, typed follow-ups citing every A8.3/A8.6 source kind, a return by an independent reviewer, terminal in v1")
  const ewAudits = await auditsOfEvent(E_W_ID)
  check(
    'T041',
    'Valid escalation becomes awaiting acknowledgement',
    E_W.status === 201 && dispositionEW.state === 'AWAITING_ACKNOWLEDGEMENT' && dispositionEW.escalation?.escalationEventId === E_W_ID && dispositionEW.acknowledgement === null && same(dispositionEW.followups, []) &&
      dispositionEW.eventCount === 1 && same(countsAfterEW, plus(countsBeforeEW, 1)) && ewAudits.length === 1 && ewAudits[0].actionCode === 'exception_escalation.recorded' && ewAudits[0].organizationId === org &&
      ewAudits[0].actorUserId === M1.id && ewAudits[0].beforeState === null,
    "M1's escalation of W derives AWAITING_ACKNOWLEDGEMENT naming it; exactly one escalation row and one audit (exception_escalation.recorded, Org A, actor M1) were added and nothing else changed",
  )
  const ewRow = (await eventsOf(W.intakeId))[0]
  check(
    'T042',
    'Exact target recorded in escalation',
    E_W.body.targetMemberId === T.membershipId && ewRow?.targetMemberId === T.membershipId && (ewAudits[0]?.afterState as any)?.targetMemberId === T.membershipId && dispositionEW.escalation?.targetMemberId === T.membershipId &&
      dispositionEW.escalation?.escalatedByMembershipId === M1.membershipId && dispositionEW.escalation?.escalatedByUserId === M1.id && E_W.body.reasonCode === 'NEEDS_SUPERVISOR_REVIEW',
    "T's membership is exactly the nominated member answered, stored, audited and derived for W's escalation, with M1 as escalator and NEEDS_SUPERVISOR_REVIEW",
  )
  const wDispositions: any[] = [dispositionEW]
  const countsBeforeAW = await counts()
  const A_W = await escalationPost(W, ackOf(E_W_ID), T.who)
  const A_W_ID = (A_W.body?.escalationEventId ?? MISSING) as string
  wDispositions.push((await dispositionOf(W)).body)
  check(
    'T043',
    'Independent target acknowledges',
    A_W.status === 201 && A_W.body.sequence === 2 && A_W.body.eventCode === 'ACKNOWLEDGE_ESCALATION' && A_W.body.referencedEscalationEventId === E_W_ID && A_W.body.recordedByMembershipId === T.membershipId &&
      A_W.body.recordedByUserId === T.id && T.id !== M1.id && same(await counts(), plus(countsBeforeAW, 1)),
    "T — the nominated member, a different user and membership from the escalator M1 — acknowledges W's escalation (201, event 2); exactly one row and one audit were added",
  )
  check(
    'T044',
    'Acknowledgement enters FOLLOWUP_ACTIVE',
    wDispositions[1].state === 'FOLLOWUP_ACTIVE' && wDispositions[1].acknowledgement?.acknowledgementEventId === A_W_ID && same(Object.keys(wDispositions[1].acknowledgement ?? {}), ACK_KEYS) &&
      wDispositions[1].acknowledgement?.acknowledgedByMembershipId === T.membershipId && same(wDispositions[1].followups, []) && wDispositions[1].escalation?.escalationEventId === E_W_ID,
    "W derives FOLLOWUP_ACTIVE naming T's acknowledgement (exactly its four keys), the escalation unchanged and no follow-up yet",
  )
  const FU1_W = await escalationPost(W, followupOf(A_W_ID, IW.findingId, 'SOURCE_RECHECK_RECORDED'), T.who)
  wDispositions.push((await dispositionOf(W)).body)
  check(
    'T045',
    'Valid typed follow-up appended',
    FU1_W.status === 201 && FU1_W.body.sequence === 3 && FU1_W.body.acknowledgementEventId === A_W_ID && FU1_W.body.followupCode === 'SOURCE_RECHECK_RECORDED' && FU1_W.body.sourceEventId === IW.findingId &&
      FU1_W.body.sourceEventKind === 'INVESTIGATION_FINDING' && FU1_W.body.recordedByMembershipId === T.membershipId && wDispositions[2].followups.length === 1 && same(Object.keys(wDispositions[2].followups[0] ?? {}), FOLLOWUP_KEYS),
    "T records SOURCE_RECHECK_RECORDED citing W's A8.3 finding (201, event 3); the server established the kind INVESTIGATION_FINDING from the A8.3 owner; W derives one follow-up",
  )
  const duplicateFU = await escalationPost(W, followupOf(A_W_ID, IW.findingId, 'SOURCE_RECHECK_RECORDED'), T.who)
  const FU2_W = await escalationPost(W, followupOf(A_W_ID, WW.verificationId, 'INTERNAL_POLICY_REVIEWED'), T.who)
  wDispositions.push((await dispositionOf(W)).body)
  const FU3_W = await escalationPost(W, followupOf(A_W_ID, IW.linkId, 'SOURCE_RECHECK_RECORDED'), T.who)
  wDispositions.push((await dispositionOf(W)).body)
  const FU4_W = await escalationPost(W, followupOf(A_W_ID, WW.reportId, 'ADDITIONAL_INFORMATION_REQUESTED'), T.who)
  wDispositions.push((await dispositionOf(W)).body)
  check(
    'T046',
    'Second distinct follow-up allowed',
    duplicateFU.status === 409 && errorCode(duplicateFU.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /already recorded/.test(errorMessage(duplicateFU.body)) &&
      [FU2_W, FU3_W, FU4_W].every((r, i) => r.status === 201 && r.body.sequence === 4 + i) && FU2_W.body.sourceEventKind === 'WORK_VERIFICATION' && FU3_W.body.sourceEventKind === 'INVESTIGATION_EVIDENCE_LINK' &&
      FU4_W.body.sourceEventKind === 'WORK_REPORT' && wDispositions[5].followups.length === 4,
    "an exact repeat of T's first follow-up (same code, same record) is refused 409; three distinct follow-ups are recorded (events 4–6): INTERNAL_POLICY_REVIEWED citing W's A8.6 verification (WORK_VERIFICATION), SOURCE_RECHECK_RECORDED citing its A8.3 link (INVESTIGATION_EVIDENCE_LINK) and ADDITIONAL_INFORMATION_REQUESTED citing its A8.6 report (WORK_REPORT)",
  )
  const countsBeforeReturn = await counts()
  const R_W = await escalationPost(W, returnOf(E_W_ID, 'FOLLOWUP_RECORDED'), RW.who)
  const R_W_ID = (R_W.body?.escalationEventId ?? MISSING) as string
  wDispositions.push((await dispositionOf(W)).body)
  check(
    'T047',
    'Reviewer may return after follow-up',
    R_W.status === 201 && R_W.body.sequence === 7 && R_W.body.referencedEscalationEventId === E_W_ID && R_W.body.returnReasonCode === 'FOLLOWUP_RECORDED' && R_W.body.recordedByMembershipId === RW.membershipId &&
      ![M1.membershipId, T.membershipId].includes(RW.membershipId) && same(await counts(), plus(countsBeforeReturn, 1)) && same(Object.keys(wDispositions[6].returned ?? {}), RETURN_KEYS),
    "RW — holding the review permission, independent of the escalator M1, the nominated member T and the current assignee M1 — returns W's escalation with FOLLOWUP_RECORDED (201, event 7)",
  )
  const wTriageAfterReturn = (await triageDispositionOf(W)).body
  check(
    'T048',
    'Return ends escalation workflow v1',
    wDispositions[6].state === 'RETURNED_TO_OWNER' && wDispositions[6].returned?.returnEventId === R_W_ID && wTriageAfterReturn.dispositionCode === 'ASSIGNED' && wTriageAfterReturn.assignedMemberId === M1.membershipId &&
      withoutEvaluatedAt(wTriageAfterReturn) === wTriageBefore && (await resolutionDispositionOf(W)).body.state === 'RETURNED_FOR_REWORK',
    "W derives RETURNED_TO_OWNER (terminal in v1); the return is a process log, not a reassignment: W's A8.2 disposition still assigns M1 exactly as before, and its A8.7 state is still RETURNED_FOR_REWORK",
  )
  const expectedStates = ['AWAITING_ACKNOWLEDGEMENT', 'FOLLOWUP_ACTIVE', 'FOLLOWUP_ACTIVE', 'FOLLOWUP_ACTIVE', 'FOLLOWUP_ACTIVE', 'FOLLOWUP_ACTIVE', 'RETURNED_TO_OWNER']
  check(
    'T049',
    'Each event yields correct disposition',
    same(wDispositions.map((d) => d.state), expectedStates) && same(wDispositions.map((d) => d.followups.length), [0, 0, 1, 2, 3, 4, 4]) && same(wDispositions.map((d) => d.eventCount), [1, 2, 3, 4, 5, 6, 7]) &&
      same(wDispositions.map((d) => d.lastSequence), [1, 2, 3, 4, 5, 6, 7]) && wDispositions.slice(1).every((d) => d.acknowledgement?.acknowledgementEventId === A_W_ID),
    `after each of W's seven events the disposition is exactly ${expectedStates.join(' → ')}, with 0,0,1,2,3,4,4 follow-ups and the event count and last sequence one more each time`,
  )
  const wAnswers = [E_W, A_W, FU1_W, FU2_W, FU3_W, FU4_W, R_W].map((r) => JSON.stringify(r.body))
  const wHistoryNow = (await historyOf(W)).body.items.map((item: unknown) => JSON.stringify(item))
  check(
    'T050',
    'Prior event DTO bytes remain identical',
    same(wHistoryNow, wAnswers) && (await rowHash(E_W_ID)) === ewHashAtCreation && (await rowHash(E_N0_ID)) === en0HashBefore,
    "W's history after the return holds each of its seven events byte-for-byte as the route answered it when recorded; N0's first escalation row hashes exactly as when it was written",
  )

  // ---------------------------------------------------------------- invalid transitions (T051–T060)
  section('Invalid transitions on J, H, N0 and W: an acknowledgement without an escalation, a follow-up before acknowledgement, a return before a follow-up, a second escalation, the wrong acknowledger, a self-acknowledgement, an unsupported source, the wrong escalation, anything after the return, nothing written on a refusal')
  const countsBeforeIllegal = await counts()
  const noEscalation = [await escalationPost(J, ackOf(MISSING), T.who), await escalationPost(J, followupOf(MISSING, inv(J).findingId), T.who), await escalationPost(J, returnOf(MISSING), RW.who)]
  check(
    'T051',
    'Cannot acknowledge without escalation',
    noEscalation.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /no escalation of this exception is open/.test(errorMessage(r.body))) && (await eventsOf(J.intakeId)).length === 0,
    'an acknowledgement, a follow-up or a return on J, which holds no escalation, is refused 409; nothing recorded',
  )
  const E_J = await escalationPost(J, escalateOf(T), M4.who)
  const E_J_ID = (E_J.body?.escalationEventId ?? MISSING) as string
  const beforeAck = [await escalationPost(J, followupOf(MISSING, inv(J).findingId), T.who), await escalationPost(J, followupOf(E_J_ID, inv(J).findingId), T.who)]
  check(
    'T052',
    'Cannot follow up before acknowledgement',
    E_J.status === 201 && beforeAck.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /only after the nominated member acknowledges/.test(errorMessage(r.body))) && (await eventsOf(J.intakeId)).length === 1,
    "after M4 escalated J to T, T's follow-ups before any acknowledgement (naming no acknowledgement, or the escalation itself) are refused 409",
  )
  const returnBeforeAck = await escalationPost(J, returnOf(E_J_ID), RW.who)
  const A_J = await escalationPost(J, ackOf(E_J_ID), T.who)
  const A_J_ID = (A_J.body?.escalationEventId ?? MISSING) as string
  const returnBeforeFollowup = await escalationPost(J, returnOf(E_J_ID), RW.who)
  check(
    'T053',
    'Cannot return before follow-up',
    [returnBeforeAck, returnBeforeFollowup].every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /at least one follow-up is recorded/.test(errorMessage(r.body))) && A_J.status === 201 &&
      (await eventsOf(J.intakeId)).length === 2,
    "RW's return of J before its acknowledgement and again after it but before any follow-up is refused 409 each time; only T's acknowledgement was added",
  )
  const secondEscalation = [await escalationPost(J, escalateOf(T), M4.who), await escalationPost(N0, escalateOf(RW), M4.who), await escalationPost(W, escalateOf(T), M1.who)]
  const eS1 = randomUUID()
  const secondDirect = await directInsert([rowOf(S, { id: eS1 }), rowOf(S, { sequence: 2, target_member_id: RW.membershipId })])
  check(
    'T054',
    'Duplicate escalation while active 409',
    secondEscalation.slice(0, 2).every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /already open/.test(errorMessage(r.body))) && secondEscalation[2].status === 409 &&
      secondDirect.refused && /exception_escalation_transition: an escalation of this intake already exists/.test(secondDirect.message) && secondDirect.clean,
    "a second escalation of J (awaiting) and of N0 (follow-up active, another target) is refused 409, as is one of W after its return; a second direct escalation row on S is refused by the guard (one cycle per intake in v1)",
  )
  const E_H = await escalationPost(H, escalateOf(T3), M4.who)
  const E_H_ID = (E_H.body?.escalationEventId ?? MISSING) as string
  const wrongAcker = [await escalationPost(H, ackOf(E_H_ID), T.who), await escalationPost(H, ackOf(E_H_ID), RW.who)]
  const wrongAckerService = await recordEscalationEvent(H.claimId, H.intakeId, ackOf(E_H_ID), DR.id)
  check(
    'T055',
    'Wrong nominated acknowledger 409',
    E_H.status === 201 && wrongAcker.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE') && wrongAckerService.ok === false &&
      wrongAckerService.code === 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE' && (await eventsOf(H.intakeId)).length === 1,
    "H was escalated to T3: T (the nominated member of other escalations), RW and DR acknowledging it are each refused 409 TARGET_NOT_ELIGIBLE (route and service); nothing recorded",
  )
  const selfAck = [await escalationPost(H, ackOf(E_H_ID), M4.who)]
  const selfAckService = await recordEscalationEvent(H.claimId, H.intakeId, ackOf(E_H_ID), M4.id)
  const selfAckDirect = await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })])
  const A_H = await escalationPost(H, ackOf(E_H_ID), T3.who)
  const A_H_ID = (A_H.body?.escalationEventId ?? MISSING) as string
  check(
    'T056',
    'Escalator cannot self-acknowledge',
    selfAck[0].status === 409 && errorCode(selfAck[0].body) === 'EXCEPTION_ESCALATION_NOT_INDEPENDENT' && /never acknowledged by its own escalator/.test(errorMessage(selfAck[0].body)) && selfAckService.ok === false &&
      selfAckService.code === 'EXCEPTION_ESCALATION_NOT_INDEPENDENT' && selfAckDirect.refused && /exception_escalation_independence/.test(selfAckDirect.message) && selfAckDirect.clean && A_H.status === 201,
    "M4 acknowledging its own escalation of H is refused 409 NOT_INDEPENDENT through the route and the service, and a direct self-acknowledgement on S by the guard; T3 then acknowledges H (201)",
  )
  const n0TriageIds = (await prisma.exceptionTriageEvent.findMany({ where: { exceptionIntakeId: N0.intakeId }, select: { id: true } })).map((row) => row.id)
  const unsupported = [
    await escalationPost(N0, followupOf(A_N0_ID, n0TriageIds[0]), T.who), await escalationPost(N0, followupOf(A_N0_ID, N0.intakeId), T.who), await escalationPost(N0, followupOf(A_N0_ID, E_N0_ID), T.who),
    await escalationPost(PD, followupOf(MISSING, RQ_PD), T.who), await escalationPost(PD, followupOf(MISSING, (plans.get(PD.intakeId) as Plan).proposalId), T.who),
  ]
  const missingSource = await escalationPost(N0, followupOf(A_N0_ID, MISSING), T.who)
  const foreignSource = [await escalationPost(N0, followupOf(A_N0_ID, IW.findingId), T.who), await escalationPost(N0, followupOf(A_N0_ID, inv(F).findingId), T.who), await escalationPost(N0, followupOf(A_N0_ID, WW.verificationId), T.who)]
  const sourceDirect = [
    await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: MISSING }), followupRow(S, 3, MISSING, inv(S).findingId, 'WORK_REPORT')]),
    await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: MISSING }), followupRow(S, 3, MISSING, inv(S).linkId, 'INVESTIGATION_FINDING')]),
    await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: MISSING }), followupRow(S, 3, MISSING, IW.findingId, 'INVESTIGATION_FINDING')]),
    await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: MISSING }), followupRow(S, 3, MISSING, MISSING, 'WORK_VERIFICATION')]),
  ]
  check(
    'T057',
    'Wrong source kind fails closed',
    unsupported.every((r) => r.status === 409 && errorCode(r.body) === 'UNSUPPORTED_REFERENCE' && !rawError(r.body)) && missingSource.status === 404 &&
      foreignSource.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingSource)) && !JSON.stringify(r.body).includes(IW.findingId)) &&
      sourceDirect.every((r) => r.refused && /exception_escalation_source/.test(r.message) && r.clean) && (await n0Rows()) === 3,
    "citing N0's own A8.2 triage event, its intake or its escalation, or PD's A8.7 request or A8.5 proposal, is refused 409 UNSUPPORTED_REFERENCE; W's finding and verification and the other tenant's finding are exactly the missing-source 404; direct rows on S citing its finding as a WORK_REPORT, its link as a finding, W's finding or a missing event are refused by the source guard — never a generic foreign UUID",
  )
  const wrongEscalation = [await escalationPost(N0, returnOf(MISSING), RW.who), await escalationPost(N0, returnOf(A_N0_ID), RW.who), await escalationPost(N0, returnOf(E_W_ID), RW.who)]
  const wrongAckRef = [await escalationPost(N0, followupOf(E_N0_ID, inv(N0).linkId), T.who), await escalationPost(N0, followupOf(A_W_ID, inv(N0).linkId), T.who)]
  check(
    'T058',
    'Return under wrong escalation refused',
    wrongEscalation.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /names exactly the open escalation/.test(errorMessage(r.body))) &&
      wrongAckRef.every((r) => r.status === 409 && /names exactly the escalation's acknowledgement/.test(errorMessage(r.body))) && (await n0Rows()) === 3,
    "on N0 a return naming no escalation, its acknowledgement or W's escalation, and a follow-up naming its escalation or W's acknowledgement, are each refused 409; nothing recorded",
  )
  const afterReturn = [
    await escalationPost(W, escalateOf(T), M1.who), await escalationPost(W, ackOf(E_W_ID), T.who), await escalationPost(W, followupOf(A_W_ID, IW.findingId, 'INTERNAL_POLICY_REVIEWED'), T.who),
    await escalationPost(W, returnOf(E_W_ID, 'FURTHER_WORK_REQUIRED'), RW2.who),
  ]
  const afterReturnDirect = await directInsert([followupRow(W, 8, A_W_ID, IW.findingId, 'INVESTIGATION_FINDING', { followup_code: 'INTERNAL_POLICY_REVIEWED' })])
  check(
    'T059',
    'Any event after terminal return 409',
    afterReturn.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /RETURNED_TO_OWNER, which is terminal in v1/.test(errorMessage(r.body))) &&
      afterReturnDirect.refused && /exception_escalation_transition: the escalation of this intake was returned to its owner/.test(afterReturnDirect.message) && afterReturnDirect.clean && (await eventsOf(W.intakeId)).length === 7,
    "after W's return a new escalation, a second acknowledgement, a further follow-up and a second return are each refused 409, and a direct follow-up row by the guard; a further cycle needs a separately versioned policy",
  )
  check(
    'T060',
    'All refused writes have zero effects',
    same(await counts(), plus(countsBeforeIllegal, 4)) && [E_J, A_J, E_H, A_H].every((r) => r.status === 201) &&
      [...noEscalation, ...beforeAck, returnBeforeAck, returnBeforeFollowup, ...secondEscalation, ...wrongAcker, ...selfAck, ...unsupported, missingSource, ...foreignSource, ...wrongEscalation, ...wrongAckRef, ...afterReturn].every((r: any) => r.status >= 400) &&
      [secondDirect, selfAckDirect, ...sourceDirect, afterReturnDirect].every((r) => r.clean),
    'across this section only the four legal events (J escalated and acknowledged, H escalated and acknowledged) were added, each with its audit; every refusal — route, service or direct — left every counted table exactly as it was',
  )

  // ---------------------------------------------------------------- database integrity on S (T061–T070, always rolled back)
  section('Database integrity on S (always rolled back): RESTRICT keys, valid direct events, forged linkage, forged recording members, ineligible nominated members and actors, contract, event and shape CHECKs with triggers off, sequence, UPDATE/DELETE/TRUNCATE, the one-cycle and follow-up backstops')
  const fksOf = (table: string) => prisma.$queryRawUnsafe<{ name: string; del: string }[]>(`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid = '${table}'::regclass ORDER BY conname`)
  const fks = await fksOf(TABLE)
  const parentDeletes = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${INTAKE_TABLE} WHERE id = $1::uuid`, W.intakeId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM organization_memberships WHERE id = $1::uuid`, T.membershipId)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id = $1::uuid`, RW.id)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM claims WHERE id = $1::uuid`, W.claimId)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, E_W_ID)),
  ]
  // The escalation key with every trigger of this table off: only the RESTRICT self-key can refuse.
  const restrictAlone = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE ${TABLE} DISABLE TRIGGER USER`)
    await tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, E_W_ID)
  })
  check(
    'T061',
    'All FKs RESTRICT and scoped',
    fks.length === 8 && fks.every((fk) => fk.del === 'r') && parentDeletes.every((r) => !r.message.includes(NOT_COMMITTED) && /append-only|foreign key|23503|claims cannot be deleted/.test(r.message) && r.clean) &&
      /foreign key|23503/.test(restrictAlone.message) && /exception_escalation_events_escalation_event_id_fkey/.test(restrictAlone.message) && restrictAlone.clean,
    `${fks.map((f) => f.name.replace(`${TABLE}_`, '')).join(', ')}: all ON DELETE RESTRICT; deleting W's intake, the nominated membership, a returning user, the Claim (A6's own guard first) or the escalation itself is refused; with this table's triggers disabled the escalation is still held by the acknowledgement's RESTRICT self-key alone`,
  )
  const aS1 = randomUUID()
  const sF = inv(S).findingId
  const sL = inv(S).linkId
  const sRep = work(S).reportId
  const sVer = work(S).verificationId
  const validDirect = [
    await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: aS1 }), followupRow(S, 3, aS1, sF, 'INVESTIGATION_FINDING'), followupRow(S, 4, aS1, sRep, 'WORK_REPORT', { followup_code: 'ADDITIONAL_INFORMATION_REQUESTED' }), returnRow(S, 5, eS1)]),
    await directInsert([
      rowOf(S, { id: eS1, reason_code: 'POLICY_GUIDANCE_REQUIRED' }), ackRow(S, 2, eS1, { id: aS1 }), followupRow(S, 3, aS1, sL, 'INVESTIGATION_EVIDENCE_LINK'),
      followupRow(S, 4, aS1, sVer, 'WORK_VERIFICATION', { followup_code: 'INTERNAL_POLICY_REVIEWED' }), returnRow(S, 5, eS1, { return_reason_code: 'FURTHER_WORK_REQUIRED', recorded_by_membership_id: RW2.membershipId, recorded_by_user_id: RW2.id }),
    ]),
  ]
  check('T062', 'Valid direct SQL events accepted then rollback', validDirect.every((r) => !r.refused && r.clean) && (await eventsOf(S.intakeId)).length === 0, "two whole valid cycles as direct rows on S — every reason, follow-up code, source kind and return reason — pass every guard and roll back; S holds no committed event")
  const forgedLinkage = [await directInsert([rowOf(S, { organization_id: otherOrg })]), await directInsert([rowOf(S, { claim_id: W.claimId })]), await directInsert([rowOf(S, { exception_intake_id: RC.intakeId })])]
  check('T063', 'Wrong Claim/intake/tenant direct row refused', forgedLinkage.every((r) => r.refused && /exception_escalation_coherence/.test(r.message) && r.clean), 'a direct event under the other organization, another Claim or another intake than its own is refused by the coherence guard')
  const forgedActors = {
    mismatched: await directInsert([rowOf(S, { recorded_by_user_id: M2.id })]), foreign: await directInsert([rowOf(S, { recorded_by_membership_id: O.membershipId, recorded_by_user_id: O.id })]),
    missing: await directInsert([rowOf(S, { recorded_by_membership_id: MISSING })]), otherTenantOfUser: await directInsert([rowOf(S, { recorded_by_membership_id: M1X.id, recorded_by_user_id: M1.id })]),
    notAssignee: await directInsert([rowOf(S, { recorded_by_membership_id: M2.membershipId, recorded_by_user_id: M2.id })]),
    viewerEscalator: await directInsert([rowOf(S, { recorded_by_membership_id: viewerMembershipId, recorded_by_user_id: viewerUser.id })]),
  }
  check(
    'T064',
    'Forged recording member direct row refused',
    [forgedActors.mismatched, forgedActors.foreign, forgedActors.missing, forgedActors.otherTenantOfUser].every((r) => r.refused && /exception_escalation_member/.test(r.message)) &&
      [forgedActors.notAssignee, forgedActors.viewerEscalator].every((r) => r.refused && /exception_escalation_assignee/.test(r.message)) && Object.values(forgedActors).every((r) => r.clean),
    "a membership of another user, the other tenant's, M1's own membership in the other tenant or none is refused by the member guard; an escalator who is not S's assignee (M2, the Viewer) by the assignee guard",
  )
  const ineligible = {
    roleless: await directInsert([rowOf(S, { target_member_id: NR.membershipId })]), viewer: await directInsert([rowOf(S, { target_member_id: viewerMembershipId })]),
    foreign: await directInsert([rowOf(S, { target_member_id: O.membershipId })]), self: await directInsert([rowOf(S, { target_member_id: M4.membershipId })]),
    otherAcker: await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { recorded_by_membership_id: RW.membershipId, recorded_by_user_id: RW.id })]),
    targetReturns: await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: aS1 }), followupRow(S, 3, aS1, sF, 'INVESTIGATION_FINDING'), returnRow(S, 4, eS1, { recorded_by_membership_id: T.membershipId, recorded_by_user_id: T.id })]),
    escalatorReturns: await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: aS1 }), followupRow(S, 3, aS1, sF, 'INVESTIGATION_FINDING'), returnRow(S, 4, eS1, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })]),
    rolelessReturns: await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: aS1 }), followupRow(S, 3, aS1, sF, 'INVESTIGATION_FINDING'), returnRow(S, 4, eS1, { recorded_by_membership_id: NR.membershipId, recorded_by_user_id: NR.id })]),
  }
  const selfPlanted = await plantedRead(S, [rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })])
  check(
    'T065',
    'Ineligible nominated member direct row refused',
    [ineligible.roleless, ineligible.viewer, ineligible.foreign, ineligible.otherAcker].every((r) => r.refused && /exception_escalation_target/.test(r.message)) && ineligible.self.refused &&
      /exception_escalation_independence: an escalation never nominates its own escalator/.test(ineligible.self.message) &&
      [ineligible.targetReturns, ineligible.escalatorReturns, ineligible.rolelessReturns].every((r) => r.refused && /exception_escalation_independence/.test(r.message)) && Object.values(ineligible).every((r) => r.clean) &&
      selfPlanted.value?.history.ok === false && selfPlanted.value.disposition.ok === false && selfPlanted.clean,
    "on S a direct escalation nominating a role-less member, the Viewer or the other tenant's member, and an acknowledgement by another member, are refused by the target guard; nominating the escalator itself, and a return by the nominated member, the escalator or a member without the review permission, by the independence guard; a planted self-acknowledgement fails the whole read (409)",
  )
  const off = { triggersOff: true }
  const eventCodeAlone = await directInsert([rowOf(S, { event_code: 'ESCALATE' })], off)
  const contractAlone = await directInsert([rowOf(S, { contract_version: 'A8-ESCALATION-2' })], off)
  check(
    'T066',
    'Unknown contract and event CHECK fail',
    eventCodeAlone.refused && /exception_escalation_events_event_code_chk/.test(eventCodeAlone.message) && contractAlone.refused && /exception_escalation_events_contract_chk/.test(contractAlone.message) && eventCodeAlone.clean && contractAlone.clean,
    'with every trigger off, an unknown event code is refused by its CHECK and a future contract (A8-ESCALATION-2) by the contract CHECK',
  )
  const shapes = [
    await directInsert([rowOf(S, { reason_code: null })], off), await directInsert([rowOf(S, { reason_code: 'URGENT' })], off), await directInsert([rowOf(S, { target_member_id: null })], off),
    await directInsert([rowOf(S, { followup_code: 'SOURCE_RECHECK_RECORDED' })], off), await directInsert([rowOf(S, { source_event_id: sF, source_event_kind: 'INVESTIGATION_FINDING' })], off),
    await directInsert([rowOf(S, { return_reason_code: 'FOLLOWUP_RECORDED' })], off), await directInsert([ackRow(S, 1, MISSING, { escalation_event_id: null })], off),
    await directInsert([ackRow(S, 1, MISSING, { target_member_id: T.membershipId })], off), await directInsert([followupRow(S, 1, MISSING, sF, 'INVESTIGATION_FINDING', { acknowledgement_event_id: null })], off),
    await directInsert([followupRow(S, 1, MISSING, sF, 'INVESTIGATION_FINDING', { followup_code: null })], off), await directInsert([followupRow(S, 1, MISSING, sF, 'INVESTIGATION_FINDING', { followup_code: 'DONE' })], off),
    await directInsert([followupRow(S, 1, MISSING, sF, 'INVESTIGATION_FINDING', { source_event_id: null })], off), await directInsert([followupRow(S, 1, MISSING, sF, 'INVESTIGATION_FINDING', { source_event_kind: null })], off),
    await directInsert([followupRow(S, 1, MISSING, sF, 'TRIAGE_EVENT')], off), await directInsert([followupRow(S, 1, MISSING, sF, 'INVESTIGATION_FINDING', { escalation_event_id: MISSING })], off),
    await directInsert([returnRow(S, 1, MISSING, { escalation_event_id: null })], off), await directInsert([returnRow(S, 1, MISSING, { return_reason_code: null })], off),
    await directInsert([returnRow(S, 1, MISSING, { return_reason_code: 'CLOSED' })], off), await directInsert([returnRow(S, 1, MISSING, { acknowledgement_event_id: MISSING })], off),
  ]
  check(
    'T067',
    'Invalid shape and reason CHECK fail',
    shapes.every((r) => r.refused && /exception_escalation_events_shape_chk/.test(r.message) && r.clean),
    `with every trigger off, ${shapes.length} malformed rows — an escalation without or with an uncontrolled reason, without a target or with another event's field; an acknowledgement without its escalation or with a target; a follow-up without its acknowledgement, code or source, with an uncontrolled code or kind, or an escalation field; a return without its escalation or reason, with an uncontrolled reason or an acknowledgement — are each refused by the shape CHECK`,
  )
  const firstTwo = await directInsert([rowOf(S, { sequence: 2 })])
  const reusedLive = await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 1, eS1)])
  const zero = await directInsert([rowOf(S, { sequence: 0 })], off)
  const reusedOff = await directInsert([rowOf(S), rowOf(S, { reason_code: 'EVIDENCE_INCOMPLETE' })], off)
  check(
    'T068',
    'Missing/reused sequence refused',
    firstTwo.refused && /exception_escalation_sequence/.test(firstTwo.message) && reusedLive.refused && /exception_escalation_sequence/.test(reusedLive.message) && zero.refused && /exception_escalation_events_sequence_chk/.test(zero.message) &&
      reusedOff.refused && /exception_escalation_events_(sequence_key|one_cycle_key)|23505/.test(reusedOff.message) && [firstTwo, reusedLive, zero, reusedOff].every((r) => r.clean),
    'a first event numbered 2 and a reused number 1 are refused by the sequence guard; number 0 by its CHECK and, with every trigger off, a reused number by the unique (intake, sequence) index',
  )
  const wHash = await rowsHash([W.intakeId])
  const mutations = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = sequence WHERE id = $1::uuid`, E_W_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET return_reason_code = 'FURTHER_WORK_REQUIRED' WHERE id = $1::uuid`, R_W_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, R_W_ID)),
  ]
  const truncation = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`))
  const cascade = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`))
  // A later owner's ON DELETE RESTRICT key into this table would make PostgreSQL refuse a plain TRUNCATE before any
  // trigger runs; TRUNCATE ... CASCADE still reaches this guard. Judged on behaviour: every wipe is refused.
  const referencedBy = await prisma.$queryRawUnsafe<{ del: string; self: boolean }[]>(`SELECT confdeltype::text AS del, conrelid = confrelid AS self FROM pg_constraint WHERE contype = 'f' AND confrelid = '${TABLE}'::regclass`)
  const truncationRefused = /append-only/.test(truncation.message) || (/cannot truncate a table referenced in a foreign key constraint/.test(truncation.message) && referencedBy.some((row) => !row.self) && referencedBy.every((row) => row.del === 'r'))
  check(
    'T069',
    'UPDATE DELETE and TRUNCATE refused',
    mutations.every((r) => /append-only/.test(r.message) && r.clean) && truncationRefused && truncation.clean && /append-only/.test(cascade.message) && cascade.clean && (await rowsHash([W.intakeId])) === wHash,
    "a no-op UPDATE of W's escalation, changing its return reason, deleting the return, a TRUNCATE and a TRUNCATE … CASCADE are each refused (append-only); nothing changed",
  )
  const backstop = {
    twoAcksOff: await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1), ackRow(S, 3, eS1)], off),
    twoReturnsOff: await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: aS1 }), followupRow(S, 3, aS1, sF, 'INVESTIGATION_FINDING'), returnRow(S, 4, eS1), returnRow(S, 5, eS1, { recorded_by_membership_id: RW2.membershipId, recorded_by_user_id: RW2.id })], off),
    twoEscalationsOff: await directInsert([rowOf(S), rowOf(S, { sequence: 2 })], off),
    duplicateFollowupLive: await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { id: aS1 }), followupRow(S, 3, aS1, sF, 'INVESTIGATION_FINDING'), followupRow(S, 4, aS1, sF, 'INVESTIGATION_FINDING')]),
    secondAckLive: await directInsert([rowOf(S, { id: eS1 }), ackRow(S, 2, eS1), ackRow(S, 3, eS1)]),
  }
  check(
    'T070',
    'Duplicate acknowledgement/return backstop',
    [backstop.twoAcksOff, backstop.twoReturnsOff, backstop.twoEscalationsOff].every((r) => r.refused && /exception_escalation_events_one_cycle_key|23505/.test(r.message)) && backstop.duplicateFollowupLive.refused &&
      /exception_escalation_events_followup_key|23505/.test(backstop.duplicateFollowupLive.message) && backstop.secondAckLive.refused && /exception_escalation_transition: an acknowledgement names exactly the intake's escalation, which is acknowledged once/.test(backstop.secondAckLive.message) &&
      Object.values(backstop).every((r) => r.clean),
    'with every trigger off a second acknowledgement, a second return and a second escalation of one intake are still refused by the one-cycle unique index; live, an exact duplicate follow-up is refused by the follow-up unique index and a second acknowledgement by the guard',
  )

  // ---------------------------------------------------------------- audit and atomicity (T071–T080), J's and AT's writers
  section("Audit and atomicity on J and AT: one event and one audit commit together, crashes after the insert and after the audit, a retry after a proven rollback, database time, metadata only, no audit on reads or refusals, the rows across a database restart, no orphan")
  const serviceCode = committedCode(`${MODULE_DIR}/exception-escalation.service.ts`)
  const onTx = serviceCode.slice(serviceCode.indexOf('async function recordOnTransaction'), serviceCode.indexOf('async function reconcileUnknownOutcome'))
  const firstStatement = onTx.split('\n').slice(1).find((line) => /^\s*(if|const|await|return)\b/.test(line)) ?? ''
  // T071 and T098 on AT: while AT's escalation is inserted but uncommitted, no other connection sees it or its audit,
  // and a read answers the committed history at once.
  const holdInsert = holdAt('exceptionEscalation.inserted')
  const committing = recordEscalationEvent(AT.claimId, AT.intakeId, escalateOf(T), M4.id)
  await Promise.race([holdInsert.arrived, committing])
  const during = { rows: (await eventsOf(AT.intakeId)).length, audits: await auditsOfIntake(AT.intakeId) }
  const readDuring = dispositionOf(AT)
  const readReturned = await settledWithin(readDuring, 5000)
  const readDuringBody = (await readDuring).body
  holdInsert.release()
  const RAT = await committing
  clearConcurrencyProbes()
  const atRows = await eventsOf(AT.intakeId)
  const ratAudit = RAT.ok ? (await auditsOfEvent(RAT.value.escalationEventId))[0] : undefined
  check(
    'T071',
    'One event and one audit atomically',
    during.rows === 0 && during.audits === 0 && RAT.ok && atRows.length === 1 && (await auditsOfIntake(AT.intakeId)) === 1 && !!ratAudit && ratAudit.actionCode === 'exception_escalation.recorded' &&
      ratAudit.beforeState === null && (ratAudit.afterState as any)?.recordedAt === atRows[0].recordedAt.toISOString() && ratAudit.organizationId === AT.organizationId && ratAudit.actorUserId === M4.id,
    "while M4's escalation of AT was uncommitted no other connection saw it or its audit; after commit exactly one of each, the audit holding the event's own database time, organization and actor",
  )
  const followupJ = followupOf(A_J_ID, inv(J).findingId)
  const failAfterInsert = failOnce('exceptionEscalation.inserted', 'injected failure after the escalation insert')
  const crashedInsert = await attemptAdversarial(() => recordEscalationEvent(J.claimId, J.intakeId, followupJ, T.id))
  const afterCrash1 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T072', 'Crash after event rolls back everything', failAfterInsert.reached === 1 && /injected failure after the escalation insert/.test(crashedInsert) && afterCrash1.rows === 2 && afterCrash1.audits === 2, "a failure right after T's follow-up insert on J rolled back the whole transaction: no event, no audit, no retry")
  const failAfterAudit = failOnce('exceptionEscalation.audited', 'injected failure after the escalation audit')
  const crashedAudit = await attemptAdversarial(() => recordEscalationEvent(J.claimId, J.intakeId, followupJ, T.id))
  const afterCrash2 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T073', 'Crash after audit rolls back everything', failAfterAudit.reached === 1 && /injected failure after the escalation audit/.test(crashedAudit) && afterCrash2.rows === 2 && afterCrash2.audits === 2, 'a failure after the audit rolled back both: no event, no audit, no retry')
  // T089 and T090's writers: exhausted retries and unknown outcomes on J, before its one accepted retry.
  const always = failEveryTime('exceptionEscalation.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const exhausted = await recordEscalationEvent(J.claimId, J.intakeId, followupJ, T.id)
  const lost = failEveryTime('exceptionEscalation.audited', 'Connection terminated unexpectedly')
  const unknownOutcome = await recordEscalationEvent(J.claimId, J.intakeId, followupJ, T.id)
  const early = failEveryTime('exceptionEscalation.claim_locked', 'Connection terminated unexpectedly')
  const earlyOutcome = await recordEscalationEvent(J.claimId, J.intakeId, followupJ, T.id)
  clearConcurrencyProbes()
  const jBeforeRetry = (await eventsOf(J.intakeId)).length
  const once = failOnce('exceptionEscalation.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const FU_J = await recordEscalationEvent(J.claimId, J.intakeId, followupJ, T.id)
  clearConcurrencyProbes()
  check(
    'T074',
    'Confirmed rollback retry writes exactly once',
    once.reached === 1 && FU_J.ok && FU_J.value.sequence === 3 && jBeforeRetry === 2 && (await eventsOf(J.intakeId)).length === 3 && (await auditsOfIntake(J.intakeId)) === 3,
    "one provably aborted serialization failure is retried on a fresh transaction that re-reads every owner and records T's follow-up exactly once (event 3) with one audit",
  )
  // T089's unique collision on AT's acknowledgement, retried on a fresh transaction.
  const atBeforeUnique = (await eventsOf(AT.intakeId)).length
  const uniqueOnce = failOnce('exceptionEscalation.inserted', 'duplicate key value violates unique constraint "exception_escalation_events_sequence_key"')
  const A_AT = await recordEscalationEvent(AT.claimId, AT.intakeId, ackOf(RAT.ok ? RAT.value.escalationEventId : MISSING), T.id)
  clearConcurrencyProbes()
  const runEventsSoFar = await prisma.exceptionEscalationEvent.findMany({ where: { recordedAt: { gte: runStartedAt } } })
  const runAuditsSoFar = await prisma.auditEvent.findMany({ where: { actionCode: 'exception_escalation.recorded', occurredAt: { gte: runStartedAt } } })
  const auditOf = (eventId: string) => runAuditsSoFar.filter((a) => a.entityId === eventId)
  const timeRows = await prisma.$queryRawUnsafe<{ n: bigint; differ: bigint; early: bigint }[]>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE recorded_at <> created_at) AS differ, count(*) FILTER (WHERE recorded_at < $1::timestamptz) AS early FROM ${TABLE} WHERE exception_intake_id = ANY($2::uuid[])`,
    runStartedAt.toISOString(), runIntakes.map((k) => k.intakeId),
  )
  const pastTime = await directInsert([rowOf(S, { recorded_at: '2020-01-01T00:00:00.000Z' })])
  const futureTime = await directInsert([rowOf(S, { recorded_at: new Date(Date.now() + 86_400_000).toISOString() })])
  const retime = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET recorded_at = recorded_at - interval '1 day' WHERE id = $1::uuid`, E_W_ID))
  check(
    'T075',
    'Database transaction event timestamp',
    Number(timeRows[0].n) >= 20 && Number(timeRows[0].differ) === 0 && Number(timeRows[0].early) === 0 && [pastTime, futureTime].every((r) => r.refused && /exception_escalation_time/.test(r.message) && r.clean) &&
      /append-only/.test(retime.message) && retime.clean && runEventsSoFar.every((e) => (auditOf(e.id)[0]?.afterState as any)?.recordedAt === e.recordedAt.toISOString()),
    `every one of the ${Number(timeRows[0].n)} events this run was recorded and created at the database's own transaction time (equal, never before the run); a past or future time in a direct row is refused by the time guard and re-timing an event is refused (append-only); each audit carries the event's own time`,
  )
  check(
    'T076',
    'Audit actor/organization exact',
    runEventsSoFar.length >= 20 && runAuditsSoFar.length === runEventsSoFar.length &&
      runEventsSoFar.every((e) => {
        const audits = auditOf(e.id)
        const after = audits[0]?.afterState as any
        return audits.length === 1 && audits[0].organizationId === e.organizationId && audits[0].actorUserId === e.recordedByUserId && audits[0].entityType === 'EXCEPTION_ESCALATION_EVENT' && audits[0].beforeState === null &&
          same(Object.keys(after ?? {}).sort(), [...AUDIT_KEYS].sort()) && after?.recordedByMembershipId === e.recordedByMembershipId && after?.exceptionIntakeId === e.exceptionIntakeId && after?.claimId === e.claimId &&
          after?.targetMemberId === e.targetMemberId && after?.referencedEscalationEventId === e.escalationEventId && after?.acknowledgementEventId === e.acknowledgementEventId &&
          after?.sourceEventId === e.sourceEventId && after?.sourceEventKind === e.sourceEventKind
      }),
    `each of the ${runEventsSoFar.length} escalation events this run has exactly one audit — exactly ${AUDIT_KEYS.length} keys — under its own organization, acting user and membership, intake, Claim, target, escalation, acknowledgement and source`,
  )
  const auditText = JSON.stringify(runAuditsSoFar.map((a) => a.afterState))
  check(
    'T077',
    'Metadata-only audits no patient/payment',
    ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), 'AED', '125.25', M1.email, T.email, 'Synthetic member', 'Synthetic finding.', 'FURTHER_REVIEW_REQUIRED'].some((value) => auditText.includes(value)) &&
      !AUDIT_KEYS.some((k) => /patient|name|amount|currency|payer|payment|narrative|note|text|finding|diagnos/i.test(k)),
    'no audit holds a patient, date of birth, diagnosis, member contact, synthetic text, the cited A8.3 finding code, an amount or a currency, and no audit key names one: ids, codes, the acting membership and time only',
  )
  const auditsBeforeReads = await prisma.auditEvent.count()
  const countsBeforeReads = await counts()
  for (const k of [W, N0, J, S, RS]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await dispositionOf(k, who)
  }
  const readRefusals = [
    await historyOf(W, anonymous), await dispositionOf(F), await historyOf({ claimId: W.claimId, intakeId: MISSING }), await get(`${base(W)}/escalation-disposition?current=1`), await escalationPost(W, escalateOf(T), asViewer),
    await escalationPost(RS, escalateOf(T), M4.who), await escalationPost(S, returnOf(MISSING), RW.who), await escalationPost(W, escalateOf(T), M1.who), await escalationPost(W, { eventCode: 'NOPE' }, M1.who),
  ]
  check(
    'T078',
    'No audit on reads or refusals',
    (await prisma.auditEvent.count()) === auditsBeforeReads && (await unchanged(countsBeforeReads)) && readRefusals.map((r) => r.status).join('/') === '401/404/404/400/403/409/409/409/400',
    `twenty reads by an Admin and a Viewer and nine refused requests (${readRefusals.map((r) => r.status).join('/')}) wrote no audit and changed no row`,
  )
  // T079, T100 and T126 — one database outage and restart: health stays truthful, ready reports the outage, and every
  // escalation row of this run survives the restart byte-identical.
  const agree = async (k: Intake) => {
    const items = (await historyOf(k)).body.items as any[]
    const d = (await dispositionOf(k)).body
    return same(replayIndependently(items), dispositionFacts(d))
  }
  const agreeIntakes = [W, RS, PD, EP, ER, S, N0, TR, J, AT, RC, K, G, H]
  const agreeAll = async () => (await Promise.all(agreeIntakes.map(agree))).every(Boolean)
  const rowsBeforeOutage = await rowsHash(runIntakes.map((k) => k.intakeId))
  const historiesBeforeOutage = await Promise.all(agreeIntakes.map(async (k) => withoutEvaluatedAt((await historyOf(k)).body)))
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
  const rowsAfterOutage = await rowsHash(runIntakes.map((k) => k.intakeId))
  const historiesAfterOutage = await Promise.all(agreeIntakes.map(async (k) => withoutEvaluatedAt((await historyOf(k)).body)))
  const agreeAfterRestart = await agreeAll()
  check(
    'T079',
    'Historical rows survive restart unchanged',
    stopped && restarted && recovered && rowsAfterOutage === rowsBeforeOutage && same(historiesAfterOutage, historiesBeforeOutage),
    `the database was stopped and started again: every escalation row of this run hashes exactly as before and all ${agreeIntakes.length} histories read back byte-identical`,
  )
  const contiguous = async (k: Intake) => {
    const rows = await eventsOf(k.intakeId)
    return same(rows.map((e) => e.sequence), rows.map((_e, i) => i + 1)) && (await auditsOfIntake(k.intakeId)) === rows.length
  }
  const orphanAudits = runAuditsSoFar.filter((a) => !runEventsSoFar.some((e) => e.id === a.entityId))
  check(
    'T080',
    'No orphan event or orphan audit',
    runEventsSoFar.every((e) => auditOf(e.id).length === 1) && orphanAudits.length === 0 && (await Promise.all([W, N0, J, AT, H, TR, EP].map(contiguous))).every(Boolean),
    `${runEventsSoFar.length} events and ${runAuditsSoFar.length} escalation audits this run pair one to one; no audit names a missing event; W, N0, J, AT, H, TR and EP are numbered 1..N with one audit each, after every crash and retry`,
  )

  // ---------------------------------------------------------------- concurrency (T081–T090)
  section('Concurrency: the Claim lock first in one SERIALIZABLE transaction shared by every owner read, simultaneous escalations, acknowledgements and follow-ups, a concurrent A8.2 reassignment, an A8.7 decision while an escalation waits, permission removals, bounded retries, unknown commits')
  // T081's writers: one follow-up holds J's Claim lock while an identical second one waits.
  const holdLock = holdAt('exceptionEscalation.claim_locked')
  const sameFollowup = followupOf(A_J_ID, inv(J).linkId, 'ADDITIONAL_INFORMATION_REQUESTED')
  const firstJ = recordEscalationEvent(J.claimId, J.intakeId, sameFollowup, T.id)
  await Promise.race([holdLock.arrived, firstJ])
  const secondJ = recordEscalationEvent(J.claimId, J.intakeId, sameFollowup, T.id)
  const secondWaited = !(await settledWithin(secondJ, 1500))
  holdLock.release()
  const [j1, j2] = await Promise.all([firstJ, secondJ])
  clearConcurrencyProbes()
  check(
    'T081',
    'Claim NOWAIT lock is first statement',
    /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(firstStatement) && secondWaited && j1.ok && j1.value.sequence === 4 && j2.ok === false && j2.code === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED',
    'the Claim row NOWAIT lock is the first statement of the write; while one follow-up on J held it an identical second one waited, then was judged on the committed state (already recorded: 409)',
  )
  // An A8.7 write on AT while an A8.8 follow-up holds AT's Claim: it waits for the same lock and is judged afterwards.
  const holdAT = holdAt('exceptionEscalation.claim_locked')
  const atFollowup = recordEscalationEvent(AT.claimId, AT.intakeId, followupOf(A_AT.ok ? A_AT.value.escalationEventId : MISSING, inv(AT).findingId), T.id)
  await Promise.race([holdAT.arrived, atFollowup])
  const atResolution = recordResolutionEvent(AT.claimId, AT.intakeId, { eventCode: 'REQUEST_INTERNAL_RESOLUTION', verificationEventId: MISSING, reasonCode: 'VERIFIED_INTERNAL_WORK' }, M4.id)
  const atResolutionWaited = !(await settledWithin(atResolution, 1500))
  holdAT.release()
  const [atFollowed, atResolved] = await Promise.all([atFollowup, atResolution])
  clearConcurrencyProbes()
  check(
    'T082',
    'SERIALIZABLE across all owner reads',
    /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && (serviceCode.match(/prisma\.\$transaction\(\(tx\) => recordOnTransaction\(/g) ?? []).length === 1 &&
      [
        /getExceptionIntakesOf\(claimId, tx\)/, /getTriageDispositionOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getTriageHistoryOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getInvestigationHistoryOf\(claimId, parent\.exceptionIntakeId, tx\)/,
        /getRemediationDispositionOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getRemediationHistoryOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getWorkHistoryOf\(claimId, parent\.exceptionIntakeId, tx\)/,
        /getResolutionDispositionOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getResolutionHistoryOf\(claimId, parent\.exceptionIntakeId, tx\)/,
      ].every((p) => p.test(serviceCode)) && /recordAuditEvent\(/.test(onTx) && /insertEscalationEvent\(/.test(onTx) && atResolutionWaited && atFollowed.ok && atResolved.ok === false,
    "one SERIALIZABLE transaction re-reads the A8.1, A8.2, A8.3, A8.5, A8.6 and A8.7 owners on the same client and writes the event and its audit; an A8.7 request on AT while AT's follow-up held the Claim waited for that lock and was then judged by A8.7 itself (no verified work: refused)",
  )
  const escalationRace = await Promise.all(Array.from({ length: 5 }, () => escalationPost(RC, escalateOf(T), M4.who)))
  const isRefusedStep = (r: { status: number; body: any }) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED'
  const E_RC_ID = (escalationRace.find((r) => r.status === 201)?.body.escalationEventId ?? MISSING) as string
  check(
    'T083',
    'Concurrent escalations only one accepted',
    escalationRace.filter((r) => r.status === 201).length === 1 && escalationRace.filter(isRefusedStep).length === 4 && (await eventsOf(RC.intakeId)).length === 1 && (await auditsOfIntake(RC.intakeId)) === 1 &&
      (await dispositionOf(RC)).body.escalation?.escalationEventId === E_RC_ID,
    `five identical escalations of RC at once (${escalationRace.map((r) => r.status).join('/')}): one 201 and four 409; one event, one audit, and it is the open escalation`,
  )
  const ackRace = await Promise.all(Array.from({ length: 5 }, () => escalationPost(RC, ackOf(E_RC_ID), T.who)))
  const A_RC_ID = (ackRace.find((r) => r.status === 201)?.body.escalationEventId ?? MISSING) as string
  check(
    'T084',
    'Concurrent acknowledgements only one',
    ackRace.filter((r) => r.status === 201).length === 1 && ackRace.filter(isRefusedStep).length === 4 && (await eventsOf(RC.intakeId)).length === 2 && (await auditsOfIntake(RC.intakeId)) === 2,
    `five acknowledgements of RC's escalation by T at once (${ackRace.map((r) => r.status).join('/')}): one 201 and four 409; one acknowledgement`,
  )
  const rcSources: [string, string][] = [
    [inv(RC).findingId, 'SOURCE_RECHECK_RECORDED'], [inv(RC).linkId, 'SOURCE_RECHECK_RECORDED'], [inv(RC).findingId, 'ADDITIONAL_INFORMATION_REQUESTED'], [inv(RC).linkId, 'INTERNAL_POLICY_REVIEWED'],
    [inv(RC).findingId, 'INTERNAL_POLICY_REVIEWED'], [inv(RC).findingId, 'SOURCE_RECHECK_RECORDED'],
  ]
  const followupRace = await Promise.all(rcSources.map(([source, code]) => escalationPost(RC, followupOf(A_RC_ID, source, code), T.who)))
  const rcRows = await eventsOf(RC.intakeId)
  check(
    'T085',
    'Concurrent follow-ups serialize 1..N',
    followupRace.filter((r) => r.status === 201).length === 5 && followupRace.filter(isRefusedStep).length === 1 && rcRows.length === 7 && (await contiguous(RC)) &&
      same(rcRows.slice(2).map((e) => e.sequence), [3, 4, 5, 6, 7]) && new Set(rcRows.slice(2).map((e) => `${e.followupCode}:${e.sourceEventId}`)).size === 5,
    `six follow-ups by T at once — five distinct and one exact repeat (${followupRace.map((r) => r.status).join('/')}): the five distinct ones are recorded, serialized as events 3..7 with one audit each, and the repeat is refused 409`,
  )
  // K: an A8.2 reassignment to M2 holds K's Claim lock while M4 escalates; later K is reassigned to T and back.
  const holdTriage = holdAt('exceptionTriage.inserted')
  const kReassign = recordTriageEvent(K.claimId, K.intakeId, reassignTo(M2), creatorId)
  await Promise.race([holdTriage.arrived, kReassign])
  const kEscalate = recordEscalationEvent(K.claimId, K.intakeId, escalateOf(T), M4.id)
  const kWaited = !(await settledWithin(kEscalate, 1500))
  holdTriage.release()
  const [kReassigned, kResult] = await Promise.all([kReassign, kEscalate])
  clearConcurrencyProbes()
  const E_K = await escalationPost(K, escalateOf(T), M2.who)
  const E_K_ID = (E_K.body?.escalationEventId ?? MISSING) as string
  const A_K = await escalationPost(K, ackOf(E_K_ID), T.who)
  const A_K_ID = (A_K.body?.escalationEventId ?? MISSING) as string
  await triage(K, reassignTo(T))
  const targetIsAssignee = await escalationPost(K, followupOf(A_K_ID, inv(K).findingId), T.who)
  await triage(K, reassignTo(M4))
  const FU_K = await escalationPost(K, followupOf(A_K_ID, inv(K).findingId), T.who)
  const assigneeReturns = await escalationPost(K, returnOf(E_K_ID), M4.who)
  const assigneeReturnDirect = await directInsert([returnRow(K, 4, E_K_ID, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })])
  const R_K = await escalationPost(K, returnOf(E_K_ID, 'FURTHER_WORK_REQUIRED'), RW2.who)
  check(
    'T086',
    'A8.2 reassignment invalidates stale actor',
    kWaited && kReassigned.ok && kResult.ok === false && kResult.code === 'EXCEPTION_ESCALATION_NOT_ASSIGNEE' && E_K.status === 201 && E_K.body.recordedByMembershipId === M2.membershipId && A_K.status === 201 &&
      targetIsAssignee.status === 409 && errorCode(targetIsAssignee.body) === 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE' && FU_K.status === 201 && assigneeReturns.status === 409 &&
      errorCode(assigneeReturns.body) === 'EXCEPTION_ESCALATION_NOT_INDEPENDENT' && /not the current assignee/.test(errorMessage(assigneeReturns.body)) && assigneeReturnDirect.refused &&
      /exception_escalation_independence/.test(assigneeReturnDirect.message) && assigneeReturnDirect.clean && R_K.status === 201 && (await eventsOf(K.intakeId)).length === 4,
    "while an A8.2 reassignment of K to M2 held K's Claim lock, M4's escalation waited, re-read the committed assignment and was refused 409 (no longer the assignee), then M2 escalated (201) and T acknowledged; with K reassigned to T, T's follow-up was refused (the nominated member is never the current assignee) and recorded once K was reassigned to M4; M4 — now the current assignee, neither escalator nor target — returning it is refused 409 by the service and the guard, and RW2 returns it (201)",
  )
  // ER: an escalation open with a follow-up; an A8.7 confirmation holds ER's Claim lock while RW's return waits.
  const E_ER = await escalationPost(ER, escalateOf(T), M4.who)
  const A_ER = await escalationPost(ER, ackOf(E_ER.body?.escalationEventId ?? MISSING), T.who)
  const FU_ER = await escalationPost(ER, followupOf(A_ER.body?.escalationEventId ?? MISSING, inv(ER).findingId), T.who)
  const RQ_ER = await requestResolution(ER, work(ER), M4.who)
  const holdDecision = holdAt('exceptionResolution.claim_locked')
  const erDecision = recordResolutionEvent(ER.claimId, ER.intakeId, { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId: RQ_ER, decisionCode: 'CONFIRM_INTERNAL_RESOLUTION' }, DR.id)
  await Promise.race([holdDecision.arrived, erDecision])
  const erReturn = recordEscalationEvent(ER.claimId, ER.intakeId, returnOf(E_ER.body?.escalationEventId ?? MISSING), RW.id)
  const erWaited = !(await settledWithin(erReturn, 1500))
  holdDecision.release()
  const [erDecided, erReturned] = await Promise.all([erDecision, erReturn])
  clearConcurrencyProbes()
  const erAfter = [await escalationPost(ER, followupOf(A_ER.body?.escalationEventId ?? MISSING, inv(ER).linkId), T.who), await escalationPost(ER, returnOf(E_ER.body?.escalationEventId ?? MISSING), RW.who)]
  const erDirect = await directInsert([returnRow(ER, 4, E_ER.body?.escalationEventId ?? MISSING)])
  check(
    'T087',
    'A8.7 resolved state blocks later append',
    [E_ER, A_ER, FU_ER].every((r) => r.status === 201) && erWaited && erDecided.ok && erReturned.ok === false && erReturned.code === 'EXCEPTION_ESCALATION_TRANSITION_REFUSED' && /RESOLVED_INTERNAL/.test(erReturned.message) &&
      erAfter.every((r) => r.status === 409 && /RESOLVED_INTERNAL under A8\.7; no further escalation event is recorded/.test(errorMessage(r.body))) && erDirect.refused &&
      /exception_escalation_transition: the exception is RESOLVED_INTERNAL under A8\.7/.test(erDirect.message) && (await eventsOf(ER.intakeId)).length === 3 && (await dispositionOf(ER)).body.state === 'FOLLOWUP_ACTIVE',
    "ER was escalated, acknowledged and followed up; while DR's A8.7 confirmation held ER's Claim lock RW's return waited, then read A8.7 RESOLVED_INTERNAL and was refused 409; every later follow-up and return is refused (route and guard) and the escalation stays exactly as recorded (FOLLOWUP_ACTIVE) — A8.8 never overrides the resolution",
  )
  const holdG = holdAt('exceptionEscalation.claim_locked')
  const gEscalate = recordEscalationEvent(G.claimId, G.intakeId, escalateOf(T), M5.id)
  await Promise.race([holdG.arrived, gEscalate])
  await prisma.membershipRole.deleteMany({ where: { membershipId: M5.membershipId } })
  holdG.release()
  const gResult = await gEscalate
  clearConcurrencyProbes()
  const gHttp = await escalationPost(G, escalateOf(T), M5.who)
  const gDirect = await directInsert([rowOf(G, { recorded_by_membership_id: M5.membershipId, recorded_by_user_id: M5.id })])
  const holdH = holdAt('exceptionEscalation.claim_locked')
  const hFollowup = recordEscalationEvent(H.claimId, H.intakeId, followupOf(A_H_ID, inv(H).findingId), T3.id)
  await Promise.race([holdH.arrived, hFollowup])
  await prisma.membershipRole.deleteMany({ where: { membershipId: T3.membershipId } })
  holdH.release()
  const hResult = await hFollowup
  clearConcurrencyProbes()
  const hHttp = await escalationPost(H, followupOf(A_H_ID, inv(H).findingId), T3.who)
  const hDirect = await directInsert([followupRow(H, 3, A_H_ID, inv(H).findingId, 'INVESTIGATION_FINDING', { recorded_by_membership_id: T3.membershipId, recorded_by_user_id: T3.id })])
  check(
    'T088',
    'Permission removal before commit refused',
    gResult.ok === false && gResult.code === 'EXCEPTION_ESCALATION_NOT_ASSIGNEE' && gHttp.status === 403 && gDirect.refused && /exception_escalation_assignee/.test(gDirect.message) && gDirect.clean &&
      (await eventsOf(G.intakeId)).length === 0 && hResult.ok === false && hResult.code === 'EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE' && hHttp.status === 403 && hDirect.refused &&
      /exception_escalation_target/.test(hDirect.message) && hDirect.clean && (await eventsOf(H.intakeId)).length === 2,
    "M5's role was removed while its escalation of G held the Claim lock: refused 409 (no current permission), its next attempt 403 and a direct row refused by the assignee guard; T3's role was removed while its follow-up on H held the lock: refused 409 (no longer eligible), then 403, and a direct row refused by the target guard; nothing recorded",
  )
  check(
    'T089',
    'Only proven failure retries max three',
    always.reached === 3 && exhausted.ok === false && exhausted.code === 'EXCEPTION_ESCALATION_CONFLICT' && /kept conflicting; nothing was recorded/.test(exhausted.message) && /const MAX_ESCALATION_ATTEMPTS = 3/.test(serviceCode) &&
      /deadlock detected/.test(serviceCode) && /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode) && uniqueOnce.reached === 1 && A_AT.ok && A_AT.value.sequence === atBeforeUnique + 1 && /isUniqueViolation\(error\)/.test(serviceCode),
    `a serialization failure on every attempt stops after exactly 3 fresh transactions with a 409 and nothing recorded; a deadlock is retried the same way; a unique (intake, sequence) collision is retried on a fresh transaction and AT's acknowledgement is recorded once as event ${atBeforeUnique + 1}; busy locks are waited for within the 30 s budget`,
  )
  check(
    'T090',
    'Unknown commit reconciled never blindly retried',
    lost.reached === 1 && unknownOutcome.ok === false && unknownOutcome.code === 'EXCEPTION_ESCALATION_CONFLICT' && /holds no event at sequence 3; nothing was recorded/.test(unknownOutcome.message) &&
      early.reached === 1 && earlyOutcome.ok === false && /failed before an event was written/.test(earlyOutcome.message) && jBeforeRetry === 2 && /reconcileAttempt\(records, attempted\)/.test(serviceCode),
    "a connection lost after the audit is reconciled against the committed history (no event 3: nothing recorded) and a loss before the insert is reported as such; each reached once — never resubmitted, never a 201 (RECORDED and OTHER_EVENT are proven by the reducer's unit tests, T091)",
  )

  // ---------------------------------------------------------------- reducer and reads (T091–T100)
  section('Reducer and reads: unit tests over every state/event pair, 100 derivations, an independent replay, an unknown contract, gapped and misnumbered histories, a cross-tenant row, READ ONLY snapshot reads, database read time, agreement after the restart')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  const reducerCode = committedCode(`${MODULE_DIR}/exception-escalation.reducer.ts`)
  const reducerTests = committedText(`${MODULE_DIR}/exception-escalation.reducer.test.ts`)
  check(
    'T091',
    'Pure reducer all state/event pairs',
    ownUnit.ok && /ℹ pass 11/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output) && /every illegal state\/event pair is refused/.test(reducerTests) && /RETURNED_TO_OWNER is terminal in v1/.test(reducerTests) &&
      /the A8\.7 gate \(D1\)/.test(reducerTests) && !/prisma|await |async |Date\.now|Math\.random|new Date|from '\.\.\/\.\.\/shared/.test(reducerCode),
    'the 11 reducer and request tests pass (the worked cycle, the terminal return, every illegal state/event pair, the A8.7 gate, exact shapes, whole histories and the unknown-outcome reconciliation); the reducer reads no database, clock or randomness',
  )
  const parentOf = (k: Intake) => ({ exceptionIntakeId: k.intakeId, organizationId: k.organizationId, claimId: k.claimId })
  const wStored = await eventsOf(W.intakeId)
  const derivations = new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveEscalation(parentOf(W), wStored))))
  const wDerived = deriveEscalation(parentOf(W), wStored)
  check('T092', '100 identical replays deterministic', derivations.size === 1 && wDerived.ok && wDerived.value.state === 'RETURNED_TO_OWNER' && wDerived.value.followups.length === 4, "100 derivations of W's stored history are byte-identical (RETURNED_TO_OWNER with four follow-ups)")
  const replays = await Promise.all(agreeIntakes.map(agree))
  check('T093', 'Independent replay matches disposition', replays.every(Boolean), `this suite's own replay of the ${agreeIntakes.length} home intakes' histories (${agreeIntakes.map((k) => k.label).join(', ')}) gives exactly each derived disposition`)
  const refusedRead = (r: { value?: { history: any; disposition: any }; clean: boolean }) =>
    r.value?.history.ok === false && r.value.history.code === 'EXCEPTION_ESCALATION_CONFLICT' && r.value.disposition.ok === false && r.value.disposition.code === 'EXCEPTION_ESCALATION_CONFLICT' && r.clean
  const futureContract = await plantedRead(S, [rowOf(S, { contract_version: 'A8-ESCALATION-2' })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_contract_chk`)
  check('T094', 'Unknown contract refuses whole read', refusedRead(futureContract), 'a planted history under A8-ESCALATION-2 (its CHECK dropped) makes the history and the disposition refuse 409 — never repaired, never partial')
  const gapped = await plantedRead(S, [rowOf(S, { id: eS1 }), ackRow(S, 3, eS1)])
  check('T095', 'Gapped sequence refuses whole read', refusedRead(gapped), 'a planted history numbered 1, 3 makes both reads refuse 409')
  const wrongFirst = await plantedRead(S, [rowOf(S, { sequence: 2 })])
  check('T096', 'Wrong first sequence refuses whole read', refusedRead(wrongFirst), 'a planted history whose first event is numbered 2 makes both reads refuse 409')
  const foreignPlanted = await plantedRead(S, [rowOf(S, { organization_id: otherOrg })])
  const otherIntakePlanted = await plantedRead(S, [rowOf(S, { id: eS1 }), ackRow(S, 2, eS1, { claim_id: W.claimId })])
  check('T097', 'Cross-tenant injected row refuses read', refusedRead(foreignPlanted) && refusedRead(otherIntakePlanted), "a planted row of the other tenant, and one carrying another Claim, make both reads refuse 409")
  const countsBeforeGet = await counts()
  for (const k of [W, N0, J, RC, K]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await dispositionOf(k, who)
  }
  const selectors = [await get(`${base(W)}/escalation-history?latest=1`), await get(`${base(W)}/escalation-disposition?state=RETURNED_TO_OWNER`)]
  const snapshotCode = committedCode('backend/src/shared/database/read-snapshot.ts')
  check(
    'T098',
    'One READ ONLY snapshot on GET',
    (await unchanged(countsBeforeGet)) && selectors.every((r) => r.status === 400) && /SET TRANSACTION READ ONLY/.test(snapshotCode) &&
      /withReadSnapshot\(undefined, \(tx\) => getEscalationHistoryOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode) && /withReadSnapshot\(undefined, \(tx\) => getEscalationDispositionOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode) &&
      readReturned && readDuringBody?.state === 'NO_ESCALATION' && readDuringBody?.eventCount === 0,
    "twenty reads by an Admin and a Viewer changed no row; each runs in one READ ONLY snapshot; a query selector is refused (400); while AT's escalation was inserted but uncommitted a read returned at once with the committed history (NO_ESCALATION, 0 events), never blocked and never the uncommitted event",
  )
  const dbNow = async () => (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts.getTime()
  const beforeRead = await dbNow()
  const readAgain = (await dispositionOf(W)).body
  const historyAgain = (await historyOf(W)).body
  const afterRead = await dbNow()
  const evaluated = [Date.parse(readAgain.evaluatedAt), Date.parse(historyAgain.evaluatedAt)]
  check(
    'T099',
    'EvaluatedAt DB time; event time stable',
    evaluated.every((t) => t >= beforeRead - 1 && t <= afterRead + 1) && evaluated[1] >= evaluated[0] && historyAgain.items.every((item: any, i: number) => item.recordedAt === wStored[i].recordedAt.toISOString()) &&
      historyAgain.items[0].recordedAt === E_W.body.recordedAt && historyAgain.items[6].recordedAt === R_W.body.recordedAt,
    "each read's evaluatedAt lies between two database clock readings around it; every event's recordedAt is its stored database time and W's escalation and return still read exactly as answered when recorded",
  )
  check(
    'T100',
    'History and disposition agree after restart',
    agreeAfterRestart && (await agreeAll()),
    `after the database restart (T079) and again now, the history and the disposition of every one of the ${agreeIntakes.length} home intakes agree with this suite's own replay`,
  )

  // ---------------------------------------------------------------- hard module boundaries (T101–T110)
  section('Hard module boundaries: every A8.1, A8.2, A8.3, A8.5, A8.6, A8.7, A6 and A7 record unchanged; no CRG activation, coding or DRG; no execution, resolution, closure, queue, SLA or A9; no browser storage, transport, log or PHI')
  const moduleCode = committedProductionCodeOf([MODULE_DIR]).code
  const feCode = committedProductionCodeOf([FE_DIR]).code
  const ownerSnapshotNow = await snap()
  const untouched = (paths: string[]) => gitArgs(['diff', '--name-only', ownRange, '--', ...paths.map((p) => `:/${p}`)]) === ''
  check(
    'T101',
    'No change to A8.1 intake',
    untouched(['backend/src/modules/exception-intake']) && ownerSnapshotNow.intakes === ownerSnapshotBefore.intakes && ownerSnapshotNow.intakeAudits === ownerSnapshotBefore.intakeAudits &&
      withoutEvaluatedAt((await get(`/api/claims/${W.claimId}/exception-intake`)).body) === wIntakesBefore,
    "the A8.1 module is unchanged; every intake of this run and its audit are byte-identical; W's intake list reads back the same",
  )
  check(
    'T102',
    'No change to A8.2 assignment',
    untouched(['backend/src/modules/exception-triage']) && (await triageHash()) === triageHashBefore && triageIdsBefore.length >= 30 && withoutEvaluatedAt((await triageDispositionOf(W)).body) === wTriageBefore &&
      !/recordTriageEvent|exceptionTriageEvent\.|INSERT INTO "exception_triage/.test(moduleCode),
    `the A8.2 module is unchanged; all ${triageIdsBefore.length} triage events that existed before the first escalation are byte-identical (the later ones are A8.2's own events); W's assignment to M1 survives its escalation and return; the module never assigns`,
  )
  check(
    'T103',
    'No new A8.3 evidence or findings',
    untouched(['backend/src/modules/exception-investigation', A83_MIGRATION]) && ownerSnapshotNow.investigation === ownerSnapshotBefore.investigation && withoutEvaluatedAt((await investigationSummaryOf(W)).body) === wInvestigationBefore,
    "the A8.3 module and migration are unchanged; every A8.3 event of this run is byte-identical and W's investigation summary reads back the same: follow-ups cite A8.3 records, they never add one",
  )
  check(
    'T104',
    'No change to A8.5 proposal approvals',
    untouched(['backend/src/modules/exception-remediation', A85_MIGRATION]) && ownerSnapshotNow.remediation === ownerSnapshotBefore.remediation && withoutEvaluatedAt((await remediationDispositionOf(W)).body) === wRemediationBefore,
    "the A8.5 module and migration are unchanged; every A8.5 event of this run is byte-identical and W's plan still reads APPROVED_FOR_PLANNING",
  )
  check(
    'T105',
    'No change to A8.6 verified work',
    untouched(['backend/src/modules/exception-remediation-work', A86_MIGRATION]) && ownerSnapshotNow.work === ownerSnapshotBefore.work && withoutEvaluatedAt((await workDispositionOf(W)).body) === wWorkBefore,
    "the A8.6 module and migration are unchanged; every A8.6 event of this run is byte-identical and W's work still reads VERIFIED_INTERNAL_WORK",
  )
  const resolutionInserts = (moduleCode.match(/INSERT INTO "?exception_resolution/g) ?? []).length
  check(
    'T106',
    'No change to A8.7 resolution history',
    untouched(['backend/src/modules/exception-resolution', A87_MIGRATION]) && (await resolutionHash()) === resolutionHashBefore && resolutionIdsBefore.length >= 5 && resolutionInserts === 0 &&
      withoutEvaluatedAt((await resolutionDispositionOf(W)).body) === wResolutionBefore.disposition && withoutEvaluatedAt((await resolutionHistoryOf(W)).body) === wResolutionBefore.history &&
      !/recordResolutionEvent/.test(moduleCode),
    `the A8.7 module and migration are unchanged; all ${resolutionIdsBefore.length} A8.7 events that existed before the first escalation are byte-identical (the later ones are A8.7's own); W's resolution history and RETURNED_FOR_REWORK disposition read back the same; the module never writes a resolution`,
  )
  check(
    'T107',
    'No A6 frozen byte/digest change',
    untouched(['backend/src/modules/claim-submission', 'backend/src/modules/claim-payload', 'backend/src/modules/claim-evidence', 'backend/src/modules/claim-lifecycle', 'backend/src/modules/claim-correction']) &&
      ownerSnapshotNow.freezes === ownerSnapshotBefore.freezes && ownerSnapshotNow.lifecycle === ownerSnapshotBefore.lifecycle && ownerSnapshotNow.links === ownerSnapshotBefore.links && ownerSnapshotNow.claims === ownerSnapshotBefore.claims,
    `the A6 owners are unchanged; each freeze, sealed manifest, lifecycle event, correction link and Claim of the ${runClaims.length + 1} run Claims is byte-identical`,
  )
  const A7_MODULES = ['revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'closure-basis-trace', 'revenue-timeline', 'revenue-delta', 'revenue-continuity'].map((m) => `backend/src/modules/${m}`)
  check('T108', 'No A7 financial evidence change', untouched(A7_MODULES) && ownerSnapshotNow.a7 === ownerSnapshotBefore.a7 && ownerSnapshotNow.encounters === ownerSnapshotBefore.encounters, 'the A7 owners are unchanged; the A7 evidence, classification, gate, case and prerequisite tables hold exactly the rows they held; no Encounter changed')
  check(
    'T109',
    'No CRG activation, coding or DRG',
    ownerSnapshotNow.coding === ownerSnapshotBefore.coding && untouched(['backend/src/modules/coding-release', 'backend/src/modules/coding-validation']) &&
      !/coding-release|codingRelease|coding-validation|codingValidation|crg_|code_system|procedure-code|diagnosis-code|drg|tariff|regulatory/i.test(moduleCode) && !COLUMNS.some((c) => /drg|code_system|release|tariff/.test(c)) &&
      (await eventsOf(PD.intakeId)).some((e) => e.reasonCode === 'POLICY_GUIDANCE_REQUIRED'),
    "every CRG-01 coding-release and validation table and the A2 code masters hold exactly the rows they held; the CRG modules are unchanged; the module reads no coding, DRG, tariff or regulatory owner — PD's POLICY_GUIDANCE_REQUIRED escalation is an internal note that set nothing",
  )
  const tablesAt = (ref: string) => new Set(migrationDirsAt(ref).flatMap((dir) => [...gitArgs(['show', `${ref}:${dir}/migration.sql`]).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])))
  const mainTables = tablesAt(ownBase)
  const a88Tables = [...committedText(MIGRATION).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
  // Tables that existed on main belong to earlier phases; only what this branch adds is judged. Later phases' tables are
  // those created by migrations committed after A8.8's own merge (none on its own branch).
  const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])) : [])
  const newTablesLike = async (pattern: string) => (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`, pattern)).map((r) => r.t).filter((t) => !mainTables.has(t) && !laterPhaseTables.has(t))
  const forbiddenRoutes = await Promise.all(
    ['close', 'closure', 'resolve', 'reopen', 'sla', 'queue', 'execute', 'claim-correction', 'claim-adjustment', 'release', 'payer-submission', 'transmit', 'escalate', 'assign'].map((p) => post(`${base(W)}/${p}`, {})),
  )
  const searches = await Promise.all(['/api/exception-escalation', '/api/escalation-events', '/api/escalation-queue', `/api/organizations/${org}/escalation-events`, `/api/claims/${W.claimId}/escalation-events`, `/api/organizations/${org}/escalations`].map((p) => get(p)))
  const inserts = [...moduleCode.matchAll(/INSERT INTO "?([a-z_]+)"?/g)].map((m) => m[1])
  const dtoKeys = [...deepKeys([(await historyOf(W)).body, (await dispositionOf(W)).body, (await historyOf(RC)).body, (await dispositionOf(K)).body])]
  const allCodes88 = [...escalationEventCodes, ...escalationReasonCodes, ...followupCodes, ...returnReasonCodes, ...sourceEventKinds, ...escalationStates]
  const storedText = JSON.stringify(await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${TABLE} WHERE claim_id = ANY($1::uuid[])`, runClaims), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  const dtoText = JSON.stringify([(await historyOf(W)).body, (await dispositionOf(W)).body, (await historyOf(RC)).body, (await dispositionOf(K)).body])
  const repositoryCode = committedCode(`${MODULE_DIR}/exception-escalation.repository.ts`)
  check(
    'T110',
    'No execution, resolution, closure or A9',
    forbiddenRoutes.every((r) => r.status === 404) && searches.every((r) => r.status === 404) && same(a88Tables, [TABLE]) && mainTables.size > 50 &&
      (await newTablesLike('(closure|sla|deadline|due_|queue|outbox|_job|reopen|timer)')).length === 0 && same(inserts, [TABLE]) &&
      !/UPDATE "|DELETE FROM|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\.create\(|\.createMany\(/.test(moduleCode) && (moduleCode.match(/findMany\(/g) ?? []).length === 1 &&
      /orderBy: \{ sequence: 'asc' \}/.test(repositoryCode) && !/findFirst\(/.test(moduleCode) &&
      !COLUMNS.some((c) => /sla|deadline|due|queue|clos|resol|reopen|patient|name|birth|email|phone|diagnos|amount|currency|payer|narrative|note|text|payload|hash|digest|status|current|latest|priority/.test(c)) &&
      !dtoKeys.some((k) => /patient|birth|email|diagnos|amount|currency|payer|payment|narrative|note|payload|hash|digest|priority|deadline|due/i.test(k)) &&
      !allCodes88.some((c) => /SLA|DEADLINE|QUEUE|OVERDUE|CLOSE|RESOLVE|REOPEN|PAID|DENI|PAYMENT|PAYER|REMIT|EMERGENCY|URGENT/.test(c)) &&
      ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), key('home-PA'), 'AED', '125.25', '12.125', M1.email, T.email, 'Synthetic member', 'Synthetic finding.'].some((value) => storedText.includes(value) || dtoText.includes(value) || auditText.includes(value)) &&
      !/from 'node:(http|https|net|tls|dgram|fs|child_process)'|\bfetch\(|axios|console\.|logger\.|process\.stdout|enqueue|setInterval|worker_threads|cron/.test(moduleCode) &&
      !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|setInterval|setTimeout|navigator\.sendBeacon|WebSocket|EventSource/.test(feCode) && !/method: '(POST|PUT|PATCH|DELETE)'/.test(feCode),
    `no close, resolve, reopen, SLA, queue, execute, claim correction or adjustment, release, payer, transmit, escalate or assign route, no organization-wide list or search, and no such table, column or code; the A8.8 migration creates exactly ${TABLE}; the module's only write is its own append-only INSERT (and the audit through its owner) and its one list read is one intake's events in sequence; no patient, contact, clinical, amount, payer, narrative, payload, priority or due value is stored, answered or audited; the module logs nothing and opens no network, file or queue; the page only reads and stores nothing`,
  )

  // ---------------------------------------------------------------- backward regressions (T111–T120)
  section('Backward regressions — A8.7 invoked, nesting A8.6 -> A8.5 -> A8.3 -> A8.2 -> A8.1 -> A7.10 -> … -> A7.1 -> A6.10 -> … -> A5 -> A1')
  await apiReady('the A8.7 and backward regression chain')
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const goldenNow = async () => {
    const history = (await historyOf(W)).body
    return {
      history: withoutEvaluatedAt(history),
      disposition: withoutEvaluatedAt((await dispositionOf(W)).body),
      audits: JSON.stringify(await Promise.all(history.items.map(async (e: any) => (await auditsOfEvent(e.escalationEventId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))))),
      rows: await rowsHash(runIntakes.map((k) => k.intakeId)),
    }
  }
  const goldenBefore = await goldenNow()
  const chain = run('npm run test:a8:exception-resolution')
  const nestedLog = `a88-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A8.7')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A8.7] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A8.7 asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD, its own two runs) and re-proves
  // A8.6's branch-only causes against its own branch. On A8.8 those statements are obsolete by design; every other A8.7
  // check is substantive. T120 below proves each cause independently on this branch, down to A7.9.
  const a87NonApplicable: Record<string, string> = {
    T001: "A8.7 'A8.5 accepted merge is ancestor' requires the A8.7 feature branch name; A8.8 is cut from the main that contains A8.5, Checkpoint B, A8.6 and A8.7 (T001–T003 here)",
    T004: "A8.7 'Clean branch and remote parity' compares this tree with origin/feature/a8-7-…; THIS branch's clean tree and parity are proved by T005 and T129 here",
    T010: "A8.7 'Diff scope excludes CRG-B/C and A9' lists the paths A8.7 was allowed to change; A8.8 legitimately changes its own (T010 here)",
    T120: "A8.7 'Branch-only historical N/A individually proven' proves A8.6's branch-only causes against the A8.7 branch; here every one is re-proved on this branch, down to A7.9 (T120)",
    T128: "A8.7 'Two independent 130/130 runs exact HEAD' is the identity of A8.7's own two submitted runs at origin/feature/a8-7-…; THIS run's identity is proved by T128 and T129 here",
    T129: "A8.7 'Clean remote HEAD, full logs and hashes' compares HEAD with origin/feature/a8-7-…; THIS branch's parity, logs and hashes are proved by T005 and T129 here",
  }
  const undocumented = failing.filter((id) => !(id in a87NonApplicable))
  const summary = chain.output.match(/\[A8\.7\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.7\] RUN ABORTED|\[A8\.7\] uncaught error|\[A8\.7\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const a87Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  check(
    'T111',
    'A8.7 substantive regressions PASS',
    ran && reconciled && undocumented.length === 0 && a87Passing === 130 - failing.length && a87Passing >= 124 &&
      ['T002', 'T003', 'T005', 'T006', 'T007', 'T008', 'T009', 'T011', 'T023', 'T048', 'T061', 'T071', 'T081', 'T091', 'T109', 'T111', 'T112', 'T113', 'T114', 'T117', 'T118', 'T119', 'T121', 'T123', 'T124', 'T125', 'T130'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A8.7 suite did not complete'
      : !reconciled
        ? `A8.7 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A8.7 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A8\.7\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A8.7] automated summary: ', 'A8.7 ')}; all ${a87Passing} substantive checks PASS (its own-scope T005/T008, its later-phase-aware T109 and its terminal-return T048 included) and every failure is documented`,
  )
  check('T112', 'A8.6 substantive regressions PASS', verdictOf('T111') === 'PASS', `A8.7 T111 (A8.6, with its own documented branch-only items) ${verdictOf('T111')}`)
  check('T113', 'A8.5 substantive regressions PASS', verdictOf('T112') === 'PASS', `A8.7 T112 (A8.5) ${verdictOf('T112')}`)
  check('T114', 'A8.3 substantive regressions PASS', verdictOf('T113') === 'PASS', `A8.7 T113 (A8.3) ${verdictOf('T113')}`)
  check('T115', 'A8.2 and A8.1 regressions PASS', ['T114', 'T115'].every((id) => verdictOf(id) === 'PASS') && a84Paths.length === 0, `A8.7 T114 (A8.2) ${verdictOf('T114')} and T115 (A8.1 and the A8.4 closure) ${verdictOf('T115')}`)
  check('T116', 'A7.1–A7.10 regression chain PASS', verdictOf('T116') === 'PASS', `A8.7 T116 (A7.10 and A7.1–A7.9) ${verdictOf('T116')}`)
  check('T117', 'A6.1–A6.10 regression chain PASS', verdictOf('T117') === 'PASS', `A8.7 T117 (A6.10, which nests A6.9 → A6.1) ${verdictOf('T117')}`)
  check('T118', 'A5.1–A5.10 regression chain PASS', verdictOf('T118') === 'PASS', `A8.7 T118 (the chain reaching A5.10 → A5.1) ${verdictOf('T118')}`)
  const a3Scope = run('npm run test:a3:scope')
  check('T119', 'A1–A4 governance/auth tests PASS', verdictOf('T119') === 'PASS' && a3Scope.ok, `A8.7 T119 (A4 → A1, A3 included, and A2) ${verdictOf('T119')}; the A3.9 scope suite over this branch's files ${a3Scope.ok ? 'PASS' : 'FAIL'}`)
  let naPrinted = 0
  for (const id of Object.keys(a87NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) {
      notApplicableCheck(`T120/${id}`, `A8.7 ${titleOf(row.line)}`, a87NonApplicable[id])
      naPrinted += 1
    }
  }
  // Each documented failure must fail for its branch-only cause, proved independently on this branch from its own line
  // and this branch's state, all the way down: A8.7 T120's A8.6 items, A8.6 T110's A8.5 items, A8.5 T110's A8.3 items,
  // A8.3 T119's A8.2 items, A8.2 T120's A8.1 items, A8.1 T110's A7.10 items and A7.10 T111's A7.9 items, down to A7.9
  // T120's A7.8 items. A depth may fail only with its documented branch-only items, each exactly once; every item its
  // aggregator names must fail at the next depth.
  const headSha = git('rev-parse HEAD')
  const originHead = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a88Branch}`])
  const shortMainDefault = git('rev-parse --short origin/main')
  const thisBranchClean = (line: string) => line.includes(`## ${a88Branch}...origin/${a88Branch}`) && !/ahead|behind/.test(line.split(`## ${a88Branch}...origin/${a88Branch}`)[1]?.split(';')[0] ?? 'ahead')
  const NESTED_BRANCH_ONLY: { tag: string; aggregator: string; ids: string[] }[] = [
    { tag: 'A8.6', aggregator: 'T110', ids: ['T001', 'T003', 'T010', 'T110', 'T127', 'T129'] },
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
    const pattern = new RegExp(`^\\[A8\\.7\\] +${NESTED_BRANCH_ONLY.slice(0, depth + 1).map((d) => `nested: \\[${escapeTag(d.tag)}\\] +`).join('')}(T\\d{3}) .* \\.{3,} FAIL - (.*)$`)
    return chain.output.split(/\r?\n/).map((line) => line.match(pattern)).filter((m): m is RegExpMatchArray => m !== null).map((m) => ({ id: m[1], detail: m[2] }))
  }
  const listAfter = (text: string, label: RegExp) => ((text.match(label) ?? ['', ''])[1] ?? '').split(', ').map((s) => s.trim()).filter(Boolean)
  const detailOf = (line: string) => (line.match(/ \.{3,} FAIL - (.*)$/) ?? ['', ''])[1]
  // A nested line is cut at a fixed width, so only its last listed path may be a prefix.
  const pathsInScope = (paths: string[]) => paths.length > 0 && paths.every((p, i) => changedPaths.includes(p) || (i === paths.length - 1 && changedPaths.some((c) => c.startsWith(p))))
  const ancestorsNamed = (detail: string) => /\bas [0-9a-f]{7,40}\b/.test(detail) && [...detail.matchAll(/\bas ([0-9a-f]{7,40})\b/g)].every((m) => gitOk(`merge-base --is-ancestor ${m[1]} HEAD`))
  const nestedDepthProved = (depth: number, named: string[]): boolean => {
    const level = NESTED_BRANCH_ONLY[depth]
    const fails = nestedFails(depth)
    const ids = fails.map((f) => f.id)
    return fails.length > 0 && new Set(ids).size === ids.length && named.length > 0 && new Set(named).size === named.length && named.every((id) => ids.includes(id)) && ids.every((id) => level.ids.includes(id)) && fails.every((f) => nestedItemProved(depth, f.id, f.detail, fails.length))
  }
  const nestedItemProved = (depth: number, id: string, detail: string, count: number): boolean => {
    const level = NESTED_BRANCH_ONLY[depth]
    if (id === level.aggregator) {
      const unproven = listAfter(detail, /^cause not proven for: (.*)$/)
      return depth === NESTED_BRANCH_ONLY.length - 1 ? unproven.length > 0 && new Set(unproven).size === unproven.length && unproven.every((x) => A78_BRANCH_ONLY.includes(x)) : nestedDepthProved(depth + 1, unproven)
    }
    if (id === 'T010') return outOfScope.length === 0 && pathsInScope(listAfter(detail, /^unexpected: (.*)$/))
    if (depth === 0) {
      // A8.6's own items: its base, its branch, its parity and its run identity, each naming THIS branch and HEAD.
      if (id === 'T001') return /^A8\.5 merged as [0-9a-f]{7} /.test(detail) && detail.includes(`latest main ${shortMainDefault} contained`) && ancestorsNamed(detail)
      if (id === 'T003') return detail.startsWith(`branch ${a88Branch}; working tree clean;`) && thisBranchClean(detail)
      if (id === 'T127') return originHead === headSha && detail.includes(`HEAD ${headSha}`) && thisBranchClean(detail) && /the tree is clean after every check/.test(detail)
      if (id === 'T129') return originHead === headSha && detail.includes(`HEAD ${headSha.slice(0, 12)}`)
      return false
    }
    if (depth === 1) {
      // A8.5's own items, the same four kinds.
      if (id === 'T001') return /^A8\.3 merged as [0-9a-f]{7} .*an ancestor/.test(detail) && detail.includes(`latest main ${shortMainDefault} contained`) && ancestorsNamed(detail)
      if (id === 'T003') return detail.startsWith(`branch ${a88Branch}; working tree clean;`) && thisBranchClean(detail)
      if (id === 'T127') return originHead === headSha && detail.includes(`HEAD ${headSha}`) && thisBranchClean(detail) && /the tree is clean after every check/.test(detail)
      if (id === 'T129') return originHead === headSha && detail.includes(`HEAD ${headSha.slice(0, 12)}`)
      return false
    }
    if (id === 'T001') return detail.startsWith(`branch ${a88Branch};`) && detail.includes(`latest main ${shortMain}`) && ancestorsNamed(detail)
    if (id === 'T002') return detail.startsWith('working tree clean;') && thisBranchClean(detail)
    // T122, T123 and T130 are the identity of the historical branch's own runs: here they name THIS exact pushed HEAD.
    const counted = detail.match(/^(\d+) of the 129 checks before this one PASS, (\d+) FAIL/)
    return originHead === headSha && (detail.includes(headSha) || thisBranchClean(detail)) && (!counted || (Number(counted[2]) === count - 1 && Number(counted[1]) === 129 - (count - 1)))
  }
  const a87Line = (id: string) => rows.find((r) => r.id === id && r.verdict === 'FAIL')?.line ?? ''
  const causes: Record<string, () => boolean> = {
    T001: () => detailOf(a87Line('T001')).startsWith(`branch ${a88Branch};`) && a87Line('T001').includes(`latest main ${shortMain} contained`) && ancestorsNamed(detailOf(a87Line('T001'))) && gitOk(`merge-base --is-ancestor ${A87_MERGE} HEAD`),
    T004: () => detailOf(a87Line('T004')).startsWith('working tree clean;') && thisBranchClean(a87Line('T004')),
    T010: () => outOfScope.length === 0 && pathsInScope(listAfter(detailOf(a87Line('T010')), /^unexpected: (.*)$/)),
    T120: () => originHead === headSha && nestedDepthProved(0, listAfter(detailOf(a87Line('T120')), /^cause not proven for: (.*)$/)),
    T128: () => originHead === headSha && a87Line('T128').includes(` at ${headSha}: all 127 checks before this one executed`),
    T129: () => originHead === headSha && a87Line('T129').includes(`HEAD ${headSha}`) && thisBranchClean(a87Line('T129')) && /the tree is clean after every check/.test(a87Line('T129')),
  }
  const unprovenHere = failing.filter((id) => !(id in causes) || !causes[id]())
  // Every original nested FAIL result is kept verbatim with its N/A category. An N/A may only be a BRANCH item (branch
  // name or base ancestry), a HEAD item (clean tree, origin parity, or a run's own identity at its exact HEAD), a SCOPE
  // item (the paths that package was allowed to change) or an AGGREGATE item (a suite's own "every branch-only N/A
  // justified" check, whose items are each re-proved above). Any other kind fails T120.
  type Category = 'BRANCH' | 'HEAD' | 'SCOPE' | 'AGGREGATE'
  const topCategory: Record<string, Category> = { T001: 'BRANCH', T004: 'HEAD', T010: 'SCOPE', T120: 'AGGREGATE', T128: 'HEAD', T129: 'HEAD' }
  const ownLevelCategory: Record<string, Category> = { T001: 'BRANCH', T003: 'BRANCH', T010: 'SCOPE', T110: 'AGGREGATE', T127: 'HEAD', T129: 'HEAD' }
  const categoryOf = (tags: string[], id: string): Category | null => {
    if (tags.length === 0) return topCategory[id] ?? null
    if (tags.length > NESTED_BRANCH_ONLY.length || tags.some((tag, i) => tag !== NESTED_BRANCH_ONLY[i].tag)) return null
    const level = NESTED_BRANCH_ONLY[tags.length - 1]
    if (!level.ids.includes(id)) return null
    if (tags.length <= 2) return ownLevelCategory[id] ?? null
    return id === 'T001' ? 'BRANCH' : id === 'T010' ? 'SCOPE' : id === level.aggregator ? 'AGGREGATE' : ['T002', 'T122', 'T123', 'T130'].includes(id) ? 'HEAD' : null
  }
  const nestedEvidence = chain.output
    .split(/\r?\n/)
    .map((line) => ({ line, m: line.match(/^\[([^\]]+)\]((?: +nested: \[[^\]]+\])*) +(\S+) .* \.{3,} FAIL - /) }))
    .filter((x): x is { line: string; m: RegExpMatchArray } => x.m !== null && x.m[1] === 'A8.7')
    .map(({ line, m }) => {
      const tags = [...m[2].matchAll(/nested: \[([^\]]+)\]/g)].map((t) => t[1])
      return { line, tags, id: m[3], category: categoryOf(tags, m[3]), reason: tags.length === 0 ? (a87NonApplicable[m[3]] ?? '') : '' }
    })
  const uncategorized = nestedEvidence.filter((e) => e.category === null)
  const evidenceLog = `a88-nested-evidence-${runId}.log`
  const evidenceText = [
    `A8.8 — nested regression evidence, run ${runId} at HEAD ${headSha}`,
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
    'Historical phase-only N/A individually proven',
    ran && undocumented.length === 0 && unprovenHere.length === 0 && failing.length > 0 && naPrinted === failing.length && failing.every((id) => a87NonApplicable[id].length > 80) && uncategorized.length === 0 &&
      failing.every((id) => nestedEvidence.some((e) => e.tags.length === 0 && e.id === id)) && existsSync(evidenceLog),
    undocumented.length > 0
      ? `undocumented A8.7 failures: ${undocumented.join(', ')}`
      : unprovenHere.length > 0
        ? `cause not proven for: ${unprovenHere.join(', ')}`
        : uncategorized.length > 0
          ? `not a branch, HEAD or scope item: ${uncategorized.map((e) => [...e.tags, e.id].join('>')).join(', ').slice(0, 300)}`
          : `each documented A8.7 failure (${failing.join(', ')}) is printed individually with its reason and fails only for its branch-only cause, proved on this branch from its own line — T120's A8.6 items re-proved at every depth down to A7.9; all ${nestedEvidence.length} original nested FAIL lines kept verbatim in backend/${evidenceLog} — ${categoryCounts}, no other kind`,
  )

  // ---------------------------------------------------------------- final evidence and release (T121–T130)
  section('Final evidence and release: units, typecheck, frontend lint and build, the replay and the constraint catalog, outage and recovery, no 5xx, two runs at the exact pushed HEAD with the synthetic worked example, the handoff')
  const allUnit = run('npm run test:unit')
  check('T121', 'Backend unit tests pass', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok, `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 11 A8.8 reducer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Backend typecheck passes', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint passes', lint.ok, 'frontend lint clean, including the read-only escalation check page')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend production build passes', build.ok, `frontend production build ${(build.output.match(/built in [\dms.]+/) ?? ['ok'])[0]}`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = applied.filter((row) => {
    const blob = committedBlob(`backend/prisma/migrations/${row.name}/migration.sql`)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  const restrictLines = (replay.output.match(/PASS {2}exception_escalation_events_\w+_fkey is present after a clean replay/g) ?? []).length
  const catalog = {
    indexes: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT indexname AS n FROM pg_indexes WHERE tablename = '${TABLE}' ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    checks: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT conname AS n FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND contype = 'c' ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    triggers: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT tgname AS n FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND NOT tgisinternal ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    foreignKeys: (await fksOf(TABLE)).map((r) => `${r.name.replace(`${TABLE}_`, '')}:${r.del === 'r' ? 'RESTRICT' : r.del}`),
  }
  const generatedAgain = run('npm run db:generate')
  check(
    'T125',
    'Migration constraints and checksums verified',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && restrictLines === 8 && /PASS {2}exception_escalation_events_append_only_trg is present/.test(replay.output) &&
      /PASS {2}exception_escalation_events_no_truncate_trg is present/.test(replay.output) && /PASS {2}exception_escalation_events_shape_chk is present/.test(replay.output) &&
      status.ok && /Database schema is up to date/.test(status.output) && applied.length === headMigrationDirs.length && same(applied.map((r) => r.name), headMigrationDirs.map((d) => d.split('/').pop())) &&
      checksumMismatch.length === 0 && generatedAgain.ok && git('status --porcelain') === '' &&
      same(catalog.indexes, [
        'acknowledgement_event_id_idx', 'claim_id_idx', 'escalation_event_id_idx', 'followup_key', 'one_cycle_key', 'organization_id_idx', 'pkey', 'recorded_by_membership_id_idx', 'recorded_by_user_id_idx',
        'sequence_key', 'source_event_id_idx', 'target_member_id_idx',
      ]) &&
      same(catalog.checks, ['contract_chk', 'event_code_chk', 'sequence_chk', 'shape_chk']) && same(catalog.triggers, ['append_only_trg', 'insert_guard_trg', 'no_truncate_trg']) && catalog.foreignKeys.length === 8 &&
      catalog.foreignKeys.every((fk) => fk.endsWith(':RESTRICT')),
    `scratch replay from empty: ${appliedCount} migrations, ALL CHECKS PASS, all ${restrictLines} RESTRICT keys and every trigger and CHECK survive; exactly the ${headMigrationDirs.length} committed migrations are applied, in order, each with its committed checksum; live catalog — indexes ${catalog.indexes.join(', ')}; CHECKs ${catalog.checks.join(', ')}; triggers ${catalog.triggers.join(', ')}; keys ${catalog.foreignKeys.join(', ')}`,
  )
  check(
    'T126',
    'DB health/ready outage recovery truthful',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered && rowsAfterOutage === rowsBeforeOutage && agreeAfterRestart,
    'up 200/200; with the database stopped (T079) health stayed 200 and ready reported 503; recovery 200; every escalation row of this run hashed exactly as before the outage and history and disposition agreed for every home intake after the restart',
  )
  // No pg "client.query() while already executing" deprecation in this process or in any process of the nested chain
  // (its output carries each suite's stderr).
  const nestedDriverWarnings = (chain.output.match(/Calling client\.query\(\) when the client is already executing a query/g) ?? []).length
  check(
    'T127',
    'Zero unexpected HTTP 5xx',
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
    `worked escalation: Claim W ${W.claimId}, intake ${W.intakeId} (A8.2 classify → assign M1; A8.3 link → finding; A8.5 plan by M1 → approval by RV; A8.6 report by M1 → EVIDENCE_SUPPORTED by VR; A8.7 request by M1 → RETURN_FOR_REWORK by DR): ESCALATE_FOR_REVIEW (NEEDS_SUPERVISOR_REVIEW) by M1 to T → ACKNOWLEDGE_ESCALATION by T → four RECORD_FOLLOWUP by T citing the A8.3 finding and link and the A8.6 report and verification → RETURN_TO_OWNER (FOLLOWUP_RECORDED) by RW; RETURNED_TO_OWNER, 7 events, 7 audits; W still assigned to M1 and still A8.7 RETURNED_FOR_REWORK; nothing resolved, closed, reassigned, executed or paid`,
  )
  const headNow = git('rev-parse HEAD')
  const checksBefore128 = passed + failed
  const earlierRuns = readdirSync('.')
    .filter((name) => /^a88-nested-A88-\d{13}\.log$/.test(name) && name !== nestedLog)
    .filter((name) => readFileSync(name, 'utf8').includes(`[A8.7] HEAD ${headNow}`))
    .map((name) => name.replace(/^a88-nested-|\.log$/g, ''))
  const runIntakeIds = new Set(runIntakes.map((k) => k.intakeId))
  check(
    'T128',
    'Two independent 130/130 exact-head runs',
    checksBefore128 === 127 && /^A88-\d{13}$/.test(runId) && !earlierRuns.includes(runId) && headNow === headAtStart && headNow === originHead && runEventsSoFar.every((e) => runIntakeIds.has(e.exceptionIntakeId)) &&
      runEventMembers.length >= 30 && runEventMembers.every((e) => e.org === org && /@reviewers\.sbn\.test$/.test(e.member ?? '')) && same(goldenAfter, goldenBefore) && W.status === 201 && W_CLASSIFY.sequence === 1 &&
      W_ASSIGN.sequence === 2 && IW.statuses.every((s) => s === 201) && same(PW.statuses, [201, 201]) && same(WW.statuses, [201, 201]) &&
      same(finalHistory.items.map((e: any) => [e.sequence, e.eventCode, e.recordedByMembershipId]), [
        [1, 'ESCALATE_FOR_REVIEW', M1.membershipId], [2, 'ACKNOWLEDGE_ESCALATION', T.membershipId], [3, 'RECORD_FOLLOWUP', T.membershipId], [4, 'RECORD_FOLLOWUP', T.membershipId],
        [5, 'RECORD_FOLLOWUP', T.membershipId], [6, 'RECORD_FOLLOWUP', T.membershipId], [7, 'RETURN_TO_OWNER', RW.membershipId],
      ]) && (await eventsOf(F.intakeId)).length === 0,
    `run ${runId} at ${headNow}: all 127 checks before this one executed (${passed} PASS) with fixtures and members it created itself — W built entirely through its owners' routes and, after the nested chain, its history, disposition, audits and every run row read back identically; all ${runEventMembers.length} escalation events this run belong to the synthetic Org A and were recorded by synthetic members only; ${earlierRuns.length > 0 ? `earlier kept run(s) at this HEAD: ${earlierRuns.join(', ')}` : 'no earlier run at this HEAD is kept here, so this is the first'}; the two submitted runs must both state HEAD ${headNow.slice(0, 12)} with different runIds`,
  )
  check(
    'T129',
    'Origin parity, clean tree, evidence hashes',
    headNow === headAtStart && headNow === originHead && headNow.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a88Branch}`) && !/ahead|behind/.test(tracking) && outOfScope.length === 0 &&
      existsSync(nestedLog) && existsSync(evidenceLog),
    `HEAD ${headNow} = origin/${a88Branch}; ${tracking}; the tree is clean after every check (the nested logs are ignored output); nested output kept in backend/${nestedLog} (SHA-256 ${sha256Of(Buffer.from(chain.output))}), nested evidence in backend/${evidenceLog} (SHA-256 ${sha256Of(Buffer.from(evidenceText))})`,
  )
  const typesText = committedText(`${MODULE_DIR}/exception-escalation.types.ts`)
  const vocabulary = [...escalationEventCodes, ...escalationReasonCodes, ...followupCodes, ...returnReasonCodes, ...sourceEventKinds, ...escalationStates, CONTRACT]
  check(
    'T130',
    'Owner handoff keeps closure and integration later',
    registerFlat.includes('## Out of scope (handoff)') && registerFlat.includes('executing any remediation') && registerFlat.includes('governed exception closure') && registerFlat.includes('INTERNAL HANDOFF') && registerFlat.includes('## A6.10 T087 later-phase recognition (included in this PR)') &&
      registerFlat.includes('`RETURNED_TO_OWNER` | An independent reviewer returned it with its reason. Terminal in v1.') && registerFlat.includes('A9') && registerAtHead.includes(A85_MERGE) && registerAtHead.includes(A86_MERGE) &&
      registerAtHead.includes(A87_MERGE) && registerAtHead.includes(`(${CONTRACT})`) && vocabulary.every((code) => registerAtHead.includes(`\`${code}\``) && typesText.includes(`'${code}'`)) &&
      [
        'getExceptionIntakesOf', 'getTriageDispositionOf', 'getTriageHistoryOf', 'getInvestigationHistoryOf', 'getRemediationDispositionOf', 'getRemediationHistoryOf', 'getWorkHistoryOf', 'getResolutionDispositionOf',
        'getResolutionHistoryOf', 'assigneeCurrentlyEligible', 'getEscalationDispositionOf',
      ].every((t) => registerAtHead.includes(t)),
    `the register records the start gate (A8.5 ${A85_MERGE.slice(0, 7)}, A8.6 ${A86_MERGE.slice(0, 7)}, A8.7 ${A87_MERGE.slice(0, 7)} = main at start), the A8.7 reconciliation and decisions D1–D8, the owner readers, ${CONTRACT} and all ${vocabulary.length} controlled codes (each identical in the module), escalation as an internal handoff only, RETURNED_TO_OWNER as terminal in v1, the A6.10 T087 later-phase correction made in this PR, and execution, a second cycle, closure, SLAs, CRG activation and A9 as later, separately approved work`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] EXCEPTION ESCALATION ACCEPTANCE COMPLETE` : `[${TAG}] A8.8 FINAL FAIL`)
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
    // The synthetic partial role of this run exists only for the six-permission proof; if a run stopped inside it, it
    // is removed here so no later check ever sees it.
    try {
      const leftover = await prisma.role.findMany({ where: { code: { startsWith: 'SYNTHETIC_A88_' } }, select: { id: true } })
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
