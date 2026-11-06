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
import { deriveRemediation } from '../../modules/exception-remediation/exception-remediation.reducer.ts'
import { getRemediationDispositionOf, getRemediationHistoryOf, recordRemediationEvent, recordRemediationEventOn } from '../../modules/exception-remediation/exception-remediation.service.ts'
import {
  REMEDIATION_CONTRACT_VERSION,
  actionCodes,
  decisionCodes,
  rationaleCodes,
  remediationEventCodes,
  remediationStates,
  reviewReasonCodes,
} from '../../modules/exception-remediation/exception-remediation.types.ts'

// A8.5 — focused acceptance for Exception Remediation Proposal & Review Decision (A8-REMEDIATION-PLAN-1, T001–T130).
//
// Every Claim, freeze, A8.1 intake, A8.2 triage event and A8.3 investigation event is built through its owners exactly
// as the A8.3 suite builds them: a Claim frozen twice without an A6.9 link is a genuine history contradiction, its intake
// is recorded through the A8.1 route, classified and assigned through the A8.2 route, and its assignee links the intake
// basis and records a finding through the A8.3 route. Every remediation event is recorded through the A8.5 route by the
// assignee or an independent reviewer or, where a probe must pause or fail one writer, through the production A8.5
// service in this process. Direct SQL writes are adversarial only, run against the live guards (or, to isolate one
// CHECK, with the triggers off), and are ALWAYS rolled back; a broken stored history is planted only inside such a
// transaction and the production reads answer on THAT transaction. Synthetic users are provisioned per run through
// Better Auth's own server-side creation with a random password that is never printed. An approval is planning
// authorization only: nothing in this suite expects, or finds, anything executed, corrected, resolved or paid.

const TAG = 'A8.5'
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

