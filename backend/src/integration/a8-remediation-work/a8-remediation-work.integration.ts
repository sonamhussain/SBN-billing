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
import { recordRemediationEvent } from '../../modules/exception-remediation/exception-remediation.service.ts'
import { deriveWork } from '../../modules/exception-remediation-work/exception-remediation-work.reducer.ts'
import { getWorkDispositionOf, getWorkHistoryOf, recordWorkEvent } from '../../modules/exception-remediation-work/exception-remediation-work.service.ts'
import {
  WORK_CODE_OF_ACTION,
  WORK_CONTRACT_VERSION,
  basisReferenceKinds,
  verificationCodes,
  verificationReasonCodes,
  workCodes,
  workEventCodes,
  workStates,
} from '../../modules/exception-remediation-work/exception-remediation-work.types.ts'

// A8.6 — focused acceptance for Remediation Work Record & Independent Verification (A8-REMEDIATION-WORK-1, T001–T130).
//
// Every Claim, freeze, A8.1 intake, A8.2 triage event, A8.3 investigation event and A8.5 remediation event is built
// through its owners exactly as the A8.5 suite builds them: a Claim frozen twice without an A6.9 link is a genuine
// history contradiction, its intake is recorded through the A8.1 route, classified and assigned through the A8.2 route,
// its assignee links the intake basis and records a finding through the A8.3 route, proposes an action through the A8.5
// route and an independent reviewer approves it there. Every work event is recorded through the A8.6 route by the
// assignee or an independent verifier or, where a probe must pause or fail one writer, through the production A8.6
// service in this process. Direct SQL writes are adversarial only, run against the live guards (or, to isolate one
// CHECK, with the triggers off), and are ALWAYS rolled back; a broken stored history is planted only inside such a
// transaction and the production reads answer on THAT transaction. Synthetic users are provisioned per run through
// Better Auth's own server-side creation with a random password that is never printed. A report is an attestation and a
// verification confirms only that the cited internal record and the report agree: nothing in this suite expects, or
// finds, anything executed, corrected, resolved, closed or paid.

const TAG = 'A8.6'
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