const runId = `A85-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a85Branch = 'feature/a8-5-exception-remediation'
const a83Branch = 'feature/a8-3-exception-investigation'
const a82Branch = 'feature/a8-2-exception-triage'
const a81Branch = 'feature/a8-1-exception-intake'
const a81FixBranch = 'fix/a8-1-harness-later-phase-recognition'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
const crgBranch = 'fix/crg-01-final-coding-release'
const harnessFixBranch = 'fix/a5-10-a7-2-harness-later-phase-recognition'
const UPSTREAM_BRANCHES = [
  'feature/a6-10-a6-integration-acceptance', 'feature/a7-1-revenue-source-evidence', 'feature/a7-2-evidence-classification', 'feature/a7-3-adjudication-evidence-readiness',
  'feature/a7-4-revenue-evidence-case-assembly', 'feature/a7-5-case-closure-prerequisite-assessment', 'feature/a7-6-closure-basis-trace', 'feature/a7-7-revenue-evidence-timeline', a78Branch, a79Branch, a710Branch, a81Branch, a81FixBranch, a82Branch,
  a83Branch, harnessFixBranch, crgBranch,
]
// The accepted A8.3 merge and the clean main this branch was cut from, both recorded in the register (start gate).
const A83_MERGE = 'a9f15806f4a178250b4aa263874a2b5c17ba827c'
const MAIN_AT_START = 'c8ebf2c4cc385dadeaacafca0bca69db5c534b7a'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/exception-remediation'
const FE_DIR = 'frontend/src/modules/exception-remediation'
const HARNESS_DIR = 'backend/src/integration/a8-exception-remediation'
const REGISTER_DOC = 'docs/A8_Exception_Remediation.md'
const MIGRATION_NAME = '20261105090000_a8_5_exception_remediation'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const A83_MIGRATION = 'backend/prisma/migrations/20261103090000_a8_3_exception_investigation/migration.sql'
const TABLE = 'exception_remediation_events'
const INVESTIGATION_TABLE = 'exception_investigation_events'
const TRIAGE_TABLE = 'exception_triage_events'
const INTAKE_TABLE = 'exception_intake_records'
const UNIT_TESTS = [`${MODULE_DIR}/exception-remediation.reducer.test.ts`, `${MODULE_DIR}/exception-remediation.validation.test.ts`]
const CONTRACT = 'A8-REMEDIATION-PLAN-1'
const INTAKE_CONTRACT = 'A8-EXCEPTION-INTAKE-1'
const TIMELINE_CONTRACT = 'A7-REVENUE-TIMELINE-1'
const EVENT_KEYS = [
  'remediationEventId', 'contractVersion', 'exceptionIntakeId', 'organizationId', 'claimId', 'sequence', 'eventCode', 'actionCode', 'findingEventId', 'rationaleCode', 'proposalEventId',
  'decisionCode', 'reviewReasonCode', 'recordedByMembershipId', 'recordedByUserId', 'recordedAt',
]
const HISTORY_KEYS = ['contractVersion', 'exceptionIntakeId', 'items', 'evaluatedAt']
const DISPOSITION_KEYS = ['contractVersion', 'exceptionIntakeId', 'state', 'pendingProposal', 'latestDecision', 'approvedProposalEventId', 'proposalCount', 'eventCount', 'lastSequence', 'evaluatedAt']
const PROPOSAL_KEYS = ['remediationEventId', 'sequence', 'actionCode', 'findingEventId', 'rationaleCode', 'proposedByMembershipId', 'proposedByUserId']
const DECISION_KEYS = ['remediationEventId', 'sequence', 'proposalEventId', 'decisionCode', 'reviewReasonCode', 'reviewedByMembershipId', 'reviewedByUserId']
const AUDIT_KEYS = [
  'remediationEventId', 'exceptionIntakeId', 'claimId', 'contractVersion', 'sequence', 'eventCode', 'actionCode', 'findingEventId', 'rationaleCode', 'proposalEventId', 'decisionCode',
  'reviewReasonCode', 'recordedByMembershipId', 'recordedAt',
]
const COLUMNS = [
  'id', 'exception_intake_id', 'organization_id', 'claim_id', 'contract_version', 'sequence', 'event_code', 'action_code', 'a8_3_finding_event_id', 'rationale_code', 'proposal_event_id',
  'decision_code', 'review_reason_code', 'recorded_by_membership_id', 'recorded_by_user_id', 'recorded_at', 'created_at',
]
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/shared/authorization/authorization.types.ts',
  'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'backend/src/modules/audit/audit.types.ts', 'frontend/src/developer/checkRegistry.tsx', REGISTER_DOC,
]
// Every table a remediation write could conceivably touch, in a fixed key order. A read or a refusal must leave every
// one as it was; a recorded event adds exactly one row here and one audit.
const COUNT_TABLES = [TABLE, INVESTIGATION_TABLE, TRIAGE_TABLE, INTAKE_TABLE, 'audit_events', 'claims', 'claim_freezes', 'claim_freeze_lifecycle_events', 'claim_correction_links', 'organization_memberships', 'membership_roles']
// The CRG-01 coding-release tables and the A2 code masters: a RECHECK_CODING_REFERENCE proposal selects, activates and
// changes none of them.
const CODING_TABLES = ['crg_code_system_datasets', 'crg_code_system_rights', 'crg_release_imports', 'crg_release_code_memberships', 'crg_retirement_classifications', 'procedure_codes', 'diagnosis_codes']

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
type HistoryItem = { remediationEventId: string; sequence: number; eventCode: string; actionCode: string | null; findingEventId: string | null; rationaleCode: string | null; proposalEventId: string | null; decisionCode: string | null; reviewReasonCode: string | null }
function replayIndependently(items: HistoryItem[]) {
  let state = 'NO_PROPOSAL'
  let pending: HistoryItem | null = null
  let latestDecision: HistoryItem | null = null
  let proposals = 0
  for (const item of items) {
    if (item.eventCode === 'PROPOSE_ACTION') {
      proposals += 1
      pending = item
      state = 'AWAITING_REVIEW'
    } else {
      latestDecision = item
      pending = null
      state = item.decisionCode === 'APPROVE_PROPOSAL' ? 'APPROVED_FOR_PLANNING' : 'RETURNED_FOR_REVISION'
    }
  }
  return {
    state,
    pendingProposalId: pending?.remediationEventId ?? null,
    latestDecisionId: latestDecision?.remediationEventId ?? null,
    approvedProposalEventId: state === 'APPROVED_FOR_PLANNING' ? (latestDecision?.proposalEventId ?? null) : null,
    proposalCount: proposals,
    eventCount: items.length,
    lastSequence: items.length > 0 ? items[items.length - 1].sequence : null,
  }
}
const dispositionFacts = (d: any) => ({
  state: d?.state,
  pendingProposalId: d?.pendingProposal?.remediationEventId ?? null,
  latestDecisionId: d?.latestDecision?.remediationEventId ?? null,
  approvedProposalEventId: d?.approvedProposalEventId ?? null,
  proposalCount: d?.proposalCount,
  eventCount: d?.eventCount,
  lastSequence: d?.lastSequence,
})

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] A8.5 exception remediation proposal & review decision (${CONTRACT}) — run ${runId}`)
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

  // ---------------------------------------------------------------- start, ownership and scope (T001–T010)
  section('Start, ownership and scope: the accepted A8.3 merge, the A8.4 closure and A8.5 index, branch and tree, one additive migration, Prisma, replay, the narrow permissions and audit action, three routes, earlier contracts, diff scope')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a83Merge = mergeOf(a83Branch)
  const a82Merge = mergeOf(a82Branch)
  const a81Merge = mergeOf(a81Branch)
  const a81FixMerge = mergeOf(a81FixBranch)
  const a710Merge = mergeOf(a710Branch)
  const upstreamMerges = UPSTREAM_BRANCHES.map((name) => ({ name, sha: mergeOf(name) }))
  check(
    'T001',
    'A8.3 accepted merge is ancestor; clean main base',
    branch === a85Branch && a83Merge === A83_MERGE && gitOk(`merge-base --is-ancestor ${a83Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${MAIN_AT_START} HEAD`) &&
      gitOk('merge-base --is-ancestor origin/main HEAD') && upstreamMerges.every((m) => m.sha.length === 40 && gitOk(`merge-base --is-ancestor ${m.sha} HEAD`)),
    `A8.3 merged as ${a83Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A83_MERGE.slice(0, 7)}), an ancestor; cut from clean main ${MAIN_AT_START.slice(0, 7)} (CRG-01 Checkpoint A); latest main ${git('rev-parse --short origin/main')} contained; A6.10, A7.1–A7.10, A8.1–A8.3, both harness corrections and CRG-01 are ancestors; not stacked`,
  )
  const registerAtHead = committedText(REGISTER_DOC)
  const registerFlat = registerAtHead.replace(/\s+/g, ' ')
  const headTree = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter(Boolean)
  const a84Paths = headTree.filter((path) => /(^|[\\/_-])a8[-_]?4([\\/_.-]|$)/i.test(path))
  check(
    'T002',
    'A8.4 duplicate closure recorded; A8.5 indexed',
    registerFlat.includes('On 2026-11-04 the architecture owner closed the earlier A8.4 investigation-evidence specification as a duplicate of A8.3') &&
      registerFlat.includes('A8.5 is the approved next A8 index') && registerFlat.includes('It is not executable') && a84Paths.length === 0,
    a84Paths.length === 0
      ? 'the register records the 2026-11-04 closure of the A8.4 investigation-evidence specification as a duplicate of A8.3 (not executable) and A8.5 as the approved next index; no A8.4 module, migration, suite or page exists at HEAD'
      : `A8.4 paths exist: ${a84Paths.join(', ').slice(0, 200)}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T003',
    'Correct branch from main; clean tracked tree',
    branch === a85Branch && dirty.length === 0 && tracking.includes(`origin/${a85Branch}`) && !/ahead|behind/.test(tracking),
    dirty.length === 0 ? `branch ${branch}; working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  // A8.5's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge added
  // (the same values, literally, on its own branch). A later package's changes are that package's to prove.
  const ownMerge = branch === a85Branch ? '' : mergeOf(a85Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'
  const ownTip = ownMerge || 'HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = migrationDirsAt(ownTip)
  const ownBaseMigrationDirs = migrationDirsAt(ownBase)
  check(
    'T004',
    'One additive migration; no applied one changed',
    same(ownPrismaStatus, [`A\t${MIGRATION}`, 'M\tbackend/prisma/schema.prisma']) && ownHeadMigrationDirs.length === ownBaseMigrationDirs.length + 1 && ownBaseMigrationDirs.every((dir) => ownHeadMigrationDirs.includes(dir)) &&
      ownHeadMigrationDirs[ownHeadMigrationDirs.length - 1].endsWith(MIGRATION_NAME),
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
    'Scratch replay includes every committed migration',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && /PASS {2}the A8\.5 tables are exactly exception_remediation_events/.test(replay.output) &&
      /PASS {2}exception_remediation_events_insert_guard_trg is present/.test(replay.output) && /PASS {2}one remediation event per \(intake, sequence\) and one review per proposal are unique/.test(replay.output) &&
      /PASS {2}the A8\.5 CHECKs pin A8-REMEDIATION-PLAN-1/.test(replay.output) && /PASS {2}exception_remediation_events carries exactly its 17 A8\.5 columns/.test(replay.output),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD; every A8.5 CHECK, unique index, trigger, column and RESTRICT key survives`,
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
  const knownException = [
    'exceptionIntake.create', 'exceptionIntake.read', 'exceptionTriage.read', 'exceptionTriage.record', 'exceptionInvestigation.read', 'exceptionInvestigation.record', 'exceptionRemediation.propose',
    'exceptionRemediation.review', 'exceptionRemediation.read',
  ]
  check(
    'T007',
    'Only A8.5 permissions and audit action added',
    same(catalogueHead.filter((c) => !catalogueMain.includes(c)).sort(), ['exceptionRemediation.propose', 'exceptionRemediation.read', 'exceptionRemediation.review']) && catalogueMain.every((c) => catalogueHead.includes(c)) &&
      same(allCodes.filter((c) => /^exceptionRemediation\./.test(c)).sort(), ['exceptionRemediation.propose', 'exceptionRemediation.read', 'exceptionRemediation.review']) &&
      (await grantsOf('exceptionRemediation.propose')) === 'ORG_ADMIN' && (await grantsOf('exceptionRemediation.review')) === 'ORG_ADMIN' && (await grantsOf('exceptionRemediation.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('exceptionInvestigation.record')) === 'ORG_ADMIN' && (await grantsOf('exceptionTriage.record')) === 'ORG_ADMIN' && (await grantsOf('exceptionInvestigation.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      !allCodes.some((c) => /^exception/i.test(c) && !knownException.includes(c) && !laterPermissions.includes(c)) &&
      same(auditHead.filter((c) => !auditMain.includes(c)), ['exception_remediation.recorded']) && auditMain.every((c) => auditHead.includes(c)),
    'the catalogue adds exactly exceptionRemediation.propose and .review (Admin) and .read (Admin, Viewer); the audit catalogue adds exactly exception_remediation.recorded; every earlier grant is unchanged; no execute, resolve, close, escalate or export permission exists',
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
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /exception_remediation_|exception_investigation_|exception_triage_|exception_intake_|claim_freeze|organization_memberships/.test(text)
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
  // B approves home freezes; M1 is the worked scenario's assignee and proposer; RV and RV2 are independent reviewers
  // (Admins, never assigned); M2 is K's former assignee and its assignee again after a concurrent reassignment; M4 owns
  // the other intakes; M5 loses its role while it owns G; NR is a member without any role; O and O2 belong to the other
  // tenant.
  const B = await provisionMember('b')
  const M1 = await provisionMember('m1')
  const RV = await provisionMember('rv')
  const RV2 = await provisionMember('rv2')
  const M2 = await provisionMember('m2')
  const M4 = await provisionMember('m4')
  const M5 = await provisionMember('m5')
  const NR = await provisionMember('norole', org, false)
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: two organizations; Claims frozen twice without a link, their A8.1 intakes, A8.2 assignments and A8.3 evidence links and findings by each assignee')
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
  // A8.2 through its own route (the harness's Admin, or another tenant's Admin): classification, assignment, return.
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
  // W — the worked scenario (§7) and the golden history. L — refusals, the link-only refusal, the unchanged repeat after
  // a return, self-review and the coding-reference proposal. L0 — kept UNTRIAGED. S — direct SQL (never a committed
  // remediation event). J — failure injection, retries and unknown outcomes. R — races. K — the A8.2 interplay (M2
  // assigned, then M4; reassigned to M2 concurrently later). G — M5's role removal. Q — six mixed concurrent operations.
  // F — the other tenant's intake, with its own triage and finding.
  const W = await intakeFor('worked')
  const L = await intakeFor('refusal')
  const L0 = await intakeFor('untriaged')
  const S = await intakeFor('sql')
  const J = await intakeFor('inject')
  const R = await intakeFor('race')
  const K = await intakeFor('interplay')
  const G = await intakeFor('revoked')
  const Q = await intakeFor('mixed')
  const F = await intakeFor('foreign', away, O.who)
  const W_CLASSIFY = await triage(W, classify)
  const W_ASSIGN = await triage(W, assignTo(M1))
  for (const k of [L, S, J, R, Q]) {
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
  const IL = await investigate(L, M4.who, 'EVIDENCE_CONFIRMS_RECORDED_CONFLICT')
  const IS = await investigate(S, M4.who)
  const IJ = await investigate(J, M4.who, 'EVIDENCE_INCONCLUSIVE')
  const IR = await investigate(R, M4.who)
  const IK = await investigate(K, M4.who)
  const IG = await investigate(G, M5.who)
  const IQ = await investigate(Q, M4.who)
  const IF = await investigate(F, O.who)
  const homeIntakes = [W, L, L0, S, J, R, K, G, Q]
  const runIntakes = [...homeIntakes, F]
  const runClaims = homeIntakes.map((k) => k.claimId)
  progress(
    `fixtures ready: two synthetic AE-DU/DHA worlds; ${homeIntakes.length} A8.1 intakes on contradicted Claims in Org A (basis ${W.basisCode}) and one in Org B; W assigned to M1, K to M4 after M2, G to M5, L/S/J/R/Q to M4, L0 untriaged; each assigned intake carries an A8.3 basis link and a finding by its assignee`,
  )

  const rem = (k: { claimId: string; intakeId: string }, body: unknown, who: Who) => post(`${base(k)}/remediation-events`, body, who)
  const historyOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/remediation-history`, who)
  const dispositionOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/remediation-disposition`, who)
  const triageDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/triage-disposition`)
  const investigationSummaryOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/investigation-summary`)
  const propose = (findingEventId: string, actionCode = 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', rationaleCode = 'INSUFFICIENT_EVIDENCE') => ({ eventCode: 'PROPOSE_ACTION', actionCode, findingEventId, rationaleCode })
  const approveOf = (proposalEventId: string) => ({ eventCode: 'REVIEW_ACTION', proposalEventId, decisionCode: 'APPROVE_PROPOSAL' })
  const returnOf = (proposalEventId: string, reviewReasonCode = 'NEEDS_MORE_INVESTIGATION') => ({ eventCode: 'REVIEW_ACTION', proposalEventId, decisionCode: 'RETURN_PROPOSAL', reviewReasonCode })
  const eventsOf = (intakeId: string) => prisma.exceptionRemediationEvent.findMany({ where: { exceptionIntakeId: intakeId }, orderBy: { sequence: 'asc' } })
  const auditsOfEvent = (eventId: string) => prisma.auditEvent.findMany({ where: { entityType: 'EXCEPTION_REMEDIATION_EVENT', entityId: eventId } })
  const auditsOfIntake = (intakeId: string) => prisma.auditEvent.count({ where: { actionCode: 'exception_remediation.recorded', afterState: { path: ['exceptionIntakeId'], equals: intakeId } } })
  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const plus = (before: Record<string, number>, events: number) => ({ ...before, [TABLE]: before[TABLE] + events, audit_events: before.audit_events + events })
  const codingCounts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${CODING_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    return JSON.stringify(rows.map((row) => [row.t, Number(row.n)]))
  }
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const rowsHash = (intakeIds: string[]) => hashOf(`SELECT e.* FROM ${TABLE} e WHERE e.exception_intake_id = ANY($1::uuid[])`, intakeIds)
  const rowHash = (eventId: string) => hashOf(`SELECT e.* FROM ${TABLE} e WHERE e.id = $1::uuid`, eventId)
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
  // One direct event row of intake `k`: by default its valid first proposal — naming the intake's own A8.3 finding —
  // recorded through M4's membership (the assignee of S). A review defaults to RV's approval.
  const findingOfIntake = new Map<string, string>([W, L, S, J, R, K, G, Q, F].map((k, i) => [k.intakeId, [IW, IL, IS, IJ, IR, IK, IG, IQ, IF][i].findingId]))
  const rowOf = (k: Intake, o: Row = {}): Row => ({
    id: randomUUID(), exception_intake_id: k.intakeId, organization_id: k.organizationId, claim_id: k.claimId, contract_version: CONTRACT, sequence: 1, event_code: 'PROPOSE_ACTION',
    action_code: 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', a8_3_finding_event_id: findingOfIntake.get(k.intakeId) ?? MISSING, rationale_code: 'INSUFFICIENT_EVIDENCE', proposal_event_id: null, decision_code: null,
    review_reason_code: null, recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id, recorded_at: null, ...o,
  })
  const reviewRow = (k: Intake, sequence: number, proposalId: string, o: Row = {}) =>
    rowOf(k, { sequence, event_code: 'REVIEW_ACTION', action_code: null, a8_3_finding_event_id: null, rationale_code: null, proposal_event_id: proposalId, decision_code: 'APPROVE_PROPOSAL', review_reason_code: null, recorded_by_membership_id: RV.membershipId, recorded_by_user_id: RV.id, ...o })
  const insertRow = (tx: DbClient, row: Row) =>
    row.recorded_at === null
      ? tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, action_code, a8_3_finding_event_id, rationale_code, proposal_event_id, decision_code, review_reason_code, recorded_by_membership_id, recorded_by_user_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8, $9::uuid, $10, $11::uuid, $12, $13, $14::uuid, $15::uuid)`,
          row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.action_code, row.a8_3_finding_event_id, row.rationale_code,
          row.proposal_event_id, row.decision_code, row.review_reason_code, row.recorded_by_membership_id, row.recorded_by_user_id,
        )
      : tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, action_code, a8_3_finding_event_id, rationale_code, proposal_event_id, decision_code, review_reason_code, recorded_by_membership_id, recorded_by_user_id, recorded_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8, $9::uuid, $10, $11::uuid, $12, $13, $14::uuid, $15::uuid, $16::timestamptz, $16::timestamptz)`,
          row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.action_code, row.a8_3_finding_event_id, row.rationale_code,
          row.proposal_event_id, row.decision_code, row.review_reason_code, row.recorded_by_membership_id, row.recorded_by_user_id, row.recorded_at,
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
  // A stored history planted with the triggers off (and, where named, DDL such as a dropped CHECK) inside a rolled-back
  // transaction; the production reads answer on THAT transaction.
  const plantedRead = async (k: Intake, rows: Row[], ddl?: string) =>
    rolledBack(async (tx) => {
      if (ddl) await tx.$executeRawUnsafe(ddl)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const row of rows) await insertRow(tx, row)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      return { history: await getRemediationHistoryOf(k.claimId, k.intakeId, tx), disposition: await getRemediationDispositionOf(k.claimId, k.intakeId, tx) }
    })
  const snap = async () => ({
    freezes: await hashOf(`SELECT f.*, m.id AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    lifecycle: await hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    links: await hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    claims: await hashOf(`SELECT c.* FROM claims c WHERE c.id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    intakes: await hashOf(`SELECT r.* FROM ${INTAKE_TABLE} r WHERE r.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    intakeAudits: await hashOf(`SELECT a.id, a.action_code, a.entity_id, a.after_state, a.occurred_at FROM audit_events a WHERE a.entity_type = 'EXCEPTION_INTAKE' AND a.entity_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId)),
    investigation: await hashOf(`SELECT e.* FROM ${INVESTIGATION_TABLE} e WHERE e.exception_intake_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId)),
  })
  const ownerSnapshotBefore = await snap()
  // Every A8.2 triage event that exists before the first remediation write: A8.5 must never change one of them.
  const triageIdsBefore = (await prisma.exceptionTriageEvent.findMany({ where: { exceptionIntakeId: { in: runIntakes.map((k) => k.intakeId) } }, select: { id: true } })).map((row) => row.id)
  const triageHash = () => hashOf(`SELECT t.* FROM ${TRIAGE_TABLE} t WHERE t.id = ANY($1::uuid[])`, triageIdsBefore)
  const triageHashBefore = await triageHash()
  const codingBefore = await codingCounts()
  const wTriageBefore = withoutEvaluatedAt((await triageDispositionOf(W)).body)
  const wInvestigationBefore = withoutEvaluatedAt((await investigationSummaryOf(W)).body)
  const wIntakesBefore = withoutEvaluatedAt((await get(`/api/claims/${W.claimId}/exception-intake`)).body)
  const iwFindingHashBefore = await hashOf(`SELECT e.* FROM ${INVESTIGATION_TABLE} e WHERE e.id = $1::uuid`, IW.findingId)

  // ---------------------------------------------------------------- wiring and scope (T008–T010)
  const routeCode = committedCode(`${MODULE_DIR}/exception-remediation.route.ts`)
  const missingClaim = { claimId: MISSING, intakeId: W.intakeId }
  const wiring = [await rem(missingClaim, propose(IW.findingId), M1.who), await historyOf(missingClaim), await dispositionOf(missingClaim)]
  const absent = [
    await api('PATCH', `${base(W)}/remediation-events`, {}), await api('PUT', `${base(W)}/remediation-events`, {}), await api('DELETE', `${base(W)}/remediation-events`), await get(`${base(W)}/remediation-events`),
    await get(`${base(W)}/remediation-events/${MISSING}`), await api('PUT', `${base(W)}/remediation-disposition`, {}), await post(`${base(W)}/remediation-disposition`, {}), await post(`${base(W)}/remediation-history`, {}),
    await post(`${base(W)}/remediation-execute`, {}), await post(`${base(W)}/execute`, {}), await post(`${base(W)}/actions`, {}), await post(`${base(W)}/approve`, {}), await post(`${base(W)}/remediation`, {}),
    await post(`${base(W)}/resolve`, {}), await post(`${base(W)}/close`, {}), await get(`${base(W)}/remediation-current`), await get('/api/exception-remediations'), await get('/api/remediation-events'),
    await get(`/api/claims/${W.claimId}/remediations`),
  ]
  check(
    'T008',
    'Three routes only; no execution endpoint',
    wiring.every((r) => r.status === 404 && errorCode(r.body) === 'NOT_FOUND') && absent.every((r) => r.status === 404) &&
      (routeCode.match(/exceptionRemediationRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 3 && /exceptionRemediationRouter\.post\(`\$\{BASE\}\/remediation-events`/.test(routeCode) &&
      /exceptionRemediationRouter\.get\(`\$\{BASE\}\/remediation-history`/.test(routeCode) && /exceptionRemediationRouter\.get\(`\$\{BASE\}\/remediation-disposition`/.test(routeCode) &&
      /const BASE = '\/:claimId\/exceptions\/:exceptionIntakeId'/.test(routeCode),
    `the POST and both GETs answer a missing Claim with a privacy-safe 404; PATCH/PUT/DELETE, an event by id, a current selector, execute, action, approve, resolve and close routes, a collection and cross-Claim searches are absent (${absent.map((r) => r.status).join('/')})`,
  )
  const contractConstantsAt = (ref: string) =>
    gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, 'backend/src/modules'])
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path) && !path.startsWith(`${MODULE_DIR}/`))
      .flatMap((path) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(/export const ([A-Z_]*CONTRACT_VERSION) = '([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`))
      .sort()
  const errorCodesAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/errors/error.types.ts`]).matchAll(/^\s+'([A-Z_]+)',/gm)].map((m) => m[1])
  const contractsOwn = contractConstantsAt(ownTip)
  const errorsOwn = errorCodesAt(ownTip)
  const errorsBase = errorCodesAt(ownBase)
  const productDiff = ownChangedPaths.filter((p) => /^backend\/src\/modules\//.test(p) && !p.startsWith(`${MODULE_DIR}/`) && p !== 'backend/src/modules/audit/audit.types.ts')
  const ownEarlierSuites = ownChangedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`))
  const ownEarlierUnits = ownChangedPaths.filter((file) => /\.test\.tsx?$/.test(file) && !file.startsWith(`${MODULE_DIR}/`))
  check(
    'T009',
    'All A1–A8.3 contracts unchanged',
    contractsOwn.length >= 22 && same(contractsOwn, contractConstantsAt(ownBase)) && productDiff.length === 0 && ownEarlierSuites.length === 0 && ownEarlierUnits.length === 0 &&
      ownPrismaStatus.every((s) => !/^M\tbackend\/prisma\/migrations\//.test(s)) && committedText(`${MODULE_DIR}/exception-remediation.types.ts`).includes(`REMEDIATION_CONTRACT_VERSION = '${CONTRACT}'`) &&
      errorsBase.every((c) => errorsOwn.includes(c)) &&
      same(errorsOwn.filter((c) => !errorsBase.includes(c)), ['EXCEPTION_REMEDIATION_NOT_ASSIGNEE', 'EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT', 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED', 'EXCEPTION_REMEDIATION_CONFLICT']),
    `all ${contractsOwn.length} A1–A8.3 and CRG-01 owner contracts identical to main; no earlier module's code, integration suite, unit test or applied migration changed; the error catalogue only gains the four A8.5 codes`,
  )
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${FE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file))
  const earlierSuites = changedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`))
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a9|dhpo|eclaimlink|coding-release|crg|resolution|escalat|export|work-queue|\bsla\b|execut/i.test(file))
  check(
    'T010',
    'Diff allowlist excludes CRG/A9/later domains',
    changedPaths.length > 0 && outOfScope.length === 0 && earlierSuites.length === 0 && laterDomain.length === 0,
    outOfScope.length + earlierSuites.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A8.5 module, page, harness, migration and register and the narrow shared additions; no earlier suite changed; no CRG-01, execution, resolution, export or A9 domain`
      : `unexpected: ${[...new Set([...outOfScope, ...earlierSuites, ...laterDomain])].join(', ').slice(0, 300)}`,
  )

  // ---------------------------------------------------------------- contract and input validation (T011–T020)
  section('Contract and input validation on W: the v1 literal and DTOs, strict proposal and review keys, unknown bodies, server-owned fields, malformed ids, unknown codes, the conditional reason, injection and free text')
  const countsAtStart = await counts()
  const noProposalW = { disposition: await dispositionOf(W), history: await historyOf(W), rows: (await eventsOf(W.intakeId)).length }
  const P1 = await rem(W, propose(IW.findingId), M1.who)
  const P1_ID = (P1.body?.remediationEventId ?? MISSING) as string
  const countsAfterP1 = await counts()
  const p1HashBefore = await rowHash(P1_ID)
  const contractDef = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${TABLE}_contract_chk'`))[0]?.d ?? ''
  const historyP1 = await historyOf(W)
  const dispositionP1 = await dispositionOf(W)
  check(
    'T011',
    'Exact v1 version in DTO and SQL CHECK',
    P1.status === 201 && P1.body.contractVersion === CONTRACT && REMEDIATION_CONTRACT_VERSION === CONTRACT && same(Object.keys(P1.body), EVENT_KEYS) && same(Object.keys(historyP1.body), HISTORY_KEYS) &&
      same(Object.keys(dispositionP1.body), DISPOSITION_KEYS) && same(Object.keys(dispositionP1.body.pendingProposal ?? {}), PROPOSAL_KEYS) && historyP1.body.contractVersion === CONTRACT &&
      dispositionP1.body.contractVersion === CONTRACT && contractDef.includes(`'${CONTRACT}'`) && /IS NOT NULL/.test(contractDef),
    `W's first proposal carries ${CONTRACT} and exactly the ${EVENT_KEYS.length} event keys; the history, the disposition and its pending proposal carry exactly theirs; the database CHECK pins the literal`,
  )
  const wRows = async () => (await eventsOf(W.intakeId)).length
  const isValidation = (r: { status: number; body: any }) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR'
  const strictProposal = [
    await rem(W, { ...propose(IW.findingId), proposalEventId: P1_ID }, M1.who), await rem(W, { ...propose(IW.findingId), decisionCode: 'APPROVE_PROPOSAL' }, M1.who),
    await rem(W, { ...propose(IW.findingId), reviewReasonCode: 'WRONG_SCOPE' }, M1.who), await rem(W, { eventCode: 'PROPOSE_ACTION', actionCode: 'RECHECK_CODING_REFERENCE', findingEventId: IW.findingId }, M1.who),
    await rem(W, { eventCode: 'PROPOSE_ACTION', actionCode: 'RECHECK_CODING_REFERENCE', rationaleCode: 'RECORDED_CONFLICT' }, M1.who), await rem(W, { ...propose(IW.findingId), findingEventId: 42 }, M1.who),
    await rem(W, { ...propose(IW.findingId), actionCode: null }, M1.who),
  ]
  check('T012', 'Strict PROPOSE_ACTION shape', strictProposal.every(isValidation) && (await wRows()) === 1, "a proposal with a review field, without its rationale or finding, with a non-string finding or a null action is a 400; nothing recorded")
  const strictReview = [
    await rem(W, { ...approveOf(P1_ID), reviewReasonCode: 'WRONG_SCOPE' }, RV.who), await rem(W, { ...approveOf(P1_ID), actionCode: 'REVIEW_SOURCE_PROVENANCE' }, RV.who),
    await rem(W, { ...returnOf(P1_ID), findingEventId: IW.findingId }, RV.who), await rem(W, { ...returnOf(P1_ID), rationaleCode: 'RECORDED_CONFLICT' }, RV.who),
    await rem(W, { eventCode: 'REVIEW_ACTION', decisionCode: 'APPROVE_PROPOSAL' }, RV.who), await rem(W, { eventCode: 'REVIEW_ACTION', proposalEventId: P1_ID }, RV.who),
    await rem(W, { ...approveOf(P1_ID), proposalEventId: 7 }, RV.who),
  ]
  check('T013', 'Strict REVIEW_ACTION shape', strictReview.every(isValidation) && (await wRows()) === 1, 'a review with a proposal field or an approval reason, without its proposal or decision, or with a non-string proposal is a 400; nothing recorded')
  const unknownBodies = [await rem(W, [propose(IW.findingId)], M1.who), await rem(W, {}, M1.who), await rem(W, { ...propose(IW.findingId), extra: 1 }, M1.who), await rem(W, 7, M1.who), await rem(W, 'PROPOSE_ACTION', M1.who)]
  const nullBody = await rem(W, null, M1.who)
  const nullService = await recordRemediationEvent(W.claimId, W.intakeId, null, M1.id)
  check(
    'T014',
    'Unknown property, array or null body 400',
    unknownBodies.every((r) => r.status === 400 && !rawError(r.body)) && unknownBodies.slice(0, 3).every(isValidation) && nullBody.status === 400 && nullService.ok === false && nullService.code === 'VALIDATION_ERROR' && (await wRows()) === 1,
    `an array, an empty object, an unknown property, a number or a string is a 400 (${unknownBodies.map((r) => errorCode(r.body)).join('/')}); a null body is a 400 (${errorCode(nullBody.body)}) and the service itself refuses it; nothing recorded`,
  )
  const serverOwned = await Promise.all(
    ['id', 'remediationEventId', 'sequence', 'organizationId', 'claimId', 'exceptionIntakeId', 'recordedByUserId', 'recordedByMembershipId', 'actorUserId', 'recordedAt', 'createdAt', 'contractVersion', 'state'].map((k) =>
      rem(W, { ...propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), [k]: k === 'sequence' ? 2 : k === 'recordedAt' || k === 'createdAt' ? '2020-01-01T00:00:00.000Z' : k === 'contractVersion' ? CONTRACT : k === 'state' ? 'APPROVED_FOR_PLANNING' : MISSING }, M1.who),
    ),
  )
  const queried = await post(`${base(W)}/remediation-events?sequence=2`, propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), M1.who)
  check(
    'T015',
    'Actor, Claim, org, sequence, clock not supplied',
    serverOwned.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && queried.status === 400 && (await wRows()) === 1,
    'an id, sequence, organization, Claim, intake, actor, membership, time, contract or state in the body, or a query parameter, is refused (400): the server owns them',
  )
  const badIds = ['not-a-uuid', MISSING.replace(/-/g, ''), `${MISSING}0`, encodeURIComponent("1' OR '1'='1")]
  const malformedClaim = [
    ...(await Promise.all(badIds.map((id) => rem({ claimId: id, intakeId: W.intakeId }, propose(IW.findingId), M1.who)))),
    ...(await Promise.all(badIds.map((id) => historyOf({ claimId: id, intakeId: W.intakeId })))),
    ...(await Promise.all(badIds.map((id) => dispositionOf({ claimId: id, intakeId: W.intakeId })))),
  ]
  const malformedIntake = [
    ...(await Promise.all(badIds.map((id) => rem({ claimId: W.claimId, intakeId: id }, propose(IW.findingId), M1.who)))),
    ...(await Promise.all(badIds.map((id) => historyOf({ claimId: W.claimId, intakeId: id })))),
    ...(await Promise.all(badIds.map((id) => dispositionOf({ claimId: W.claimId, intakeId: id })))),
  ]
  const malformedFinding = await Promise.all(['not-a-uuid', `${MISSING}0`, MISSING.replace(/-/g, '')].map((id) => rem(W, propose(id), M1.who)))
  const malformedProposal = await Promise.all(['not-a-uuid', `${MISSING}0`].map((id) => rem(W, approveOf(id), RV.who)))
  check(
    'T016',
    'Malformed Claim/intake/proposal/finding UUID 400',
    malformedClaim.every((r) => r.status === 400 && /invalid claim id/.test(errorMessage(r.body)) && !rawError(r.body)) && malformedIntake.every((r) => r.status === 400 && /invalid exception intake id/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      malformedFinding.every((r) => r.status === 400 && /invalid finding event id/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      malformedProposal.every((r) => r.status === 400 && /invalid proposal event id/.test(errorMessage(r.body)) && !rawError(r.body)) && (await wRows()) === 1,
    'malformed and SQL-shaped Claim and intake ids on all three routes, and malformed finding and proposal ids, are each a safe 400; nothing recorded',
  )
  const unknownActions = await Promise.all(['EXECUTE_REMEDIATION', 'CORRECT_CLAIM', 'RESOLVE_EXCEPTION', 'request_internal_documentation_check', '', null, 7].map((code) => rem(W, { ...propose(IW.findingId), actionCode: code }, M1.who)))
  check('T017', 'Unknown action code refused', unknownActions.every((r) => r.status === 400 && /unknown action code/.test(errorMessage(r.body)) && !rawError(r.body)) && (await wRows()) === 1, `only ${actionCodes.join(', ')} are accepted`)
  const unknownRationales = await Promise.all(['BECAUSE', 'PAYER_DENIED', 'recorded_conflict', '', null].map((code) => rem(W, { ...propose(IW.findingId), rationaleCode: code }, M1.who)))
  const unknownDecisions = await Promise.all(['AUTO_APPROVE', 'REJECT_PROPOSAL', 'EXECUTE', 'approve_proposal', '', null].map((code) => rem(W, { eventCode: 'REVIEW_ACTION', proposalEventId: P1_ID, decisionCode: code }, RV.who)))
  const unknownEvents = await Promise.all(['EXECUTE_ACTION', 'RESOLVE', 'CLOSE_EXCEPTION', 'propose_action', ''].map((eventCode) => rem(W, { eventCode }, M1.who)))
  check(
    'T018',
    'Unknown rationale, decision or event refused',
    unknownRationales.every((r) => r.status === 400 && /unknown rationale code/.test(errorMessage(r.body))) && unknownDecisions.every((r) => r.status === 400 && /unknown decision code/.test(errorMessage(r.body))) &&
      unknownEvents.every((r) => r.status === 400 && /unknown remediation event code/.test(errorMessage(r.body))) && (await wRows()) === 1,
    `only the rationales ${rationaleCodes.join(', ')}, the decisions ${decisionCodes.join(', ')} and the events ${remediationEventCodes.join(', ')} are accepted`,
  )
  const reasonRule = [
    await rem(W, { ...approveOf(P1_ID), reviewReasonCode: 'INSUFFICIENT_SUPPORT' }, RV.who), await rem(W, { ...approveOf(P1_ID), reviewReasonCode: null }, RV.who),
    await rem(W, { eventCode: 'REVIEW_ACTION', proposalEventId: P1_ID, decisionCode: 'RETURN_PROPOSAL' }, RV.who), await rem(W, returnOf(P1_ID, 'BECAUSE'), RV.who),
    await rem(W, { ...returnOf(P1_ID), reviewReasonCode: null }, RV.who),
  ]
  check(
    'T019',
    'Return reason only on RETURN; absent on APPROVE',
    reasonRule.every(isValidation) && /unsupported field/.test(errorMessage(reasonRule[0].body)) && /unsupported field/.test(errorMessage(reasonRule[1].body)) && /missing field/.test(errorMessage(reasonRule[2].body)) &&
      /controlled review reason code/.test(errorMessage(reasonRule[3].body)) && /controlled review reason code/.test(errorMessage(reasonRule[4].body)) && (await wRows()) === 1,
    `an approval carrying any reason field (even null) is a 400; a return without a reason, with an uncontrolled or a null one is a 400; the reasons are only ${reviewReasonCodes.join(', ')}`,
  )
  const injection = [
    await rem(W, propose("1' OR '1'='1"), M1.who), await rem(W, { ...propose(IW.findingId), findingEventId: { $ne: null } }, M1.who),
    await rem(W, { ...propose(IW.findingId), actionCode: "RECHECK_CODING_REFERENCE'; DROP TABLE claims; --" }, M1.who), await rem(W, { ...propose(IW.findingId), rationaleCode: '../RECORDED_CONFLICT' }, M1.who),
    await rem(W, JSON.parse(`{"__proto__": {"eventCode": "PROPOSE_ACTION"}, "actionCode": "RECHECK_CODING_REFERENCE", "findingEventId": "${IW.findingId}", "rationaleCode": "RECORDED_CONFLICT"}`), M1.who),
    await rem(W, JSON.parse(`{"eventCode": "PROPOSE_ACTION", "actionCode": "RECHECK_CODING_REFERENCE", "findingEventId": "${IW.findingId}", "rationaleCode": "RECORDED_CONFLICT", "constructor": {"prototype": {"admin": true}}}`), M1.who),
  ]
  const freeText = await Promise.all(
    [
      { note: 'free text' }, { narrative: 'free text' }, { comment: 'free text' }, { description: 'free text' }, { patientName: `${runId}-home-P` }, { diagnosisCode: key('home-DXA') },
      { amount: '125.25' }, { url: 'https://example.invalid/action' }, { attachment: 'c3ludGhldGlj' }, { payload: { a: 1 } }, { findingText: 'the finding' },
    ].map((extra) => rem(W, { ...propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), ...extra }, M1.who)),
  )
  check(
    'T020',
    'Operator/SQL/prototype values and free text refused',
    injection.every((r) => r.status === 400 && !rawError(r.body)) && freeText.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && (await wRows()) === 1 &&
      (await unchanged(plus(countsAtStart, 1))),
    "SQL-, operator-, traversal- and prototype-shaped values, and a note, narrative, comment, description, patient name, diagnosis, amount, URL, attachment, payload or finding text, are refused with a safe 400; only W's one valid proposal and its audit exist",
  )

  // ---------------------------------------------------------------- authentication, tenant and roles (T021–T030)
  section('Authentication, tenant and roles: 401 before lookup, Viewer and role-less 403, the assignee proposes from the session, non-assignees refused, foreign Claim, intake and finding = missing, the reviewer independent and authorized now')
  const anonPost = [await rem(W, propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), anonymous), await rem({ claimId: MISSING, intakeId: MISSING }, propose(IW.findingId), anonymous)]
  check('T021', 'Unauthenticated POST 401 before owner lookup', anonPost.every((r) => r.status === 401) && (await wRows()) === 1, 'no session: 401 on W and on a missing Claim alike (the lookup never ran)')
  check('T022', 'Unauthenticated history GET 401', (await historyOf(W, anonymous)).status === 401 && (await historyOf({ claimId: MISSING, intakeId: MISSING }, anonymous)).status === 401, 'no session: 401 on the history of W and of a missing Claim')
  check('T023', 'Unauthenticated disposition GET 401', (await dispositionOf(W, anonymous)).status === 401 && (await dispositionOf({ claimId: MISSING, intakeId: MISSING }, anonymous)).status === 401, 'no session: 401 on the disposition of W and of a missing Claim')
  const noPermission = [
    await rem(W, propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), asViewer), await rem(W, approveOf(P1_ID), asViewer), await rem(W, propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), NR.who),
    await rem(W, returnOf(P1_ID), NR.who),
  ]
  check('T024', 'Viewer cannot propose or review', noPermission.every((r) => r.status === 403) && (await wRows()) === 1, 'a Viewer (exceptionRemediation.read only) and a member without any role are refused 403 on a proposal and on a review; nothing recorded')
  check(
    'T025',
    'Current assignee proposes; actor from session',
    P1.status === 201 && P1.body.recordedByMembershipId === M1.membershipId && P1.body.recordedByUserId === M1.id && P1.body.claimId === W.claimId && P1.body.organizationId === org &&
      P1.body.exceptionIntakeId === W.intakeId && P1.body.sequence === 1 && P1.body.eventCode === 'PROPOSE_ACTION',
    "M1, to whom A8.2 assigned W, proposes (201) as itself through its own membership, numbered 1, in its own organization and Claim",
  )
  const notAssignee = [
    await rem(W, propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), RV.who), await rem(W, propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), asAdmin), await rem(L0, propose(IL.findingId), M4.who),
    await rem(L0, propose(IL.findingId), asAdmin), await rem(K, propose(IK.findingId), M2.who),
  ]
  check(
    'T026',
    'Proposer without eligible assignment refused',
    notAssignee.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_NOT_ASSIGNEE' && !rawError(r.body)) && (await wRows()) === 1 && (await eventsOf(L0.intakeId)).length === 0 &&
      (await eventsOf(K.intakeId)).length === 0,
    "an eligible reviewer and the harness's Admin on W (assigned to M1), M4 and the Admin on the UNTRIAGED L0, and M2 on K (reassigned from M2 to M4) are each refused 409 NOT_ASSIGNEE; nothing recorded",
  )
  const missingEnvelope = (r: { body: any }) => ({ ...r.body?.error, requestId: null })
  const foreignClaim = [await rem(F, propose(IF.findingId), asAdmin), await historyOf(F), await dispositionOf(F)]
  const missingClaimReads = [await rem({ claimId: MISSING, intakeId: F.intakeId }, propose(IF.findingId), asAdmin), await historyOf({ claimId: MISSING, intakeId: F.intakeId }), await dispositionOf({ claimId: MISSING, intakeId: F.intakeId })]
  check(
    'T027',
    'Foreign Claim same 404 as missing Claim',
    foreignClaim.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingClaimReads[i]))) && (await eventsOf(F.intakeId)).length === 0,
    "another organization's Claim and intake get exactly the missing-Claim envelope on all three routes; nothing recorded",
  )
  const foreignIntake = [await rem({ claimId: W.claimId, intakeId: F.intakeId }, propose(IW.findingId), M1.who), await historyOf({ claimId: W.claimId, intakeId: F.intakeId }), await dispositionOf({ claimId: W.claimId, intakeId: F.intakeId })]
  const otherClaimIntake = [await rem({ claimId: W.claimId, intakeId: L.intakeId }, propose(IL.findingId), M4.who), await historyOf({ claimId: W.claimId, intakeId: L.intakeId })]
  const missingIntake = [await rem({ claimId: W.claimId, intakeId: MISSING }, propose(IW.findingId), M1.who), await historyOf({ claimId: W.claimId, intakeId: MISSING }), await dispositionOf({ claimId: W.claimId, intakeId: MISSING })]
  check(
    'T028',
    'Foreign intake same 404 as missing intake',
    foreignIntake.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[i]))) && otherClaimIntake.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[0]))) &&
      (await eventsOf(L.intakeId)).length === 0,
    "another tenant's intake, or another Claim's intake of this tenant, named under W's Claim is exactly the missing-intake 404; nothing recorded",
  )
  const missingFinding = await rem(W, propose(MISSING, 'REFER_FOR_POLICY_REVIEW'), M1.who)
  const foreignFindings = [await rem(W, propose(IF.findingId, 'REFER_FOR_POLICY_REVIEW'), M1.who), await rem(W, propose(F.intakeId, 'REFER_FOR_POLICY_REVIEW'), M1.who)]
  check(
    'T029',
    'Cross-tenant finding refused without disclosure',
    missingFinding.status === 404 && foreignFindings.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingFinding)) && !JSON.stringify(r.body).includes(IF.findingId) && !rawError(r.body)) && (await wRows()) === 1,
    "the other tenant's A8.3 finding, and its intake named as a finding, on W are each exactly the missing-finding 404 — the body names nothing of the other tenant; nothing recorded",
  )
  const selfP1 = await rem(W, approveOf(P1_ID), M1.who)
  const reviewerWithoutRole = [await recordRemediationEvent(W.claimId, W.intakeId, approveOf(P1_ID), NR.id), await recordRemediationEvent(W.claimId, W.intakeId, approveOf(P1_ID), viewerUser.id)]
  check(
    'T030',
    'Reviewer: current permission, different member',
    selfP1.status === 409 && errorCode(selfP1.body) === 'EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT' && reviewerWithoutRole.every((r) => r.ok === false && r.code === 'EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT') &&
      noPermission[3].status === 403 && (await wRows()) === 1,
    "M1 reviewing its own proposal is refused 409; a role-less member is refused 403 at the route, and the service itself refuses (409) a reviewer without the review permission now — the role-less member and the Viewer; nothing recorded",
  )

  // ---------------------------------------------------------------- proposals and findings (T031–T040)
  section('Proposals and findings: NO_PROPOSAL is zero rows, a genuine A8.3 RECORD_FINDING of exactly this intake, one event and one audit, the pending proposal, a second or repeated proposal, A8.3 records untouched, unverifiable findings')
  check(
    'T031',
    'NO_PROPOSAL means zero rows, no stored state',
    noProposalW.rows === 0 && noProposalW.disposition.status === 200 && noProposalW.disposition.body.state === 'NO_PROPOSAL' && noProposalW.disposition.body.eventCount === 0 && noProposalW.disposition.body.lastSequence === null &&
      noProposalW.disposition.body.pendingProposal === null && noProposalW.disposition.body.latestDecision === null && noProposalW.disposition.body.approvedProposalEventId === null &&
      noProposalW.disposition.body.proposalCount === 0 && same(noProposalW.history.body.items, []) && !COLUMNS.some((c) => /state|status|current|latest/.test(c)),
    'before any event W has zero rows and derives NO_PROPOSAL with no pending proposal and no decision; the table has no state, status, current or latest column',
  )
  const findingJoin = (await prisma.$queryRawUnsafe<{ code: string; ok: boolean }[]>(
    `SELECT f.event_code AS code, (f.exception_intake_id = e.exception_intake_id AND f.claim_id = e.claim_id AND f.organization_id = e.organization_id) AS ok FROM ${TABLE} e JOIN ${INVESTIGATION_TABLE} f ON f.id = e.a8_3_finding_event_id WHERE e.id = $1::uuid`,
    P1_ID,
  ))[0]
  check(
    'T032',
    'Genuine A8.3 RECORD_FINDING required',
    P1.body.findingEventId === IW.findingId && findingJoin?.code === 'RECORD_FINDING' && findingJoin.ok === true && IW.statuses.every((s) => s === 201),
    "W's proposal names exactly M1's A8.3 RECORD_FINDING (FURTHER_REVIEW_REQUIRED) recorded through the A8.3 route; the stored key joins that finding of the same intake, Claim and organization",
  )
  const linkOnly = await rem(L, propose(IL.linkId, 'RECHECK_CODING_REFERENCE', 'RECORDED_CONFLICT'), M4.who)
  check(
    'T033',
    'A8.3 link alone cannot support a proposal',
    linkOnly.status === 409 && errorCode(linkOnly.body) === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED' && /not a recorded finding/.test(errorMessage(linkOnly.body)) && (await eventsOf(L.intakeId)).length === 0,
    "on L, M4 naming L's own A8.3 evidence link as the supporting finding is refused 409 (a link is evidence, not a finding); nothing recorded",
  )
  const otherClaimFinding = await rem(W, propose(IL.findingId, 'REFER_FOR_POLICY_REVIEW'), M1.who)
  check(
    'T034',
    'Finding matches intake, Claim and organization',
    otherClaimFinding.status === 404 && same(missingEnvelope(otherClaimFinding), missingEnvelope(missingFinding)) && foreignFindings.every((r) => r.status === 404) && (await wRows()) === 1,
    "L's finding (same organization, another Claim and intake) named on W is the missing-finding 404, as is the other tenant's (T029); the database guard refuses both as direct rows (T056)",
  )
  const p1Audits = await auditsOfEvent(P1_ID)
  check(
    'T035',
    'Valid proposal: one event, one audit',
    same(countsAfterP1, plus(countsAtStart, 1)) && p1Audits.length === 1 && p1Audits[0].actionCode === 'exception_remediation.recorded' && p1Audits[0].organizationId === org && p1Audits[0].actorUserId === M1.id && p1Audits[0].beforeState === null,
    "W's proposal added exactly one remediation row and one audit (exception_remediation.recorded, Org A, actor M1) and changed no other table",
  )
  const pending = dispositionP1.body.pendingProposal
  check(
    'T036',
    'AWAITING_REVIEW holds the exact pending ID',
    dispositionP1.body.state === 'AWAITING_REVIEW' && pending?.remediationEventId === P1_ID && pending.sequence === 1 && pending.actionCode === 'REQUEST_INTERNAL_DOCUMENTATION_CHECK' && pending.findingEventId === IW.findingId &&
      pending.rationaleCode === 'INSUFFICIENT_EVIDENCE' && pending.proposedByMembershipId === M1.membershipId && pending.proposedByUserId === M1.id && dispositionP1.body.latestDecision === null,
    'W derives AWAITING_REVIEW whose pending proposal is exactly event 1: its action, finding, rationale and author',
  )
  const secondOutstanding = await rem(W, propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW', 'POLICY_CLARIFICATION_NEEDED'), M1.who)
  check('T037', 'Second outstanding proposal refused', secondOutstanding.status === 409 && errorCode(secondOutstanding.body) === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED' && /already awaits review/.test(errorMessage(secondOutstanding.body)) && (await wRows()) === 1, 'a different proposal while one awaits review is refused 409; nothing recorded')
  // L: propose (the RECHECK_CODING_REFERENCE request), a self-review, a return, the unchanged repeat, a second decision.
  const PL1 = await rem(L, propose(IL.findingId, 'RECHECK_CODING_REFERENCE', 'RECORDED_CONFLICT'), M4.who)
  const PL1_ID = (PL1.body?.remediationEventId ?? MISSING) as string
  const selfL = await rem(L, approveOf(PL1_ID), M4.who)
  const RL1 = await rem(L, returnOf(PL1_ID, 'WRONG_SCOPE'), RV.who)
  const repeatPending = await rem(W, propose(IW.findingId), M1.who)
  const repeatReturned = await rem(L, propose(IL.findingId, 'RECHECK_CODING_REFERENCE', 'RECORDED_CONFLICT'), M4.who)
  const secondDecisionL = await rem(L, approveOf(PL1_ID), RV2.who)
  check(
    'T038',
    'Identical repeat refused, never replayed',
    repeatPending.status === 409 && errorCode(repeatPending.body) === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED' && repeatPending.body?.remediationEventId === undefined && PL1.status === 201 && RL1.status === 201 &&
      repeatReturned.status === 409 && errorCode(repeatReturned.body) === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED' && /repeats the returned proposal unchanged/.test(errorMessage(repeatReturned.body)) &&
      (await wRows()) === 1 && (await eventsOf(L.intakeId)).length === 2,
    "re-sending W's pending proposal exactly is a 409, never a replayed 201; on L, after RV returned M4's proposal, the same proposal unchanged is refused 409 (a fresh proposal must differ); nothing recorded",
  )
  check(
    'T039',
    'A8.3 finding and records byte-identical',
    (await snap()).investigation === ownerSnapshotBefore.investigation && (await hashOf(`SELECT e.* FROM ${INVESTIGATION_TABLE} e WHERE e.id = $1::uuid`, IW.findingId)) === iwFindingHashBefore &&
      withoutEvaluatedAt((await investigationSummaryOf(W)).body) === wInvestigationBefore,
    "every A8.3 event of this run's intakes is byte-identical after the proposals, returns and refusals; W's investigation summary reads back the same",
  )
  const notFindings = [await rem(W, propose(P1_ID, 'REFER_FOR_POLICY_REVIEW'), M1.who), await rem(W, propose(W_ASSIGN.triageEventId, 'REFER_FOR_POLICY_REVIEW'), M1.who), await rem(W, propose(W.intakeId, 'REFER_FOR_POLICY_REVIEW'), M1.who)]
  const unverifiable = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
    await tx.$executeRawUnsafe(
      `INSERT INTO ${INVESTIGATION_TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, linked_evidence_event_id, finding_code, recorded_by_membership_id, recorded_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'A8-EXCEPTION-INVESTIGATION-1', 5, 'RECORD_FINDING', $5::uuid, 'EVIDENCE_INCONCLUSIVE', $6::uuid, $7::uuid)`,
      randomUUID(), S.intakeId, S.organizationId, S.claimId, IS.linkId, M4.membershipId, M4.id,
    )
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return recordRemediationEventOn(S.claimId, S.intakeId, propose(IS.findingId), M4.id, tx)
  })
  check(
    'T040',
    'Wrong or unverifiable finding fails closed',
    notFindings.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingFinding))) && unverifiable.value?.ok === false && unverifiable.value.code === 'EXCEPTION_REMEDIATION_CONFLICT' &&
      /investigation history is inconsistent/.test(unverifiable.value.message) && unverifiable.clean && (await wRows()) === 1 && (await eventsOf(S.intakeId)).length === 0,
    "a remediation event, a triage event or the intake named as the finding is the missing-finding 404; when S's A8.3 history cannot be verified (a planted gap, rolled back) the proposal fails closed 409 and nothing is recorded",
  )

  // ---------------------------------------------------------------- review transitions (T041–T050)
  section('Review transitions on W: an independent return with its reason, the returned proposal unchanged, a fresh proposal, an independent approval, planning authorization only, no self-review, wrong proposals, second decisions, the terminal state')
  const R1 = await rem(W, returnOf(P1_ID, 'NEEDS_MORE_INVESTIGATION'), RV.who)
  const R1_ID = (R1.body?.remediationEventId ?? MISSING) as string
  const dispositionR1 = (await dispositionOf(W)).body
  check(
    'T041',
    'Independent reviewer returns with a reason',
    R1.status === 201 && R1.body.sequence === 2 && R1.body.proposalEventId === P1_ID && R1.body.decisionCode === 'RETURN_PROPOSAL' && R1.body.reviewReasonCode === 'NEEDS_MORE_INVESTIGATION' && R1.body.recordedByMembershipId === RV.membershipId &&
      dispositionR1.state === 'RETURNED_FOR_REVISION' && dispositionR1.pendingProposal === null && dispositionR1.latestDecision?.remediationEventId === R1_ID && same(Object.keys(dispositionR1.latestDecision ?? {}), DECISION_KEYS),
    'RV, holding the review permission and not the author, returns event 1 with NEEDS_MORE_INVESTIGATION (event 2); W derives RETURNED_FOR_REVISION with that decision',
  )
  const historyR1 = (await historyOf(W)).body
  check('T042', 'Returned proposal readable and unchanged', (await rowHash(P1_ID)) === p1HashBefore && same(historyR1.items[0], P1.body) && historyR1.items.length === 2, "event 1 is byte-identical after its return and the history still answers it exactly as recorded")
  const repeatAfterReturn = await rem(W, propose(IW.findingId), M1.who)
  const P2 = await rem(W, propose(IW.findingId, 'REVIEW_SOURCE_PROVENANCE', 'RECORDED_CONFLICT'), M1.who)
  const P2_ID = (P2.body?.remediationEventId ?? MISSING) as string
  const dispositionP2 = (await dispositionOf(W)).body
  check(
    'T043',
    'Fresh proposal after return allowed',
    repeatAfterReturn.status === 409 && /repeats the returned proposal unchanged/.test(errorMessage(repeatAfterReturn.body)) && P2.status === 201 && P2.body.sequence === 3 && P2.body.actionCode === 'REVIEW_SOURCE_PROVENANCE' &&
      P2.body.findingEventId === IW.findingId && dispositionP2.state === 'AWAITING_REVIEW' && dispositionP2.pendingProposal?.remediationEventId === P2_ID,
    "after the return, the unchanged proposal is refused 409 and M1's fresh proposal (REVIEW_SOURCE_PROVENANCE, RECORDED_CONFLICT, the same finding) is recorded as event 3, now awaiting review",
  )
  const selfP2 = await rem(W, approveOf(P2_ID), M1.who)
  const wrongProposals = [await rem(W, approveOf(MISSING), RV.who), await rem(W, approveOf(P1_ID), RV.who), await rem(W, approveOf(R1_ID), RV.who), await rem(W, approveOf(PL1_ID), RV.who)]
  const countsBeforeA1 = await counts()
  const A1 = await rem(W, approveOf(P2_ID), RV.who)
  const A1_ID = (A1.body?.remediationEventId ?? MISSING) as string
  const countsAfterA1 = await counts()
  const dispositionA1 = (await dispositionOf(W)).body
  check(
    'T044',
    'Independent reviewer approves the proposal',
    A1.status === 201 && A1.body.sequence === 4 && A1.body.proposalEventId === P2_ID && A1.body.decisionCode === 'APPROVE_PROPOSAL' && A1.body.reviewReasonCode === null && A1.body.recordedByMembershipId === RV.membershipId && A1.body.recordedByUserId === RV.id,
    'RV approves the outstanding event 3 (event 4) with no reason, through its own membership',
  )
  check(
    'T045',
    'Approval derives APPROVED_FOR_PLANNING only',
    dispositionA1.state === 'APPROVED_FOR_PLANNING' && dispositionA1.approvedProposalEventId === P2_ID && dispositionA1.pendingProposal === null && dispositionA1.latestDecision?.remediationEventId === A1_ID &&
      dispositionA1.proposalCount === 2 && dispositionA1.eventCount === 4 && dispositionA1.lastSequence === 4 && same([...remediationStates], ['NO_PROPOSAL', 'AWAITING_REVIEW', 'APPROVED_FOR_PLANNING', 'RETURNED_FOR_REVISION']) &&
      !(remediationStates as readonly string[]).some((s) => /EXECUT|RESOLV|CLOS|CORRECT|PAID|DONE|COMPLETE/.test(s)),
    `W derives APPROVED_FOR_PLANNING naming event 3 (2 proposals, 4 events); the only derived states are ${remediationStates.join(', ')} — none executes, resolves, corrects or closes`,
  )
  check(
    'T046',
    'Approval never starts execution or status update',
    same(countsAfterA1, plus(countsBeforeA1, 1)) && withoutEvaluatedAt((await triageDispositionOf(W)).body) === wTriageBefore && withoutEvaluatedAt((await investigationSummaryOf(W)).body) === wInvestigationBefore &&
      withoutEvaluatedAt((await get(`/api/claims/${W.claimId}/exception-intake`)).body) === wIntakesBefore && (await snap()).claims === ownerSnapshotBefore.claims,
    "the approval added exactly one remediation row and one audit and nothing else: W's A8.2 disposition (still ASSIGNED to M1), its A8.3 summary, its A8.1 intake list and every run Claim row read back identically",
  )
  check(
    'T047',
    'Proposer cannot review own proposal',
    [selfP1, selfP2, selfL].every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT' && !rawError(r.body)),
    "M1 approving its own proposals 1 and 3 on W, and M4 approving its own proposal on L, are each refused 409 — though each holds the review permission",
  )
  check(
    'T048',
    'Wrong proposal ID or another intake refused',
    wrongProposals.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED' && /names exactly the proposal that awaits review/.test(errorMessage(r.body))),
    "while event 3 awaited review, naming no event, the returned event 1, the review event 2 or L's proposal (another intake) is refused 409",
  )
  const secondDecisions = [await rem(W, returnOf(P2_ID, 'WRONG_SCOPE'), RV2.who), await rem(W, approveOf(P2_ID), RV.who)]
  check(
    'T049',
    'Second decision on a proposal refused',
    secondDecisions.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED') && secondDecisionL.status === 409 && errorCode(secondDecisionL.body) === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED' &&
      (await wRows()) === 4 && (await eventsOf(L.intakeId)).length === 2,
    "a second decision on W's approved proposal (another reviewer's return, the same reviewer's approval) and on L's returned proposal is refused 409; nothing recorded",
  )
  const afterApproval = await rem(W, propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW', 'POLICY_CLARIFICATION_NEEDED'), M1.who)
  check(
    'T050',
    'New proposal after approval refused',
    afterApproval.status === 409 && errorCode(afterApproval.body) === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED' && /approved for planning/.test(errorMessage(afterApproval.body)) && (await wRows()) === 4,
    'once approved for planning, a new proposal by the assignee is refused 409 (terminal for this v1 intake; no silent supersession)',
  )

  // ---------------------------------------------------------------- database integrity on S (T051–T060, always rolled back)
  section('Database integrity on S (always rolled back): RESTRICT keys, valid direct rows, forged linkage, forged actors and reviewers, self-review, foreign findings, shape CHECKs, sequence, UPDATE/DELETE/TRUNCATE, unique and pending-review guards')
  const fksOf = (table: string) => prisma.$queryRawUnsafe<{ name: string; del: string }[]>(`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid = '${table}'::regclass ORDER BY conname`)
  const fks = await fksOf(TABLE)
  const investigationFks = await fksOf(INVESTIGATION_TABLE)
  const parentDeletes = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${INTAKE_TABLE} WHERE id = $1::uuid`, W.intakeId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${INVESTIGATION_TABLE} WHERE id = $1::uuid`, IW.findingId)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id = $1::uuid`, RV.id)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM organization_memberships WHERE id = $1::uuid`, M1.membershipId)),
  ]
  check(
    'T051',
    'Existing and new foreign keys RESTRICT',
    fks.length === 7 && fks.every((fk) => fk.del === 'r') && investigationFks.length === 6 && investigationFks.every((fk) => fk.del === 'r') &&
      parentDeletes.every((r) => !r.message.includes(NOT_COMMITTED) && /append-only|foreign key|23503/.test(r.message) && r.clean),
    `${fks.map((f) => f.name.replace(`${TABLE}_`, '')).join(', ')}: all ON DELETE RESTRICT (the A8.3 keys too); deleting W's intake, its A8.3 finding, a reviewing user or a proposing membership is refused`,
  )
  const pS = randomUUID()
  const pS2 = randomUUID()
  const validDirect = [
    await directInsert([rowOf(S, { id: pS }), reviewRow(S, 2, pS)]),
    await directInsert([rowOf(S, { id: pS }), reviewRow(S, 2, pS, { decision_code: 'RETURN_PROPOSAL', review_reason_code: 'WRONG_SCOPE' }), rowOf(S, { id: pS2, sequence: 3, action_code: 'REFER_FOR_POLICY_REVIEW' }), reviewRow(S, 4, pS2, { recorded_by_membership_id: RV2.membershipId, recorded_by_user_id: RV2.id })]),
  ]
  check('T052', 'Direct valid proposal and review accepted, rolled back', validDirect.every((r) => !r.refused && r.clean) && (await eventsOf(S.intakeId)).length === 0, "a valid direct proposal and approval, and a proposal, return, fresh proposal and approval, pass every guard on S and roll back; S holds no committed event")
  const forgedLinkage = [await directInsert([rowOf(S, { organization_id: otherOrg })]), await directInsert([rowOf(S, { claim_id: W.claimId })]), await directInsert([rowOf(S, { exception_intake_id: L.intakeId })])]
  check('T053', 'Direct forged tenant/Claim/intake rejected', forgedLinkage.every((r) => r.refused && /exception_remediation_coherence/.test(r.message) && r.clean), "a direct event under the other organization, another Claim or another intake than its own is refused by the coherence guard")
  const forgedActors = {
    mismatched: await directInsert([rowOf(S, { recorded_by_user_id: M2.id })]), foreign: await directInsert([rowOf(S, { recorded_by_membership_id: O.membershipId, recorded_by_user_id: O.id })]),
    missing: await directInsert([rowOf(S, { recorded_by_membership_id: MISSING })]), notAssignee: await directInsert([rowOf(S, { recorded_by_membership_id: M2.membershipId, recorded_by_user_id: M2.id })]),
    viewerProposer: await directInsert([rowOf(S, { recorded_by_membership_id: viewerMembershipId, recorded_by_user_id: viewerUser.id })]),
    viewerReviewer: await directInsert([rowOf(S, { id: pS }), reviewRow(S, 2, pS, { recorded_by_membership_id: viewerMembershipId, recorded_by_user_id: viewerUser.id })]),
    roleless: await directInsert([rowOf(S, { id: pS }), reviewRow(S, 2, pS, { recorded_by_membership_id: NR.membershipId, recorded_by_user_id: NR.id })]),
  }
  check(
    'T054',
    'Direct forged actor and reviewer rejected',
    [forgedActors.mismatched, forgedActors.foreign, forgedActors.missing].every((r) => r.refused && /exception_remediation_member/.test(r.message)) && [forgedActors.notAssignee, forgedActors.viewerProposer].every((r) => r.refused && /exception_remediation_assignee/.test(r.message)) &&
      [forgedActors.viewerReviewer, forgedActors.roleless].every((r) => r.refused && /exception_remediation_reviewer: the reviewer's roles must grant/.test(r.message)) && Object.values(forgedActors).every((r) => r.clean),
    "a membership of another user, the other tenant's or none is refused by the member guard; a proposer who is not S's assignee (M2, the Viewer) by the assignee guard; a reviewer without the review permission (the Viewer, a role-less member) by the reviewer guard",
  )
  const selfReviewDirect = await directInsert([rowOf(S, { id: pS }), reviewRow(S, 2, pS, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })])
  check('T055', 'Direct self-review rejected by guard', selfReviewDirect.refused && /exception_remediation_reviewer: a proposal is never reviewed by its own author/.test(selfReviewDirect.message) && selfReviewDirect.clean, "M4 approving its own direct proposal on S is refused by the reviewer guard, though M4 holds the review permission")
  const foreignFindingDirect = [
    await directInsert([rowOf(S, { a8_3_finding_event_id: IL.findingId })]), await directInsert([rowOf(S, { a8_3_finding_event_id: IF.findingId })]),
    await directInsert([rowOf(S, { a8_3_finding_event_id: IS.linkId })]), await directInsert([rowOf(S, { a8_3_finding_event_id: MISSING })]),
  ]
  check('T056', 'Direct finding outside the intake rejected', foreignFindingDirect.every((r) => r.refused && /exception_remediation_finding/.test(r.message) && r.clean), "L's finding (same organization), the other tenant's finding, S's own evidence link and a missing event named on S are each refused by the finding guard")
  const off = { triggersOff: true }
  const shapes = [
    await directInsert([rowOf(S, { action_code: null })], off), await directInsert([rowOf(S, { decision_code: 'APPROVE_PROPOSAL' })], off), await directInsert([rowOf(S, { proposal_event_id: MISSING })], off),
    await directInsert([rowOf(S, { a8_3_finding_event_id: null })], off), await directInsert([rowOf(S, { action_code: 'EXECUTE_REMEDIATION' })], off), await directInsert([rowOf(S, { rationale_code: 'BECAUSE' })], off),
    await directInsert([reviewRow(S, 1, MISSING, { action_code: 'REVIEW_SOURCE_PROVENANCE' })], off), await directInsert([reviewRow(S, 1, MISSING, { review_reason_code: 'WRONG_SCOPE' })], off),
    await directInsert([reviewRow(S, 1, MISSING, { decision_code: 'RETURN_PROPOSAL' })], off), await directInsert([reviewRow(S, 1, MISSING, { decision_code: 'RETURN_PROPOSAL', review_reason_code: 'BECAUSE' })], off),
    await directInsert([reviewRow(S, 1, MISSING, { decision_code: 'AUTO_APPROVE' })], off), await directInsert([reviewRow(S, 1, MISSING, { proposal_event_id: null })], off),
  ]
  const eventCodeAlone = await directInsert([rowOf(S, { event_code: 'EXECUTE_ACTION' })], off)
  const contractAlone = await directInsert([rowOf(S, { contract_version: 'A8-REMEDIATION-PLAN-2' })], off)
  check(
    'T057',
    'Direct shape, code and contract refused by CHECK',
    shapes.every((r) => r.refused && /exception_remediation_events_shape_chk/.test(r.message) && r.clean) && eventCodeAlone.refused && /exception_remediation_events_event_code_chk/.test(eventCodeAlone.message) &&
      contractAlone.refused && /exception_remediation_events_contract_chk/.test(contractAlone.message),
    'with every trigger off, a proposal without its action or finding, with a review field or an uncontrolled code, and a review with a proposal field, an approval reason, a return without or with an uncontrolled reason, an unknown decision or no proposal are refused by the shape CHECK; an unknown event and a future contract by theirs',
  )
  const firstTwo = await directInsert([rowOf(S, { sequence: 2 })])
  const reusedLive = await directInsert([rowOf(S, { id: pS }), reviewRow(S, 1, pS)])
  const zero = await directInsert([rowOf(S, { sequence: 0 })], off)
  const reusedOff = await directInsert([rowOf(S), rowOf(S, { action_code: 'REFER_FOR_POLICY_REVIEW' })], off)
  check(
    'T058',
    'Direct first 2, reused number and 0 refused',
    firstTwo.refused && /exception_remediation_sequence/.test(firstTwo.message) && reusedLive.refused && /exception_remediation_sequence/.test(reusedLive.message) && zero.refused && /exception_remediation_events_sequence_chk/.test(zero.message) &&
      reusedOff.refused && /exception_remediation_events_sequence_key|23505/.test(reusedOff.message) && [firstTwo, reusedLive, zero, reusedOff].every((r) => r.clean),
    'a first event numbered 2 and a reused number 1 are refused by the sequence guard; number 0 by its CHECK and, with every trigger off, a reused number by the unique (intake, sequence) index',
  )
  const wHash = await rowsHash([W.intakeId])
  const mutations = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = sequence WHERE id = $1::uuid`, P1_ID)), await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET decision_code = 'RETURN_PROPOSAL', review_reason_code = 'WRONG_SCOPE' WHERE id = $1::uuid`, A1_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, R1_ID)),
  ]
  const truncation = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`))
  const cascade = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`))
  // A later owner's ON DELETE RESTRICT key into this table would make PostgreSQL refuse a plain TRUNCATE before any
  // trigger runs; TRUNCATE ... CASCADE still reaches this guard. Judged on behaviour: every wipe is refused.
  const referencedBy = await prisma.$queryRawUnsafe<{ del: string; self: boolean }[]>(`SELECT confdeltype::text AS del, conrelid = confrelid AS self FROM pg_constraint WHERE contype = 'f' AND confrelid = '${TABLE}'::regclass`)
  const truncationRefused = /append-only/.test(truncation.message) || (/cannot truncate a table referenced in a foreign key constraint/.test(truncation.message) && referencedBy.some((row) => !row.self) && referencedBy.every((row) => row.del === 'r'))
  check(
    'T059',
    'UPDATE (even no-op), DELETE, TRUNCATE refused',
    mutations.every((r) => /append-only/.test(r.message) && r.clean) && truncationRefused && truncation.clean && /append-only/.test(cascade.message) && cascade.clean && (await rowsHash([W.intakeId])) === wHash,
    "a no-op UPDATE of event 1, turning W's approval into a return, deleting its return, a TRUNCATE and a TRUNCATE … CASCADE are each refused (append-only); nothing changed",
  )
  const bypass = {
    secondPending: await directInsert([rowOf(S, { id: pS }), rowOf(S, { sequence: 2, action_code: 'REFER_FOR_POLICY_REVIEW' })]),
    uniqueReview: await directInsert([rowOf(S, { id: pS }), reviewRow(S, 2, pS), reviewRow(S, 3, pS, { decision_code: 'RETURN_PROPOSAL', review_reason_code: 'WRONG_SCOPE' })], off),
    secondReview: await directInsert([rowOf(S, { id: pS }), reviewRow(S, 2, pS, { decision_code: 'RETURN_PROPOSAL', review_reason_code: 'WRONG_SCOPE' }), reviewRow(S, 3, pS, { recorded_by_membership_id: RV2.membershipId, recorded_by_user_id: RV2.id })]),
    afterApproval: await directInsert([rowOf(S, { id: pS }), reviewRow(S, 2, pS), rowOf(S, { sequence: 3, action_code: 'REFER_FOR_POLICY_REVIEW' })]),
    repeat: await directInsert([rowOf(S, { id: pS }), reviewRow(S, 2, pS, { decision_code: 'RETURN_PROPOSAL', review_reason_code: 'WRONG_SCOPE' }), rowOf(S, { sequence: 3 })]),
  }
  check(
    'T060',
    'Direct unique or pending-review bypass refused',
    bypass.secondPending.refused && /exception_remediation_transition: a proposal already awaits review/.test(bypass.secondPending.message) && bypass.uniqueReview.refused && /exception_remediation_events_proposal_event_id_key|23505/.test(bypass.uniqueReview.message) &&
      bypass.secondReview.refused && /exception_remediation_transition: a review names exactly the proposal that awaits review/.test(bypass.secondReview.message) && bypass.afterApproval.refused &&
      /exception_remediation_transition: the proposal of this intake was approved/.test(bypass.afterApproval.message) && bypass.repeat.refused && /exception_remediation_repeat/.test(bypass.repeat.message) && Object.values(bypass).every((r) => r.clean),
    'a second proposal while one awaits review, a second decision on a returned proposal, a proposal after an approval and an unchanged repeat after a return are refused by the guard; with every trigger off a second review of one proposal is still refused by the unique (proposal) index',
  )

  // ---------------------------------------------------------------- atomicity and audit (T061–T070), J's writers
  section('Atomicity and audit on J: one event and one audit commit together, crashes after the insert and after the audit, a retry after a proven rollback, tenant and actor, database time, metadata only, no audit on reads or refusals, no backfill, no orphan')
  const serviceCode = committedCode(`${MODULE_DIR}/exception-remediation.service.ts`)
  const onTx = serviceCode.slice(serviceCode.indexOf('async function recordOnTransaction'), serviceCode.indexOf('async function reconcileUnknownOutcome'))
  const firstStatement = onTx.split('\n').slice(1).find((line) => line.trim().length > 0) ?? ''
  // T071's writers first: one proposal holds J's Claim lock while a second proposal waits.
  const holdLock = holdAt('exceptionRemediation.claim_locked')
  const firstJ = recordRemediationEvent(J.claimId, J.intakeId, propose(IJ.findingId), M4.id)
  await Promise.race([holdLock.arrived, firstJ])
  const secondJ = recordRemediationEvent(J.claimId, J.intakeId, propose(IJ.findingId, 'REFER_FOR_POLICY_REVIEW'), M4.id)
  const secondWaited = !(await settledWithin(secondJ, 1500))
  holdLock.release()
  const [j1, j2] = await Promise.all([firstJ, secondJ])
  clearConcurrencyProbes()
  const PJ1 = j1.ok ? j1.value.remediationEventId : MISSING
  const holdInsert = holdAt('exceptionRemediation.inserted')
  const committing = recordRemediationEvent(J.claimId, J.intakeId, returnOf(PJ1, 'INSUFFICIENT_SUPPORT'), RV.id)
  await Promise.race([holdInsert.arrived, committing])
  const during = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  holdInsert.release()
  const RJ1 = await committing
  clearConcurrencyProbes()
  const jAfterReturn = await eventsOf(J.intakeId)
  const rj1Audit = RJ1.ok ? (await auditsOfEvent(RJ1.value.remediationEventId))[0] : undefined
  check(
    'T061',
    'One event and one audit commit atomically',
    during.rows === 1 && during.audits === 1 && RJ1.ok && jAfterReturn.length === 2 && (await auditsOfIntake(J.intakeId)) === 2 && !!rj1Audit && rj1Audit.actionCode === 'exception_remediation.recorded' &&
      rj1Audit.beforeState === null && (rj1Audit.afterState as any)?.recordedAt === jAfterReturn[1].recordedAt.toISOString() && rj1Audit.organizationId === J.organizationId && rj1Audit.actorUserId === RV.id,
    "while RV's return on J was uncommitted no other connection saw it or its audit; after commit exactly one of each, the audit holding the event's own database time, organization and actor",
  )
  const freshJ = propose(IJ.findingId, 'REFER_FOR_POLICY_REVIEW', 'POLICY_CLARIFICATION_NEEDED')
  const failAfterInsert = failOnce('exceptionRemediation.inserted', 'injected failure after the remediation insert')
  const crashedInsert = await attemptAdversarial(() => recordRemediationEvent(J.claimId, J.intakeId, freshJ, M4.id))
  const afterCrash1 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T062', 'Crash after insert, before audit, rolls back', failAfterInsert.reached === 1 && /injected failure after the remediation insert/.test(crashedInsert) && afterCrash1.rows === 2 && afterCrash1.audits === 2, 'a failure right after the insert rolled back the whole transaction: no event, no audit, no retry')
  const failAfterAudit = failOnce('exceptionRemediation.audited', 'injected failure after the remediation audit')
  const crashedAudit = await attemptAdversarial(() => recordRemediationEvent(J.claimId, J.intakeId, freshJ, M4.id))
  const afterCrash2 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T063', 'Crash after audit, before commit, rolls back', failAfterAudit.reached === 1 && /injected failure after the remediation audit/.test(crashedAudit) && afterCrash2.rows === 2 && afterCrash2.audits === 2, 'a failure after the audit rolled back both: no event, no audit, no retry')
  const once = failOnce('exceptionRemediation.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const PJ2 = await recordRemediationEvent(J.claimId, J.intakeId, freshJ, M4.id)
  clearConcurrencyProbes()
  const PJ2_ID = PJ2.ok ? PJ2.value.remediationEventId : MISSING
  check(
    'T064',
    'Retry after proven rollback writes once',
    once.reached === 1 && PJ2.ok && PJ2.value.sequence === 3 && (await eventsOf(J.intakeId)).length === 3 && (await auditsOfIntake(J.intakeId)) === 3,
    'one provably aborted serialization failure is retried on a fresh transaction that re-reads the history and records exactly one event (3) and one audit',
  )
  // T077–T079's writers: exhausted retries, unknown outcomes, then a unique collision that is retried.
  const always = failEveryTime('exceptionRemediation.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const exhausted = await recordRemediationEvent(J.claimId, J.intakeId, approveOf(PJ2_ID), RV.id)
  const lost = failEveryTime('exceptionRemediation.audited', 'Connection terminated unexpectedly')
  const unknownOutcome = await recordRemediationEvent(J.claimId, J.intakeId, approveOf(PJ2_ID), RV.id)
  const early = failEveryTime('exceptionRemediation.claim_locked', 'Connection terminated unexpectedly')
  const earlyOutcome = await recordRemediationEvent(J.claimId, J.intakeId, approveOf(PJ2_ID), RV.id)
  const jBeforeUnique = (await eventsOf(J.intakeId)).length
  const uniqueOnce = failOnce('exceptionRemediation.inserted', 'duplicate key value violates unique constraint "exception_remediation_events_sequence_key"')
  const AJ = await recordRemediationEvent(J.claimId, J.intakeId, approveOf(PJ2_ID), RV.id)
  clearConcurrencyProbes()
  const runEventsSoFar = await prisma.exceptionRemediationEvent.findMany({ where: { recordedAt: { gte: runStartedAt } } })
  const runAuditsSoFar = await prisma.auditEvent.findMany({ where: { actionCode: 'exception_remediation.recorded', occurredAt: { gte: runStartedAt } } })
  const auditOf = (eventId: string) => runAuditsSoFar.filter((a) => a.entityId === eventId)
  check(
    'T065',
    'Every audit targets correct tenant and actor',
    runEventsSoFar.length >= 10 && runEventsSoFar.every((e) => {
      const audits = auditOf(e.id)
      const after = audits[0]?.afterState as any
      return audits.length === 1 && audits[0].organizationId === e.organizationId && audits[0].actorUserId === e.recordedByUserId && audits[0].entityType === 'EXCEPTION_REMEDIATION_EVENT' &&
        after?.recordedByMembershipId === e.recordedByMembershipId && after?.exceptionIntakeId === e.exceptionIntakeId && after?.claimId === e.claimId
    }),
    `each of the ${runEventsSoFar.length} remediation events this run has exactly one audit under its own organization, its own acting user and membership, intake and Claim`,
  )
  const timeRows = await prisma.$queryRawUnsafe<{ n: bigint; differ: bigint; early: bigint }[]>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE recorded_at <> created_at) AS differ, count(*) FILTER (WHERE recorded_at < $1::timestamptz) AS early FROM ${TABLE} WHERE exception_intake_id = ANY($2::uuid[])`,
    runStartedAt.toISOString(), runIntakes.map((k) => k.intakeId),
  )
  const pastTime = await directInsert([rowOf(S, { recorded_at: '2020-01-01T00:00:00.000Z' })])
  const futureTime = await directInsert([rowOf(S, { recorded_at: new Date(Date.now() + 86_400_000).toISOString() })])
  const retime = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET recorded_at = recorded_at - interval '1 day' WHERE id = $1::uuid`, P1_ID))
  check(
    'T066',
    'Database event time server-owned and immutable',
    Number(timeRows[0].n) >= 10 && Number(timeRows[0].differ) === 0 && Number(timeRows[0].early) === 0 && [pastTime, futureTime].every((r) => r.refused && /exception_remediation_time/.test(r.message) && r.clean) &&
      /append-only/.test(retime.message) && retime.clean && runEventsSoFar.every((e) => (auditOf(e.id)[0]?.afterState as any)?.recordedAt === e.recordedAt.toISOString()),
    "every event this run was recorded and created at the database's own transaction time (equal, never before the run); a past or future time in a direct row is refused by the time guard and re-timing an event is refused (append-only); each audit carries the event's own time",
  )
  const auditText = JSON.stringify(runAuditsSoFar.map((a) => a.afterState))
  check(
    'T067',
    'Audit metadata excludes clinical, payer, money',
    runAuditsSoFar.length === runEventsSoFar.length && runAuditsSoFar.every((a) => a.beforeState === null && same(Object.keys((a.afterState ?? {}) as object).sort(), [...AUDIT_KEYS].sort())) &&
      ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), 'AED', '125.25', M1.email, RV.email, 'Synthetic member'].some((value) => auditText.includes(value)),
    `every remediation audit is metadata only — exactly ${AUDIT_KEYS.length} keys (ids, contract, sequence, controlled codes, finding and proposal pointers, membership and time) — and holds no patient, diagnosis, member contact, amount or currency`,
  )
  const auditsBeforeReads = await prisma.auditEvent.count()
  const countsBeforeReads = await counts()
  for (const k of [W, L, J, S]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await dispositionOf(k, who)
  }
  const readRefusals = [
    await historyOf(W, anonymous), await dispositionOf(F), await historyOf({ claimId: W.claimId, intakeId: MISSING }), await get(`${base(W)}/remediation-disposition?current=1`), await rem(W, propose(IW.findingId), asViewer),
    await rem(W, propose(MISSING, 'REFER_FOR_POLICY_REVIEW'), M1.who), await rem(L, approveOf(PL1_ID), M4.who), await rem(W, propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), M1.who), await rem(W, { eventCode: 'NOPE' }, M1.who),
  ]
  check(
    'T068',
    'GET and refusal write no audit',
    (await prisma.auditEvent.count()) === auditsBeforeReads && (await unchanged(countsBeforeReads)) && readRefusals.map((r) => r.status).join('/') === '401/404/404/400/403/404/409/409/400',
    `sixteen reads by an Admin and a Viewer and nine refused requests (${readRefusals.map((r) => r.status).join('/')}) wrote no audit and changed no row`,
  )
  const wHashBeforeBackfill = await rowsHash([W.intakeId])
  const backfill = [
    await directInsert([reviewRow(W, 3, P1_ID, { decision_code: 'RETURN_PROPOSAL', review_reason_code: 'WRONG_SCOPE' })]),
    await directInsert([rowOf(W, { sequence: 5, a8_3_finding_event_id: IW.findingId, action_code: 'REFER_FOR_POLICY_REVIEW', recorded_by_membership_id: M1.membershipId, recorded_by_user_id: M1.id })]),
  ]
  const rewrite = [await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = 9 WHERE id = $1::uuid`, A1_ID)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, P1_ID))]
  check(
    'T069',
    'No late backfill, sequence rewrite or deletion',
    backfill[0].refused && /exception_remediation_sequence/.test(backfill[0].message) && backfill[1].refused && /exception_remediation_transition: the proposal of this intake was approved/.test(backfill[1].message) &&
      rewrite.every((r) => /append-only/.test(r.message) && r.clean) && backfill.every((r) => r.clean) && (await rowsHash([W.intakeId])) === wHashBeforeBackfill,
    "a review slotted into W's past is refused by the sequence guard, an event appended after its approval by the terminal guard; renumbering W's approval and deleting its first proposal are refused (append-only); W's rows are byte-identical",
  )
  const contiguous = async (k: Intake) => {
    const rows = await eventsOf(k.intakeId)
    return same(rows.map((e) => e.sequence), rows.map((_e, i) => i + 1)) && (await auditsOfIntake(k.intakeId)) === rows.length
  }
  const orphanAudits = runAuditsSoFar.filter((a) => !runEventsSoFar.some((e) => e.id === a.entityId))
  check(
    'T070',
    'One audit per event; no orphan audit',
    runEventsSoFar.every((e) => auditOf(e.id).length === 1) && orphanAudits.length === 0 && (await contiguous(W)) && (await contiguous(L)) && (await contiguous(J)),
    `${runEventsSoFar.length} events and ${runAuditsSoFar.length} remediation audits this run pair one to one; no audit names a missing event; W, L and J are numbered 1..N with one audit each, after every crash and retry`,
  )

  // ---------------------------------------------------------------- concurrency and unknown outcome (T071–T080)
  section('Concurrency and unknown outcome: the Claim lock first in one SERIALIZABLE transaction, concurrent proposals and reviews, a concurrent reassignment and role removal, six mixed operations, bounded retries, unique collisions, unknown commits, contiguous numbers')
  check(
    'T071',
    'Claim NOWAIT lock first, one SERIALIZABLE tx',
    /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(firstStatement) && /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) &&
      (serviceCode.match(/prisma\.\$transaction\(\(tx\) => recordOnTransaction\(/g) ?? []).length === 1 && /recordAuditEvent\(/.test(onTx) && /insertRemediationEvent\(/.test(onTx) && secondWaited &&
      j1.ok && j1.value.sequence === 1 && j2.ok === false && j2.code === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED',
    "the Claim row NOWAIT lock is the first statement of the one SERIALIZABLE transaction that writes the event and its audit; while one proposal on J held it a second waited, then was judged on the committed state (a proposal already awaits review: 409)",
  )
  const proposalRace = await Promise.all(
    [propose(IR.findingId, 'REVIEW_SOURCE_PROVENANCE'), propose(IR.findingId), propose(IR.findingId, 'RECHECK_CODING_REFERENCE'), propose(IR.findingId, 'REFER_FOR_POLICY_REVIEW'), propose(IR.findingId, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', 'RECORDED_CONFLICT')].map(
      (body) => rem(R, body, M4.who),
    ),
  )
  const isRefusedStep = (r: { status: number; body: any }) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_TRANSITION_REFUSED'
  const PR1_ID = (proposalRace.find((r) => r.status === 201)?.body.remediationEventId ?? MISSING) as string
  check(
    'T072',
    'Concurrent proposals: only one pending',
    proposalRace.filter((r) => r.status === 201).length === 1 && proposalRace.filter(isRefusedStep).length === 4 && (await eventsOf(R.intakeId)).length === 1 && (await auditsOfIntake(R.intakeId)) === 1 &&
      (await dispositionOf(R)).body.pendingProposal?.remediationEventId === PR1_ID,
    `five different proposals on R at once (${proposalRace.map((r) => r.status).join('/')}): one 201 and four 409; one event, one audit, and it is the pending proposal`,
  )
  const reviewRace = await Promise.all(
    [returnOf(PR1_ID, 'WRONG_SCOPE'), returnOf(PR1_ID, 'INSUFFICIENT_SUPPORT'), returnOf(PR1_ID), returnOf(PR1_ID, 'WRONG_SCOPE'), returnOf(PR1_ID, 'INSUFFICIENT_SUPPORT')].map((body, i) => rem(R, body, i % 2 === 0 ? RV.who : RV2.who)),
  )
  check(
    'T073',
    'Concurrent reviews: only one decision',
    reviewRace.filter((r) => r.status === 201).length === 1 && reviewRace.filter(isRefusedStep).length === 4 && (await eventsOf(R.intakeId)).length === 2 && (await auditsOfIntake(R.intakeId)) === 2 &&
      (await dispositionOf(R)).body.state === 'RETURNED_FOR_REVISION',
    `five reviews of R's proposal by two independent reviewers at once (${reviewRace.map((r) => r.status).join('/')}): one decision, four 409; R is RETURNED_FOR_REVISION with two events`,
  )
  const holdTriage = holdAt('exceptionTriage.inserted')
  const kReassign = recordTriageEvent(K.claimId, K.intakeId, reassignTo(M2), creatorId)
  await Promise.race([holdTriage.arrived, kReassign])
  const kProposal = recordRemediationEvent(K.claimId, K.intakeId, propose(IK.findingId), M4.id)
  const kWaited = !(await settledWithin(kProposal, 1500))
  holdTriage.release()
  const [kReassigned, kResult] = await Promise.all([kReassign, kProposal])
  clearConcurrencyProbes()
  const kByM2 = await rem(K, propose(IK.findingId), M2.who)
  check(
    'T074',
    'Concurrent reassignment and proposal serialize',
    kWaited && kReassigned.ok && kResult.ok === false && kResult.code === 'EXCEPTION_REMEDIATION_NOT_ASSIGNEE' && kByM2.status === 201 && kByM2.body.recordedByMembershipId === M2.membershipId && kByM2.body.sequence === 1 &&
      (await eventsOf(K.intakeId)).length === 1,
    "while an A8.2 reassignment of K to M2 held K's Claim lock, M4's proposal waited, re-read the committed disposition and was refused 409 (no longer the assignee); M2, the new assignee, then proposes (201, event 1)",
  )
  const holdG = holdAt('exceptionRemediation.claim_locked')
  const gProposal = recordRemediationEvent(G.claimId, G.intakeId, propose(IG.findingId), M5.id)
  await Promise.race([holdG.arrived, gProposal])
  await prisma.membershipRole.deleteMany({ where: { membershipId: M5.membershipId } })
  holdG.release()
  const gResult = await gProposal
  clearConcurrencyProbes()
  const gHttp = await rem(G, propose(IG.findingId), M5.who)
  const gDirect = await directInsert([rowOf(G, { recorded_by_membership_id: M5.membershipId, recorded_by_user_id: M5.id })])
  const gTriage = (await triageDispositionOf(G)).body
  check(
    'T075',
    'Permission change before proposal blocks commit',
    gResult.ok === false && gResult.code === 'EXCEPTION_REMEDIATION_NOT_ASSIGNEE' && gHttp.status === 403 && gDirect.refused && /exception_remediation_assignee/.test(gDirect.message) && gDirect.clean &&
      gTriage.assignedMemberId === M5.membershipId && gTriage.assigneeCurrentlyEligible === false && (await eventsOf(G.intakeId)).length === 0,
    "M5's role was removed while its proposal on G held the Claim lock: the proposal was refused 409 (no current permission); its next request is 403 and the database guard refuses a direct row; A8.2 still names M5, not eligible; nothing recorded",
  )
  const PQ1 = await rem(Q, propose(IQ.findingId), M4.who)
  const PQ1_ID = (PQ1.body?.remediationEventId ?? MISSING) as string
  const mixed = await Promise.all([
    rem(Q, propose(IQ.findingId, 'REFER_FOR_POLICY_REVIEW', 'POLICY_CLARIFICATION_NEEDED'), M4.who), rem(Q, returnOf(PQ1_ID, 'WRONG_SCOPE'), RV.who), rem(Q, approveOf(PQ1_ID), RV2.who),
    rem(Q, propose(IQ.findingId, 'RECHECK_CODING_REFERENCE', 'RECORDED_CONFLICT'), M4.who), rem(Q, returnOf(PQ1_ID, 'INSUFFICIENT_SUPPORT'), RV2.who), rem(Q, approveOf(PQ1_ID), RV.who),
  ])
  const qRows = await eventsOf(Q.intakeId)
  const qHistory = (await historyOf(Q)).body
  const qDisposition = (await dispositionOf(Q)).body
  const qDerived = deriveRemediation({ exceptionIntakeId: Q.intakeId, organizationId: Q.organizationId, claimId: Q.claimId }, qRows)
  check(
    'T076',
    'Six mixed operations: legal serial history',
    PQ1.status === 201 && mixed.every((r) => r.status === 201 || isRefusedStep(r)) && mixed.filter((r) => r.status === 201).length === qRows.length - 1 && qDerived.ok && (await contiguous(Q)) &&
      same(replayIndependently(qHistory.items), dispositionFacts(qDisposition)) && qDisposition.state === (qDerived.ok ? qDerived.value.state : 'none'),
    `after Q's proposal, two proposals, two returns and two approvals at once (${mixed.map((r) => r.status).join('/')}) left ${qRows.length} events numbered 1..N, one audit each, a history the reducer accepts and a disposition (${qDisposition.state}) this suite's own replay reproduces; every other request was a 409`,
  )
  check(
    'T077',
    'Serialization retries at most three times',
    always.reached === 3 && exhausted.ok === false && exhausted.code === 'EXCEPTION_REMEDIATION_CONFLICT' && /kept conflicting; nothing was recorded/.test(exhausted.message) && /const MAX_REMEDIATION_ATTEMPTS = 3/.test(serviceCode) &&
      /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode),
    'a serialization failure on every attempt stops after exactly 3 fresh transactions with a 409 and nothing recorded; busy locks are waited for within the 30 s budget',
  )
  check(
    'T078',
    'Unique collision re-reads before retry',
    uniqueOnce.reached === 1 && AJ.ok && AJ.value.sequence === jBeforeUnique + 1 && AJ.value.decisionCode === 'APPROVE_PROPOSAL' && (await contiguous(J)) && /isUniqueViolation\(error\)/.test(serviceCode),
    `a unique (intake, sequence) collision is retried on a fresh transaction that re-reads the history, and RV's approval is recorded exactly once as event ${jBeforeUnique + 1}`,
  )
  check(
    'T079',
    'Unknown commit reconciles; never blind 201',
    lost.reached === 1 && unknownOutcome.ok === false && unknownOutcome.code === 'EXCEPTION_REMEDIATION_CONFLICT' && /holds no event at sequence 4; nothing was recorded/.test(unknownOutcome.message) &&
      early.reached === 1 && earlyOutcome.ok === false && /failed before an event was written/.test(earlyOutcome.message) && jBeforeUnique === 3 && /reconcileAttempt\(records, attempted\)/.test(serviceCode),
    "a connection lost after the audit is reconciled against the committed history (no event 4: nothing recorded) and a loss before the insert is reported as such; each reached once — never resubmitted, never a 201 (RECORDED and OTHER_EVENT are proven by the reducer's unit tests, T081)",
  )
  check(
    'T080',
    'Events numbered 1..N without gaps after races',
    (await contiguous(W)) && (await contiguous(L)) && (await contiguous(J)) && (await contiguous(R)) && (await contiguous(K)) && (await contiguous(Q)) && (await eventsOf(G.intakeId)).length === 0 && (await eventsOf(S.intakeId)).length === 0,
    'W, L, J, R, K and Q are each numbered exactly 1..N with one audit per event after every race, crash and retry; G and S hold none',
  )

  // ---------------------------------------------------------------- reducer and read truth (T081–T090)
  section('Reducer and read truth: unit tests over every state/event pair, 100 derivations, an independent replay, corrupt, gapped and misnumbered histories, READ ONLY snapshot reads, database read time, agreement, two readers')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  const reducerCode = committedCode(`${MODULE_DIR}/exception-remediation.reducer.ts`)
  const reducerTests = committedText(`${MODULE_DIR}/exception-remediation.reducer.test.ts`)
  check(
    'T081',
    'Pure reducer unit suite: every state/event pair',
    ownUnit.ok && /ℹ pass 9/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output) && /every illegal state\/event pair is refused/.test(reducerTests) && /the worked scenario/.test(reducerTests) &&
      !/prisma|await |async |Date\.now|Math\.random|new Date|from '\.\.\/\.\.\/shared/.test(reducerCode),
    'the 9 reducer and request tests pass (the worked scenario, every illegal state/event pair, exact shapes, whole histories and the unknown-outcome reconciliation); the reducer reads no database, clock or randomness',
  )
  const wParent = { exceptionIntakeId: W.intakeId, organizationId: W.organizationId, claimId: W.claimId }
  const wStored = await eventsOf(W.intakeId)
  const derivations = new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveRemediation(wParent, wStored))))
  const wDerived = deriveRemediation(wParent, wStored)
  check('T082', 'Same stored history, same state 100 times', derivations.size === 1 && wDerived.ok && wDerived.value.state === 'APPROVED_FOR_PLANNING', "100 derivations of W's stored history are byte-identical (APPROVED_FOR_PLANNING)")
  const replays = await Promise.all([W, L, J, R, K, Q].map(async (k) => same(replayIndependently((await historyOf(k)).body.items), dispositionFacts((await dispositionOf(k)).body))))
  check('T083', 'Independent replay matches disposition', replays.every(Boolean), "this suite's own replay of W's, L's, J's, R's, K's and Q's histories gives exactly each derived disposition")
  const refusedRead = (r: { value?: { history: any; disposition: any }; clean: boolean }) =>
    r.value?.history.ok === false && r.value.history.code === 'EXCEPTION_REMEDIATION_CONFLICT' && r.value.disposition.ok === false && r.value.disposition.code === 'EXCEPTION_REMEDIATION_CONFLICT' && r.clean
  const corruptShape = await plantedRead(S, [rowOf(S, { action_code: 'EXECUTE_REMEDIATION' })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_shape_chk`)
  const plantedSelfReview = await plantedRead(S, [rowOf(S, { id: pS }), reviewRow(S, 2, pS, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })])
  const foreignPlanted = await plantedRead(S, [rowOf(S, { organization_id: otherOrg })])
  check('T084', 'Corrupt event shape fails whole read 409', refusedRead(corruptShape) && refusedRead(plantedSelfReview) && refusedRead(foreignPlanted), 'a planted uncontrolled action (its CHECK dropped), a planted self-review and a planted row of the other tenant each make the history and the disposition refuse 409 — never repaired, never partial')
  const gapped = await plantedRead(S, [rowOf(S, { id: pS }), reviewRow(S, 3, pS)])
  check('T085', 'Sequence gap fails whole read 409', refusedRead(gapped), 'a planted history numbered 1, 3 makes both reads refuse 409')
  const wrongFirst = await plantedRead(S, [rowOf(S, { sequence: 2 })])
  const futureContract = await plantedRead(S, [rowOf(S, { contract_version: 'A8-REMEDIATION-PLAN-2' })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_contract_chk`)
  check('T086', 'Wrong first number fails whole read 409', refusedRead(wrongFirst) && refusedRead(futureContract), 'a planted history whose first event is numbered 2, and one under A8-REMEDIATION-PLAN-2 (its CHECK dropped), make both reads refuse 409')
  const countsBeforeGet = await counts()
  for (const k of [W, L, J, R, Q]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await dispositionOf(k, who)
  }
  const selectors = [await get(`${base(W)}/remediation-history?latest=1`), await get(`${base(W)}/remediation-disposition?state=APPROVED_FOR_PLANNING`)]
  const snapshotCode = committedCode('backend/src/shared/database/read-snapshot.ts')
  check(
    'T087',
    'GET: one READ ONLY snapshot, no rows written',
    (await unchanged(countsBeforeGet)) && selectors.every((r) => r.status === 400) && /SET TRANSACTION READ ONLY/.test(snapshotCode) &&
      /withReadSnapshot\(undefined, \(tx\) => getRemediationHistoryOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode) && /withReadSnapshot\(undefined, \(tx\) => getRemediationDispositionOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode),
    'twenty reads by an Admin and a Viewer changed no row; each runs in one READ ONLY snapshot; a query selector is refused (400)',
  )
  const dbNow = async () => (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts.getTime()
  const beforeRead = await dbNow()
  const readAgain = (await dispositionOf(W)).body
  const historyAgain = (await historyOf(W)).body
  const afterRead = await dbNow()
  const evaluated = [Date.parse(readAgain.evaluatedAt), Date.parse(historyAgain.evaluatedAt)]
  check(
    'T088',
    'evaluatedAt is DB read time; event time stable',
    evaluated.every((t) => t >= beforeRead - 1 && t <= afterRead + 1) && evaluated[1] >= evaluated[0] && historyAgain.items.every((item: any, i: number) => item.recordedAt === wStored[i].recordedAt.toISOString()) &&
      historyAgain.items[0].recordedAt === P1.body.recordedAt,
    "each read's evaluatedAt lies between two database clock readings around it; every event's recordedAt is its stored database time and event 1 still reads exactly as answered when recorded",
  )
  const agree = async (k: Intake) => {
    const items = (await historyOf(k)).body.items as any[]
    const d = (await dispositionOf(k)).body
    const last = items[items.length - 1]
    return d.eventCount === items.length && d.lastSequence === (last?.sequence ?? null) &&
      (last?.eventCode === 'PROPOSE_ACTION' ? d.pendingProposal?.remediationEventId === last.remediationEventId : last ? d.latestDecision?.remediationEventId === last.remediationEventId && d.pendingProposal === null : d.state === 'NO_PROPOSAL')
  }
  check('T089', 'History and disposition agree with last event', (await Promise.all([W, L, J, R, K, Q, S, G].map(agree))).every(Boolean), "for W, L, J, R, K, Q, S and G the disposition's count, last number and pending proposal or latest decision are exactly the history's last event")
  const twoReaders = await Promise.all([W, L, J, R, K, Q].map(async (k) => withoutEvaluatedAt((await historyOf(k)).body) === withoutEvaluatedAt((await historyOf(k, asViewer)).body) && withoutEvaluatedAt((await dispositionOf(k)).body) === withoutEvaluatedAt((await dispositionOf(k, asViewer)).body)))
  check('T090', 'Viewer and Admin reads match exactly', twoReaders.every(Boolean), "W's, L's, J's, R's, K's and Q's history and disposition are identical for an Admin and a Viewer")

  // ---------------------------------------------------------------- no scope leakage (T091–T100)
  section('No scope leakage: nothing executed or patched, no resolution, closure, escalation or SLA, no queue or search, no payer or payment assertion, no coding release, every A8.3, A8.2, A8.1 and A6 record unchanged, no browser storage, log or transport')
  const moduleCode = committedProductionCodeOf([MODULE_DIR]).code
  const feCode = committedProductionCodeOf([FE_DIR]).code
  const ownerSnapshotNow = await snap()
  const inserts = [...moduleCode.matchAll(/INSERT INTO "?([a-z_]+)"?/g)].map((m) => m[1])
  const executeRoutes = await Promise.all(['execute', 'remediation-execute', 'apply', 'correct', 'patch-claim'].map((p) => post(`${base(W)}/${p}`, {})))
  check(
    'T091',
    'No execution, remediation patch or claim change',
    ownerSnapshotNow.claims === ownerSnapshotBefore.claims && same(inserts, [TABLE]) && !/UPDATE "|DELETE FROM|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\.create\(|\.createMany\(/.test(moduleCode) &&
      executeRoutes.every((r) => r.status === 404),
    "every run Claim row is byte-identical; the module's only write is its own append-only INSERT (and the audit through its owner) — no UPDATE, DELETE or other create; no execute, apply or correct route",
  )
  const tablesAt = (ref: string) => new Set(migrationDirsAt(ref).flatMap((dir) => [...gitArgs(['show', `${ref}:${dir}/migration.sql`]).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])))
  const mainTables = tablesAt(ownBase)
  const a85Tables = [...committedText(MIGRATION).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
  // Tables that existed on main belong to earlier phases; only what this branch adds is judged. Later phases' tables are
  // those created by migrations committed after A8.5's own merge (none on its own branch).
  const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])) : [])
  const newTablesLike = async (pattern: string) => (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`, pattern)).map((r) => r.t).filter((t) => !mainTables.has(t) && !laterPhaseTables.has(t))
  const resolutionRoutes = await Promise.all(['resolve', 'close', 'escalate', 'sla', 'closure', 'deadline'].map((p) => post(`${base(W)}/${p}`, {})))
  const allCodes85 = [...remediationEventCodes, ...actionCodes, ...rationaleCodes, ...decisionCodes, ...reviewReasonCodes, ...remediationStates]
  check(
    'T092',
    'No resolution, closure, escalation or SLA',
    resolutionRoutes.every((r) => r.status === 404) && same(a85Tables, [TABLE]) && mainTables.size > 50 && (await newTablesLike('(resolution|closure|escalat|sla|deadline|due_|work_queue|outbox|_job)')).length === 0 &&
      !allCodes85.some((c) => /RESOL|CLOS|ESCALAT|SLA|DEADLINE|EXECUT/.test(c)) && !COLUMNS.some((c) => /sla|deadline|due|resol|clos|escal/.test(c)),
    `no resolve, close, escalate, SLA or deadline route, table, column or code; the A8.5 migration creates exactly ${TABLE}`,
  )
  const searches = await Promise.all(['/api/exception-remediations', '/api/remediation-events', '/api/remediation-queue', `/api/organizations/${org}/exception-remediations`, `/api/claims/${W.claimId}/remediation-events`, `/api/claims/${W.claimId}/exceptions/remediation-history`].map((p) => get(p)))
  check(
    'T093',
    'No global queue or search API',
    searches.every((r) => r.status === 404) && (moduleCode.match(/findMany\(/g) ?? []).length === 1 && /findMany\(\{ where: \{ exceptionIntakeId \}/.test(moduleCode),
    "no organization-wide list, queue, Claim-wide collection or search route; the module's one list read is one intake's events",
  )
  const dtoKeys = [...deepKeys([(await historyOf(W)).body, (await dispositionOf(W)).body, (await historyOf(L)).body, (await dispositionOf(L)).body])]
  const paymentRoutes = await Promise.all([post(`/api/claims/${W.claimId}/payments`, {}), post(`${base(W)}/remittance`, {}), post(`${base(W)}/adjudication`, {}), post(`${base(W)}/send`, {})])
  check(
    'T094',
    'No payer, payment, remittance or adjudication',
    !COLUMNS.some((c) => /payer|payment|remit|adjudic|denial|amount|currency|outcome/.test(c)) && !dtoKeys.some((k) => /payer|payment|remit|adjudic|denial|amount|currency|outcome|financial/i.test(k)) &&
      !allCodes85.some((c) => /PAID|DENI|PAYMENT|PAYER|REMIT|ADJUDIC|SETTL|WRITE_OFF|REFUND/.test(c)) && paymentRoutes.every((r) => r.status === 404),
    'no payer, payment, remittance, adjudication, denial, amount or outcome column, key or code; no payment, remittance, adjudication or send route',
  )
  check(
    'T095',
    'No coding release activation or CRG selection',
    PL1.status === 201 && PL1.body.actionCode === 'RECHECK_CODING_REFERENCE' && (await codingCounts()) === codingBefore && !/coding-release|codingRelease|crg_|code_system|procedure-code|diagnosis-code/.test(moduleCode),
    "L's RECHECK_CODING_REFERENCE proposal was recorded as an internal request only: every CRG-01 coding-release table and the A2 procedure and diagnosis code masters hold exactly the rows they held before; the module reads and writes no coding owner",
  )
  const untouched = (paths: string[]) => gitArgs(['diff', '--name-only', ownRange, '--', ...paths.map((p) => `:/${p}`)]) === ''
  check(
    'T096',
    'A8.3 evidence and finding vocabulary unchanged',
    untouched(['backend/src/modules/exception-investigation', A83_MIGRATION]) && ownerSnapshotNow.investigation === ownerSnapshotBefore.investigation && (await hashOf(`SELECT e.* FROM ${INVESTIGATION_TABLE} e WHERE e.id = $1::uuid`, IW.findingId)) === iwFindingHashBefore,
    "the A8.3 module (its evidence kinds and finding codes) and migration are unchanged; every A8.3 event of this run's intakes is byte-identical",
  )
  check(
    'T097',
    'A8.2 assignment disposition/history unchanged',
    untouched(['backend/src/modules/exception-triage']) && (await triageHash()) === triageHashBefore && triageIdsBefore.length >= 19 && withoutEvaluatedAt((await triageDispositionOf(W)).body) === wTriageBefore,
    `the A8.2 module is unchanged; all ${triageIdsBefore.length} triage events that existed before the first remediation write are byte-identical and W's disposition reads back the same`,
  )
  check(
    'T098',
    'A8.1 intake basis and history unchanged',
    untouched(['backend/src/modules/exception-intake']) && ownerSnapshotNow.intakes === ownerSnapshotBefore.intakes && ownerSnapshotNow.intakeAudits === ownerSnapshotBefore.intakeAudits &&
      withoutEvaluatedAt((await get(`/api/claims/${W.claimId}/exception-intake`)).body) === wIntakesBefore,
    "the A8.1 module is unchanged; every intake of this run and its audit is byte-identical and W's intake list reads back the same",
  )
  check(
    'T099',
    'A6 frozen payload, digest and seal unchanged',
    untouched(['backend/src/modules/claim-submission', 'backend/src/modules/claim-payload', 'backend/src/modules/claim-evidence', 'backend/src/modules/claim-lifecycle', 'backend/src/modules/claim-correction']) &&
      ownerSnapshotNow.freezes === ownerSnapshotBefore.freezes && ownerSnapshotNow.lifecycle === ownerSnapshotBefore.lifecycle && ownerSnapshotNow.links === ownerSnapshotBefore.links,
    `the A6 owners are unchanged; each freeze, sealed manifest, lifecycle event and correction link of the ${runClaims.length + 1} run Claims is byte-identical`,
  )
  check(
    'T100',
    'No browser storage, log, transport or network',
    !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|setInterval|setTimeout|navigator\.sendBeacon|WebSocket|EventSource/.test(feCode) && !/method: '(POST|PUT|PATCH|DELETE)'/.test(feCode) &&
      !/from 'node:(http|https|net|tls|dgram|fs|child_process)'|\bfetch\(|axios|console\.|logger\.|process\.stdout|enqueue|setInterval|worker_threads|cron/.test(moduleCode),
    'the page only reads (no write method), stores nothing in the browser, logs nothing and polls nothing; the module opens no network, file, process or queue and logs nothing',
  )

  // ---------------------------------------------------------------- prior module regressions (T101–T110)
  section('Prior module regressions — A8.3 invoked, nesting A8.2 -> A8.1 -> A7.10 -> … -> A7.1 -> A6.10 -> … -> A5 -> A1')
  await apiReady('the A8.3 and backward regression chain')
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const goldenNow = async () => {
    const history = (await historyOf(W)).body
    return {
      history: withoutEvaluatedAt(history),
      disposition: withoutEvaluatedAt((await dispositionOf(W)).body),
      audits: JSON.stringify(await Promise.all(history.items.map(async (e: any) => (await auditsOfEvent(e.remediationEventId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))))),
      rows: await rowsHash([W.intakeId]),
    }
  }
  const goldenBefore = await goldenNow()
  const chain = run('npm run test:a8:exception-investigation')
  const nestedLog = `a85-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A8.3')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A8.3] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A8.3 asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD) and re-proves A8.2's
  // branch-only causes against its own branch. On A8.5 those statements are obsolete by design; every other A8.3 check
  // is substantive. T110 below proves each cause independently on this branch.
  const a83NonApplicable: Record<string, string> = {
    T001: "A8.3 'A8.2 FINAL PASS merge is an ancestor' requires the A8.3 feature branch; A8.5 is branched from the main that contains the A8.3 merge (T001 here)",
    T002: "A8.3 'Clean tree and origin parity' requires tracking origin/feature/a8-3-…; THIS branch's clean tree and parity are proved by T003 and T127 here",
    T010: "A8.3 'Changed-file allowlist excludes later phases' lists the paths A8.3 was allowed to change; A8.5 legitimately changes its own (T010 here)",
    T119: "A8.3 'Every historical branch-only N/A justified' proves A8.2's branch-only causes against the A8.3 branch; on A8.5 they are re-proved here (T110)",
    T130: "A8.3 'Second independent 130/130 run at exact HEAD' compares HEAD with origin/feature/a8-3-…; THIS run's identity is proved by T127–T129 here",
  }
  const undocumented = failing.filter((id) => !(id in a83NonApplicable))
  const summary = chain.output.match(/\[A8\.3\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.3\] RUN ABORTED|\[A8\.3\] uncaught error|\[A8\.3\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a83Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  check(
    'T101',
    'A8.3 substantive nested suite passes',
    ran && reconciled && undocumented.length === 0 && a83Passing === 130 - failing.length && a83Passing >= 125 &&
      ['T004', 'T005', 'T006', 'T007', 'T008', 'T009', 'T011', 'T061', 'T068', 'T080', 'T099', 'T100', 'T120', 'T121', 'T125', 'T126', 'T127', 'T128', 'T129'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A8.3 suite did not complete'
      : !reconciled
        ? `A8.3 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A8.3 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A8\.3\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A8.3] automated summary: ', 'A8.3 ')}; all ${a83Passing} substantive checks PASS (its own-scope T004/T007/T009, its RESTRICT-aware T068 and later-phase-aware T099 included) and every failure is documented`,
  )
  for (const id of Object.keys(a83NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T101/${id}`, `A8.3 ${titleOf(row.line)}`, a83NonApplicable[id])
  }
  check('T102', 'A8.2 substantive nested suite passes', verdictOf('T111') === 'PASS', `A8.3 T111 (A8.2, with its own documented branch-only items) ${verdictOf('T111')}`)
  check('T103', 'A8.1 substantive nested suite passes', verdictOf('T112') === 'PASS', `A8.3 T112 (A8.1) ${verdictOf('T112')}`)
  check('T104', 'A7.10 cumulative substantive suite passes', verdictOf('T113') === 'PASS', `A8.3 T113 (A7.10 through A8.1) ${verdictOf('T113')}`)
  check('T105', 'A7.1–A7.9 cumulative substantive suite passes', ['T114', 'T115'].every((id) => verdictOf(id) === 'PASS'), `A8.3 T114 (A7.9–A7.6) ${verdictOf('T114')} and T115 (A7.5–A7.1) ${verdictOf('T115')}`)
  check('T106', 'A6.10 and A6 owners suite passes', verdictOf('T116') === 'PASS', `A8.3 T116 (A6.10, which nests A6.9 → A6.1) ${verdictOf('T116')}`)
  check('T107', 'A5 validation/readiness regressions pass', verdictOf('T117') === 'PASS', `A8.3 T117 (the chain reaching A5.10 → A5.1) ${verdictOf('T117')}`)
  const a3Scope = run('npm run test:a3:scope')
  check('T108', 'A4 encounter and A3 rule regressions pass', verdictOf('T118') === 'PASS' && a3Scope.ok, `A8.3 T118 (the chain reaching A4 → A1, A3 included) ${verdictOf('T118')}; the A3.9 scope suite over this branch's files ${a3Scope.ok ? 'PASS' : 'FAIL'}`)
  check('T109', 'A2 master and A1 auth/audit regressions pass', verdictOf('T118') === 'PASS' && verdictOf('T121') === 'PASS', `A8.3 T118 (reaching A2 → A1) ${verdictOf('T118')}; A8.3 T121 (every A1–A8.3 unit suite) ${verdictOf('T121')}`)
  // Each documented failure must fail for its branch-only reason, proved independently on this branch, all the way
  // down: A8.3 T119's unproven A8.2 items, A8.2 T120's A8.1 items, A8.1 T110's A7.10 items and A7.10 T111's A7.9 items.
  const originOf = (name: string) => gitArgs(['rev-parse', '--verify', '--quiet', `origin/${name}`])
  const originA85 = originOf(a85Branch)
  const nestedLine = (depth: string[], id: string) =>
    chain.output.split(/\r?\n/).find((line) => new RegExp(`^\\[A8\\.3\\] +${depth.map((tag) => `nested: \\[${tag.replace('.', '\\.')}\\] +`).join('')}${id} `).test(line)) ?? ''
  const listAfter = (line: string, label: RegExp) => ((line.match(label) ?? ['', ''])[1] ?? '').split(', ').filter(Boolean)
  // A suite lists its unexpected paths and, when package.json carries more than its one script, says so in words; a
  // list cut short may end in a prefix of a path.
  const inScope = (paths: string[]) => paths.length > 0 && paths.every((path, index) => changedPaths.includes(path) || (path === 'package.json beyond the one script' && changedPaths.includes('backend/package.json')) || (index === paths.length - 1 && changedPaths.some((p) => p.startsWith(path))))
  const onThisBranch = branch === a85Branch && dirty.length === 0 && tracking.includes(`origin/${a85Branch}`) && !/ahead|behind/.test(tracking)
  const failCount = (depth: string[]) => chain.output.split(/\r?\n/).filter((line) => new RegExp(`^\\[A8\\.3\\] +${depth.map((tag) => `nested: \\[${tag.replace('.', '\\.')}\\] +`).join('')}T\\d{3} .* \\.{3,} FAIL`).test(line)).length
  const unprovenA82 = listAfter(lineOfRow('T119'), /cause not proven for: (.*)$/)
  const a82Unexpected = listAfter(nestedLine(['A8.2'], 'T010'), /unexpected: (.*)$/)
  const unprovenA81 = listAfter(nestedLine(['A8.2'], 'T120'), /cause not proven for: (.*)$/)
  const a81Unexpected = listAfter(nestedLine(['A8.2', 'A8.1'], 'T010'), /unexpected: (.*)$/)
  const unprovenA710 = listAfter(nestedLine(['A8.2', 'A8.1'], 'T110'), /cause not proven for: (.*)$/)
  const a710Unexpected = listAfter(nestedLine(['A8.2', 'A8.1', 'A7.10'], 'T010'), /unexpected: (.*)$/)
  const unprovenA79 = listAfter(nestedLine(['A8.2', 'A8.1', 'A7.10'], 'T111'), /cause not proven for: (.*)$/).filter((id) => /^T\d{3}$/.test(id))
  const a710SelfCount = Number((nestedLine(['A8.2', 'A8.1', 'A7.10'], 'T130').match(/(\d+) of the 129 checks before this one PASS/) ?? [])[1] ?? -1)
  const a710Causes: Record<string, boolean> = {
    T001: onThisBranch && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a710Unexpected) && outOfScope.length === 0,
    T111: unprovenA79.length > 0 && unprovenA79.every((id) => ['T001', 'T002', 'T010', 'T120', 'T130'].includes(id)) && originOf(a79Branch) === '' && originOf(a78Branch) === '' && onThisBranch && outOfScope.length === 0,
    T122: originOf(a710Branch) === '' && originA85 === headAtStart,
    T123: originOf(a710Branch) === '' && originA85 === headAtStart,
    T130: a710SelfCount === 129 - (failCount(['A8.2', 'A8.1', 'A7.10']) - 1),
  }
  const a81Causes: Record<string, boolean> = {
    T001: onThisBranch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a81Unexpected) && outOfScope.length === 0,
    T110: unprovenA710.length > 0 && unprovenA710.every((id) => id in a710Causes && a710Causes[id]),
    T130: originA85 === headAtStart && originOf(a81Branch) !== headAtStart && /all evidence corresponds to/.test(nestedLine(['A8.2', 'A8.1'], 'T130')),
  }
  const a82Causes: Record<string, boolean> = {
    T001: onThisBranch && a81Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a81Merge} HEAD`) && a81FixMerge.length === 40 && gitOk(`merge-base --is-ancestor ${a81FixMerge} HEAD`),
    T002: onThisBranch,
    T010: inScope(a82Unexpected) && outOfScope.length === 0,
    T120: unprovenA81.length > 0 && unprovenA81.every((id) => id in a81Causes && a81Causes[id]),
    T130: originA85 === headAtStart && originOf(a82Branch) !== headAtStart && /all evidence corresponds to/.test(nestedLine(['A8.2'], 'T130')),
  }
  const causes: Record<string, boolean> = {
    T001: onThisBranch && a83Merge === A83_MERGE && a82Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a82Merge} HEAD`),
    T002: onThisBranch,
    T010: inScope(listAfter(lineOfRow('T010'), /unexpected: (.*)$/)) && outOfScope.length === 0,
    T119: unprovenA82.length > 0 && unprovenA82.every((id) => id in a82Causes && a82Causes[id]),
    T130: originA85 === headAtStart && originOf(a83Branch) !== headAtStart && failing.every((id) => id in a83NonApplicable),
  }
  const unprovenHere = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A8\.3\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T110',
    'Every branch-only N/A justified; none substantive',
    ran && undocumented.length === 0 && unprovenHere.length === 0 && naLines.length === failCount(['A8.2']) && naLines.length >= 5 && naLines.every((line) => line.length > 80),
    undocumented.length > 0
      ? `undocumented A8.3 failures: ${undocumented.join(', ')}`
      : unprovenHere.length > 0
        ? `cause not proven for: ${unprovenHere.join(', ')}`
        : `each documented A8.3 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved on this branch all the way down (A8.2 ${unprovenA82.join(', ') || 'none'}; A8.1 ${unprovenA81.join(', ') || 'none'}; A7.10 ${unprovenA710.join(', ') || 'none'}; A7.9 ${unprovenA79.join(', ') || 'none'}); A8.3 itself justifies its ${naLines.length} A8.2 items`,
  )

  // ---------------------------------------------------------------- build and deployment truth (T111–T120)
  section('Build and deployment truth: units, typecheck, frontend lint and build, Prisma validate and generate, migration status and checksums, a fresh replay, outage and recovery, no 5xx')
  const allUnit = run('npm run test:unit')
  check('T111', 'Backend unit suite passes with reducer tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok, `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 9 A8.5 reducer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T112', 'Backend TypeScript typecheck passes', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T113', 'Frontend lint passes', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T114', 'Frontend production build passes', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  check('T115', 'Prisma schema validates', validate.ok && /valid/i.test(validate.output), 'prisma validate: the schema is valid (T005)')
  const generatedAgain = run('npm run db:generate')
  check('T116', 'Prisma client generates without drift', generate.ok && generatedAgain.ok && git('status --porcelain') === '' && typecheck.ok, 'the client generates (twice) without changing any tracked file, and the backend that uses it typechecks')
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = applied.filter((row) => {
    const blob = committedBlob(`backend/prisma/migrations/${row.name}/migration.sql`)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  check(
    'T117',
    'Migration status consistent; checksums kept',
    status.ok && applied.length === headMigrationDirs.length && same(applied.map((r) => r.name), headMigrationDirs.map((d) => d.split('/').pop())) && checksumMismatch.length === 0,
    checksumMismatch.length === 0 ? `all ${applied.length} committed migrations applied in order, each with the checksum of its committed file (A8.5's included)` : `checksum differs: ${checksumMismatch.map((r) => r.name).join(', ')}`,
  )
  check('T118', 'Fresh empty scratch replay passes', replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length, `scratch replay from empty: ${appliedCount} migrations, ALL CHECKS PASS (T006)`)
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
  check('T119', 'Health/ready outage and recovery truthful', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  check('T120', 'Zero unexpected HTTP 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)

  // ---------------------------------------------------------------- final evidence and handoff (T121–T130)
  section('Final evidence and handoff: the worked example through owner routes, the four-event history after the nested chain and an outage, A8.1–A8.3 hashes, the catalog, no implicit selector, no PHI, clean parity, two independent runs, the handoff')
  const runEventMembers = await prisma.$queryRawUnsafe<{ org: string; member: string | null }[]>(
    `SELECT e.organization_id::text AS org, u.email AS member FROM ${TABLE} e JOIN organization_memberships m ON m.id = e.recorded_by_membership_id JOIN "user" u ON u.id = m.user_id WHERE e.recorded_at >= $1::timestamptz AND e.recorded_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  check(
    'T121',
    'Synthetic worked example through owner routes',
    W.status === 201 && W_CLASSIFY.sequence === 1 && W_ASSIGN.sequence === 2 && IW.statuses.every((s) => s === 201) && [P1, R1, P2, A1].every((r) => r.status === 201) &&
      runEventMembers.length >= 15 && runEventMembers.every((e) => e.org === org && /@reviewers\.sbn\.test$/.test(e.member ?? '')) && (await eventsOf(F.intakeId)).length === 0,
    `W was built entirely through its owners' routes: A6 Claim frozen twice, A8.1 intake, A8.2 classify and assign to M1, A8.3 link and finding, then A8.5 proposal, return, fresh proposal and approval; all ${runEventMembers.length} remediation events this run belong to the synthetic Org A and were recorded by synthetic members only; Org B's intake has none`,
  )
  const goldenAfter = await goldenNow()
  const historyAfter = (await historyOf(W)).body
  progress(
    `worked remediation: Claim W ${W.claimId}, intake ${W.intakeId} (A8.2 classify → assign M1; A8.3 link → finding FURTHER_REVIEW_REQUIRED): P1 REQUEST_INTERNAL_DOCUMENTATION_CHECK/INSUFFICIENT_EVIDENCE by M1 → R1 RETURN_PROPOSAL/NEEDS_MORE_INVESTIGATION by RV → P2 REVIEW_SOURCE_PROVENANCE/RECORDED_CONFLICT by M1 → A1 APPROVE_PROPOSAL by RV; APPROVED_FOR_PLANNING, 4 events, 4 audits; nothing executed`,
  )
  check(
    'T122',
    'Four-event propose-return-propose-approve verifies',
    same(historyAfter.items.map((e: any) => [e.sequence, e.eventCode, e.decisionCode, e.recordedByMembershipId]), [[1, 'PROPOSE_ACTION', null, M1.membershipId], [2, 'REVIEW_ACTION', 'RETURN_PROPOSAL', RV.membershipId], [3, 'PROPOSE_ACTION', null, M1.membershipId], [4, 'REVIEW_ACTION', 'APPROVE_PROPOSAL', RV.membershipId]]) &&
      same(goldenAfter, goldenBefore),
    "W's history is exactly proposal → return → fresh proposal → approval; after the nested chain, its database restarts and an outage, the four events, the disposition, their four audits and the stored rows read back identically",
  )
  const snapAfterChain = await snap()
  check(
    'T123',
    'A8.1–A8.3 hashes unchanged across the lifecycle',
    snapAfterChain.intakes === ownerSnapshotBefore.intakes && snapAfterChain.intakeAudits === ownerSnapshotBefore.intakeAudits && snapAfterChain.investigation === ownerSnapshotBefore.investigation && (await triageHash()) === triageHashBefore &&
      snapAfterChain.freezes === ownerSnapshotBefore.freezes,
    "after every remediation write, refusal, race, crash, the nested chain and the outage, this run's A8.1 intakes and audits, its earlier A8.2 triage events, its A8.3 events and its A6 freezes hash exactly as before the first remediation write",
  )
  const catalog = {
    indexes: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT indexname AS n FROM pg_indexes WHERE tablename = '${TABLE}' ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    checks: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT conname AS n FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND contype = 'c' ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    triggers: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT tgname AS n FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND NOT tgisinternal ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    foreignKeys: (await fksOf(TABLE)).map((r) => `${r.name.replace(`${TABLE}_`, '')}:${r.del === 'r' ? 'RESTRICT' : r.del}`),
  }
  check(
    'T124',
    'Indexes, CHECKs, triggers, FKs enumerated',
    same(catalog.indexes, ['a8_3_finding_event_id_idx', 'claim_id_idx', 'organization_id_idx', 'pkey', 'proposal_event_id_key', 'recorded_by_membership_id_idx', 'recorded_by_user_id_idx', 'sequence_key']) &&
      same(catalog.checks, ['contract_chk', 'event_code_chk', 'sequence_chk', 'shape_chk']) && same(catalog.triggers, ['append_only_trg', 'insert_guard_trg', 'no_truncate_trg']) && catalog.foreignKeys.length === 7 &&
      catalog.foreignKeys.every((fk) => fk.endsWith(':RESTRICT')),
    `indexes ${catalog.indexes.join(', ')}; CHECKs ${catalog.checks.join(', ')}; triggers ${catalog.triggers.join(', ')}; keys ${catalog.foreignKeys.join(', ')}`,
  )
  const repositoryCode = committedCode(`${MODULE_DIR}/exception-remediation.repository.ts`)
  const implicitSelectors = [
    await get(`${base(W)}/remediation-history?latest=1`), await get(`${base(W)}/remediation-disposition?current=1`), await get(`${base(W)}/remediation-disposition?sequence=2`),
    await rem(W, { ...approveOf(P2_ID), currentProposal: true }, RV.who), await rem(W, { ...propose(IW.findingId, 'REFER_FOR_POLICY_REVIEW'), status: 'APPROVED_FOR_PLANNING' }, M1.who),
  ]
  check(
    'T125',
    'No implicit latest/current selector or status',
    !COLUMNS.some((c) => /status|state|current|latest|approved|executed/.test(c)) && implicitSelectors.every((r) => r.status === 400) && /orderBy: \{ sequence: 'asc' \}/.test(repositoryCode) &&
      !/orderBy: \{ (recordedAt|createdAt|id)|orderBy: \[\{ (recordedAt|createdAt|id)/.test(repositoryCode) && !/findFirst\(/.test(moduleCode),
    'no status, state, current, latest or approved column; a latest, current or sequence selector on a read and a current pointer or status in a write are refused (400); events are read in their server-owned sequence only, never the latest by time or id',
  )
  const storedText = JSON.stringify(await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${TABLE} WHERE claim_id = ANY($1::uuid[])`, runClaims), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  const dtoText = JSON.stringify([historyAfter, (await dispositionOf(W)).body, (await historyOf(L)).body, (await dispositionOf(Q)).body])
  check(
    'T126',
    'No PHI, coded diagnosis or payer amount',
    !COLUMNS.some((c) => /patient|name|birth|email|phone|address|diagnos|clinician|encounter|amount|currency|payer|narrative|note|text|payload|hash|digest/.test(c)) &&
      !dtoKeys.some((k) => /patient|name|birth|email|diagnos|clinician|encounter|amount|currency|payer|narrative|note|payload|hash|digest/i.test(k)) &&
      ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), key('home-PA'), 'AED', '125.25', '12.125', M1.email, RV.email, 'Synthetic member'].some((value) => storedText.includes(value) || dtoText.includes(value) || auditText.includes(value)),
    'no patient, member contact, clinical, diagnosis, amount, currency, payer, narrative, payload or digest column or DTO key, and no such value in any stored event, answer or audit: a member appears only as a membership and user id',
  )
  const headNow = git('rev-parse HEAD')
  check(
    'T127',
    'Final clean git status and origin parity',
    headNow === headAtStart && headNow === originA85 && headNow.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a85Branch}`) && !/ahead|behind/.test(tracking) && outOfScope.length === 0,
    `HEAD ${headNow} = origin/${a85Branch}; ${tracking}; the tree is clean after every check (the nested log is ignored output)`,
  )
  const checksBefore128 = passed + failed
  check(
    'T128',
    'Complete 130-check run at exact HEAD with runId',
    checksBefore128 === 127 && /^A85-\d{13}$/.test(runId) && headNow === headAtStart && existsSync(nestedLog),
    `run ${runId} at ${headNow}: all 127 checks before this one executed (${passed} PASS); nested output kept in backend/${nestedLog} (SHA-256 ${sha256Of(Buffer.from(chain.output)).slice(0, 16)}…)`,
  )
  const earlierRuns = readdirSync('.')
    .filter((name) => /^a85-nested-A85-\d{13}\.log$/.test(name) && name !== nestedLog)
    .filter((name) => readFileSync(name, 'utf8').includes(`[A8.3] HEAD ${headNow}`))
    .map((name) => name.replace(/^a85-nested-|\.log$/g, ''))
  const runIntakeIds = new Set(runIntakes.map((k) => k.intakeId))
  check(
    'T129',
    'Independent run at the same exact HEAD',
    !earlierRuns.includes(runId) && headNow === headAtStart && headNow === originA85 && runEventsSoFar.every((e) => runIntakeIds.has(e.exceptionIntakeId)) && runEventMembers.every((e) => /@reviewers\.sbn\.test$/.test(e.member ?? '')),
    `run ${runId} used only fixtures and members it created itself; ${earlierRuns.length > 0 ? `earlier kept run(s) at this HEAD: ${earlierRuns.join(', ')}` : 'no earlier run at this HEAD is kept here, so this is the first'}; the two submitted runs must both state HEAD ${headNow.slice(0, 12)} with different runIds`,
  )
  const typesText = committedText(`${MODULE_DIR}/exception-remediation.types.ts`)
  const vocabulary = [...remediationEventCodes, ...actionCodes, ...rationaleCodes, ...decisionCodes, ...reviewReasonCodes, ...remediationStates, CONTRACT]
  check(
    'T130',
    'Handoff: future execution out of scope',
    registerFlat.includes('## Out of scope (handoff)') && registerFlat.includes('executing the approved action') && registerFlat.includes('any actual correction, resolution, closure or escalation') &&
      registerFlat.includes('internal planning authorization only') && registerAtHead.includes(A83_MERGE) && registerAtHead.includes(MAIN_AT_START) && registerAtHead.includes(`(${CONTRACT})`) &&
      vocabulary.every((code) => registerAtHead.includes(`\`${code}\``) && typesText.includes(`'${code}'`)) && ['getExceptionIntakesOf', 'getTriageDispositionOf', 'getInvestigationHistoryOf', 'assigneeCurrentlyEligible', 'getRemediationDispositionOf'].every((t) => registerAtHead.includes(t)),
    `the register records the start gate (A8.3 merge ${A83_MERGE.slice(0, 7)}, main ${MAIN_AT_START.slice(0, 7)}), the owner readers, ${CONTRACT} and all ${vocabulary.length} controlled codes (each identical in the module), approval as planning authorization only, and execution, correction, resolution, closure and escalation as later, separately approved work`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] EXCEPTION REMEDIATION ACCEPTANCE COMPLETE` : `[${TAG}] A8.5 FINAL FAIL`)
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