const runId = `A86-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a86Branch = 'feature/a8-6-remediation-work-verification'
const a85Branch = 'feature/a8-5-exception-remediation'
const crgbBranch = 'feature/crg-01b-coding-validation-freeze'
const crgBranch = 'fix/crg-01-final-coding-release'
// The accepted A8.5 merge, the Checkpoint B merge and the clean main this branch was cut from, all recorded in the
// register (start gate). The two FILL values are set when the branch is cut from main after the Checkpoint B merge.
const A85_MERGE = '0f8f9d3bc18347b1360b72b93056724b594a6e00'
const CRGB_MERGE = '4869df3c81ac4af5dcec988768666f7acd3d809e'
const MAIN_AT_START = '4869df3c81ac4af5dcec988768666f7acd3d809e'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/exception-remediation-work'
const FE_DIR = 'frontend/src/modules/exception-remediation-work'
const HARNESS_DIR = 'backend/src/integration/a8-remediation-work'
const REGISTER_DOC = 'docs/A8_Exception_Remediation_Work.md'
const MIGRATION_NAME = '20261107090000_a8_6_exception_remediation_work'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const A85_MIGRATION = 'backend/prisma/migrations/20261105090000_a8_5_exception_remediation/migration.sql'
const A83_MIGRATION = 'backend/prisma/migrations/20261103090000_a8_3_exception_investigation/migration.sql'
const TABLE = 'exception_remediation_work_events'
const REMEDIATION_TABLE = 'exception_remediation_events'
const INVESTIGATION_TABLE = 'exception_investigation_events'
const TRIAGE_TABLE = 'exception_triage_events'
const INTAKE_TABLE = 'exception_intake_records'
const UNIT_TESTS = [`${MODULE_DIR}/exception-remediation-work.reducer.test.ts`, `${MODULE_DIR}/exception-remediation-work.validation.test.ts`]
const CONTRACT = 'A8-REMEDIATION-WORK-1'
const PLAN_CONTRACT = 'A8-REMEDIATION-PLAN-1'
const BASIS_CONTRACT = 'A8-EXCEPTION-INVESTIGATION-1'
const INTAKE_CONTRACT = 'A8-EXCEPTION-INTAKE-1'
const TIMELINE_CONTRACT = 'A7-REVENUE-TIMELINE-1'
const EVENT_KEYS = [
  'workEventId', 'contractVersion', 'exceptionIntakeId', 'organizationId', 'claimId', 'sequence', 'eventCode', 'approvedProposalEventId', 'workCode', 'basisReferenceKind', 'basisReferenceId',
  'basisReferenceContractVersion', 'workReportEventId', 'verificationCode', 'reasonCode', 'recordedByMembershipId', 'recordedByUserId', 'recordedAt',
]
const HISTORY_KEYS = ['contractVersion', 'exceptionIntakeId', 'items', 'evaluatedAt']
const DISPOSITION_KEYS = ['contractVersion', 'exceptionIntakeId', 'state', 'approvedProposalEventId', 'report', 'verification', 'eventCount', 'lastSequence', 'evaluatedAt']
const REPORT_KEYS = ['workEventId', 'sequence', 'approvedProposalEventId', 'workCode', 'basisReferenceKind', 'basisReferenceId', 'basisReferenceContractVersion', 'reportedByMembershipId', 'reportedByUserId']
const VERIFICATION_KEYS = ['workEventId', 'sequence', 'workReportEventId', 'verificationCode', 'reasonCode', 'verifiedByMembershipId', 'verifiedByUserId']
const AUDIT_KEYS = [
  'workEventId', 'exceptionIntakeId', 'claimId', 'contractVersion', 'sequence', 'eventCode', 'approvedProposalEventId', 'workCode', 'basisReferenceKind', 'basisReferenceId', 'basisReferenceContractVersion',
  'workReportEventId', 'verificationCode', 'reasonCode', 'recordedByMembershipId', 'recordedAt',
]
const COLUMNS = [
  'id', 'exception_intake_id', 'organization_id', 'claim_id', 'contract_version', 'sequence', 'event_code', 'approved_proposal_event_id', 'work_code', 'basis_reference_kind', 'basis_reference_id',
  'basis_reference_contract_version', 'work_report_event_id', 'verification_code', 'reason_code', 'recorded_by_membership_id', 'recorded_by_user_id', 'recorded_at', 'created_at',
]
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/shared/authorization/authorization.types.ts',
  'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'backend/src/modules/audit/audit.types.ts', 'frontend/src/developer/checkRegistry.tsx', REGISTER_DOC,
]
// Every table a work write could conceivably touch, in a fixed key order. A read or a refusal must leave every one as it
// was; a recorded event adds exactly one row here and one audit.
const COUNT_TABLES = [TABLE, REMEDIATION_TABLE, INVESTIGATION_TABLE, TRIAGE_TABLE, INTAKE_TABLE, 'audit_events', 'claims', 'claim_freezes', 'claim_freeze_lifecycle_events', 'claim_correction_links', 'organization_memberships', 'membership_roles']
// The CRG-01 coding-release and validation tables and the A2 code masters: a CODING_REFERENCE_REVIEW_REPORTED report
// selects, activates, imports and changes none of them.
const CODING_TABLES = [
  'crg_code_system_datasets', 'crg_code_system_rights', 'crg_release_imports', 'crg_release_code_memberships', 'crg_retirement_classifications', 'crg_validation_scopes', 'crg_validation_code_receipts',
  'crg_validation_receipt_manifests', 'procedure_codes', 'diagnosis_codes',
]
// The A7 historical records: a work event writes none of them.
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
type HistoryItem = { workEventId: string; sequence: number; eventCode: string; approvedProposalEventId: string; workReportEventId: string | null; verificationCode: string | null }
function replayIndependently(items: HistoryItem[], approvedProposalEventId: string | null) {
  let state = 'NO_WORK_REPORT'
  let report: HistoryItem | null = null
  let verification: HistoryItem | null = null
  for (const item of items) {
    if (item.eventCode === 'RECORD_WORK_REPORT') {
      report = item
      state = 'AWAITING_VERIFICATION'
    } else {
      verification = item
      state = item.verificationCode === 'EVIDENCE_SUPPORTED' ? 'VERIFIED_INTERNAL_WORK' : 'NOT_VERIFIED'
    }
  }
  return {
    state,
    approvedProposalEventId,
    reportId: report?.workEventId ?? null,
    verificationId: verification?.workEventId ?? null,
    eventCount: items.length,
    lastSequence: items.length > 0 ? items[items.length - 1].sequence : null,
  }
}
const dispositionFacts = (d: any) => ({
  state: d?.state,
  approvedProposalEventId: d?.approvedProposalEventId ?? null,
  reportId: d?.report?.workEventId ?? null,
  verificationId: d?.verification?.workEventId ?? null,
  eventCount: d?.eventCount,
  lastSequence: d?.lastSequence,
})

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)
  // pg's concurrent-query deprecation (the Checkpoint B review point), if it ever fires in this process (it is still
  // printed); T119 requires none here and none in any process of the nested chain.
  const driverWarnings: string[] = []
  process.on('warning', (warning) => {
    if (/Calling client\.query\(\) when the client is already executing a query/.test(warning.message)) driverWarnings.push(warning.message)
  })

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] A8.6 remediation work record & independent verification (${CONTRACT}) — run ${runId}`)
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
  section('Start, ownership and scope: the accepted A8.5 merge and the Checkpoint B merge, the A8.4 closure, branch and tree, one additive migration, Prisma, replay, the narrow permissions and audit action, three routes, earlier contracts, diff scope')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a85Merge = mergeOf(a85Branch)
  const crgbMerge = mergeOf(crgbBranch)
  const crgMerge = mergeOf(crgBranch)
  check(
    'T001',
    'A8.5 exact accepted merge is ancestor; clean main',
    branch === a86Branch && a85Merge === A85_MERGE && gitOk(`merge-base --is-ancestor ${a85Merge} HEAD`) && crgbMerge === CRGB_MERGE && gitOk(`merge-base --is-ancestor ${crgbMerge} HEAD`) &&
      crgMerge.length === 40 && gitOk(`merge-base --is-ancestor ${crgMerge} HEAD`) && gitOk(`merge-base --is-ancestor ${MAIN_AT_START} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `A8.5 merged as ${a85Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A85_MERGE.slice(0, 7)}) and Checkpoint B as ${crgbMerge.slice(0, 7) || 'NOT FOUND'}, both ancestors with Checkpoint A; cut from clean main ${MAIN_AT_START.slice(0, 7)}; latest main ${git('rev-parse --short origin/main')} contained; not stacked`,
  )
  const registerAtHead = committedText(REGISTER_DOC)
  const registerFlat = registerAtHead.replace(/\s+/g, ' ')
  const headTree = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter(Boolean)
  const a84Paths = headTree.filter((path) => /(^|[\\/_-])a8[-_]?4([\\/_.-]|$)/i.test(path))
  check(
    'T002',
    'A8.4 old duplicate is CLOSED; no A8.4 code',
    registerFlat.includes('On 2026-11-04 the architecture owner closed the earlier A8.4 specification as a duplicate of A8.3') && registerFlat.includes('No A8.4 code exists') && a84Paths.length === 0,
    a84Paths.length === 0 ? 'the register records the 2026-11-04 closure of A8.4 as a duplicate of A8.3; no A8.4 module, migration, suite or page exists at HEAD' : `A8.4 paths exist: ${a84Paths.join(', ').slice(0, 200)}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T003',
    'Clean tracked tree; HEAD matches remote branch',
    branch === a86Branch && dirty.length === 0 && tracking.includes(`origin/${a86Branch}`) && !/ahead|behind/.test(tracking),
    dirty.length === 0 ? `branch ${branch}; working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  // A8.6's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge added
  // (the same values, literally, on its own branch). A later package's changes are that package's to prove.
  const ownMerge = branch === a86Branch ? '' : mergeOf(a86Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'
  const ownTip = ownMerge || 'HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = migrationDirsAt(ownTip)
  const ownBaseMigrationDirs = migrationDirsAt(ownBase)
  check(
    'T004',
    'Only one additive A8.6 migration against main',
    same(ownPrismaStatus, [`A\t${MIGRATION}`, 'M\tbackend/prisma/schema.prisma']) && ownHeadMigrationDirs.length === ownBaseMigrationDirs.length + 1 && ownBaseMigrationDirs.every((dir) => ownHeadMigrationDirs.includes(dir)) &&
      ownHeadMigrationDirs[ownHeadMigrationDirs.length - 1].endsWith(MIGRATION_NAME),
    `exactly one migration added (${MIGRATION_NAME}, the newest in its own scope) and the schema extended; all ${ownBaseMigrationDirs.length} applied migrations before it untouched`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma validate, generate and status pass', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'the schema validates and generates; the working database is up to date with every migration (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check(
    'T006',
    'From-empty full replay and checksums pass',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && /PASS {2}the A8\.6 tables are exactly exception_remediation_work_events/.test(replay.output) &&
      /PASS {2}exception_remediation_work_events_insert_guard_trg is present/.test(replay.output) && /PASS {2}one work event per \(intake, sequence\) and one verification per report are unique/.test(replay.output) &&
      /PASS {2}the A8\.6 CHECKs pin A8-REMEDIATION-WORK-1/.test(replay.output) && /PASS {2}exception_remediation_work_events carries exactly its 19 A8\.6 columns/.test(replay.output),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD; every A8.6 CHECK, unique index, trigger, column and RESTRICT key survives`,
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
  const WORK_PERMISSIONS = ['exceptionRemediationWork.read', 'exceptionRemediationWork.record', 'exceptionRemediationWork.verify']
  const knownException = [
    'exceptionIntake.create', 'exceptionIntake.read', 'exceptionTriage.read', 'exceptionTriage.record', 'exceptionInvestigation.read', 'exceptionInvestigation.record', 'exceptionRemediation.propose',
    'exceptionRemediation.review', 'exceptionRemediation.read', ...WORK_PERMISSIONS,
  ]
  check(
    'T007',
    'New permissions/audit scoped; old grants same',
    same(catalogueHead.filter((c) => !catalogueMain.includes(c)).sort(), WORK_PERMISSIONS) && catalogueMain.every((c) => catalogueHead.includes(c)) &&
      same(allCodes.filter((c) => /^exceptionRemediationWork\./.test(c)).sort(), WORK_PERMISSIONS) &&
      (await grantsOf('exceptionRemediationWork.record')) === 'ORG_ADMIN' && (await grantsOf('exceptionRemediationWork.verify')) === 'ORG_ADMIN' && (await grantsOf('exceptionRemediationWork.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('exceptionRemediation.propose')) === 'ORG_ADMIN' && (await grantsOf('exceptionRemediation.review')) === 'ORG_ADMIN' && (await grantsOf('exceptionRemediation.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('exceptionTriage.record')) === 'ORG_ADMIN' && !allCodes.some((c) => /^exception/i.test(c) && !knownException.includes(c) && !laterPermissions.includes(c)) &&
      same(auditHead.filter((c) => !auditMain.includes(c)), ['exception_remediation_work.recorded']) && auditMain.every((c) => auditHead.includes(c)),
    'the catalogue adds exactly exceptionRemediationWork.record and .verify (Admin) and .read (Admin, Viewer); the audit catalogue adds exactly exception_remediation_work.recorded; every earlier grant is unchanged; no execute, resolve, close, escalate or export permission exists',
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
  // B approves home freezes; M1 is the worked scenario's assignee and reporter; RV approves every A8.5 proposal (and,
  // as D7 allows, may verify); VR and VR2 are independent verifiers (Admins, never assigned); M2 is K's former assignee
  // and its assignee again after a concurrent reassignment; M4 owns the other intakes; M5 loses its role while it owns
  // G; NR is a member without any role; O and O2 belong to the other tenant. M1 also holds a second membership in the
  // other tenant (M1X), so the same user through another membership can be tried.
  const B = await provisionMember('b')
  const M1 = await provisionMember('m1')
  const RV = await provisionMember('rv')
  const VR = await provisionMember('vr')
  const VR2 = await provisionMember('vr2')
  const M2 = await provisionMember('m2')
  const M4 = await provisionMember('m4')
  const M5 = await provisionMember('m5')
  const NR = await provisionMember('norole', org, false)
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)
  const M1X = await prisma.organizationMembership.create({ data: { organizationId: otherOrg, userId: M1.id } })
  await prisma.membershipRole.create({ data: { membershipId: M1X.id, roleId: adminRole.id } })

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: two organizations; Claims frozen twice without a link, their A8.1 intakes, A8.2 assignments, A8.3 evidence links and findings and A8.5 proposals approved by an independent reviewer')
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
  // W — the worked scenario and the golden history (report, then EVIDENCE_SUPPORTED). N — the NOT_VERIFIED path, citing
  // an evidence link, verified by the A8.5 approver (D7). L — refusals and the coding-reference report. U — an A8.5
  // proposal awaiting review (approved concurrently later, T075). UR — an A8.5 proposal returned. L0 — kept UNTRIAGED. S —
  // direct SQL (never a committed work event). J — failure injection, retries and unknown outcomes. AT — the atomic commit and the unique collision. R — races. K — the
  // A8.2 interplay (M2 assigned, then M4; reassigned to M2 concurrently later). G — M5's role removal. Q — mixed
  // concurrent operations. F — the other tenant's intake, with its own triage, finding and approved plan.
  const W = await intakeFor('worked')
  const N = await intakeFor('notverified')
  const L = await intakeFor('refusal')
  const U = await intakeFor('unapproved')
  const UR = await intakeFor('returned')
  const L0 = await intakeFor('untriaged')
  const S = await intakeFor('sql')
  const J = await intakeFor('inject')
  const AT = await intakeFor('atomic')
  const R = await intakeFor('race')
  const K = await intakeFor('interplay')
  const G = await intakeFor('revoked')
  const Q = await intakeFor('mixed')
  const F = await intakeFor('foreign', away, O.who)
  const W_CLASSIFY = await triage(W, classify)
  const W_ASSIGN = await triage(W, assignTo(M1))
  for (const k of [N, L, U, UR, S, J, AT, R, Q]) {
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
  const IN = await investigate(N, M4.who, 'EVIDENCE_INCONCLUSIVE')
  const IL = await investigate(L, M4.who, 'EVIDENCE_CONFIRMS_RECORDED_CONFLICT')
  const IU = await investigate(U, M4.who)
  const IUR = await investigate(UR, M4.who)
  const IS = await investigate(S, M4.who)
  const IJ = await investigate(J, M4.who, 'EVIDENCE_INCONCLUSIVE')
  const IAT = await investigate(AT, M4.who)
  const IR = await investigate(R, M4.who)
  const IK = await investigate(K, M4.who)
  const IG = await investigate(G, M5.who)
  const IQ = await investigate(Q, M4.who)
  const IF = await investigate(F, O.who)
  const PW = await planFor(W, IW.findingId, M1.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PN = await planFor(N, IN.findingId, M4.who, 'REVIEW_SOURCE_PROVENANCE')
  const PL = await planFor(L, IL.findingId, M4.who, 'RECHECK_CODING_REFERENCE')
  const PU = await planFor(U, IU.findingId, M4.who, 'REFER_FOR_POLICY_REVIEW', null)
  const PUR = await planFor(UR, IUR.findingId, M4.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', 'RETURN_PROPOSAL')
  const PS = await planFor(S, IS.findingId, M4.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PJ = await planFor(J, IJ.findingId, M4.who, 'REFER_FOR_POLICY_REVIEW')
  const PAT = await planFor(AT, IAT.findingId, M4.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PR = await planFor(R, IR.findingId, M4.who, 'REVIEW_SOURCE_PROVENANCE')
  const PK = await planFor(K, IK.findingId, M4.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PG = await planFor(G, IG.findingId, M5.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK')
  const PQ = await planFor(Q, IQ.findingId, M4.who, 'RECHECK_CODING_REFERENCE')
  const PF = await planFor(F, IF.findingId, O.who, 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', 'APPROVE_PROPOSAL', O2.who)
  const homeIntakes = [W, N, L, U, UR, L0, S, J, AT, R, K, G, Q]
  const runIntakes = [...homeIntakes, F]
  const runClaims = homeIntakes.map((k) => k.claimId)
  progress(
    `fixtures ready: two synthetic AE-DU/DHA worlds; ${homeIntakes.length} A8.1 intakes on contradicted Claims in Org A (basis ${W.basisCode}) and one in Org B; W assigned to M1, K to M4 after M2, G to M5, the others to M4, L0 untriaged; each assigned intake carries an A8.3 basis link and a finding by its assignee and an A8.5 proposal — approved by RV, except U (awaiting review) and UR (returned)`,
  )

  const work = (k: { claimId: string; intakeId: string }, body: unknown, who: Who) => post(`${base(k)}/remediation-work-events`, body, who)
  const historyOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/remediation-work-history`, who)
  const dispositionOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/remediation-work-disposition`, who)
  const triageDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/triage-disposition`)
  const investigationSummaryOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/investigation-summary`)
  const remediationDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/remediation-disposition`)
  const report = (plan: Plan, basisReferenceId: string, basisReferenceKind = 'INVESTIGATION_FINDING', workCode = plan.workCode) => ({ eventCode: 'RECORD_WORK_REPORT', approvedProposalEventId: plan.proposalId, workCode, basisReferenceKind, basisReferenceId })
  const supportedOf = (workReportEventId: string) => ({ eventCode: 'VERIFY_WORK_REPORT', workReportEventId, verificationCode: 'EVIDENCE_SUPPORTED' })
  const notVerifiedOf = (workReportEventId: string, reasonCode = 'SOURCE_MISMATCH') => ({ eventCode: 'VERIFY_WORK_REPORT', workReportEventId, verificationCode: 'EVIDENCE_NOT_VERIFIED', reasonCode })
  const eventsOf = (intakeId: string) => prisma.exceptionRemediationWorkEvent.findMany({ where: { exceptionIntakeId: intakeId }, orderBy: { sequence: 'asc' } })
  const auditsOfEvent = (eventId: string) => prisma.auditEvent.findMany({ where: { entityType: 'EXCEPTION_REMEDIATION_WORK_EVENT', entityId: eventId } })
  const auditsOfIntake = (intakeId: string) => prisma.auditEvent.count({ where: { actionCode: 'exception_remediation_work.recorded', afterState: { path: ['exceptionIntakeId'], equals: intakeId } } })
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
  // One direct event row of intake `k`: by default its valid report — naming the intake's approved plan, its 1:1 work
  // code and its own A8.3 finding — recorded through M4's membership (the assignee of S). A verification defaults to
  // VR's EVIDENCE_SUPPORTED.
  const planOfIntake = new Map<string, Plan>([W, N, L, S, J, AT, R, K, G, Q, F].map((k, i) => [k.intakeId, [PW, PN, PL, PS, PJ, PAT, PR, PK, PG, PQ, PF][i]]))
  const findingOfIntake = new Map<string, string>([W, N, L, U, UR, S, J, AT, R, K, G, Q, F].map((k, i) => [k.intakeId, [IW, IN, IL, IU, IUR, IS, IJ, IAT, IR, IK, IG, IQ, IF][i].findingId]))
  const rowOf = (k: Intake, o: Row = {}): Row => ({
    id: randomUUID(), exception_intake_id: k.intakeId, organization_id: k.organizationId, claim_id: k.claimId, contract_version: CONTRACT, sequence: 1, event_code: 'RECORD_WORK_REPORT',
    approved_proposal_event_id: planOfIntake.get(k.intakeId)?.proposalId ?? MISSING, work_code: planOfIntake.get(k.intakeId)?.workCode ?? 'DOCUMENTATION_CHECK_REPORTED', basis_reference_kind: 'INVESTIGATION_FINDING',
    basis_reference_id: findingOfIntake.get(k.intakeId) ?? MISSING, basis_reference_contract_version: BASIS_CONTRACT, work_report_event_id: null, verification_code: null, reason_code: null,
    recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id, recorded_at: null, ...o,
  })
  const verifyRow = (k: Intake, sequence: number, reportId: string, o: Row = {}) =>
    rowOf(k, {
      sequence, event_code: 'VERIFY_WORK_REPORT', work_code: null, basis_reference_kind: null, basis_reference_id: null, basis_reference_contract_version: null, work_report_event_id: reportId,
      verification_code: 'EVIDENCE_SUPPORTED', reason_code: null, recorded_by_membership_id: VR.membershipId, recorded_by_user_id: VR.id, ...o,
    })
  const insertRow = (tx: DbClient, row: Row) =>
    row.recorded_at === null
      ? tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, approved_proposal_event_id, work_code, basis_reference_kind, basis_reference_id, basis_reference_contract_version, work_report_event_id, verification_code, reason_code, recorded_by_membership_id, recorded_by_user_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8::uuid, $9, $10, $11::uuid, $12, $13::uuid, $14, $15, $16::uuid, $17::uuid)`,
          row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.approved_proposal_event_id, row.work_code, row.basis_reference_kind,
          row.basis_reference_id, row.basis_reference_contract_version, row.work_report_event_id, row.verification_code, row.reason_code, row.recorded_by_membership_id, row.recorded_by_user_id,
        )
      : tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, approved_proposal_event_id, work_code, basis_reference_kind, basis_reference_id, basis_reference_contract_version, work_report_event_id, verification_code, reason_code, recorded_by_membership_id, recorded_by_user_id, recorded_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8::uuid, $9, $10, $11::uuid, $12, $13::uuid, $14, $15, $16::uuid, $17::uuid, $18::timestamptz, $18::timestamptz)`,
          row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.approved_proposal_event_id, row.work_code, row.basis_reference_kind,
          row.basis_reference_id, row.basis_reference_contract_version, row.work_report_event_id, row.verification_code, row.reason_code, row.recorded_by_membership_id, row.recorded_by_user_id, row.recorded_at,
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
      return { history: await getWorkHistoryOf(k.claimId, k.intakeId, tx), disposition: await getWorkDispositionOf(k.claimId, k.intakeId, tx) }
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
  // Every A8.2 triage event and A8.5 remediation event that exists before the first work write: A8.6 must never change
  // one of them (U's A8.5 approval later in T075 is A8.5's own new event, judged there).
  const triageIdsBefore = (await prisma.exceptionTriageEvent.findMany({ where: { exceptionIntakeId: { in: runIntakes.map((k) => k.intakeId) } }, select: { id: true } })).map((row) => row.id)
  const triageHash = () => hashOf(`SELECT t.* FROM ${TRIAGE_TABLE} t WHERE t.id = ANY($1::uuid[])`, triageIdsBefore)
  const triageHashBefore = await triageHash()
  const remediationIdsBefore = (await prisma.exceptionRemediationEvent.findMany({ where: { exceptionIntakeId: { in: runIntakes.map((k) => k.intakeId) } }, select: { id: true } })).map((row) => row.id)
  const remediationHash = () => hashOf(`SELECT r.* FROM ${REMEDIATION_TABLE} r WHERE r.id = ANY($1::uuid[])`, remediationIdsBefore)
  const remediationHashBefore = await remediationHash()
  const wTriageBefore = withoutEvaluatedAt((await triageDispositionOf(W)).body)
  const wInvestigationBefore = withoutEvaluatedAt((await investigationSummaryOf(W)).body)
  const wRemediationBefore = withoutEvaluatedAt((await remediationDispositionOf(W)).body)
  const wIntakesBefore = withoutEvaluatedAt((await get(`/api/claims/${W.claimId}/exception-intake`)).body)

  // ---------------------------------------------------------------- wiring and scope (T008–T010)
  const routeCode = committedCode(`${MODULE_DIR}/exception-remediation-work.route.ts`)
  const missingClaim = { claimId: MISSING, intakeId: W.intakeId }
  const wiring = [await work(missingClaim, report(PW, IW.findingId), M1.who), await historyOf(missingClaim), await dispositionOf(missingClaim)]
  const absent = [
    await api('PATCH', `${base(W)}/remediation-work-events`, {}), await api('PUT', `${base(W)}/remediation-work-events`, {}), await api('DELETE', `${base(W)}/remediation-work-events`),
    await get(`${base(W)}/remediation-work-events`), await get(`${base(W)}/remediation-work-events/${MISSING}`), await api('PUT', `${base(W)}/remediation-work-disposition`, {}),
    await post(`${base(W)}/remediation-work-disposition`, {}), await post(`${base(W)}/remediation-work-history`, {}), await post(`${base(W)}/remediation-work-execute`, {}), await post(`${base(W)}/execute`, {}),
    await post(`${base(W)}/verify`, {}), await post(`${base(W)}/resolve`, {}), await post(`${base(W)}/close`, {}), await get(`${base(W)}/remediation-work-current`), await get('/api/remediation-work-events'),
    await get('/api/exception-remediation-work'), await get(`/api/claims/${W.claimId}/remediation-work`), await get(`${base(W)}/remediation-work-queue`), await get(`${base(W)}/remediation-work-export`),
  ]
  check(
    'T008',
    'Exactly 3 routes; no execution/closure/queue',
    wiring.every((r) => r.status === 404 && errorCode(r.body) === 'NOT_FOUND') && absent.every((r) => r.status === 404) &&
      (routeCode.match(/exceptionRemediationWorkRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 3 && /exceptionRemediationWorkRouter\.post\(`\$\{BASE\}\/remediation-work-events`/.test(routeCode) &&
      /exceptionRemediationWorkRouter\.get\(`\$\{BASE\}\/remediation-work-history`/.test(routeCode) && /exceptionRemediationWorkRouter\.get\(`\$\{BASE\}\/remediation-work-disposition`/.test(routeCode) &&
      /const BASE = '\/:claimId\/exceptions\/:exceptionIntakeId'/.test(routeCode),
    `the POST and both GETs answer a missing Claim with a privacy-safe 404; PATCH/PUT/DELETE, an event by id, a current selector, execute, verify, resolve, close, queue and export routes, a collection and cross-Claim searches are absent (${absent.map((r) => r.status).join('/')})`,
  )
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
    'T009',
    'All A1–A8.5 and CRG contracts unchanged',
    contractsOwn.length >= 22 && same(contractsOwn, contractConstantsAt(ownBase)) && productDiff.length === 0 && ownEarlierSuites.length === 0 && ownEarlierUnits.length === 0 &&
      ownPrismaStatus.every((s) => !/^M\tbackend\/prisma\/migrations\//.test(s)) && committedText(`${MODULE_DIR}/exception-remediation-work.types.ts`).includes(`WORK_CONTRACT_VERSION = '${CONTRACT}'`) &&
      errorsBase.every((c) => errorsOwn.includes(c)) &&
      same(errorsOwn.filter((c) => !errorsBase.includes(c)), [
        'EXCEPTION_REMEDIATION_WORK_NOT_ASSIGNEE', 'EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT', 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED', 'EXCEPTION_REMEDIATION_WORK_CONFLICT', 'UNSUPPORTED_EVIDENCE_KIND',
      ]),
    `all ${contractsOwn.length} A1–A8.5 and CRG owner contract literals identical to main; no earlier module's code, integration suite, unit test or applied migration changed; the error catalogue only gains the five A8.6 codes`,
  )
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${FE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file))
  const earlierSuites = changedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`))
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a9|dhpo|eclaimlink|coding-release|coding-validation|crg|resolution|escalat|export|queue|\bsla\b|execut/i.test(file))
  check(
    'T010',
    'Diff allowlist A8.6 only; no A9/CRG-B change',
    changedPaths.length > 0 && outOfScope.length === 0 && earlierSuites.length === 0 && laterDomain.length === 0,
    outOfScope.length + earlierSuites.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A8.6 module, page, harness, migration and register and the narrow shared additions; no earlier suite changed; no CRG, execution, resolution, queue, export or A9 domain`
      : `unexpected: ${[...new Set([...outOfScope, ...earlierSuites, ...laterDomain])].join(', ').slice(0, 300)}`,
  )

  // ---------------------------------------------------------------- DTO and protocol (T011–T020)
  section('DTO and protocol on W: the v1 literal on rows and DTOs, strict report and verification keys, server-owned fields, malformed ids, uncontrolled codes, the conditional reason, the evidence contract, injection and free text')
  const countsAtStart = await counts()
  const noWorkW = { disposition: await dispositionOf(W), history: await historyOf(W), rows: (await eventsOf(W.intakeId)).length }
  const noWorkU = (await dispositionOf(U)).body
  const RW1 = await work(W, report(PW, IW.findingId), M1.who)
  const RW1_ID = (RW1.body?.workEventId ?? MISSING) as string
  const countsAfterRW1 = await counts()
  const rw1HashBefore = await rowHash(RW1_ID)
  const contractDef = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${TABLE}_contract_chk'`))[0]?.d ?? ''
  const rw1Row = (await eventsOf(W.intakeId))[0]
  const historyRW1 = await historyOf(W)
  const dispositionRW1 = await dispositionOf(W)
  check(
    'T011',
    'Contract literal pinned on rows and DTOs',
    RW1.status === 201 && RW1.body.contractVersion === CONTRACT && WORK_CONTRACT_VERSION === CONTRACT && rw1Row?.contractVersion === CONTRACT && same(Object.keys(RW1.body), EVENT_KEYS) &&
      same(Object.keys(historyRW1.body), HISTORY_KEYS) && same(Object.keys(dispositionRW1.body), DISPOSITION_KEYS) && same(Object.keys(dispositionRW1.body.report ?? {}), REPORT_KEYS) &&
      historyRW1.body.contractVersion === CONTRACT && dispositionRW1.body.contractVersion === CONTRACT && contractDef.includes(`'${CONTRACT}'`) && /IS NOT NULL/.test(contractDef),
    `W's report carries ${CONTRACT} on its stored row and in exactly the ${EVENT_KEYS.length} event keys; the history, the disposition and its report carry exactly theirs; the database CHECK pins the literal`,
  )
  const wRows = async () => (await eventsOf(W.intakeId)).length
  const isValidation = (r: { status: number; body: any }) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR'
  const missingReportKeys = await Promise.all(
    ['approvedProposalEventId', 'workCode', 'basisReferenceKind', 'basisReferenceId'].map((field) => {
      const body: Record<string, unknown> = { ...report(PW, IW.findingId) }
      delete body[field]
      return work(W, body, M1.who)
    }),
  )
  const extraReportKeys = await Promise.all(
    [{ workReportEventId: RW1_ID }, { verificationCode: 'EVIDENCE_SUPPORTED' }, { reasonCode: 'SOURCE_MISSING' }, { extra: 1 }].map((extra) => work(W, { ...report(PW, IW.linkId, 'INVESTIGATION_EVIDENCE_LINK'), ...extra }, M1.who)),
  )
  const oddBodies = [await work(W, [report(PW, IW.findingId)], M1.who), await work(W, {}, M1.who), await work(W, 7, M1.who), await work(W, 'RECORD_WORK_REPORT', M1.who), await work(W, null, M1.who)]
  const nullService = await recordWorkEvent(W.claimId, W.intakeId, null, M1.id)
  check(
    'T012',
    'Report keys exact; missing or extra key 400',
    missingReportKeys.every((r) => isValidation(r) && /missing field/.test(errorMessage(r.body))) && extraReportKeys.every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) &&
      oddBodies.every((r) => r.status === 400 && !rawError(r.body)) && nullService.ok === false && nullService.code === 'VALIDATION_ERROR' && (await wRows()) === 1,
    `a report without its plan, work code, evidence kind or evidence record is a 400 (missing field); with a verification field or an unknown property a 400 (unsupported field); an array, empty, numeric, string or null body is a 400 (${oddBodies.map((r) => r.status).join('/')}) and the service itself refuses null; nothing recorded`,
  )
  const strictVerify = [
    await work(W, { ...supportedOf(RW1_ID), reasonCode: 'SOURCE_MISSING' }, VR.who), await work(W, { ...supportedOf(RW1_ID), reasonCode: null }, VR.who),
    await work(W, { eventCode: 'VERIFY_WORK_REPORT', workReportEventId: RW1_ID, verificationCode: 'EVIDENCE_NOT_VERIFIED' }, VR.who), await work(W, { ...notVerifiedOf(RW1_ID), reasonCode: null }, VR.who),
    await work(W, { ...supportedOf(RW1_ID), approvedProposalEventId: PW.proposalId }, VR.who), await work(W, { ...supportedOf(RW1_ID), workCode: 'DOCUMENTATION_CHECK_REPORTED' }, VR.who),
    await work(W, { ...supportedOf(RW1_ID), basisReferenceId: IW.findingId }, VR.who), await work(W, { eventCode: 'VERIFY_WORK_REPORT', verificationCode: 'EVIDENCE_SUPPORTED' }, VR.who),
  ]
  check(
    'T013',
    'Verification keys exact; reason conditional',
    strictVerify.every(isValidation) && /unsupported field/.test(errorMessage(strictVerify[0].body)) && /unsupported field/.test(errorMessage(strictVerify[1].body)) && /missing field/.test(errorMessage(strictVerify[2].body)) &&
      /controlled reason code/.test(errorMessage(strictVerify[3].body)) && (await wRows()) === 1,
    'a supported verification carrying any reason field (even null), a not-verified one without a reason or with a null one, one naming a plan, work code or evidence record, and one without its report are each a 400; nothing recorded',
  )
  const serverOwned = await Promise.all(
    ['id', 'workEventId', 'sequence', 'organizationId', 'claimId', 'exceptionIntakeId', 'recordedByUserId', 'recordedByMembershipId', 'actorUserId', 'recordedAt', 'createdAt', 'contractVersion', 'state', 'status', 'outcome'].map((k) =>
      work(W, { ...report(PW, IW.linkId, 'INVESTIGATION_EVIDENCE_LINK'), [k]: k === 'sequence' ? 2 : k === 'recordedAt' || k === 'createdAt' ? '2020-01-01T00:00:00.000Z' : k === 'contractVersion' ? CONTRACT : k === 'state' ? 'VERIFIED_INTERNAL_WORK' : k === 'status' || k === 'outcome' ? 'RESOLVED' : MISSING }, M1.who),
    ),
  )
  const queried = await post(`${base(W)}/remediation-work-events?sequence=2`, report(PW, IW.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M1.who)
  check(
    'T014',
    'Server-owned actor/tenant/time/number refused',
    serverOwned.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && queried.status === 400 && (await wRows()) === 1,
    'an id, sequence, organization, Claim, intake, actor, membership, time, contract, state, status or outcome in the body, or a query parameter, is refused (400): the server owns them',
  )
  const badIds = ['not-a-uuid', MISSING.replace(/-/g, ''), `${MISSING}0`, encodeURIComponent("1' OR '1'='1")]
  const malformedClaim = [
    ...(await Promise.all(badIds.map((id) => work({ claimId: id, intakeId: W.intakeId }, report(PW, IW.findingId), M1.who)))),
    ...(await Promise.all(badIds.map((id) => historyOf({ claimId: id, intakeId: W.intakeId })))),
    ...(await Promise.all(badIds.map((id) => dispositionOf({ claimId: id, intakeId: W.intakeId })))),
  ]
  const malformedIntake = [
    ...(await Promise.all(badIds.map((id) => work({ claimId: W.claimId, intakeId: id }, report(PW, IW.findingId), M1.who)))),
    ...(await Promise.all(badIds.map((id) => historyOf({ claimId: W.claimId, intakeId: id })))),
    ...(await Promise.all(badIds.map((id) => dispositionOf({ claimId: W.claimId, intakeId: id })))),
  ]
  const malformedPlan = await Promise.all(['not-a-uuid', `${MISSING}0`, MISSING.replace(/-/g, '')].map((id) => work(W, { ...report(PW, IW.findingId), approvedProposalEventId: id }, M1.who)))
  check(
    'T015',
    'Malformed Claim/intake/proposal id safe 400',
    malformedClaim.every((r) => r.status === 400 && /invalid claim id/.test(errorMessage(r.body)) && !rawError(r.body)) && malformedIntake.every((r) => r.status === 400 && /invalid exception intake id/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      malformedPlan.every((r) => r.status === 400 && /invalid approved proposal event id/.test(errorMessage(r.body)) && !rawError(r.body)) && (await wRows()) === 1,
    'malformed and SQL-shaped Claim and intake ids on all three routes, and malformed approved-proposal ids, are each a safe 400; nothing recorded',
  )
  const malformedEvidence = await Promise.all(['not-a-uuid', `${MISSING}0`, MISSING.replace(/-/g, '')].map((id) => work(W, report(PW, id), M1.who)))
  const malformedReport = await Promise.all(['not-a-uuid', `${MISSING}0`].map((id) => work(W, supportedOf(id), VR.who)))
  check(
    'T016',
    'Malformed evidence/report id safe 400',
    malformedEvidence.every((r) => r.status === 400 && /invalid evidence record id/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      malformedReport.every((r) => r.status === 400 && /invalid work report event id/.test(errorMessage(r.body)) && !rawError(r.body)) && (await wRows()) === 1,
    'malformed evidence record ids and malformed work report ids are each a safe 400; nothing recorded',
  )
  const unknownEvents = await Promise.all(['RESOLVE_EXCEPTION', 'EXECUTE_ACTION', 'CLOSE_EXCEPTION', 'record_work_report', '', null, 7].map((eventCode) => work(W, { ...report(PW, IW.findingId), eventCode }, M1.who)))
  check('T017', 'Uncontrolled event code refused', unknownEvents.every((r) => r.status === 400 && /unknown remediation work event code/.test(errorMessage(r.body)) && !rawError(r.body)) && (await wRows()) === 1, `only ${workEventCodes.join(', ')} are accepted`)
  const unknownWork = await Promise.all(['CLAIM_CORRECTED', 'EXCEPTION_RESOLVED', 'documentation_check_reported', '', null].map((code) => work(W, { ...report(PW, IW.findingId), workCode: code }, M1.who)))
  const unsupportedKinds = await Promise.all(['ATTACHMENT', 'A7_CASE_ASSESSMENT', 'INTAKE_BASIS', 'PAYER_LETTER', 'investigation_finding'].map((kind) => work(W, report(PW, IW.findingId, kind), M1.who)))
  const nonStringKind = await work(W, { ...report(PW, IW.findingId), basisReferenceKind: 7 }, M1.who)
  const unknownVerification = await Promise.all(['RESOLVED', 'PAID', 'evidence_supported', '', null].map((code) => work(W, { eventCode: 'VERIFY_WORK_REPORT', workReportEventId: RW1_ID, verificationCode: code }, VR.who)))
  check(
    'T018',
    'Uncontrolled work/evidence/verification code',
    unknownWork.every((r) => isValidation(r) && /unknown work code/.test(errorMessage(r.body))) && unsupportedKinds.every((r) => r.status === 400 && errorCode(r.body) === 'UNSUPPORTED_EVIDENCE_KIND' && !rawError(r.body)) &&
      isValidation(nonStringKind) && unknownVerification.every((r) => isValidation(r) && /unknown verification code/.test(errorMessage(r.body))) && (await wRows()) === 1,
    `only the work codes ${workCodes.join(', ')}, the evidence kinds ${basisReferenceKinds.join(', ')} (any other kind is 400 UNSUPPORTED_EVIDENCE_KIND) and the verification codes ${verificationCodes.join(', ')} are accepted`,
  )
  const unknownReasons = await Promise.all(['BECAUSE', 'PAYER_DENIED', 'source_missing', ''].map((code) => work(W, notVerifiedOf(RW1_ID, code), VR.who)))
  const ownerContract = await Promise.all([BASIS_CONTRACT, 'A8-EXCEPTION-INVESTIGATION-2', PLAN_CONTRACT].map((contract) => work(W, { ...report(PW, IW.findingId), basisReferenceContractVersion: contract }, M1.who)))
  check(
    'T019',
    'Unknown reason or ref-owner contract refused',
    unknownReasons.every((r) => isValidation(r) && /controlled reason code/.test(errorMessage(r.body))) && ownerContract.every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) && (await wRows()) === 1,
    `the reasons are only ${verificationReasonCodes.join(', ')}; the evidence owner's contract is the server's (${BASIS_CONTRACT}, stored on the row) and naming any contract in the body is a 400`,
  )
  const injection = [
    await work(W, report(PW, "1' OR '1'='1"), M1.who), await work(W, { ...report(PW, IW.findingId), basisReferenceId: { $ne: null } }, M1.who),
    await work(W, { ...report(PW, IW.findingId), workCode: "DOCUMENTATION_CHECK_REPORTED'; DROP TABLE claims; --" }, M1.who), await work(W, { ...report(PW, IW.findingId), basisReferenceKind: '../INVESTIGATION_FINDING' }, M1.who),
    await work(W, JSON.parse(`{"__proto__": {"eventCode": "RECORD_WORK_REPORT"}, "approvedProposalEventId": "${PW.proposalId}", "workCode": "DOCUMENTATION_CHECK_REPORTED", "basisReferenceKind": "INVESTIGATION_FINDING", "basisReferenceId": "${IW.findingId}"}`), M1.who),
    await work(W, JSON.parse(`{"eventCode": "RECORD_WORK_REPORT", "approvedProposalEventId": "${PW.proposalId}", "workCode": "DOCUMENTATION_CHECK_REPORTED", "basisReferenceKind": "INVESTIGATION_FINDING", "basisReferenceId": "${IW.findingId}", "constructor": {"prototype": {"admin": true}}}`), M1.who),
  ]
  const freeText = await Promise.all(
    [
      { note: 'free text' }, { narrative: 'free text' }, { comment: 'free text' }, { description: 'free text' }, { patientName: `${runId}-home-P` }, { diagnosisCode: key('home-DXA') },
      { amount: '125.25' }, { currencyCode: 'AED' }, { url: 'https://example.invalid/evidence' }, { attachment: 'c3ludGhldGlj' }, { payload: { a: 1 } }, { payerId: MISSING },
    ].map((extra) => work(W, { ...report(PW, IW.linkId, 'INVESTIGATION_EVIDENCE_LINK'), ...extra }, M1.who)),
  )
  check(
    'T020',
    'PHI, free text, injection or amount refused',
    injection.every((r) => r.status === 400 && !rawError(r.body)) && freeText.every((r) => r.status === 400 && /unsupported field/.test(errorMessage(r.body))) && (await wRows()) === 1 &&
      (await unchanged(plus(countsAtStart, 1))),
    "SQL-, operator-, traversal- and prototype-shaped values, and a note, narrative, comment, description, patient name, diagnosis, amount, currency, URL, attachment, payload or payer are refused with a safe 400; only W's one valid report and its audit exist",
  )

  // ---------------------------------------------------------------- permission and ownership (T021–T030)
  section('Permission and ownership: 401 before lookup, Viewer and role-less 403, the current assignee reports from the session, non-assignees and stale assignees refused, foreign Claim, intake, plan and evidence = missing, the verifier independent and authorized now')
  const anonPost = [await work(W, report(PW, IW.linkId, 'INVESTIGATION_EVIDENCE_LINK'), anonymous), await work({ claimId: MISSING, intakeId: MISSING }, report(PW, IW.findingId), anonymous)]
  check('T021', 'Anonymous POST 401 before owner lookup', anonPost.every((r) => r.status === 401) && (await wRows()) === 1, 'no session: 401 on W and on a missing Claim alike (the lookup never ran)')
  const anonGet = [await historyOf(W, anonymous), await dispositionOf(W, anonymous), await historyOf({ claimId: MISSING, intakeId: MISSING }, anonymous), await dispositionOf({ claimId: MISSING, intakeId: MISSING }, anonymous)]
  check('T022', 'Anonymous GET 401 before owner lookup', anonGet.every((r) => r.status === 401), 'no session: 401 on the history and the disposition of W and of a missing Claim')
  const noPermission = [
    await work(W, report(PW, IW.linkId, 'INVESTIGATION_EVIDENCE_LINK'), asViewer), await work(W, supportedOf(RW1_ID), asViewer), await work(W, report(PW, IW.linkId, 'INVESTIGATION_EVIDENCE_LINK'), NR.who),
    await work(W, notVerifiedOf(RW1_ID), NR.who),
  ]
  check('T023', 'Viewer cannot report or verify: 403', noPermission.every((r) => r.status === 403) && (await wRows()) === 1, 'a Viewer (exceptionRemediationWork.read only) and a member without any role are refused 403 on a report and on a verification; nothing recorded')
  check(
    'T024',
    'Authorized current assignee report: 201',
    RW1.status === 201 && RW1.body.recordedByMembershipId === M1.membershipId && RW1.body.recordedByUserId === M1.id && RW1.body.claimId === W.claimId && RW1.body.organizationId === org &&
      RW1.body.exceptionIntakeId === W.intakeId && RW1.body.sequence === 1 && RW1.body.eventCode === 'RECORD_WORK_REPORT' && RW1.body.approvedProposalEventId === PW.proposalId &&
      RW1.body.workCode === 'DOCUMENTATION_CHECK_REPORTED' && RW1.body.basisReferenceKind === 'INVESTIGATION_FINDING' && RW1.body.basisReferenceId === IW.findingId && RW1.body.basisReferenceContractVersion === BASIS_CONTRACT,
    "M1, to whom A8.2 assigned W, reports (201) as itself through its own membership, numbered 1, against W's approved proposal with its 1:1 work code, citing M1's A8.3 finding under the A8.3 contract",
  )
  const notAssignee = [
    await work(N, report(PN, IN.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M1.who), await work(N, report(PN, IN.linkId, 'INVESTIGATION_EVIDENCE_LINK'), VR.who), await work(N, report(PN, IN.linkId, 'INVESTIGATION_EVIDENCE_LINK'), asAdmin),
    await work(L0, report(PW, IW.findingId), M4.who), await work(L0, report(PW, IW.findingId), asAdmin), await work(K, report(PK, IK.findingId), M2.who),
  ]
  check(
    'T025',
    'Non-assignee and stale assignee: 409',
    notAssignee.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_WORK_NOT_ASSIGNEE' && !rawError(r.body)) && (await eventsOf(N.intakeId)).length === 0 &&
      (await eventsOf(L0.intakeId)).length === 0 && (await eventsOf(K.intakeId)).length === 0,
    "M1, a verifier and the harness's Admin on N (assigned to M4), M4 and the Admin on the UNTRIAGED L0, and M2 on K (reassigned from M2 to M4: a stale assignee) are each refused 409 NOT_ASSIGNEE; nothing recorded",
  )
  const sameOrgReads = [await historyOf(W), await dispositionOf(W), await historyOf(W, asViewer), await dispositionOf(W, asViewer), await historyOf(W, VR.who), await dispositionOf(N, asViewer)]
  check(
    'T026',
    'Same organization authorized reads 200',
    sameOrgReads.every((r) => r.status === 200 && r.body.contractVersion === CONTRACT) && sameOrgReads[0].body.items.length === 1 && sameOrgReads[1].body.state === 'AWAITING_VERIFICATION',
    "the Admin, a Viewer and another member of Org A read W's history and disposition (and N's) with 200; W holds its one report, awaiting verification",
  )
  const missingEnvelope = (r: { body: any }) => ({ ...r.body?.error, requestId: null })
  const foreignClaim = [await work(F, report(PF, IF.findingId), asAdmin), await historyOf(F), await dispositionOf(F)]
  const missingClaimReads = [await work({ claimId: MISSING, intakeId: F.intakeId }, report(PF, IF.findingId), asAdmin), await historyOf({ claimId: MISSING, intakeId: F.intakeId }), await dispositionOf({ claimId: MISSING, intakeId: F.intakeId })]
  check(
    'T027',
    'Foreign Claim indistinguishable from missing',
    foreignClaim.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingClaimReads[i]))) && (await eventsOf(F.intakeId)).length === 0,
    "another organization's Claim and intake get exactly the missing-Claim envelope on all three routes; nothing recorded",
  )
  const foreignIntake = [await work({ claimId: W.claimId, intakeId: F.intakeId }, report(PW, IW.findingId), M1.who), await historyOf({ claimId: W.claimId, intakeId: F.intakeId }), await dispositionOf({ claimId: W.claimId, intakeId: F.intakeId })]
  const otherClaimIntake = [await work({ claimId: W.claimId, intakeId: N.intakeId }, report(PN, IN.findingId), M4.who), await historyOf({ claimId: W.claimId, intakeId: N.intakeId })]
  const missingIntake = [await work({ claimId: W.claimId, intakeId: MISSING }, report(PW, IW.findingId), M1.who), await historyOf({ claimId: W.claimId, intakeId: MISSING }), await dispositionOf({ claimId: W.claimId, intakeId: MISSING })]
  check(
    'T028',
    'Foreign intake indistinguishable from missing',
    foreignIntake.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[i]))) && otherClaimIntake.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[0]))) &&
      (await eventsOf(N.intakeId)).length === 0,
    "another tenant's intake, or another Claim's intake of this tenant, named under W's Claim is exactly the missing-intake 404; nothing recorded",
  )
  const missingPlan = await work(N, report({ ...PN, proposalId: MISSING }, IN.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who)
  const foreignPlan = await work(N, report({ ...PN, proposalId: PF.proposalId }, IN.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who)
  const missingEvidence = await work(N, report(PN, MISSING, 'INVESTIGATION_EVIDENCE_LINK'), M4.who)
  const foreignEvidence = [await work(N, report(PN, IF.findingId), M4.who), await work(N, report(PN, IF.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who)]
  check(
    'T029',
    'Foreign plan/evidence indistinguishable',
    missingPlan.status === 404 && foreignPlan.status === 404 && same(missingEnvelope(foreignPlan), missingEnvelope(missingPlan)) && !JSON.stringify(foreignPlan.body).includes(PF.proposalId) &&
      missingEvidence.status === 404 && foreignEvidence.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingEvidence)) && !JSON.stringify(r.body).includes(IF.findingId) && !rawError(r.body)) &&
      (await eventsOf(N.intakeId)).length === 0,
    "on N, the other tenant's approved A8.5 proposal is exactly the missing-plan 404, and its A8.3 finding and link are exactly the missing-evidence 404 — the body names nothing of the other tenant; nothing recorded",
  )
  const selfRW1 = await work(W, supportedOf(RW1_ID), M1.who)
  const verifierWithoutRole = [await recordWorkEvent(W.claimId, W.intakeId, supportedOf(RW1_ID), NR.id), await recordWorkEvent(W.claimId, W.intakeId, supportedOf(RW1_ID), viewerUser.id)]
  const selfService = await recordWorkEvent(W.claimId, W.intakeId, supportedOf(RW1_ID), M1.id)
  check(
    'T030',
    'Verifier independent by user AND membership',
    selfRW1.status === 409 && errorCode(selfRW1.body) === 'EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT' && selfService.ok === false && selfService.code === 'EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT' &&
      verifierWithoutRole.every((r) => r.ok === false && r.code === 'EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT') && noPermission[3].status === 403 && (await wRows()) === 1,
    "M1 verifying its own report is refused 409 through the route and the service; a role-less member is refused 403 at the route, and the service itself refuses (409) a verifier without the verify permission now — the role-less member and the Viewer; the same user through another membership is refused by the guard and the reducer (T046); nothing recorded",
  )

  // ---------------------------------------------------------------- owner basis and report (T031–T040)
  section('Owner basis and report: NO_WORK_REPORT is zero rows, only an approved A8.5 proposal of exactly this intake, A8.3 evidence of exactly this intake under its kind, the 1:1 work code, one event and one audit, a second or duplicate report')
  check(
    'T031',
    'Zero rows yields NO_WORK_REPORT',
    noWorkW.rows === 0 && noWorkW.disposition.status === 200 && noWorkW.disposition.body.state === 'NO_WORK_REPORT' && noWorkW.disposition.body.eventCount === 0 && noWorkW.disposition.body.lastSequence === null &&
      noWorkW.disposition.body.report === null && noWorkW.disposition.body.verification === null && noWorkW.disposition.body.approvedProposalEventId === PW.proposalId && same(noWorkW.history.body.items, []) &&
      noWorkU.state === 'NO_WORK_REPORT' && noWorkU.approvedProposalEventId === null && !COLUMNS.some((c) => /state|status|current|latest/.test(c)),
    "before any event W has zero rows and derives NO_WORK_REPORT naming its approved proposal (completion is never inferred from the approval); U, whose proposal awaits review, derives NO_WORK_REPORT with no plan; the table has no state, status, current or latest column",
  )
  const unapproved = [await work(U, report({ ...PU, workCode: 'POLICY_REVIEW_REFERRED' }, IU.findingId), M4.who), await work(UR, report({ ...PUR, workCode: 'DOCUMENTATION_CHECK_REPORTED' }, IUR.findingId), M4.who)]
  check(
    'T032',
    'Unapproved or returned proposal supports nothing',
    unapproved.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED' && /not the approved proposal of this exception/.test(errorMessage(r.body))) &&
      (await eventsOf(U.intakeId)).length === 0 && (await eventsOf(UR.intakeId)).length === 0,
    "U's proposal awaiting A8.5 review and UR's returned proposal are each refused 409 as a report's plan; nothing recorded",
  )
  const otherIntakePlan = [await work(N, report({ ...PW, workCode: 'SOURCE_PROVENANCE_REVIEWED' }, IN.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who), await work(N, report({ ...PL, workCode: 'SOURCE_PROVENANCE_REVIEWED' }, IN.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who)]
  const planJoin = (await prisma.$queryRawUnsafe<{ code: string; ok: boolean; approved: boolean }[]>(
    `SELECT p.event_code AS code, (p.exception_intake_id = e.exception_intake_id AND p.claim_id = e.claim_id AND p.organization_id = e.organization_id) AS ok,
            EXISTS (SELECT 1 FROM ${REMEDIATION_TABLE} r WHERE r.proposal_event_id = p.id AND r.decision_code = 'APPROVE_PROPOSAL') AS approved
     FROM ${TABLE} e JOIN ${REMEDIATION_TABLE} p ON p.id = e.approved_proposal_event_id WHERE e.id = $1::uuid`,
    RW1_ID,
  ))[0]
  check(
    'T033',
    'Approved proposal scoped to exact intake/Claim',
    otherIntakePlan.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingPlan))) && planJoin?.code === 'PROPOSE_ACTION' && planJoin.ok === true && planJoin.approved === true &&
      PW.statuses.every((s) => s === 201) && (await eventsOf(N.intakeId)).length === 0,
    "W's and L's approved proposals named on N are exactly the missing-plan 404; W's stored report joins its own approved A8.5 PROPOSE_ACTION of the same intake, Claim and organization",
  )
  const notEvidence = [await work(N, report(PN, PN.proposalId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who), await work(N, report(PN, W_ASSIGN.triageEventId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who), await work(N, report(PN, N.intakeId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who)]
  const evidenceJoin = (await prisma.$queryRawUnsafe<{ code: string; ok: boolean }[]>(
    `SELECT f.event_code AS code, (f.exception_intake_id = e.exception_intake_id AND f.claim_id = e.claim_id AND f.organization_id = e.organization_id) AS ok FROM ${TABLE} e JOIN ${INVESTIGATION_TABLE} f ON f.id = e.basis_reference_id WHERE e.id = $1::uuid`,
    RW1_ID,
  ))[0]
  check(
    'T034',
    'A8.3 evidence must exist under approved kind',
    missingEvidence.status === 404 && notEvidence.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingEvidence))) && evidenceJoin?.code === 'RECORD_FINDING' && evidenceJoin.ok === true &&
      IW.statuses.every((s) => s === 201) && (await eventsOf(N.intakeId)).length === 0,
    "a missing record, an A8.5 event, an A8.2 event and the intake itself named as evidence are each the missing-evidence 404; W's stored report joins M1's A8.3 RECORD_FINDING of the same intake, Claim and organization",
  )
  const otherClaimEvidence = [await work(N, report(PN, IL.findingId), M4.who), await work(N, report(PN, IL.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who)]
  check(
    'T035',
    'Same-tenant other Claim reference refused',
    otherClaimEvidence.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingEvidence))) && (await eventsOf(N.intakeId)).length === 0,
    "L's A8.3 finding and link (same organization, another Claim and intake) named on N are the missing-evidence 404; the database guard refuses them as direct rows (T056)",
  )
  const wrongKind = [await work(N, report(PN, IN.linkId, 'INVESTIGATION_FINDING'), M4.who), await work(N, report(PN, IN.findingId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who)]
  check(
    'T036',
    'Link vs finding reference shape enforced',
    wrongKind.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED' && /is not of the kind/.test(errorMessage(r.body))) && (await eventsOf(N.intakeId)).length === 0,
    "on N, M4's own A8.3 evidence link cited as an INVESTIGATION_FINDING, and its own finding cited as an INVESTIGATION_EVIDENCE_LINK, are each refused 409; nothing recorded",
  )
  const wrongWorkCodes = await Promise.all(['DOCUMENTATION_CHECK_REPORTED', 'CODING_REFERENCE_REVIEW_REPORTED', 'POLICY_REVIEW_REFERRED'].map((code) => work(N, report(PN, IN.linkId, 'INVESTIGATION_EVIDENCE_LINK', code), M4.who)))
  const RN1 = await work(N, report(PN, IN.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who)
  const RN1_ID = (RN1.body?.workEventId ?? MISSING) as string
  check(
    'T037',
    'Work code matches approved action mapping',
    wrongWorkCodes.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED' && /not the one that answers the approved proposal/.test(errorMessage(r.body))) &&
      RN1.status === 201 && RN1.body.workCode === 'SOURCE_PROVENANCE_REVIEWED' && RW1.body.workCode === WORK_CODE_OF_ACTION.REQUEST_INTERNAL_DOCUMENTATION_CHECK &&
      same(Object.entries(WORK_CODE_OF_ACTION), [['REVIEW_SOURCE_PROVENANCE', 'SOURCE_PROVENANCE_REVIEWED'], ['REQUEST_INTERNAL_DOCUMENTATION_CHECK', 'DOCUMENTATION_CHECK_REPORTED'], ['RECHECK_CODING_REFERENCE', 'CODING_REFERENCE_REVIEW_REPORTED'], ['REFER_FOR_POLICY_REVIEW', 'POLICY_REVIEW_REFERRED']]),
    "N's approved REVIEW_SOURCE_PROVENANCE is answered only by SOURCE_PROVENANCE_REVIEWED: the other three work codes are each refused 409, then M4's report citing its link is recorded (201); the mapping is exactly 1:1 for all four A8.5 actions",
  )
  const rw1Audits = await auditsOfEvent(RW1_ID)
  check(
    'T038',
    'Valid report numbered 1 with one audit',
    same(countsAfterRW1, plus(countsAtStart, 1)) && rw1Audits.length === 1 && rw1Audits[0].actionCode === 'exception_remediation_work.recorded' && rw1Audits[0].organizationId === org && rw1Audits[0].actorUserId === M1.id &&
      rw1Audits[0].beforeState === null && RW1.body.sequence === 1 && RN1.body.sequence === 1,
    "W's report (and N's) is numbered 1; W's added exactly one work row and one audit (exception_remediation_work.recorded, Org A, actor M1) and changed no other table",
  )
  const secondPending = await work(W, report(PW, IW.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M1.who)
  check(
    'T039',
    'Second report while pending refused',
    secondPending.status === 409 && errorCode(secondPending.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED' && /already awaits verification/.test(errorMessage(secondPending.body)) && (await wRows()) === 1,
    "a different report (citing W's evidence link) while W's report awaits verification is refused 409; nothing recorded",
  )
  const duplicate = await work(W, report(PW, IW.findingId), M1.who)
  check(
    'T040',
    'Exact duplicate report refused',
    duplicate.status === 409 && errorCode(duplicate.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED' && duplicate.body?.workEventId === undefined && (await wRows()) === 1 && (await rowHash(RW1_ID)) === rw1HashBefore,
    "re-sending W's report exactly is a 409, never a replayed 201; W's report row is byte-identical",
  )

  // ---------------------------------------------------------------- verification flow (T041–T050)
  section('Verification flow on W and N: wrong reports refused, an independent verification as EVIDENCE_SUPPORTED, a NOT_VERIFIED with its reason by the A8.5 approver, no verification without a report, no self-verification, no second verification, terminal states, A8.5/A8.3 untouched')
  const wrongReports = [await work(W, supportedOf(MISSING), VR.who), await work(W, supportedOf(RN1_ID), VR.who), await work(W, supportedOf(PW.proposalId), VR.who)]
  const noReport = await work(L, supportedOf(RW1_ID), VR.who)
  const countsBeforeV1 = await counts()
  const V1 = await work(W, supportedOf(RW1_ID), VR.who)
  const V1_ID = (V1.body?.workEventId ?? MISSING) as string
  const countsAfterV1 = await counts()
  const dispositionV1 = (await dispositionOf(W)).body
  check(
    'T041',
    'Independent authorized verifier verifies',
    V1.status === 201 && V1.body.sequence === 2 && V1.body.workReportEventId === RW1_ID && V1.body.verificationCode === 'EVIDENCE_SUPPORTED' && V1.body.recordedByMembershipId === VR.membershipId &&
      V1.body.recordedByUserId === VR.id && V1.body.approvedProposalEventId === PW.proposalId && dispositionV1.state === 'VERIFIED_INTERNAL_WORK' && dispositionV1.verification?.workEventId === V1_ID &&
      same(Object.keys(dispositionV1.verification ?? {}), VERIFICATION_KEYS) && same(countsAfterV1, plus(countsBeforeV1, 1)),
    "VR, holding the verify permission and not the reporter, verifies W's report as EVIDENCE_SUPPORTED (event 2, carrying the same approved plan); W derives VERIFIED_INTERNAL_WORK; exactly one work row and one audit were added",
  )
  const VN = await work(N, notVerifiedOf(RN1_ID, 'SOURCE_MISMATCH'), RV.who)
  const VN_ID = (VN.body?.workEventId ?? MISSING) as string
  const dispositionVN = (await dispositionOf(N)).body
  check(
    'T042',
    'EVIDENCE_NOT_VERIFIED carries controlled reason',
    VN.status === 201 && VN.body.verificationCode === 'EVIDENCE_NOT_VERIFIED' && VN.body.reasonCode === 'SOURCE_MISMATCH' && VN.body.recordedByMembershipId === RV.membershipId &&
      dispositionVN.state === 'NOT_VERIFIED' && dispositionVN.verification?.reasonCode === 'SOURCE_MISMATCH' && dispositionVN.verification?.workEventId === VN_ID,
    "RV — the A8.5 approver of N's plan, independent of the reporter M4 (D7) — records EVIDENCE_NOT_VERIFIED with SOURCE_MISMATCH; N derives NOT_VERIFIED with that reason",
  )
  const v1Row = (await eventsOf(W.intakeId))[1]
  check('T043', 'EVIDENCE_SUPPORTED carries no reason', V1.body.reasonCode === null && v1Row?.reasonCode === null && dispositionV1.verification?.reasonCode === null, "W's EVIDENCE_SUPPORTED verification has no reason in its answer, its stored row or its disposition")
  check(
    'T044',
    'Verification names the exact outstanding report',
    wrongReports.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED' && /names exactly the work report that awaits verification/.test(errorMessage(r.body))),
    "while W's report awaited verification, naming no event, N's report (another intake) or W's A8.5 proposal is refused 409",
  )
  check(
    'T045',
    'No verification without a report',
    noReport.status === 409 && errorCode(noReport.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED' && /no work report of this exception awaits verification/.test(errorMessage(noReport.body)) && (await eventsOf(L.intakeId)).length === 0,
    'a verification on L, which holds no work report, is refused 409; nothing recorded',
  )
  const rS = randomUUID()
  const selfDirect = {
    sameMember: await directInsert([rowOf(S, { id: rS }), verifyRow(S, 2, rS, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })]),
    otherMembership: await directInsert([rowOf(S, { id: rS }), verifyRow(S, 2, rS, { recorded_by_membership_id: VR.membershipId, recorded_by_user_id: M4.id })]),
    otherTenantMembership: await directInsert([verifyRow(W, 3, RW1_ID, { recorded_by_membership_id: M1X.id, recorded_by_user_id: M1.id, approved_proposal_event_id: PW.proposalId })]),
  }
  const selfPlanted = await plantedRead(S, [rowOf(S, { id: rS }), verifyRow(S, 2, rS, { recorded_by_membership_id: VR.membershipId, recorded_by_user_id: M4.id })])
  check(
    'T046',
    'No self-verification, not even via another membership',
    selfRW1.status === 409 && selfService.ok === false && selfDirect.sameMember.refused && /exception_remediation_work_verifier: a work report is never verified by its own reporter/.test(selfDirect.sameMember.message) &&
      [selfDirect.otherMembership, selfDirect.otherTenantMembership].every((r) => r.refused && /exception_remediation_work_member/.test(r.message)) && Object.values(selfDirect).every((r) => r.clean) &&
      selfPlanted.value?.history.ok === false && selfPlanted.value.disposition.ok === false && selfPlanted.clean,
    "M1 verifying its own report is refused (route and service); on S a direct self-verification is refused by the verifier guard and the reporter's user acting through VR's membership by the member guard, as is M1 verifying its own W report through its membership of the other tenant; a planted verification by the reporter's user under another membership fails the whole read (409)",
  )
  const secondVerifications = [await work(W, notVerifiedOf(RW1_ID, 'INSUFFICIENT_SUPPORT'), VR2.who), await work(W, supportedOf(RW1_ID), VR.who), await work(N, supportedOf(RN1_ID), VR.who)]
  check(
    'T047',
    'No second verification of the same report',
    secondVerifications.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED') && (await wRows()) === 2 && (await eventsOf(N.intakeId)).length === 2,
    "a second verification of W's report (another verifier's NOT_VERIFIED, the same verifier again) and of N's report is refused 409; nothing recorded",
  )
  const afterTerminal = [await work(W, report(PW, IW.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M1.who), await work(W, report(PW, IW.findingId), M1.who), await work(N, report(PN, IN.findingId, 'INVESTIGATION_FINDING'), M4.who)]
  check(
    'T048',
    'After terminal verification further events 409',
    afterTerminal.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED' && /verified or not verified/.test(errorMessage(r.body))) && (await wRows()) === 2 && (await eventsOf(N.intakeId)).length === 2,
    'after VERIFIED_INTERNAL_WORK (W) and NOT_VERIFIED (N) a new report, even citing other evidence, is refused 409 (one report per approved proposal in v1; no silent supersession)',
  )
  check(
    'T049',
    'Verification never mutates A8.5 or A8.3',
    (await remediationHash()) === remediationHashBefore && (await snap()).investigation === ownerSnapshotBefore.investigation && withoutEvaluatedAt((await remediationDispositionOf(W)).body) === wRemediationBefore &&
      withoutEvaluatedAt((await investigationSummaryOf(W)).body) === wInvestigationBefore && withoutEvaluatedAt((await triageDispositionOf(W)).body) === wTriageBefore,
    "after the reports and verifications every A8.5 event and every A8.3 event of this run's intakes is byte-identical; W's A8.5 disposition (APPROVED_FOR_PLANNING), A8.3 summary and A8.2 disposition read back the same",
  )
  check(
    'T050',
    'No derived RESOLVED/PAID/CLOSED state',
    same([...workStates], ['NO_WORK_REPORT', 'AWAITING_VERIFICATION', 'VERIFIED_INTERNAL_WORK', 'NOT_VERIFIED']) && !(workStates as readonly string[]).some((s) => /RESOL|PAID|CLOS|EXECUT|CORRECT|COMPLETE|DONE/.test(s)) &&
      ![...deepKeys([dispositionV1, dispositionVN])].some((k) => /resol|paid|clos|outcome|payment/i.test(k)),
    `the only derived states are ${workStates.join(', ')} — none resolves, pays, executes, corrects or closes, and no disposition key does`,
  )

  // ---------------------------------------------------------------- direct SQL integrity on S (T051–T060, always rolled back)
  section('Direct SQL integrity on S (always rolled back): RESTRICT keys, valid direct rows, forged linkage, forged actors and verifiers, foreign or unsupported basis and plan, shape CHECKs with triggers off, sequence, UPDATE/DELETE/TRUNCATE, the unique verification')
  const fksOf = (table: string) => prisma.$queryRawUnsafe<{ name: string; del: string }[]>(`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid = '${table}'::regclass ORDER BY conname`)
  const fks = await fksOf(TABLE)
  const parentDeletes = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${INTAKE_TABLE} WHERE id = $1::uuid`, W.intakeId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${REMEDIATION_TABLE} WHERE id = $1::uuid`, PW.proposalId)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${INVESTIGATION_TABLE} WHERE id = $1::uuid`, IW.findingId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id = $1::uuid`, VR.id)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM organization_memberships WHERE id = $1::uuid`, M1.membershipId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM claims WHERE id = $1::uuid`, W.claimId)),
  ]
  check(
    'T051',
    'Every FK RESTRICT; parent deletion refused',
    fks.length === 8 && fks.every((fk) => fk.del === 'r') && parentDeletes.every((r) => !r.message.includes(NOT_COMMITTED) && /append-only|foreign key|23503|claims cannot be deleted/.test(r.message) && r.clean),
    `${fks.map((f) => f.name.replace(`${TABLE}_`, '')).join(', ')}: all ON DELETE RESTRICT; deleting W's intake, its approved A8.5 proposal, its A8.3 finding, a verifying user, a reporting membership or the Claim is refused (the Claim already by A6's own claims_identity_guard, which runs before the key)`,
  )
  const rS2 = randomUUID()
  const validDirect = [
    await directInsert([rowOf(S, { id: rS }), verifyRow(S, 2, rS)]),
    await directInsert([rowOf(S, { id: rS, basis_reference_kind: 'INVESTIGATION_EVIDENCE_LINK', basis_reference_id: IS.linkId }), verifyRow(S, 2, rS, { verification_code: 'EVIDENCE_NOT_VERIFIED', reason_code: 'SOURCE_MISSING' })]),
    await directInsert([rowOf(S, { id: rS2 }), verifyRow(S, 2, rS2, { recorded_by_membership_id: RV.membershipId, recorded_by_user_id: RV.id })]),
  ]
  check('T052', 'Valid direct report and review roll back', validDirect.every((r) => !r.refused && r.clean) && (await eventsOf(S.intakeId)).length === 0, "a valid direct report and verification (finding or link; supported, not verified, or by the A8.5 approver) pass every guard on S and roll back; S holds no committed event")
  const forgedLinkage = [await directInsert([rowOf(S, { organization_id: otherOrg })]), await directInsert([rowOf(S, { claim_id: W.claimId })]), await directInsert([rowOf(S, { exception_intake_id: L.intakeId })])]
  check('T053', 'Foreign tenant/Claim/intake direct row refused', forgedLinkage.every((r) => r.refused && /exception_remediation_work_coherence/.test(r.message) && r.clean), 'a direct event under the other organization, another Claim or another intake than its own is refused by the coherence guard')
  const forgedActors = {
    mismatched: await directInsert([rowOf(S, { recorded_by_user_id: M2.id })]), foreign: await directInsert([rowOf(S, { recorded_by_membership_id: O.membershipId, recorded_by_user_id: O.id })]),
    missing: await directInsert([rowOf(S, { recorded_by_membership_id: MISSING })]), otherTenantOfUser: await directInsert([rowOf(S, { recorded_by_membership_id: M1X.id, recorded_by_user_id: M1.id })]),
    notAssignee: await directInsert([rowOf(S, { recorded_by_membership_id: M2.membershipId, recorded_by_user_id: M2.id })]),
    viewerReporter: await directInsert([rowOf(S, { recorded_by_membership_id: viewerMembershipId, recorded_by_user_id: viewerUser.id })]),
  }
  check(
    'T054',
    'Forged actor/member direct row refused',
    [forgedActors.mismatched, forgedActors.foreign, forgedActors.missing, forgedActors.otherTenantOfUser].every((r) => r.refused && /exception_remediation_work_member/.test(r.message)) &&
      [forgedActors.notAssignee, forgedActors.viewerReporter].every((r) => r.refused && /exception_remediation_work_assignee/.test(r.message)) && Object.values(forgedActors).every((r) => r.clean),
    "a membership of another user, the other tenant's, M1's own membership in the other tenant or none is refused by the member guard; a reporter who is not S's assignee (M2, the Viewer) by the assignee guard",
  )
  const forgedVerifiers = [
    await directInsert([rowOf(S, { id: rS }), verifyRow(S, 2, rS, { recorded_by_membership_id: viewerMembershipId, recorded_by_user_id: viewerUser.id })]),
    await directInsert([rowOf(S, { id: rS }), verifyRow(S, 2, rS, { recorded_by_membership_id: NR.membershipId, recorded_by_user_id: NR.id })]),
  ]
  check(
    'T055',
    'Forged verifier or current permission refused',
    forgedVerifiers.every((r) => r.refused && /exception_remediation_work_verifier: the verifier's roles must grant/.test(r.message) && r.clean) && selfDirect.sameMember.refused,
    'a verifier without the verify permission now (the Viewer, a role-less member) is refused by the verifier guard, as is the reporter itself (T046)',
  )
  const badBasis = [
    await directInsert([rowOf(S, { basis_reference_id: IL.findingId })]), await directInsert([rowOf(S, { basis_reference_id: IF.findingId })]),
    await directInsert([rowOf(S, { basis_reference_id: IS.linkId })]), await directInsert([rowOf(S, { basis_reference_kind: 'INVESTIGATION_EVIDENCE_LINK', basis_reference_id: IS.findingId })]),
    await directInsert([rowOf(S, { basis_reference_id: MISSING })]), await directInsert([rowOf(S, { basis_reference_id: PS.proposalId })]),
  ]
  const badPlan = [
    await directInsert([rowOf(S, { approved_proposal_event_id: PU.proposalId })]), await directInsert([rowOf(S, { approved_proposal_event_id: PW.proposalId })]),
    await directInsert([rowOf(S, { approved_proposal_event_id: MISSING })]), await directInsert([rowOf(S, { approved_proposal_event_id: PF.proposalId })]),
  ]
  const badWorkCode = await Promise.all(['SOURCE_PROVENANCE_REVIEWED', 'CODING_REFERENCE_REVIEW_REPORTED', 'POLICY_REVIEW_REFERRED'].map((code) => directInsert([rowOf(S, { work_code: code })])))
  check(
    'T056',
    'Foreign or unsupported basis refused by guard',
    badBasis.every((r) => r.refused && /exception_remediation_work_basis/.test(r.message) && r.clean) && badPlan.every((r) => r.refused && /exception_remediation_work_plan/.test(r.message) && r.clean) &&
      badWorkCode.every((r) => r.refused && /exception_remediation_work_code/.test(r.message) && r.clean),
    "L's finding, the other tenant's finding, S's link cited as a finding, S's finding cited as a link, a missing record and an A8.5 event are refused by the basis guard; U's unapproved proposal, W's approved proposal, a missing one and the other tenant's by the plan guard; any work code but the plan action's by the work-code guard",
  )
  const off = { triggersOff: true }
  const shapes = [
    await directInsert([rowOf(S, { work_code: null })], off), await directInsert([rowOf(S, { work_code: 'CLAIM_CORRECTED' })], off), await directInsert([rowOf(S, { basis_reference_kind: 'ATTACHMENT' })], off),
    await directInsert([rowOf(S, { basis_reference_id: null })], off), await directInsert([rowOf(S, { basis_reference_contract_version: null })], off), await directInsert([rowOf(S, { basis_reference_contract_version: 'A8-EXCEPTION-INVESTIGATION-2' })], off),
    await directInsert([rowOf(S, { verification_code: 'EVIDENCE_SUPPORTED' })], off), await directInsert([rowOf(S, { work_report_event_id: MISSING })], off), await directInsert([rowOf(S, { reason_code: 'SOURCE_MISSING' })], off),
    await directInsert([verifyRow(S, 1, MISSING, { work_code: 'DOCUMENTATION_CHECK_REPORTED' })], off), await directInsert([verifyRow(S, 1, MISSING, { basis_reference_id: IS.findingId })], off),
    await directInsert([verifyRow(S, 1, MISSING, { reason_code: 'SOURCE_MISSING' })], off), await directInsert([verifyRow(S, 1, MISSING, { verification_code: 'EVIDENCE_NOT_VERIFIED' })], off),
    await directInsert([verifyRow(S, 1, MISSING, { verification_code: 'EVIDENCE_NOT_VERIFIED', reason_code: 'BECAUSE' })], off), await directInsert([verifyRow(S, 1, MISSING, { verification_code: 'RESOLVED' })], off),
    await directInsert([verifyRow(S, 1, MISSING, { work_report_event_id: null })], off),
  ]
  const eventCodeAlone = await directInsert([rowOf(S, { event_code: 'RESOLVE_EXCEPTION' })], off)
  const contractAlone = await directInsert([rowOf(S, { contract_version: 'A8-REMEDIATION-WORK-2' })], off)
  const noPlan = await directInsert([rowOf(S, { approved_proposal_event_id: null })], off)
  check(
    'T057',
    'Shape and controlled CHECKs hold, triggers off',
    shapes.every((r) => r.refused && /exception_remediation_work_events_shape_chk/.test(r.message) && r.clean) && eventCodeAlone.refused && /exception_remediation_work_events_event_code_chk/.test(eventCodeAlone.message) &&
      contractAlone.refused && /exception_remediation_work_events_contract_chk/.test(contractAlone.message) && noPlan.refused && /null value|23502|approved_proposal_event_id/.test(noPlan.message),
    'with every trigger off, a report without its work code, evidence or evidence contract, with an uncontrolled code or a verification field, and a verification with a report field, a supported reason, a not-verified without or with an uncontrolled reason, an unknown code or no report are refused by the shape CHECK; an unknown event and a future contract by theirs; a row without its plan by NOT NULL',
  )
  const firstTwo = await directInsert([rowOf(S, { sequence: 2 })])
  const reusedLive = await directInsert([rowOf(S, { id: rS }), verifyRow(S, 1, rS)])
  const zero = await directInsert([rowOf(S, { sequence: 0 })], off)
  const reusedOff = await directInsert([rowOf(S), rowOf(S, { basis_reference_kind: 'INVESTIGATION_EVIDENCE_LINK', basis_reference_id: IS.linkId })], off)
  check(
    'T058',
    'Non-positive or repeated sequence refused',
    firstTwo.refused && /exception_remediation_work_sequence/.test(firstTwo.message) && reusedLive.refused && /exception_remediation_work_sequence/.test(reusedLive.message) && zero.refused && /exception_remediation_work_events_sequence_chk/.test(zero.message) &&
      reusedOff.refused && /exception_remediation_work_events_sequence_key|23505/.test(reusedOff.message) && [firstTwo, reusedLive, zero, reusedOff].every((r) => r.clean),
    'a first event numbered 2 and a reused number 1 are refused by the sequence guard; number 0 by its CHECK and, with every trigger off, a reused number by the unique (intake, sequence) index',
  )
  const wHash = await rowsHash([W.intakeId])
  const mutations = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = sequence WHERE id = $1::uuid`, RW1_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET verification_code = 'EVIDENCE_NOT_VERIFIED', reason_code = 'SOURCE_MISSING' WHERE id = $1::uuid`, V1_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, V1_ID)),
  ]
  const truncation = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`))
  const cascade = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`))
  // A later owner's ON DELETE RESTRICT key into this table would make PostgreSQL refuse a plain TRUNCATE before any
  // trigger runs; TRUNCATE ... CASCADE still reaches this guard. Judged on behaviour: every wipe is refused.
  const referencedBy = await prisma.$queryRawUnsafe<{ del: string; self: boolean }[]>(`SELECT confdeltype::text AS del, conrelid = confrelid AS self FROM pg_constraint WHERE contype = 'f' AND confrelid = '${TABLE}'::regclass`)
  const truncationRefused = /append-only/.test(truncation.message) || (/cannot truncate a table referenced in a foreign key constraint/.test(truncation.message) && referencedBy.some((row) => !row.self) && referencedBy.every((row) => row.del === 'r'))
  check(
    'T059',
    'UPDATE, DELETE, TRUNCATE refuse incl. no-op',
    mutations.every((r) => /append-only/.test(r.message) && r.clean) && truncationRefused && truncation.clean && /append-only/.test(cascade.message) && cascade.clean && (await rowsHash([W.intakeId])) === wHash,
    "a no-op UPDATE of W's report, turning its verification into NOT_VERIFIED, deleting it, a TRUNCATE and a TRUNCATE … CASCADE are each refused (append-only); nothing changed",
  )
  const bypass = {
    uniqueVerification: await directInsert([rowOf(S, { id: rS }), verifyRow(S, 2, rS), verifyRow(S, 3, rS, { verification_code: 'EVIDENCE_NOT_VERIFIED', reason_code: 'SOURCE_MISSING' })], off),
    secondVerification: await directInsert([rowOf(S, { id: rS }), verifyRow(S, 2, rS), verifyRow(S, 3, rS, { recorded_by_membership_id: VR2.membershipId, recorded_by_user_id: VR2.id })]),
    secondReport: await directInsert([rowOf(S, { id: rS }), rowOf(S, { sequence: 2, basis_reference_kind: 'INVESTIGATION_EVIDENCE_LINK', basis_reference_id: IS.linkId })]),
    afterTerminal: await directInsert([rowOf(S, { id: rS }), verifyRow(S, 2, rS), rowOf(S, { sequence: 3, basis_reference_kind: 'INVESTIGATION_EVIDENCE_LINK', basis_reference_id: IS.linkId })]),
    otherReport: await directInsert([rowOf(S, { id: rS }), verifyRow(S, 2, RW1_ID)]),
  }
  check(
    'T060',
    'Duplicate verification blocked by unique key',
    bypass.uniqueVerification.refused && /exception_remediation_work_events_work_report_event_id_key|23505/.test(bypass.uniqueVerification.message) && bypass.secondVerification.refused &&
      /exception_remediation_work_transition: the work report of this intake was verified/.test(bypass.secondVerification.message) && bypass.secondReport.refused &&
      /exception_remediation_work_transition: a work report of this intake already exists/.test(bypass.secondReport.message) && bypass.afterTerminal.refused &&
      /exception_remediation_work_transition: the work report of this intake was verified/.test(bypass.afterTerminal.message) && bypass.otherReport.refused &&
      /exception_remediation_work_transition: a verification names exactly the work report that awaits verification/.test(bypass.otherReport.message) && Object.values(bypass).every((r) => r.clean),
    "with every trigger off a second verification of one report is still refused by the unique (work report) index; live, a second verification, a second report, a report after a verification and a verification of W's report on S are refused by the guard",
  )

  // ---------------------------------------------------------------- atomicity and provenance (T061–T070), J's and AT's writers
  section('Atomicity and provenance on J and AT: one event and one audit commit together, crashes after the insert and after the audit, a retry after a proven rollback, tenant, actor and plan pointers, database time, metadata only, no audit on reads or refusals, no backdating, no orphan')
  const serviceCode = committedCode(`${MODULE_DIR}/exception-remediation-work.service.ts`)
  const onTx = serviceCode.slice(serviceCode.indexOf('async function recordOnTransaction'), serviceCode.indexOf('async function reconcileUnknownOutcome'))
  const firstStatement = onTx.split('\n').slice(1).find((line) => line.trim().length > 0) ?? ''
  // T071's writers first: one report holds J's Claim lock while a second report waits.
  const holdLock = holdAt('exceptionRemediationWork.claim_locked')
  const firstJ = recordWorkEvent(J.claimId, J.intakeId, report(PJ, IJ.findingId), M4.id)
  await Promise.race([holdLock.arrived, firstJ])
  const secondJ = recordWorkEvent(J.claimId, J.intakeId, report(PJ, IJ.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M4.id)
  const secondWaited = !(await settledWithin(secondJ, 1500))
  holdLock.release()
  const [j1, j2] = await Promise.all([firstJ, secondJ])
  clearConcurrencyProbes()
  const RJ1 = j1.ok ? j1.value.workEventId : MISSING
  // T061 on AT: while AT's report is inserted but uncommitted, no other connection sees it or its audit.
  const holdInsert = holdAt('exceptionRemediationWork.inserted')
  const committing = recordWorkEvent(AT.claimId, AT.intakeId, report(PAT, IAT.findingId), M4.id)
  await Promise.race([holdInsert.arrived, committing])
  const during = { rows: (await eventsOf(AT.intakeId)).length, audits: await auditsOfIntake(AT.intakeId) }
  holdInsert.release()
  const RAT = await committing
  clearConcurrencyProbes()
  const atRows = await eventsOf(AT.intakeId)
  const ratAudit = RAT.ok ? (await auditsOfEvent(RAT.value.workEventId))[0] : undefined
  check(
    'T061',
    'Event and metadata audit commit atomically',
    during.rows === 0 && during.audits === 0 && RAT.ok && atRows.length === 1 && (await auditsOfIntake(AT.intakeId)) === 1 && !!ratAudit && ratAudit.actionCode === 'exception_remediation_work.recorded' &&
      ratAudit.beforeState === null && (ratAudit.afterState as any)?.recordedAt === atRows[0].recordedAt.toISOString() && ratAudit.organizationId === AT.organizationId && ratAudit.actorUserId === M4.id,
    "while M4's report on AT was uncommitted no other connection saw it or its audit; after commit exactly one of each, the audit holding the event's own database time, organization and actor",
  )
  const verifyJ = supportedOf(RJ1)
  const failAfterInsert = failOnce('exceptionRemediationWork.inserted', 'injected failure after the work insert')
  const crashedInsert = await attemptAdversarial(() => recordWorkEvent(J.claimId, J.intakeId, verifyJ, VR.id))
  const afterCrash1 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T062', 'Crash after event before audit rolls back', failAfterInsert.reached === 1 && /injected failure after the work insert/.test(crashedInsert) && afterCrash1.rows === 1 && afterCrash1.audits === 1, 'a failure right after the verification insert on J rolled back the whole transaction: no event, no audit, no retry')
  const failAfterAudit = failOnce('exceptionRemediationWork.audited', 'injected failure after the work audit')
  const crashedAudit = await attemptAdversarial(() => recordWorkEvent(J.claimId, J.intakeId, verifyJ, VR.id))
  const afterCrash2 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T063', 'Crash after audit before commit rolls back', failAfterAudit.reached === 1 && /injected failure after the work audit/.test(crashedAudit) && afterCrash2.rows === 1 && afterCrash2.audits === 1, 'a failure after the audit rolled back both: no event, no audit, no retry')
  // T078 and T080's writers: exhausted retries and unknown outcomes on J, before its one accepted retry.
  const always = failEveryTime('exceptionRemediationWork.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const exhausted = await recordWorkEvent(J.claimId, J.intakeId, verifyJ, VR.id)
  const lost = failEveryTime('exceptionRemediationWork.audited', 'Connection terminated unexpectedly')
  const unknownOutcome = await recordWorkEvent(J.claimId, J.intakeId, verifyJ, VR.id)
  const early = failEveryTime('exceptionRemediationWork.claim_locked', 'Connection terminated unexpectedly')
  const earlyOutcome = await recordWorkEvent(J.claimId, J.intakeId, verifyJ, VR.id)
  clearConcurrencyProbes()
  const jBeforeRetry = (await eventsOf(J.intakeId)).length
  const once = failOnce('exceptionRemediationWork.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const VJ = await recordWorkEvent(J.claimId, J.intakeId, verifyJ, VR.id)
  clearConcurrencyProbes()
  check(
    'T064',
    'Confirmed rollback, then one accepted retry',
    once.reached === 1 && VJ.ok && VJ.value.sequence === 2 && jBeforeRetry === 1 && (await eventsOf(J.intakeId)).length === 2 && (await auditsOfIntake(J.intakeId)) === 2,
    "one provably aborted serialization failure is retried on a fresh transaction that re-reads the history and records VR's verification exactly once (event 2) with one audit",
  )
  // T079's writer on AT: a unique collision on the verification, retried on a fresh transaction.
  const atBeforeUnique = (await eventsOf(AT.intakeId)).length
  const uniqueOnce = failOnce('exceptionRemediationWork.inserted', 'duplicate key value violates unique constraint "exception_remediation_work_events_sequence_key"')
  const VAT = await recordWorkEvent(AT.claimId, AT.intakeId, supportedOf(RAT.ok ? RAT.value.workEventId : MISSING), VR.id)
  clearConcurrencyProbes()
  const runEventsSoFar = await prisma.exceptionRemediationWorkEvent.findMany({ where: { recordedAt: { gte: runStartedAt } } })
  const runAuditsSoFar = await prisma.auditEvent.findMany({ where: { actionCode: 'exception_remediation_work.recorded', occurredAt: { gte: runStartedAt } } })
  const auditOf = (eventId: string) => runAuditsSoFar.filter((a) => a.entityId === eventId)
  check(
    'T065',
    'Audit tenant/actor/plan/record pointers exact',
    runEventsSoFar.length >= 8 && runEventsSoFar.every((e) => {
      const audits = auditOf(e.id)
      const after = audits[0]?.afterState as any
      return audits.length === 1 && audits[0].organizationId === e.organizationId && audits[0].actorUserId === e.recordedByUserId && audits[0].entityType === 'EXCEPTION_REMEDIATION_WORK_EVENT' &&
        after?.recordedByMembershipId === e.recordedByMembershipId && after?.exceptionIntakeId === e.exceptionIntakeId && after?.claimId === e.claimId && after?.approvedProposalEventId === e.approvedProposalEventId &&
        after?.basisReferenceId === e.basisReferenceId && after?.workReportEventId === e.workReportEventId
    }),
    `each of the ${runEventsSoFar.length} work events this run has exactly one audit under its own organization, acting user and membership, intake, Claim, approved plan, evidence record and report`,
  )
  const timeRows = await prisma.$queryRawUnsafe<{ n: bigint; differ: bigint; early: bigint }[]>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE recorded_at <> created_at) AS differ, count(*) FILTER (WHERE recorded_at < $1::timestamptz) AS early FROM ${TABLE} WHERE exception_intake_id = ANY($2::uuid[])`,
    runStartedAt.toISOString(), runIntakes.map((k) => k.intakeId),
  )
  const pastTime = await directInsert([rowOf(S, { recorded_at: '2020-01-01T00:00:00.000Z' })])
  const futureTime = await directInsert([rowOf(S, { recorded_at: new Date(Date.now() + 86_400_000).toISOString() })])
  const retime = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET recorded_at = recorded_at - interval '1 day' WHERE id = $1::uuid`, RW1_ID))
  check(
    'T066',
    'Database event timestamps server-owned',
    Number(timeRows[0].n) >= 8 && Number(timeRows[0].differ) === 0 && Number(timeRows[0].early) === 0 && [pastTime, futureTime].every((r) => r.refused && /exception_remediation_work_time/.test(r.message) && r.clean) &&
      /append-only/.test(retime.message) && retime.clean && runEventsSoFar.every((e) => (auditOf(e.id)[0]?.afterState as any)?.recordedAt === e.recordedAt.toISOString()),
    "every event this run was recorded and created at the database's own transaction time (equal, never before the run); a past or future time in a direct row is refused by the time guard and re-timing an event is refused (append-only); each audit carries the event's own time",
  )
  const auditText = JSON.stringify(runAuditsSoFar.map((a) => a.afterState))
  check(
    'T067',
    'Audit holds no PHI, amount or source text',
    runAuditsSoFar.length === runEventsSoFar.length && runAuditsSoFar.every((a) => a.beforeState === null && same(Object.keys((a.afterState ?? {}) as object).sort(), [...AUDIT_KEYS].sort())) &&
      ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), 'AED', '125.25', M1.email, VR.email, 'Synthetic member', 'Synthetic finding.'].some((value) => auditText.includes(value)),
    `every work audit is metadata only — exactly ${AUDIT_KEYS.length} keys (ids, contract, sequence, controlled codes, plan, evidence and report pointers, membership and time) — and holds no patient, diagnosis, member contact, source text, amount or currency`,
  )
  const auditsBeforeReads = await prisma.auditEvent.count()
  const countsBeforeReads = await counts()
  for (const k of [W, N, J, S]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await dispositionOf(k, who)
  }
  const readRefusals = [
    await historyOf(W, anonymous), await dispositionOf(F), await historyOf({ claimId: W.claimId, intakeId: MISSING }), await get(`${base(W)}/remediation-work-disposition?current=1`), await work(W, report(PW, IW.findingId), asViewer),
    await work(N, report(PN, MISSING), M4.who), await work(W, supportedOf(RW1_ID), M1.who), await work(W, report(PW, IW.findingId), M1.who), await work(W, { eventCode: 'NOPE' }, M1.who),
  ]
  check(
    'T068',
    'Reads and refusals write no audit',
    (await prisma.auditEvent.count()) === auditsBeforeReads && (await unchanged(countsBeforeReads)) && readRefusals.map((r) => r.status).join('/') === '401/404/404/400/403/404/409/409/400',
    `sixteen reads by an Admin and a Viewer and nine refused requests (${readRefusals.map((r) => r.status).join('/')}) wrote no audit and changed no row`,
  )
  const wHashBeforeBackfill = await rowsHash([W.intakeId])
  const backfill = [
    await directInsert([verifyRow(W, 2, RW1_ID, { verification_code: 'EVIDENCE_NOT_VERIFIED', reason_code: 'SOURCE_MISSING', approved_proposal_event_id: PW.proposalId })]),
    await directInsert([rowOf(W, { sequence: 3, basis_reference_kind: 'INVESTIGATION_EVIDENCE_LINK', basis_reference_id: IW.linkId, recorded_by_membership_id: M1.membershipId, recorded_by_user_id: M1.id })]),
  ]
  const rewrite = [await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = 9 WHERE id = $1::uuid`, V1_ID)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, RW1_ID))]
  check(
    'T069',
    'Backdated or resequenced event refused',
    backfill[0].refused && /exception_remediation_work_sequence/.test(backfill[0].message) && backfill[1].refused && /exception_remediation_work_transition: the work report of this intake was verified/.test(backfill[1].message) &&
      rewrite.every((r) => /append-only/.test(r.message) && r.clean) && backfill.every((r) => r.clean) && (await rowsHash([W.intakeId])) === wHashBeforeBackfill,
    "a verification slotted into W's past is refused by the sequence guard, a report appended after its verification by the terminal guard; renumbering W's verification and deleting its report are refused (append-only); W's rows are byte-identical",
  )
  const contiguous = async (k: Intake) => {
    const rows = await eventsOf(k.intakeId)
    return same(rows.map((e) => e.sequence), rows.map((_e, i) => i + 1)) && (await auditsOfIntake(k.intakeId)) === rows.length
  }
  const orphanAudits = runAuditsSoFar.filter((a) => !runEventsSoFar.some((e) => e.id === a.entityId))
  check(
    'T070',
    'No orphan audit or unpaired event',
    runEventsSoFar.every((e) => auditOf(e.id).length === 1) && orphanAudits.length === 0 && (await contiguous(W)) && (await contiguous(N)) && (await contiguous(J)) && (await contiguous(AT)),
    `${runEventsSoFar.length} events and ${runAuditsSoFar.length} work audits this run pair one to one; no audit names a missing event; W, N, J and AT are numbered 1..N with one audit each, after every crash and retry`,
  )

  // ---------------------------------------------------------------- concurrency (T071–T080)
  section('Concurrency: the Claim lock first in one SERIALIZABLE transaction, simultaneous reports and verifications, a concurrent reassignment, a concurrent A8.5 decision, a permission revocation, mixed operations, bounded retries, unique collisions, unknown commits')
  check(
    'T071',
    'Claim lock first query inside SERIALIZABLE',
    /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(firstStatement) && /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) &&
      (serviceCode.match(/prisma\.\$transaction\(\(tx\) => recordOnTransaction\(/g) ?? []).length === 1 && /recordAuditEvent\(/.test(onTx) && /insertWorkEvent\(/.test(onTx) && secondWaited &&
      j1.ok && j1.value.sequence === 1 && j2.ok === false && j2.code === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED',
    "the Claim row NOWAIT lock is the first statement of the one SERIALIZABLE transaction that writes the event and its audit; while one report on J held it a second waited, then was judged on the committed state (a report already awaits verification: 409)",
  )
  const reportRace = await Promise.all(Array.from({ length: 5 }, () => work(R, report(PR, IR.findingId), M4.who)))
  const isRefusedStep = (r: { status: number; body: any }) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED'
  const RR1_ID = (reportRace.find((r) => r.status === 201)?.body.workEventId ?? MISSING) as string
  check(
    'T072',
    'Two simultaneous same reports: one accepted',
    reportRace.filter((r) => r.status === 201).length === 1 && reportRace.filter(isRefusedStep).length === 4 && (await eventsOf(R.intakeId)).length === 1 && (await auditsOfIntake(R.intakeId)) === 1 &&
      (await dispositionOf(R)).body.report?.workEventId === RR1_ID,
    `five identical reports on R at once (${reportRace.map((r) => r.status).join('/')}): one 201 and four 409; one event, one audit, and it is the outstanding report`,
  )
  const verifyRace = await Promise.all(
    [supportedOf(RR1_ID), notVerifiedOf(RR1_ID, 'SOURCE_MISSING'), supportedOf(RR1_ID), notVerifiedOf(RR1_ID, 'INSUFFICIENT_SUPPORT'), supportedOf(RR1_ID)].map((body, i) => work(R, body, i % 2 === 0 ? VR.who : VR2.who)),
  )
  check(
    'T073',
    'Two simultaneous reviews: one accepted',
    verifyRace.filter((r) => r.status === 201).length === 1 && verifyRace.filter(isRefusedStep).length === 4 && (await eventsOf(R.intakeId)).length === 2 && (await auditsOfIntake(R.intakeId)) === 2 &&
      ['VERIFIED_INTERNAL_WORK', 'NOT_VERIFIED'].includes((await dispositionOf(R)).body.state),
    `five verifications of R's report by two independent verifiers at once (${verifyRace.map((r) => r.status).join('/')}): one decision, four 409; R is terminal with two events`,
  )
  const holdTriage = holdAt('exceptionTriage.inserted')
  const kReassign = recordTriageEvent(K.claimId, K.intakeId, reassignTo(M2), creatorId)
  await Promise.race([holdTriage.arrived, kReassign])
  const kReport = recordWorkEvent(K.claimId, K.intakeId, report(PK, IK.findingId), M4.id)
  const kWaited = !(await settledWithin(kReport, 1500))
  holdTriage.release()
  const [kReassigned, kResult] = await Promise.all([kReassign, kReport])
  clearConcurrencyProbes()
  const kByM2 = await work(K, report(PK, IK.findingId), M2.who)
  check(
    'T074',
    'Concurrent A8.2 reassignment rejudges actor',
    kWaited && kReassigned.ok && kResult.ok === false && kResult.code === 'EXCEPTION_REMEDIATION_WORK_NOT_ASSIGNEE' && kByM2.status === 201 && kByM2.body.recordedByMembershipId === M2.membershipId && kByM2.body.sequence === 1 &&
      (await eventsOf(K.intakeId)).length === 1,
    "while an A8.2 reassignment of K to M2 held K's Claim lock, M4's report waited, re-read the committed disposition and was refused 409 (no longer the assignee); M2, the new assignee, then reports against the same approved plan (201, event 1)",
  )
  const holdPlan = holdAt('exceptionRemediation.inserted')
  const uApproval = recordRemediationEvent(U.claimId, U.intakeId, { eventCode: 'REVIEW_ACTION', proposalEventId: PU.proposalId, decisionCode: 'APPROVE_PROPOSAL' }, RV.id)
  await Promise.race([holdPlan.arrived, uApproval])
  const uReport = recordWorkEvent(U.claimId, U.intakeId, report(PU, IU.findingId), M4.id)
  const uWaited = !(await settledWithin(uReport, 1500))
  holdPlan.release()
  const [uApproved, uResult] = await Promise.all([uApproval, uReport])
  clearConcurrencyProbes()
  const wPlanChange = await post(`${base(W)}/remediation-events`, { eventCode: 'REVIEW_ACTION', proposalEventId: PW.proposalId, decisionCode: 'RETURN_PROPOSAL', reviewReasonCode: 'WRONG_SCOPE' }, VR2.who)
  check(
    'T075',
    'Concurrent A8.5 decision cannot change basis',
    uWaited && uApproved.ok && uResult.ok && uResult.value.approvedProposalEventId === PU.proposalId && uResult.value.sequence === 1 && wPlanChange.status === 409 &&
      (await dispositionOf(W)).body.approvedProposalEventId === PW.proposalId && (await remediationHash()) === remediationHashBefore,
    "while an A8.5 approval of U's proposal held U's Claim lock, M4's report waited and was judged on the committed approval (201 against exactly that plan); a later A8.5 decision on W's approved proposal is refused by A8.5 (terminal), so W's work basis stays its approved proposal and every earlier A8.5 event is byte-identical",
  )
  const holdG = holdAt('exceptionRemediationWork.claim_locked')
  const gReport = recordWorkEvent(G.claimId, G.intakeId, report(PG, IG.findingId), M5.id)
  await Promise.race([holdG.arrived, gReport])
  await prisma.membershipRole.deleteMany({ where: { membershipId: M5.membershipId } })
  holdG.release()
  const gResult = await gReport
  clearConcurrencyProbes()
  const gHttp = await work(G, report(PG, IG.findingId), M5.who)
  const gDirect = await directInsert([rowOf(G, { recorded_by_membership_id: M5.membershipId, recorded_by_user_id: M5.id })])
  const gTriage = (await triageDispositionOf(G)).body
  check(
    'T076',
    'Current permission revocation blocks write',
    gResult.ok === false && gResult.code === 'EXCEPTION_REMEDIATION_WORK_NOT_ASSIGNEE' && gHttp.status === 403 && gDirect.refused && /exception_remediation_work_assignee/.test(gDirect.message) && gDirect.clean &&
      gTriage.assignedMemberId === M5.membershipId && gTriage.assigneeCurrentlyEligible === false && (await eventsOf(G.intakeId)).length === 0,
    "M5's role was removed while its report on G held the Claim lock: the report was refused 409 (no current permission); its next request is 403 and the database guard refuses a direct row; A8.2 still names M5, not eligible; nothing recorded",
  )
  const RQ1 = await work(Q, report(PQ, IQ.findingId), M4.who)
  const RQ1_ID = (RQ1.body?.workEventId ?? MISSING) as string
  const mixed = await Promise.all([
    work(Q, report(PQ, IQ.linkId, 'INVESTIGATION_EVIDENCE_LINK'), M4.who), work(Q, supportedOf(RQ1_ID), VR.who), work(Q, notVerifiedOf(RQ1_ID, 'SOURCE_MISSING'), VR2.who),
    work(Q, report(PQ, IQ.findingId), M4.who), work(Q, supportedOf(RQ1_ID), RV.who), work(Q, notVerifiedOf(RQ1_ID, 'INSUFFICIENT_SUPPORT'), VR.who),
  ])
  const qRows = await eventsOf(Q.intakeId)
  const qHistory = (await historyOf(Q)).body
  const qDisposition = (await dispositionOf(Q)).body
  const qDerived = deriveWork({ exceptionIntakeId: Q.intakeId, organizationId: Q.organizationId, claimId: Q.claimId }, { approvedProposalEventId: PQ.proposalId, actionCode: PQ.actionCode }, qRows)
  check(
    'T077',
    'Mixed same-Claim operations serialize legally',
    RQ1.status === 201 && RQ1.body.workCode === 'CODING_REFERENCE_REVIEW_REPORTED' && mixed.every((r) => r.status === 201 || isRefusedStep(r)) && mixed.filter((r) => r.status === 201).length === 1 && qRows.length === 2 &&
      qDerived.ok && (await contiguous(Q)) && same(replayIndependently(qHistory.items, PQ.proposalId), dispositionFacts(qDisposition)) && qDisposition.state === (qDerived.ok ? qDerived.value.state : 'none'),
    `after Q's report, two reports and four verifications at once (${mixed.map((r) => r.status).join('/')}) left 2 events numbered 1..N, one audit each, a history the reducer accepts and a disposition (${qDisposition.state}) this suite's own replay reproduces; every other request was a 409`,
  )
  check(
    'T078',
    'Bounded retry on 40001 or deadlock',
    always.reached === 3 && exhausted.ok === false && exhausted.code === 'EXCEPTION_REMEDIATION_WORK_CONFLICT' && /kept conflicting; nothing was recorded/.test(exhausted.message) && /const MAX_WORK_ATTEMPTS = 3/.test(serviceCode) &&
      /deadlock detected/.test(serviceCode) && /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode),
    'a serialization failure on every attempt stops after exactly 3 fresh transactions with a 409 and nothing recorded; a deadlock is retried the same way; busy locks are waited for within the 30 s budget',
  )
  check(
    'T079',
    'Unique collision rereads on a fresh tx',
    uniqueOnce.reached === 1 && VAT.ok && VAT.value.sequence === atBeforeUnique + 1 && VAT.value.verificationCode === 'EVIDENCE_SUPPORTED' && (await contiguous(AT)) && /isUniqueViolation\(error\)/.test(serviceCode),
    `a unique (intake, sequence) collision is retried on a fresh transaction that re-reads the history, and VR's verification of AT is recorded exactly once as event ${atBeforeUnique + 1}`,
  )
  check(
    'T080',
    'Unknown commit reconciled; no blind replay',
    lost.reached === 1 && unknownOutcome.ok === false && unknownOutcome.code === 'EXCEPTION_REMEDIATION_WORK_CONFLICT' && /holds no event at sequence 2; nothing was recorded/.test(unknownOutcome.message) &&
      early.reached === 1 && earlyOutcome.ok === false && /failed before an event was written/.test(earlyOutcome.message) && jBeforeRetry === 1 && /reconcileAttempt\(records, attempted\)/.test(serviceCode),
    "a connection lost after the audit is reconciled against the committed history (no event 2: nothing recorded) and a loss before the insert is reported as such; each reached once — never resubmitted, never a 201 (RECORDED and OTHER_EVENT are proven by the reducer's unit tests, T081)",
  )

  // ---------------------------------------------------------------- replay and reads (T081–T090)
  section('Replay and reads: unit tests over every state/event pair, 100 derivations, an independent replay, malformed, gapped and misnumbered histories, READ ONLY snapshot reads, database read time, agreement, two readers')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  const reducerCode = committedCode(`${MODULE_DIR}/exception-remediation-work.reducer.ts`)
  const reducerTests = committedText(`${MODULE_DIR}/exception-remediation-work.reducer.test.ts`)
  check(
    'T081',
    'Pure reducer tests all legal/illegal pairs',
    ownUnit.ok && /ℹ pass 10/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output) && /every illegal state\/event pair is refused/.test(reducerTests) && /the work code is exactly the approved action/.test(reducerTests) &&
      !/prisma|await |async |Date\.now|Math\.random|new Date|from '\.\.\/\.\.\/shared/.test(reducerCode),
    'the 10 reducer and request tests pass (the worked scenarios, the 1:1 work code, every illegal state/event pair, exact shapes, whole histories and the unknown-outcome reconciliation); the reducer reads no database, clock or randomness',
  )
  const parentOf = (k: Intake) => ({ exceptionIntakeId: k.intakeId, organizationId: k.organizationId, claimId: k.claimId })
  const wPlan = { approvedProposalEventId: PW.proposalId, actionCode: PW.actionCode }
  const wStored = await eventsOf(W.intakeId)
  const derivations = new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveWork(parentOf(W), wPlan, wStored))))
  const wDerived = deriveWork(parentOf(W), wPlan, wStored)
  check('T082', '100 identical histories, identical results', derivations.size === 1 && wDerived.ok && wDerived.value.state === 'VERIFIED_INTERNAL_WORK', "100 derivations of W's stored history against its approved plan are byte-identical (VERIFIED_INTERNAL_WORK)")
  const replayed: [Intake, Plan][] = [[W, PW], [N, PN], [J, PJ], [AT, PAT], [R, PR], [K, PK], [Q, PQ], [U, PU]]
  const replays = await Promise.all(replayed.map(async ([k, plan]) => same(replayIndependently((await historyOf(k)).body.items, plan.proposalId), dispositionFacts((await dispositionOf(k)).body))))
  check('T083', 'Independent replay matches stored history', replays.every(Boolean), "this suite's own replay of W's, N's, J's, AT's, R's, K's, Q's and U's histories gives exactly each derived disposition")
  const refusedRead = (r: { value?: { history: any; disposition: any }; clean: boolean }) =>
    r.value?.history.ok === false && r.value.history.code === 'EXCEPTION_REMEDIATION_WORK_CONFLICT' && r.value.disposition.ok === false && r.value.disposition.code === 'EXCEPTION_REMEDIATION_WORK_CONFLICT' && r.clean
  const corruptShape = await plantedRead(S, [rowOf(S, { work_code: 'CLAIM_CORRECTED' })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_shape_chk`)
  const plantedSelf = await plantedRead(S, [rowOf(S, { id: rS }), verifyRow(S, 2, rS, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })])
  const foreignPlanted = await plantedRead(S, [rowOf(S, { organization_id: otherOrg })])
  const otherPlanPlanted = await plantedRead(S, [rowOf(S, { approved_proposal_event_id: PW.proposalId })])
  check(
    'T084',
    'Malformed history gives 409, never partial',
    refusedRead(corruptShape) && refusedRead(plantedSelf) && refusedRead(foreignPlanted) && refusedRead(otherPlanPlanted),
    "a planted uncontrolled work code (its CHECK dropped), a planted self-verification, a planted row of the other tenant and a planted report against another intake's plan each make the history and the disposition refuse 409 — never repaired, never partial",
  )
  const gapped = await plantedRead(S, [rowOf(S, { id: rS }), verifyRow(S, 3, rS)])
  check('T085', 'History gap causes 409', refusedRead(gapped), 'a planted history numbered 1, 3 makes both reads refuse 409')
  const wrongFirst = await plantedRead(S, [rowOf(S, { sequence: 2 })])
  const futureContract = await plantedRead(S, [rowOf(S, { contract_version: 'A8-REMEDIATION-WORK-2' })], `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_contract_chk`)
  check('T086', 'Wrong first sequence causes 409', refusedRead(wrongFirst) && refusedRead(futureContract), 'a planted history whose first event is numbered 2, and one under A8-REMEDIATION-WORK-2 (its CHECK dropped), make both reads refuse 409')
  const countsBeforeGet = await counts()
  for (const k of [W, N, J, R, Q]) for (const who of [asAdmin, asViewer]) {
    await historyOf(k, who)
    await dispositionOf(k, who)
  }
  const selectors = [await get(`${base(W)}/remediation-work-history?latest=1`), await get(`${base(W)}/remediation-work-disposition?state=VERIFIED_INTERNAL_WORK`)]
  const snapshotCode = committedCode('backend/src/shared/database/read-snapshot.ts')
  check(
    'T087',
    'GET is one READ ONLY consistent snapshot',
    (await unchanged(countsBeforeGet)) && selectors.every((r) => r.status === 400) && /SET TRANSACTION READ ONLY/.test(snapshotCode) &&
      /withReadSnapshot\(undefined, \(tx\) => getWorkHistoryOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode) && /withReadSnapshot\(undefined, \(tx\) => getWorkDispositionOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode),
    'twenty reads by an Admin and a Viewer changed no row; each runs in one READ ONLY snapshot that also reads the A8.1–A8.5 owners; a query selector is refused (400)',
  )
  const dbNow = async () => (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts.getTime()
  const beforeRead = await dbNow()
  const readAgain = (await dispositionOf(W)).body
  const historyAgain = (await historyOf(W)).body
  const afterRead = await dbNow()
  const evaluated = [Date.parse(readAgain.evaluatedAt), Date.parse(historyAgain.evaluatedAt)]
  check(
    'T088',
    'Read evaluatedAt from DB; event times fixed',
    evaluated.every((t) => t >= beforeRead - 1 && t <= afterRead + 1) && evaluated[1] >= evaluated[0] && historyAgain.items.every((item: any, i: number) => item.recordedAt === wStored[i].recordedAt.toISOString()) &&
      historyAgain.items[0].recordedAt === RW1.body.recordedAt,
    "each read's evaluatedAt lies between two database clock readings around it; every event's recordedAt is its stored database time and W's report still reads exactly as answered when recorded",
  )
  const agree = async (k: Intake) => {
    const items = (await historyOf(k)).body.items as any[]
    const d = (await dispositionOf(k)).body
    const last = items[items.length - 1]
    return d.eventCount === items.length && d.lastSequence === (last?.sequence ?? null) &&
      (last?.eventCode === 'RECORD_WORK_REPORT' ? d.report?.workEventId === last.workEventId && d.verification === null : last ? d.verification?.workEventId === last.workEventId : d.state === 'NO_WORK_REPORT')
  }
  const agreeAll = async () => (await Promise.all([W, N, J, AT, R, K, Q, U, S, G, L].map(agree))).every(Boolean)
  check('T089', 'History and disposition agree', await agreeAll(), "for W, N, J, AT, R, K, Q, U, S, G and L the disposition's count, last number and report or verification are exactly the history's last event (re-checked after the outage, T124)")
  const twoReaders = await Promise.all([W, N, J, R, K, Q].map(async (k) => withoutEvaluatedAt((await historyOf(k)).body) === withoutEvaluatedAt((await historyOf(k, asViewer)).body) && withoutEvaluatedAt((await dispositionOf(k)).body) === withoutEvaluatedAt((await dispositionOf(k, asViewer)).body)))
  check('T090', 'Admin and Viewer responses identical', twoReaders.every(Boolean), "W's, N's, J's, R's, K's and Q's history and disposition are identical for an Admin and a Viewer (no authorization context in the body)")

  // ---------------------------------------------------------------- hard boundaries (T091–T100)
  section('Hard boundaries: nothing executed or corrected, no resolution, closure, escalation, SLA, queue or search, no payer or payment fact, no CRG activation, every A8.3, A8.2, A8.1, A6, A7 and CRG record unchanged')
  const moduleCode = committedProductionCodeOf([MODULE_DIR]).code
  const feCode = committedProductionCodeOf([FE_DIR]).code
  const ownerSnapshotNow = await snap()
  const inserts = [...moduleCode.matchAll(/INSERT INTO "?([a-z_]+)"?/g)].map((m) => m[1])
  const executeRoutes = await Promise.all(['execute', 'remediation-work-execute', 'apply', 'correct', 'patch-claim', 'encounter-correction'].map((p) => post(`${base(W)}/${p}`, {})))
  check(
    'T091',
    'No execution or correction of Claim/Encounter',
    ownerSnapshotNow.claims === ownerSnapshotBefore.claims && ownerSnapshotNow.encounters === ownerSnapshotBefore.encounters && same(inserts, [TABLE]) &&
      !/UPDATE "|DELETE FROM|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\.create\(|\.createMany\(/.test(moduleCode) && executeRoutes.every((r) => r.status === 404),
    "every run Claim and Encounter row is byte-identical; the module's only write is its own append-only INSERT (and the audit through its owner) — no UPDATE, DELETE or other create; no execute, apply or correct route",
  )
  const tablesAt = (ref: string) => new Set(migrationDirsAt(ref).flatMap((dir) => [...gitArgs(['show', `${ref}:${dir}/migration.sql`]).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])))
  const mainTables = tablesAt(ownBase)
  const a86Tables = [...committedText(MIGRATION).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
  // Tables that existed on main belong to earlier phases; only what this branch adds is judged. Later phases' tables are
  // those created by migrations committed after A8.6's own merge (none on its own branch).
  const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])) : [])
  const newTablesLike = async (pattern: string) => (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`, pattern)).map((r) => r.t).filter((t) => !mainTables.has(t) && !laterPhaseTables.has(t))
  const resolutionRoutes = await Promise.all(['resolve', 'close', 'escalate', 'closure', 'resolution', 'complete'].map((p) => post(`${base(W)}/${p}`, {})))
  const allCodes86 = [...workEventCodes, ...workCodes, ...basisReferenceKinds, ...verificationCodes, ...verificationReasonCodes, ...workStates]
  check(
    'T092',
    'No exception resolution, closure or escalation',
    resolutionRoutes.every((r) => r.status === 404) && same(a86Tables, [TABLE]) && mainTables.size > 50 && (await newTablesLike('(resolution|closure|escalat)')).length === 0 &&
      !allCodes86.some((c) => /RESOL|CLOS|ESCALAT|EXECUT/.test(c)) && !COLUMNS.some((c) => /resol|clos|escal/.test(c)),
    `no resolve, close, escalate or complete route, table, column or code; the A8.6 migration creates exactly ${TABLE}`,
  )
  const searches = await Promise.all(
    ['/api/exception-remediation-work', '/api/remediation-work-events', '/api/remediation-work-queue', `/api/organizations/${org}/remediation-work`, `/api/claims/${W.claimId}/remediation-work-events`, `/api/claims/${W.claimId}/exceptions/remediation-work-history`, `${base(W)}/sla`].map((p) => get(p)),
  )
  check(
    'T093',
    'No SLA, queue or global search',
    searches.every((r) => r.status === 404) && (await newTablesLike('(sla|deadline|due_|queue|outbox|_job)')).length === 0 && (moduleCode.match(/findMany\(/g) ?? []).length === 1 && /findMany\(\{ where: \{ exceptionIntakeId \}/.test(moduleCode) &&
      !COLUMNS.some((c) => /sla|deadline|due|queue/.test(c)) && !allCodes86.some((c) => /SLA|DEADLINE|QUEUE|OVERDUE/.test(c)),
    "no organization-wide list, queue, SLA, Claim-wide collection or search route, table, column or code; the module's one list read is one intake's events",
  )
  const dtoKeys = [...deepKeys([(await historyOf(W)).body, (await dispositionOf(W)).body, (await historyOf(N)).body, (await dispositionOf(N)).body])]
  const paymentRoutes = await Promise.all([post(`/api/claims/${W.claimId}/payments`, {}), post(`${base(W)}/remittance`, {}), post(`${base(W)}/adjudication`, {}), post(`${base(W)}/send`, {})])
  check(
    'T094',
    'No payer/payment/remittance/adjudication fact',
    !COLUMNS.some((c) => /payer|payment|remit|adjudic|denial|amount|currency|outcome/.test(c)) && !dtoKeys.some((k) => /payer|payment|remit|adjudic|denial|amount|currency|outcome|financial/i.test(k)) &&
      !allCodes86.some((c) => /PAID|DENI|PAYMENT|PAYER|REMIT|ADJUDIC|SETTL|WRITE_OFF|REFUND/.test(c)) && paymentRoutes.every((r) => r.status === 404),
    'no payer, payment, remittance, adjudication, denial, amount or outcome column, key or code; no payment, remittance, adjudication or send route',
  )
  check(
    'T095',
    'No CRG coding import, rights or scope switch',
    RQ1.status === 201 && RQ1.body.workCode === 'CODING_REFERENCE_REVIEW_REPORTED' && ownerSnapshotNow.coding === ownerSnapshotBefore.coding &&
      !/coding-release|codingRelease|coding-validation|codingValidation|crg_|code_system|procedure-code|diagnosis-code/.test(moduleCode),
    "Q's CODING_REFERENCE_REVIEW_REPORTED report was recorded as an internal report only: every CRG-01 coding-release and validation table (scopes, receipts, manifests, rights, imports, memberships) and the A2 code masters hold exactly the rows they held before; the module reads and writes no coding owner",
  )
  const untouched = (paths: string[]) => gitArgs(['diff', '--name-only', ownRange, '--', ...paths.map((p) => `:/${p}`)]) === ''
  check(
    'T096',
    'A8.3 findings and events byte-identical',
    untouched(['backend/src/modules/exception-investigation', A83_MIGRATION]) && ownerSnapshotNow.investigation === ownerSnapshotBefore.investigation && withoutEvaluatedAt((await investigationSummaryOf(W)).body) === wInvestigationBefore,
    "the A8.3 module and migration are unchanged; every A8.3 event of this run's intakes is byte-identical and W's investigation summary reads back the same",
  )
  check(
    'T097',
    'A8.2 assignments byte-identical',
    untouched(['backend/src/modules/exception-triage']) && (await triageHash()) === triageHashBefore && triageIdsBefore.length >= 25 && withoutEvaluatedAt((await triageDispositionOf(W)).body) === wTriageBefore,
    `the A8.2 module is unchanged; all ${triageIdsBefore.length} triage events that existed before the first work write are byte-identical and W's disposition reads back the same`,
  )
  check(
    'T098',
    'A8.1 intake and audits byte-identical',
    untouched(['backend/src/modules/exception-intake']) && ownerSnapshotNow.intakes === ownerSnapshotBefore.intakes && ownerSnapshotNow.intakeAudits === ownerSnapshotBefore.intakeAudits &&
      withoutEvaluatedAt((await get(`/api/claims/${W.claimId}/exception-intake`)).body) === wIntakesBefore,
    "the A8.1 module is unchanged; every intake of this run and its audit is byte-identical and W's intake list reads back the same",
  )
  check(
    'T099',
    'A6 freezes and corrections byte-identical',
    untouched(['backend/src/modules/claim-submission', 'backend/src/modules/claim-payload', 'backend/src/modules/claim-evidence', 'backend/src/modules/claim-lifecycle', 'backend/src/modules/claim-correction']) &&
      ownerSnapshotNow.freezes === ownerSnapshotBefore.freezes && ownerSnapshotNow.lifecycle === ownerSnapshotBefore.lifecycle && ownerSnapshotNow.links === ownerSnapshotBefore.links,
    `the A6 owners are unchanged; each freeze, sealed manifest, lifecycle event and correction link of the ${runClaims.length + 1} run Claims is byte-identical`,
  )
  const A7_MODULES = ['revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'closure-basis-trace', 'revenue-timeline', 'revenue-delta', 'revenue-continuity'].map((m) => `backend/src/modules/${m}`)
  check(
    'T100',
    'A7, A8.5 and CRG historical records identical',
    untouched([...A7_MODULES, 'backend/src/modules/coding-release', 'backend/src/modules/coding-validation', 'backend/src/modules/exception-remediation', A85_MIGRATION]) && ownerSnapshotNow.a7 === ownerSnapshotBefore.a7 &&
      ownerSnapshotNow.coding === ownerSnapshotBefore.coding && (await remediationHash()) === remediationHashBefore && withoutEvaluatedAt((await remediationDispositionOf(W)).body) === wRemediationBefore,
    "the A7 owners, the CRG coding-release and coding-validation modules, the A8.5 module and migration are unchanged; the A7 evidence, gate, case and prerequisite tables and the CRG tables hold exactly the rows they held; every earlier A8.5 event of this run is byte-identical and W's A8.5 disposition reads back the same",
  )

  // ---------------------------------------------------------------- backward regression (T101–T110)
  section('Backward regression — A8.5 invoked, nesting A8.3 -> A8.2 -> A8.1 -> A7.10 -> … -> A7.1 -> A6.10 -> … -> A5 -> A1')
  await apiReady('the A8.5 and backward regression chain')
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const goldenNow = async () => {
    const history = (await historyOf(W)).body
    return {
      history: withoutEvaluatedAt(history),
      disposition: withoutEvaluatedAt((await dispositionOf(W)).body),
      audits: JSON.stringify(await Promise.all(history.items.map(async (e: any) => (await auditsOfEvent(e.workEventId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))))),
      rows: await rowsHash(runIntakes.map((k) => k.intakeId)),
    }
  }
  const goldenBefore = await goldenNow()
  const chain = run('npm run test:a8:exception-remediation')
  const nestedLog = `a86-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A8.5')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A8.5] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A8.5 asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD, its own two runs) and re-proves
  // A8.3's branch-only causes against its own branch. On A8.6 those statements are obsolete by design; every other A8.5
  // check is substantive. T110 below proves each cause independently on this branch, down to A7.9.
  const a85NonApplicable: Record<string, string> = {
    T001: "A8.5 'A8.3 accepted merge is ancestor; clean main base' requires A8.5's own base (main c8ebf2c); A8.6 is cut from the main that contains A8.5 and Checkpoint B (T001 here)",
    T003: "A8.5 'Correct branch from main; clean tracked tree' requires the A8.5 feature branch; THIS branch's clean tree and parity are proved by T003 and T127 here",
    T010: "A8.5 'Diff allowlist excludes CRG/A9/later domains' lists the paths A8.5 was allowed to change; A8.6 legitimately changes its own (T010 here)",
    T110: "A8.5 'Every branch-only N/A justified; none substantive' proves A8.3's branch-only causes against the A8.5 branch; here every one is re-proved on this branch, down to A7.9 (T110)",
    T127: "A8.5 'Final clean git status and origin parity' compares HEAD with origin/feature/a8-5-…; THIS branch's parity is proved by T127 here",
    T129: "A8.5 'Independent run at the same exact HEAD' is the identity of A8.5's own two submitted runs; THIS run's identity is proved by T128 and T129 here",
  }
  const undocumented = failing.filter((id) => !(id in a85NonApplicable))
  const summary = chain.output.match(/\[A8\.5\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.5\] RUN ABORTED|\[A8\.5\] uncaught error|\[A8\.5\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a85Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  check(
    'T101',
    'A8.5 substantive regressions pass',
    ran && reconciled && undocumented.length === 0 && a85Passing === 130 - failing.length && a85Passing >= 124 &&
      ['T002', 'T004', 'T005', 'T006', 'T007', 'T008', 'T009', 'T011', 'T051', 'T059', 'T061', 'T071', 'T091', 'T092', 'T111', 'T112', 'T113', 'T114', 'T117', 'T118', 'T119', 'T120', 'T124', 'T128', 'T130'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A8.5 suite did not complete'
      : !reconciled
        ? `A8.5 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A8.5 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A8\.5\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A8.5] automated summary: ', 'A8.5 ')}; all ${a85Passing} substantive checks PASS (its own-scope T004/T007/T009, its RESTRICT-aware T051/T059 and later-phase-aware T092 included) and every failure is documented`,
  )
  check('T102', 'A8.4 duplicate remains closed', verdictOf('T002') === 'PASS' && a84Paths.length === 0, `A8.5 T002 (the A8.4 closure) ${verdictOf('T002')}; no A8.4 path exists at HEAD (T002 here)`)
  check('T103', 'A8.3 substantive regressions pass', verdictOf('T101') === 'PASS', `A8.5 T101 (A8.3, with its own documented branch-only items) ${verdictOf('T101')}`)
  check('T104', 'A8.2 and A8.1 substantive regressions pass', ['T102', 'T103'].every((id) => verdictOf(id) === 'PASS'), `A8.5 T102 (A8.2) ${verdictOf('T102')} and T103 (A8.1) ${verdictOf('T103')}`)
  check('T105', 'A7.10 and A7.1–A7.9 regressions pass', ['T104', 'T105'].every((id) => verdictOf(id) === 'PASS'), `A8.5 T104 (A7.10) ${verdictOf('T104')} and T105 (A7.1–A7.9) ${verdictOf('T105')}`)
  check('T106', 'A6.10 and A6.1–A6.9 regressions pass', verdictOf('T106') === 'PASS', `A8.5 T106 (A6.10, which nests A6.9 → A6.1) ${verdictOf('T106')}`)
  check('T107', 'A5.1–A5.10 substantive regressions pass', verdictOf('T107') === 'PASS', `A8.5 T107 (the chain reaching A5.10 → A5.1) ${verdictOf('T107')}`)
  const a3Scope = run('npm run test:a3:scope')
  check('T108', 'A4/A3/A2/A1 substantive regressions pass', ['T108', 'T109'].every((id) => verdictOf(id) === 'PASS') && a3Scope.ok, `A8.5 T108 (A4 → A1, A3 included) ${verdictOf('T108')} and T109 (A2 → A1) ${verdictOf('T109')}; the A3.9 scope suite over this branch's files ${a3Scope.ok ? 'PASS' : 'FAIL'}`)
  let naPrinted = 0
  for (const id of Object.keys(a85NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) {
      notApplicableCheck(`T109/${id}`, `A8.5 ${titleOf(row.line)}`, a85NonApplicable[id])
      naPrinted += 1
    }
  }
  check(
    'T109',
    'Historical branch-only failures explained',
    ran && naPrinted === failing.length && failing.length > 0 && failing.every((id) => a85NonApplicable[id].length > 80),
    `each of the ${failing.length} A8.5 failures (${failing.join(', ') || 'none'}) is printed individually with its original-branch explanation and the owner test on this branch that replaces it`,
  )
  // Each documented failure must fail for its branch-only cause, proved independently on this branch from its own line
  // and this branch's state, all the way down: A8.5 T110's A8.3 items, A8.3 T119's A8.2 items, A8.2 T120's A8.1 items,
  // A8.1 T110's A7.10 items and A7.10 T111's A7.9 items, down to A7.9 T120's A7.8 items. A depth may fail only with its
  // documented branch-only items, each exactly once; every item its aggregator names must fail at the next depth.
  const headSha = git('rev-parse HEAD')
  const originHead = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a86Branch}`])
  const shortMain = git('rev-parse --short=7 origin/main')
  const thisBranchClean = (line: string) => line.includes(`## ${a86Branch}...origin/${a86Branch}`) && !/ahead|behind/.test(line.split(`## ${a86Branch}...origin/${a86Branch}`)[1]?.split(';')[0] ?? 'ahead')
  const NESTED_BRANCH_ONLY: { tag: string; aggregator: string; ids: string[] }[] = [
    { tag: 'A8.3', aggregator: 'T119', ids: ['T001', 'T002', 'T010', 'T119', 'T130'] },
    { tag: 'A8.2', aggregator: 'T120', ids: ['T001', 'T002', 'T010', 'T120', 'T130'] },
    { tag: 'A8.1', aggregator: 'T110', ids: ['T001', 'T002', 'T010', 'T110', 'T130'] },
    { tag: 'A7.10', aggregator: 'T111', ids: ['T001', 'T002', 'T010', 'T111', 'T122', 'T123', 'T130'] },
    { tag: 'A7.9', aggregator: 'T120', ids: ['T001', 'T002', 'T010', 'T120', 'T130'] },
  ]
  const A78_BRANCH_ONLY = ['T001', 'T002', 'T010', 'T120', 'T130']
  const escapeTag = (tag: string) => tag.replace(/[.-]/g, (c) => `\\${c}`)
  const nestedFails = (depth: number) => {
    const pattern = new RegExp(`^\\[A8\\.5\\] +${NESTED_BRANCH_ONLY.slice(0, depth + 1).map((d) => `nested: \\[${escapeTag(d.tag)}\\] +`).join('')}(T\\d{3}) .* \\.{3,} FAIL - (.*)$`)
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
  const nestedItemProved = (depth: number, id: string, detail: string, count: number): boolean => {
    const level = NESTED_BRANCH_ONLY[depth]
    if (id === 'T001') return detail.startsWith(`branch ${a86Branch};`) && detail.includes(`latest main ${shortMain}`) && /\bas [0-9a-f]{7,40}\b/.test(detail) && [...detail.matchAll(/\bas ([0-9a-f]{7,40})\b/g)].every((m) => gitOk(`merge-base --is-ancestor ${m[1]} HEAD`))
    if (id === 'T002') return detail.startsWith('working tree clean;') && thisBranchClean(detail)
    if (id === 'T010') return outOfScope.length === 0 && pathsInScope(listAfter(detail, /^unexpected: (.*)$/))
    if (id === level.aggregator) {
      const unproven = listAfter(detail, /^cause not proven for: (.*)$/)
      return depth === NESTED_BRANCH_ONLY.length - 1 ? unproven.length > 0 && new Set(unproven).size === unproven.length && unproven.every((x) => A78_BRANCH_ONLY.includes(x)) : nestedDepthProved(depth + 1, unproven)
    }
    // T122, T123 and T130 are the identity of the historical branch's own runs: here they name THIS exact pushed HEAD.
    const counted = detail.match(/^(\d+) of the 129 checks before this one PASS, (\d+) FAIL/)
    return originHead === headSha && (detail.includes(headSha) || thisBranchClean(detail)) && (!counted || (Number(counted[2]) === count - 1 && Number(counted[1]) === 129 - (count - 1)))
  }
  const a85Line = (id: string) => (rows.find((r) => r.id === id && r.verdict === 'FAIL')?.line ?? '')
  const causes: Record<string, () => boolean> = {
    T001: () => /A8\.3 merged as [0-9a-f]{7} .*an ancestor/.test(a85Line('T001')) && a85Line('T001').includes(`latest main ${git('rev-parse --short origin/main')} contained`) && gitOk(`merge-base --is-ancestor ${A85_MERGE} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    T003: () => a85Line('T003').includes(`branch ${a86Branch}`) && a85Line('T003').includes('working tree clean') && thisBranchClean(a85Line('T003')),
    T010: () => outOfScope.length === 0 && pathsInScope(listAfter(detailOf(a85Line('T010')), /^unexpected: (.*)$/)),
    T110: () => originHead === headSha && nestedDepthProved(0, listAfter(detailOf(a85Line('T110')), /^cause not proven for: (.*)$/)),
    T127: () => a85Line('T127').includes(`HEAD ${headSha}`) && thisBranchClean(a85Line('T127')) && /the tree is clean after every check/.test(a85Line('T127')),
    T129: () => a85Line('T129').includes(`HEAD ${headSha.slice(0, 12)}`),
  }
  const unprovenHere = failing.filter((id) => !(id in causes) || !causes[id]())
  // Every original nested FAIL result is kept verbatim with its N/A category, as the Checkpoint B review asked. An N/A
  // may only be a BRANCH item (branch name or base ancestry), a HEAD item (clean tree, origin parity, or a run's own
  // identity at its exact HEAD), a SCOPE item (the paths that package was allowed to change) or an AGGREGATE item (a
  // suite's own "every branch-only N/A justified" check, whose items are each re-proved above). Any other kind fails T110.
  type Category = 'BRANCH' | 'HEAD' | 'SCOPE' | 'AGGREGATE'
  const a85Category: Record<string, Category> = { T001: 'BRANCH', T003: 'BRANCH', T010: 'SCOPE', T110: 'AGGREGATE', T127: 'HEAD', T129: 'HEAD' }
  const categoryOf = (tags: string[], id: string): Category | null => {
    if (tags.length === 0) return a85Category[id] ?? null
    if (tags.length > NESTED_BRANCH_ONLY.length || tags.some((tag, i) => tag !== NESTED_BRANCH_ONLY[i].tag)) return null
    const level = NESTED_BRANCH_ONLY[tags.length - 1]
    if (!level.ids.includes(id)) return null
    return id === 'T001' ? 'BRANCH' : id === 'T010' ? 'SCOPE' : id === level.aggregator ? 'AGGREGATE' : ['T002', 'T122', 'T123', 'T130'].includes(id) ? 'HEAD' : null
  }
  const nestedEvidence = chain.output
    .split(/\r?\n/)
    .map((line) => ({ line, m: line.match(/^\[([^\]]+)\]((?: +nested: \[[^\]]+\])*) +(\S+) .* \.{3,} FAIL - /) }))
    .filter((x): x is { line: string; m: RegExpMatchArray } => x.m !== null && x.m[1] === 'A8.5')
    .map(({ line, m }) => {
      const tags = [...m[2].matchAll(/nested: \[([^\]]+)\]/g)].map((t) => t[1])
      return { line, tags, id: m[3], category: categoryOf(tags, m[3]), reason: tags.length === 0 ? (a85NonApplicable[m[3]] ?? '') : '' }
    })
  const uncategorized = nestedEvidence.filter((e) => e.category === null)
  const evidenceLog = `a86-nested-evidence-${runId}.log`
  const evidenceText = [
    `A8.6 — nested regression evidence, run ${runId} at HEAD ${headSha}`,
    'Every original nested FAIL result, verbatim, with its N/A category (BRANCH | HEAD | SCOPE | AGGREGATE); a top-level item also carries its reason.',
    `The full nested output is kept in ${nestedLog}.`,
    '',
    ...nestedEvidence.flatMap((e) => [`[${e.category ?? 'UNCATEGORIZED'}] ${e.line}`, ...(e.reason ? [`    reason: ${e.reason}`] : [])]),
    '',
  ].join('\n')
  writeFileSync(evidenceLog, evidenceText)
  const categoryCounts = (['BRANCH', 'HEAD', 'SCOPE', 'AGGREGATE'] as Category[]).map((c) => `${nestedEvidence.filter((e) => e.category === c).length} ${c}`).join(', ')
  check(
    'T110',
    'No substantive failure relabeled N/A',
    ran && undocumented.length === 0 && unprovenHere.length === 0 && failing.length > 0 && uncategorized.length === 0 &&
      failing.every((id) => nestedEvidence.some((e) => e.tags.length === 0 && e.id === id)) && existsSync(evidenceLog),
    undocumented.length > 0
      ? `undocumented A8.5 failures: ${undocumented.join(', ')}`
      : unprovenHere.length > 0
        ? `cause not proven for: ${unprovenHere.join(', ')}`
        : uncategorized.length > 0
          ? `not a branch, HEAD or scope item: ${uncategorized.map((e) => [...e.tags, e.id].join('>')).join(', ').slice(0, 300)}`
          : `each documented A8.5 failure (${failing.join(', ')}) fails only for its branch-only cause, proved on this branch from its own line — T110's A8.3 items re-proved at every depth down to A7.9; all ${nestedEvidence.length} original nested FAIL lines kept verbatim in backend/${evidenceLog} — ${categoryCounts}, no other kind`,
  )

  // ---------------------------------------------------------------- build and restart (T111–T120)
  section('Build and restart: units, typecheck, frontend lint and build, Prisma status and migration count, checksums, a scratch replay, outage and recovery, no 5xx, UTF-8/UTC/timezone/locale determinism')
  const allUnit = run('npm run test:unit')
  check('T111', 'Backend unit tests incl. A8.6 pass', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok, `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 10 A8.6 reducer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T112', 'Backend typecheck passes', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T113', 'Frontend lint passes', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T114', 'Frontend production build passes', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  check(
    'T115',
    'Prisma status and migration count exact',
    status.ok && /Database schema is up to date/.test(status.output) && applied.length === headMigrationDirs.length && same(applied.map((r) => r.name), headMigrationDirs.map((d) => d.split('/').pop())),
    `prisma status up to date; exactly the ${headMigrationDirs.length} committed migrations are applied, in order, the newest being ${MIGRATION_NAME}`,
  )
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = applied.filter((row) => {
    const blob = committedBlob(`backend/prisma/migrations/${row.name}/migration.sql`)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  const generatedAgain = run('npm run db:generate')
  check(
    'T116',
    'All historical migration checksums unchanged',
    checksumMismatch.length === 0 && generatedAgain.ok && git('status --porcelain') === '',
    checksumMismatch.length === 0 ? `all ${applied.length} applied migrations carry the checksum of their committed file (A8.6's included); the client regenerates without changing any tracked file` : `checksum differs: ${checksumMismatch.map((r) => r.name).join(', ')}`,
  )
  const restrictLines = (replay.output.match(/PASS {2}exception_remediation_work_events_\w+_fkey is present after a clean replay/g) ?? []).length
  check(
    'T117',
    'Scratch replay keeps checks, guards, RESTRICT',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && restrictLines === 8 && /PASS {2}exception_remediation_work_events_append_only_trg is present/.test(replay.output) &&
      /PASS {2}exception_remediation_work_events_no_truncate_trg is present/.test(replay.output) && /PASS {2}exception_remediation_work_events_shape_chk is present/.test(replay.output),
    `scratch replay from empty: ${appliedCount} migrations, ALL CHECKS PASS; the insert guard, append-only and no-truncate triggers, every CHECK and all ${restrictLines} RESTRICT keys survive (T006)`,
  )
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
  check('T118', 'DB outage gives truthful health/ready', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  // No pg "client.query() while already executing" deprecation in this process or in any process of the nested chain
  // (its output carries each suite's stderr).
  const nestedDriverWarnings = (chain.output.match(/Calling client\.query\(\) when the client is already executing a query/g) ?? []).length
  check(
    'T119',
    'No unexpected HTTP 5xx or resets',
    serverErrors === 0 && connectionResets === 0 && driverWarnings.length === 0 && nestedDriverWarnings === 0,
    `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run; ${driverWarnings.length + nestedDriverWarnings} pg client.query() deprecation warnings in this process and the nested chain`,
  )
  const deterministic = ['Asia/Dubai', 'America/Los_Angeles', 'UTC'].map((tz) =>
    run(`node --input-type=module -e "import { deriveWork } from './src/modules/exception-remediation-work/exception-remediation-work.reducer.ts'; const i = JSON.parse(process.env.A86_DERIVE_INPUT); process.stdout.write(JSON.stringify(deriveWork(i.parent, i.plan, i.events)))"`, {
      TZ: tz, LANG: 'ar_AE.UTF-8', LC_ALL: 'ar_AE.UTF-8', A86_DERIVE_INPUT: JSON.stringify({ parent: parentOf(W), plan: wPlan, events: wStored }),
    }),
  )
  const inProcess = JSON.stringify(deriveWork(parentOf(W), wPlan, JSON.parse(JSON.stringify(wStored))))
  const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  const finalHistory = (await historyOf(W)).body
  check(
    'T120',
    'UTF-8/UTC/timezone/locale deterministic',
    deterministic.every((r) => r.ok && r.output === inProcess) && finalHistory.items.every((e: any) => isoUtc.test(e.recordedAt)) && isoUtc.test(finalHistory.evaluatedAt) &&
      Buffer.from(JSON.stringify(finalHistory), 'utf8').toString('utf8') === JSON.stringify(finalHistory),
    "W's stored history derives byte-identically under Asia/Dubai, America/Los_Angeles and UTC with an Arabic UTF-8 locale; every event time and evaluatedAt is ISO-8601 UTC (Z); the answers are UTF-8 clean",
  )

  // ---------------------------------------------------------------- evidence final (T121–T130)
  section('Evidence final: the worked workflow through owner routes, plan approval -> report -> verification with nothing executed, independent actors, row hashes after the restart, the catalog, no sensitive values, clean parity, two runs, the handoff')
  const runEventMembers = await prisma.$queryRawUnsafe<{ org: string; member: string | null }[]>(
    `SELECT e.organization_id::text AS org, u.email AS member FROM ${TABLE} e JOIN organization_memberships m ON m.id = e.recorded_by_membership_id JOIN "user" u ON u.id = m.user_id WHERE e.recorded_at >= $1::timestamptz AND e.recorded_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  check(
    'T121',
    'One synthetic worked workflow via owner routes',
    W.status === 201 && W_CLASSIFY.sequence === 1 && W_ASSIGN.sequence === 2 && IW.statuses.every((s) => s === 201) && same(PW.statuses, [201, 201]) && [RW1, V1].every((r) => r.status === 201) &&
      runEventMembers.length >= 12 && runEventMembers.every((e) => e.org === org && /@reviewers\.sbn\.test$/.test(e.member ?? '')) && (await eventsOf(F.intakeId)).length === 0,
    `W was built entirely through its owners' routes: A6 Claim frozen twice, A8.1 intake, A8.2 classify and assign to M1, A8.3 link and finding, A8.5 proposal by M1 and approval by RV, then the A8.6 report by M1 and verification by VR; all ${runEventMembers.length} work events this run belong to the synthetic Org A and were recorded by synthetic members only; Org B's intake has none`,
  )
  const goldenAfter = await goldenNow()
  progress(
    `worked remediation work: Claim W ${W.claimId}, intake ${W.intakeId} (A8.2 classify → assign M1; A8.3 link → finding; A8.5 REQUEST_INTERNAL_DOCUMENTATION_CHECK by M1 → APPROVE_PROPOSAL by RV): RW1 DOCUMENTATION_CHECK_REPORTED citing the A8.3 finding by M1 → V1 EVIDENCE_SUPPORTED by VR; VERIFIED_INTERNAL_WORK, 2 events, 2 audits; nothing executed, corrected or resolved`,
  )
  check(
    'T122',
    'Plan approval → report → verification only',
    same(finalHistory.items.map((e: any) => [e.sequence, e.eventCode, e.verificationCode, e.recordedByMembershipId]), [[1, 'RECORD_WORK_REPORT', null, M1.membershipId], [2, 'VERIFY_WORK_REPORT', 'EVIDENCE_SUPPORTED', VR.membershipId]]) &&
      same(goldenAfter, goldenBefore) && (await remediationDispositionOf(W)).body.state === 'APPROVED_FOR_PLANNING' && (await snap()).claims === ownerSnapshotBefore.claims,
    "W's history is exactly report → verification against the approved plan; after the nested chain, its database restarts and an outage, the events, the disposition, their audits and every run row read back identically; A8.5 still says APPROVED_FOR_PLANNING (planning only) and no Claim changed",
  )
  const wAudits = await Promise.all([RW1_ID, V1_ID].map(async (id) => (await auditsOfEvent(id))[0]))
  const nAudits = await Promise.all([RN1_ID, VN_ID].map(async (id) => (await auditsOfEvent(id))[0]))
  check(
    'T123',
    'Independent actor audit records exact',
    wAudits[0]?.actorUserId === M1.id && wAudits[1]?.actorUserId === VR.id && (wAudits[0]?.afterState as any)?.recordedByMembershipId === M1.membershipId && (wAudits[1]?.afterState as any)?.recordedByMembershipId === VR.membershipId &&
      nAudits[0]?.actorUserId === M4.id && nAudits[1]?.actorUserId === RV.id && (wAudits[1]?.afterState as any)?.workReportEventId === RW1_ID && (nAudits[1]?.afterState as any)?.reasonCode === 'SOURCE_MISMATCH',
    "W's report audit names M1 and its verification audit VR (different user and membership, naming the exact report); N's report audit names M4 and its NOT_VERIFIED audit RV, the A8.5 approver, with its reason",
  )
  check(
    'T124',
    'All recorded row hashes stable after restart',
    (await rowsHash(runIntakes.map((k) => k.intakeId))) === rowsBeforeOutage && rowsBeforeOutage === goldenBefore.rows && (await agreeAll()),
    "every work row of this run's intakes hashes exactly as before the nested chain and before the database outage; history and disposition still agree for every intake after the restart",
  )
  const catalog = {
    indexes: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT indexname AS n FROM pg_indexes WHERE tablename = '${TABLE}' ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    checks: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT conname AS n FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND contype = 'c' ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    triggers: (await prisma.$queryRawUnsafe<{ n: string }[]>(`SELECT tgname AS n FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND NOT tgisinternal ORDER BY 1`)).map((r) => r.n.replace(`${TABLE}_`, '')),
    foreignKeys: (await fksOf(TABLE)).map((r) => `${r.name.replace(`${TABLE}_`, '')}:${r.del === 'r' ? 'RESTRICT' : r.del}`),
  }
  check(
    'T125',
    'All constraints, keys and triggers enumerated',
    same(catalog.indexes, ['approved_proposal_event_i_idx', 'basis_reference_id_idx', 'claim_id_idx', 'organization_id_idx', 'pkey', 'recorded_by_membership_id_idx', 'recorded_by_user_id_idx', 'sequence_key', 'work_report_event_id_key']) &&
      same(catalog.checks, ['contract_chk', 'event_code_chk', 'sequence_chk', 'shape_chk']) && same(catalog.triggers, ['append_only_trg', 'insert_guard_trg', 'no_truncate_trg']) && catalog.foreignKeys.length === 8 &&
      catalog.foreignKeys.every((fk) => fk.endsWith(':RESTRICT')),
    `indexes ${catalog.indexes.join(', ')}; CHECKs ${catalog.checks.join(', ')}; triggers ${catalog.triggers.join(', ')}; keys ${catalog.foreignKeys.join(', ')}`,
  )
  const storedText = JSON.stringify(await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${TABLE} WHERE claim_id = ANY($1::uuid[])`, runClaims), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  const dtoText = JSON.stringify([finalHistory, (await dispositionOf(W)).body, (await historyOf(N)).body, (await dispositionOf(Q)).body])
  const repositoryCode = committedCode(`${MODULE_DIR}/exception-remediation-work.repository.ts`)
  check(
    'T126',
    'No sensitive values in DTO, audit or logs',
    !COLUMNS.some((c) => /patient|name|birth|email|phone|address|diagnos|clinician|encounter|amount|currency|payer|narrative|note|text|payload|hash|digest|status|current|latest/.test(c)) &&
      !dtoKeys.some((k) => /patient|name|birth|email|diagnos|clinician|encounter|amount|currency|payer|narrative|note|payload|hash|digest/i.test(k)) &&
      ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), key('home-PA'), 'AED', '125.25', '12.125', M1.email, VR.email, 'Synthetic member', 'Synthetic finding.'].some((value) => storedText.includes(value) || dtoText.includes(value) || auditText.includes(value)) &&
      !/from 'node:(http|https|net|tls|dgram|fs|child_process)'|\bfetch\(|axios|console\.|logger\.|process\.stdout|enqueue|setInterval|worker_threads|cron/.test(moduleCode) &&
      !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|setInterval|setTimeout|navigator\.sendBeacon|WebSocket|EventSource/.test(feCode) && !/method: '(POST|PUT|PATCH|DELETE)'/.test(feCode) &&
      /orderBy: \{ sequence: 'asc' \}/.test(repositoryCode) && !/findFirst\(/.test(moduleCode),
    'no patient, member contact, clinical, diagnosis, amount, currency, payer, narrative, payload, digest or status column or DTO key, and no such value in any stored event, answer or audit; the module logs nothing and opens no network, file or queue; the page only reads, stores nothing and logs nothing; events are read in their server-owned sequence only',
  )
  const headNow = git('rev-parse HEAD')
  check(
    'T127',
    'Git status clean; remote parity exact',
    headNow === headAtStart && headNow === originHead && headNow.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a86Branch}`) && !/ahead|behind/.test(tracking) && outOfScope.length === 0,
    `HEAD ${headNow} = origin/${a86Branch}; ${tracking}; the tree is clean after every check (the nested log is ignored output)`,
  )
  const checksBefore128 = passed + failed
  check(
    'T128',
    'First full run: 130 assertions with run id',
    checksBefore128 === 127 && /^A86-\d{13}$/.test(runId) && headNow === headAtStart && existsSync(nestedLog) && existsSync(evidenceLog),
    `run ${runId} at ${headNow}: all 127 checks before this one executed (${passed} PASS); nested output kept in backend/${nestedLog} (SHA-256 ${sha256Of(Buffer.from(chain.output)).slice(0, 16)}…), nested evidence in backend/${evidenceLog} (SHA-256 ${sha256Of(Buffer.from(evidenceText)).slice(0, 16)}…)`,
  )
  const earlierRuns = readdirSync('.')
    .filter((name) => /^a86-nested-A86-\d{13}\.log$/.test(name) && name !== nestedLog)
    .filter((name) => readFileSync(name, 'utf8').includes(`[A8.5] HEAD ${headNow}`))
    .map((name) => name.replace(/^a86-nested-|\.log$/g, ''))
  const runIntakeIds = new Set(runIntakes.map((k) => k.intakeId))
  check(
    'T129',
    'Second independent run at same exact HEAD',
    !earlierRuns.includes(runId) && headNow === headAtStart && headNow === originHead && runEventsSoFar.every((e) => runIntakeIds.has(e.exceptionIntakeId)) && runEventMembers.every((e) => /@reviewers\.sbn\.test$/.test(e.member ?? '')),
    `run ${runId} used only fixtures and members it created itself; ${earlierRuns.length > 0 ? `earlier kept run(s) at this HEAD: ${earlierRuns.join(', ')}` : 'no earlier run at this HEAD is kept here, so this is the first'}; the two submitted runs must both state HEAD ${headNow.slice(0, 12)} with different runIds`,
  )
  const typesText = committedText(`${MODULE_DIR}/exception-remediation-work.types.ts`)
  const vocabulary = [...workEventCodes, ...workCodes, ...basisReferenceKinds, ...verificationCodes, ...verificationReasonCodes, ...workStates, CONTRACT]
  check(
    'T130',
    'Handoff: execution and closure OUT OF SCOPE',
    registerFlat.includes('## Out of scope (handoff)') && registerFlat.includes('executing any A8.5 action') && registerFlat.includes('resolving or closing an exception') && registerFlat.includes('attestation') &&
      registerAtHead.includes(A85_MERGE) && registerAtHead.includes(CRGB_MERGE) && registerAtHead.includes(MAIN_AT_START) && registerAtHead.includes(`(${CONTRACT})`) &&
      vocabulary.every((code) => registerAtHead.includes(`\`${code}\``) && typesText.includes(`'${code}'`)) &&
      ['getExceptionIntakesOf', 'getTriageDispositionOf', 'getInvestigationHistoryOf', 'getRemediationDispositionOf', 'getRemediationHistoryOf', 'assigneeCurrentlyEligible', 'getWorkDispositionOf'].every((t) => registerAtHead.includes(t)),
    `the register records the start gate (A8.5 merge ${A85_MERGE.slice(0, 7)}, Checkpoint B merge ${CRGB_MERGE.slice(0, 7)}, main ${MAIN_AT_START.slice(0, 7)}), the owner readers, ${CONTRACT} and all ${vocabulary.length} controlled codes (each identical in the module), a report as an attestation only, and execution, resolution and closure as later, separately approved work`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] REMEDIATION WORK ACCEPTANCE COMPLETE` : `[${TAG}] A8.6 FINAL FAIL`)
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
