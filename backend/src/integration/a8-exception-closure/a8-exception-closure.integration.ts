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
import { recordEscalationEvent } from '../../modules/exception-escalation/exception-escalation.service.ts'
import { WORK_CODE_OF_ACTION } from '../../modules/exception-remediation-work/exception-remediation-work.types.ts'
import { getSubmissionCodingProvenance } from '../../modules/coding-validation/coding-validation.service.ts'
import { deriveClosure, eligibilityOf } from '../../modules/exception-closure/exception-closure.reducer.ts'
import {
  getClosureHistory,
  getClosureHistoryOf,
  getClosureReconstruction,
  getClosureReconstructionOf,
  recordClosureEvent,
  recordClosureEventOn,
} from '../../modules/exception-closure/exception-closure.service.ts'
import {
  CLOSURE_CONTRACT_VERSION,
  PARENT_READ_PERMISSIONS,
  basisReferenceKinds,
  closureEventCodes,
  closureReasonCodes,
  closureStates,
} from '../../modules/exception-closure/exception-closure.types.ts'

// A8.9 — focused acceptance for Internal Exception Closure & Historical Reconstruction (A8-CLOSURE-1, T001–T130).
//
// Every Claim, freeze, A8.1 intake, A8.2 triage event, A8.3 investigation event, A8.5 remediation event, A8.6 work event,
// A8.7 resolution event and A8.8 escalation event is built through its owners exactly as the A8.8 suite builds them: a
// Claim frozen twice without an A6.9 link, its intake recorded through the A8.1 route, classified and assigned through
// the A8.2 route, its assignee links and finds through the A8.3 route, proposes through the A8.5 route (approved by an
// independent reviewer), reports through the A8.6 route (verified by an independent verifier), requests an internal
// resolution through the A8.7 route (confirmed or returned by an independent decider) and, where an intake needs an A8.8
// position, escalates through the A8.8 route. Every closure is recorded through the A8.9 route by an independent
// confirmer or, where a probe must pause or fail one writer, through the production A8.9 service in this process. Direct
// SQL writes are adversarial only, run against the live guards (or, to isolate one CHECK, with the triggers off), and are
// ALWAYS rolled back; a broken stored history is planted only inside such a transaction and the production reads answer
// on THAT transaction. Synthetic users are provisioned per run through Better Auth's own server-side creation with a
// random password that is never printed; one synthetic role, created and removed again by this run, proves each of the
// seven upstream read permissions on its own. CLOSED_INTERNAL is an internal process position only: nothing in this
// suite expects, or finds, anything adjudicated, paid, corrected, reopened or sent.

const TAG = 'A8.9'
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

const runId = `A89-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a89Branch = 'feature/a8-9-closure-and-reconstruction'
const a88Branch = 'feature/a8-8-exception-escalation-followup'
const a87Branch = 'feature/a8-7-internal-exception-resolution'
const a86Branch = 'feature/a8-6-remediation-work-verification'
const a85Branch = 'feature/a8-5-exception-remediation'
const crgbBranch = 'feature/crg-01b-coding-validation-freeze'
const crgBranch = 'fix/crg-01-final-coding-release'
// The accepted A8.5, Checkpoint B, A8.6, A8.7 and A8.8 merges, all recorded in the register (start gate). The A8.8
// merge is the one this branch is cut from.
const A85_MERGE = '0f8f9d3bc18347b1360b72b93056724b594a6e00'
const CRGB_MERGE = '4869df3c81ac4af5dcec988768666f7acd3d809e'
const A86_MERGE = '18de6c81f9f47374d011cfe9a688b500b8c17beb'
const A87_MERGE = '8af18916428bf173d87c33653ed8350c75c1edcb'
const A88_ACCEPTED_HEAD = '76aaaa2e5f44e1ec303de0e6762c4df621e44de2'
const A88_MERGE = '012d6fd92b3b1990ff72a662a33a9a800328a9b6'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/exception-closure'
const FE_DIR = 'frontend/src/modules/exception-closure'
const HARNESS_DIR = 'backend/src/integration/a8-exception-closure'
const REGISTER_DOC = 'docs/A8_Exception_Closure.md'
// The one earlier suite this package corrects (at the head developer's decision, in this PR): A7.5's T095 judges every
// table that existed when A7.5 merged exactly as before, and leaves a later phase's own tables to that phase.
const A75_SUITE = 'backend/src/integration/a7-case-prerequisite/a7-case-prerequisite.integration.ts'
const MIGRATION_NAME = '20261112090000_a8_9_exception_closure'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const A88_MIGRATION = 'backend/prisma/migrations/20261111090000_a8_8_exception_escalation/migration.sql'
const A87_MIGRATION = 'backend/prisma/migrations/20261110090000_a8_7_exception_resolution/migration.sql'
const A86_MIGRATION = 'backend/prisma/migrations/20261107090000_a8_6_exception_remediation_work/migration.sql'
const A85_MIGRATION = 'backend/prisma/migrations/20261105090000_a8_5_exception_remediation/migration.sql'
const A83_MIGRATION = 'backend/prisma/migrations/20261103090000_a8_3_exception_investigation/migration.sql'
const TABLE = 'exception_closure_events'
const ESCALATION_TABLE = 'exception_escalation_events'
const RESOLUTION_TABLE = 'exception_resolution_events'
const WORK_TABLE = 'exception_remediation_work_events'
const REMEDIATION_TABLE = 'exception_remediation_events'
const INVESTIGATION_TABLE = 'exception_investigation_events'
const TRIAGE_TABLE = 'exception_triage_events'
const INTAKE_TABLE = 'exception_intake_records'
const UNIT_TESTS = [`${MODULE_DIR}/exception-closure.reducer.test.ts`, `${MODULE_DIR}/exception-closure.validation.test.ts`]
const CONTRACT = 'A8-CLOSURE-1'
const INTAKE_CONTRACT = 'A8-EXCEPTION-INTAKE-1'
const TIMELINE_CONTRACT = 'A7-REVENUE-TIMELINE-1'
const SEVEN_READS = ['exceptionIntake.read', 'exceptionTriage.read', 'exceptionInvestigation.read', 'exceptionRemediation.read', 'exceptionRemediationWork.read', 'exceptionResolution.read', 'exceptionEscalation.read']
const EVENT_KEYS = [
  'closureEventId', 'contractVersion', 'exceptionIntakeId', 'organizationId', 'claimId', 'sequence', 'eventCode', 'resolutionDecisionEventId', 'closureReasonCode', 'basisReferenceKind',
  'basisReferenceId', 'basisOwnerContractVersion', 'recordedByMembershipId', 'recordedByUserId', 'recordedAt',
]
const HISTORY_KEYS = ['contractVersion', 'exceptionIntakeId', 'items', 'evaluatedAt']
const RECONSTRUCTION_KEYS = ['contractVersion', 'exceptionIntakeId', 'state', 'recordedClosure', 'chain', 'submissions', 'evaluatedAt']
const ENTRY_KEYS = ['position', 'owner', 'ownerContractVersion', 'recordId', 'sequence', 'eventCode']
const SUBMISSION_KEYS = ['submissionId', 'submissionContractVersion', 'codingVerificationStatus', 'codingContractVersion']
const AUDIT_KEYS = [
  'closureEventId', 'exceptionIntakeId', 'claimId', 'contractVersion', 'sequence', 'eventCode', 'resolutionDecisionEventId', 'closureReasonCode', 'basisReferenceKind', 'basisReferenceId',
  'basisOwnerContractVersion', 'recordedByMembershipId', 'recordedAt',
]
const COLUMNS = [
  'id', 'exception_intake_id', 'organization_id', 'claim_id', 'contract_version', 'sequence', 'event_code', 'resolution_decision_event_id', 'basis_reference_kind', 'basis_reference_id',
  'basis_owner_contract_version', 'closure_reason_code', 'recorded_by_membership_id', 'recorded_by_user_id', 'recorded_at', 'created_at',
]
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/shared/authorization/authorization.types.ts',
  'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'backend/src/modules/audit/audit.types.ts', 'frontend/src/developer/checkRegistry.tsx', REGISTER_DOC,
]
// Every table a closure write could conceivably touch, in a fixed key order. A read or a refusal must leave every one as
// it was; a recorded closure adds exactly one row here and one audit.
const COUNT_TABLES = [
  TABLE, ESCALATION_TABLE, RESOLUTION_TABLE, WORK_TABLE, REMEDIATION_TABLE, INVESTIGATION_TABLE, TRIAGE_TABLE, INTAKE_TABLE, 'audit_events', 'claims', 'claim_freezes',
  'claim_freeze_lifecycle_events', 'claim_correction_links', 'organization_memberships', 'membership_roles',
]
// The CRG-01 coding-release and validation tables and the A2 code masters: no closure selects, activates, imports or
// changes any of them.
const CODING_TABLES = [
  'crg_code_system_datasets', 'crg_code_system_rights', 'crg_release_imports', 'crg_release_code_memberships', 'crg_retirement_classifications', 'crg_validation_scopes', 'crg_validation_code_receipts',
  'crg_validation_receipt_manifests', 'procedure_codes', 'diagnosis_codes',
]
// The A7 historical records: a closure writes none of them.
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

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)
  // pg's concurrent-query deprecation, if it ever fires in this process (it is still printed); T117 requires none here
  // and none in any process of the nested chain.
  const driverWarnings: string[] = []
  process.on('warning', (warning) => {
    if (/Calling client\.query\(\) when the client is already executing a query/.test(warning.message)) driverWarnings.push(warning.message)
  })

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] A8.9 internal exception closure and historical reconstruction (${CONTRACT}) — run ${runId}`)
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
  for (const role of await prisma.role.findMany({ where: { code: { startsWith: 'SYNTHETIC_A89_' } }, select: { id: true } })) {
    await prisma.membershipRole.deleteMany({ where: { roleId: role.id } })
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
    await prisma.role.delete({ where: { id: role.id } })
  }

  // ---------------------------------------------------------------- start, ancestry and versions (T001–T010)
  section('Start, ancestry and versions: the accepted A8.6, A8.7 and A8.8 merges, the A8.4 closure, clean synchronized main, Checkpoint B in and C out, the owner reader matrix, the frozen eligibility and independence rules, one additive migration, the allowlist')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const shortMain = git('rev-parse --short=7 origin/main')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a85Merge = mergeOf(a85Branch)
  const a86Merge = mergeOf(a86Branch)
  const a87Merge = mergeOf(a87Branch)
  const a88Merge = mergeOf(a88Branch)
  const crgbMerge = mergeOf(crgbBranch)
  const crgMerge = mergeOf(crgBranch)
  const onMainAndHead = (sha: string) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} origin/main`) && gitOk(`merge-base --is-ancestor ${sha} HEAD`)
  check(
    'T001',
    'A8.6 approved merge SHA ancestor of main',
    branch === a89Branch && a86Merge === A86_MERGE && onMainAndHead(a86Merge) && a85Merge === A85_MERGE && onMainAndHead(a85Merge) && gitOk(`merge-base --is-ancestor ${A85_MERGE} ${A86_MERGE}`) &&
      gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; A8.6 merged as ${a86Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A86_MERGE.slice(0, 7)}) after A8.5 as ${a85Merge.slice(0, 7) || 'NOT FOUND'}, both ancestors of main and HEAD; latest main ${shortMain} contained; not stacked`,
  )
  check(
    'T002',
    'A8.7 approved merge SHA ancestor of main',
    a87Merge === A87_MERGE && onMainAndHead(a87Merge) && gitOk(`merge-base --is-ancestor ${A86_MERGE} ${A87_MERGE}`),
    `A8.7 merged as ${a87Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A87_MERGE.slice(0, 7)}, FINAL PASS), an ancestor of main and HEAD and a descendant of the A8.6 merge`,
  )
  check(
    'T003',
    'A8.8 approved merge SHA ancestor of main',
    a88Merge === A88_MERGE && onMainAndHead(a88Merge) && gitOk(`merge-base --is-ancestor ${A87_MERGE} ${A88_MERGE}`) && gitArgs(['rev-parse', `${A88_MERGE}^2`]) === A88_ACCEPTED_HEAD &&
      gitArgs(['rev-parse', `${A88_MERGE}^{tree}`]) === gitArgs(['rev-parse', `${A88_ACCEPTED_HEAD}^{tree}`]),
    `A8.8 merged as ${a88Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A88_MERGE.slice(0, 7)}, FINAL PASS), an ancestor of main and HEAD and a descendant of the A8.7 merge; its tree is exactly the accepted HEAD ${A88_ACCEPTED_HEAD.slice(0, 7)}`,
  )
  const registerAtHead = committedText(REGISTER_DOC)
  const registerFlat = registerAtHead.replace(/\s+/g, ' ')
  const headTree = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter(Boolean)
  const a84Paths = headTree.filter((path) => /(^|[\\/_-])a8[-_]?4([\\/_.-]|$)/i.test(path))
  check(
    'T004',
    'A8.4 duplicate officially closed',
    registerFlat.includes('On 2026-11-04 the architecture owner closed the earlier A8.4 specification as a duplicate of A8.3') && registerFlat.includes('No A8.4 code exists') && a84Paths.length === 0,
    a84Paths.length === 0 ? 'the register records the 2026-11-04 closure of A8.4 as a duplicate of A8.3; no A8.4 module, migration, suite or page exists at HEAD' : `A8.4 paths exist: ${a84Paths.join(', ').slice(0, 200)}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  const branchCommits = git('rev-list origin/main..HEAD').split(/\r?\n/).filter(Boolean)
  const branchMerges = git('rev-list --merges origin/main..HEAD').split(/\r?\n/).filter(Boolean)
  check(
    'T005',
    'Clean synchronized main source, no stacking',
    branch === a89Branch && dirty.length === 0 && tracking.includes(`origin/${a89Branch}`) && !/ahead|behind/.test(tracking) && gitArgs(['merge-base', 'HEAD', 'origin/main']) === gitArgs(['rev-parse', 'origin/main']) &&
      branchCommits.length >= 1 && branchMerges.length === 0 && gitOk(`merge-base --is-ancestor ${A88_MERGE} origin/main`),
    dirty.length === 0
      ? `working tree clean; ${tracking}; origin/main ${shortMain} (holding the A8.8 merge) is the merge base (synchronized); ${branchCommits.length} commit(s) of this branch alone, no merge commit, nothing stacked`
      : `uncommitted: ${dirty.length} path(s)`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const checkpointCPaths = headTree.filter((path) => /checkpoint[-_]?c\b|crg[-_]?01[-_]?c\b/i.test(path))
  check(
    'T006',
    'CRG-01B merge ancestor; C remains excluded',
    crgbMerge === CRGB_MERGE && onMainAndHead(crgbMerge) && crgMerge.length === 40 && onMainAndHead(crgMerge) && checkpointCPaths.length === 0 && !changedPaths.some((p) => /crg|coding-release|coding-validation|checkpoint/i.test(p)) &&
      registerFlat.includes('Checkpoint C, A9, A10 and A11 stay separate'),
    `Checkpoint B merged as ${crgbMerge.slice(0, 7) || 'NOT FOUND'} (the register's ${CRGB_MERGE.slice(0, 7)}) and Checkpoint A as ${crgMerge.slice(0, 7) || 'NOT FOUND'}, both ancestors; no Checkpoint C path exists and this branch changes no CRG file; the register keeps Checkpoint C, A9, A10 and A11 separate`,
  )
  // The owner matrix: every accepted reader the module consumes is named in the register and imported from its owner,
  // and every upstream literal the eligibility table names is the owner's own.
  const serviceText = committedCode(`${MODULE_DIR}/exception-closure.service.ts`)
  const READERS: [string, string][] = [
    ['getExceptionIntakesOf', 'exception-intake'], ['getTriageDispositionOf', 'exception-triage'], ['getTriageHistoryOf', 'exception-triage'], ['getInvestigationHistoryOf', 'exception-investigation'],
    ['getRemediationDispositionOf', 'exception-remediation'], ['getRemediationHistoryOf', 'exception-remediation'], ['getWorkDispositionOf', 'exception-remediation-work'], ['getWorkHistoryOf', 'exception-remediation-work'],
    ['getResolutionDispositionOf', 'exception-resolution'], ['getResolutionHistoryOf', 'exception-resolution'], ['getEscalationDispositionOf', 'exception-escalation'], ['getEscalationHistoryOf', 'exception-escalation'],
    ['findFreezesOfClaim', 'claim-submission'], ['getSubmissionCodingProvenanceOf', 'coding-validation'], ['getEffectivePermissions', 'authorization'],
  ]
  const importsOf = (text: string) => [...text.matchAll(/import \{([^}]+)\} from '([^']+)'/g)].map((m) => ({ names: m[1].split(',').map((n) => n.trim()), from: m[2] }))
  const serviceImports = importsOf(serviceText)
  const imported = (name: string, owner: string) => serviceImports.some((i) => i.names.includes(name) && i.from.includes(`/${owner}/`))
  const resolutionTypes = committedText('backend/src/modules/exception-resolution/exception-resolution.types.ts')
  const escalationTypes = committedText('backend/src/modules/exception-escalation/exception-escalation.types.ts')
  const UPSTREAM_STATES = { resolution: ['NO_RESOLUTION_REQUEST', 'AWAITING_RESOLUTION_DECISION', 'RETURNED_FOR_REWORK', 'RESOLVED_INTERNAL'], escalation: ['NO_ESCALATION', 'AWAITING_ACKNOWLEDGEMENT', 'FOLLOWUP_ACTIVE', 'RETURNED_TO_OWNER'] }
  check(
    'T007',
    'Exact owner reader/DTO/state matrix signed',
    READERS.every(([name, owner]) => imported(name, owner)) && READERS.slice(0, 12).every(([name]) => registerAtHead.includes(`\`${name}`)) &&
      resolutionTypes.includes(`RESOLUTION_CONTRACT_VERSION = 'A8-RESOLUTION-DECISION-1'`) && escalationTypes.includes(`ESCALATION_CONTRACT_VERSION = 'A8-ESCALATION-1'`) &&
      resolutionTypes.includes(`resolutionStates = [${UPSTREAM_STATES.resolution.map((s) => `'${s}'`).join(', ')}]`) && escalationTypes.includes(`escalationStates = [${UPSTREAM_STATES.escalation.map((s) => `'${s}'`).join(', ')}]`) &&
      [...UPSTREAM_STATES.resolution.slice(1), ...UPSTREAM_STATES.escalation].every((s) => registerAtHead.includes(`\`${s}\``)) && !/from '\.\.\/exception-[a-z-]+\/exception-[a-z-]+\.repository\.ts'/.test(serviceText),
    `the module imports each of the ${READERS.length} accepted readers from its own owner (A8.1–A8.8, the A6.7 freezes, the CRG coding status, the A1 permissions) and no earlier owner's repository; the register names every A8 reader; the basis owner contracts and the A8.7 and A8.8 states the eligibility table names are exactly those owners' literals`,
  )
  const reducerText = committedText(`${MODULE_DIR}/exception-closure.reducer.ts`)
  const migrationText = committedText(MIGRATION)
  check(
    'T008',
    'Closure eligibility and independence frozen',
    registerFlat.includes('## Eligibility (§3, CL-01, CL-02)') && registerFlat.includes('## Who may close (D1, D3)') &&
      ['**CL-01.**', '**CL-02.**', '**D1.**', '**D2.**', '**D3.**', '**D4.**', '**D5.**', '**D6.**', '**D7.**', '**D8.**', '**D9.**'].every((d) => registerAtHead.includes(d)) &&
      registerFlat.includes('| `RESOLVED_INTERNAL` | `NO_ESCALATION` | eligible: basis `RESOLUTION_DECISION`') && registerFlat.includes('| `RESOLVED_INTERNAL` | `RETURNED_TO_OWNER`, returned for `FOLLOWUP_RECORDED` | eligible (CL-01): basis `ESCALATION_RETURN`') &&
      registerFlat.includes('| `RESOLVED_INTERNAL` | `RETURNED_TO_OWNER`, returned for `FURTHER_WORK_REQUIRED` | refused (CL-01, v1)') && registerFlat.includes('**Architecture approval (2026-11-13).**') &&
      /returnReasonCode === 'FOLLOWUP_RECORDED'/.test(reducerText) && /exception_closure_eligibility: the intake''s A8\.8 escalation was returned for further work/.test(migrationText) &&
      registerFlat.includes('refused (CL-02): the escalation is outstanding') && /never closed by its A8\.7 resolution's own requester or decider/.test(reducerText) &&
      /exception_closure_independence: an exception is never closed by its A8\.7 resolution''s own requester or decider/.test(migrationText) && /exception_closure_eligibility: the intake''s A8\.8 escalation is still outstanding/.test(migrationText),
    'the register freezes the eligibility table, as the architecture owner approved it (CL-01 eligible on an A8.8 return for FOLLOWUP_RECORDED and refused for FURTHER_WORK_REQUIRED, CL-02 refused while an escalation is outstanding, no resolution refused), the confirmer rule (confirm permission now, independent of the A8.7 requester and decider, assigned now) and decisions CL-01, CL-02 and D1–D9; the reducer and the database guard hold the same rules',
  )
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  // A8.9's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge added
  // (the same values, literally, on its own branch). A later package's changes are that package's to prove.
  const ownMerge = branch === a89Branch ? '' : mergeOf(a89Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownBase = ownMerge ? gitArgs(['rev-parse', `${ownMerge}^1`]) : 'origin/main'
  const ownTip = ownMerge || 'HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = migrationDirsAt(ownTip)
  const ownBaseMigrationDirs = migrationDirsAt(ownBase)
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check(
    'T009',
    'Only one additive A8.9 migration',
    same(ownPrismaStatus, [`A\t${MIGRATION}`, 'M\tbackend/prisma/schema.prisma']) && ownHeadMigrationDirs.length === ownBaseMigrationDirs.length + 1 && ownBaseMigrationDirs.every((dir) => ownHeadMigrationDirs.includes(dir)) &&
      ownHeadMigrationDirs[ownHeadMigrationDirs.length - 1].endsWith(MIGRATION_NAME) && validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output) &&
      same([...migrationText.matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]), [TABLE]) && !/ALTER TABLE "(?!exception_closure_events")/.test(migrationText),
    `exactly one migration added (${MIGRATION_NAME}, the newest in its own scope, creating only ${TABLE} and altering no other table) and the schema extended; all ${ownBaseMigrationDirs.length} applied migrations before it untouched; the schema validates and generates and the working database is up to date (never reset)`,
  )
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  const catalogueAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/authorization/authorization.types.ts`]).matchAll(/^\s+'([A-Za-z_]+\.[A-Za-z_]+)',/gm)].map((m) => m[1])
  const auditCodesAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/modules/audit/audit.types.ts`]).matchAll(/^\s+'([a-z_]+\.[a-z_]+)',/gm)].map((m) => m[1])
  const catalogueHead = catalogueAt(ownTip)
  const catalogueMain = catalogueAt(ownBase)
  const laterPermissions = ownMerge ? catalogueAt('HEAD').filter((c) => !catalogueHead.includes(c)) : []
  const auditHead = auditCodesAt(ownTip)
  const auditMain = auditCodesAt(ownBase)
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const CLOSURE_PERMISSIONS = ['exceptionClosure.confirm', 'exceptionClosure.read']
  const knownException = [
    'exceptionIntake.create', 'exceptionIntake.read', 'exceptionTriage.read', 'exceptionTriage.record', 'exceptionInvestigation.read', 'exceptionInvestigation.record', 'exceptionRemediation.propose',
    'exceptionRemediation.review', 'exceptionRemediation.read', 'exceptionRemediationWork.read', 'exceptionRemediationWork.record', 'exceptionRemediationWork.verify', 'exceptionResolution.request',
    'exceptionResolution.decide', 'exceptionResolution.read', 'exceptionEscalation.handle', 'exceptionEscalation.raise', 'exceptionEscalation.read', 'exceptionEscalation.review', ...CLOSURE_PERMISSIONS,
  ]
  const contractConstantsAt = (ref: string) =>
    gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, 'backend/src/modules'])
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path) && !path.startsWith(`${MODULE_DIR}/`))
      .flatMap((path) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(/export const ([A-Z_0-9]*CONTRACT_VERSION[A-Z_0-9]*) = '([^']+)'/g)].map((m) => `${path}:${m[1]}=${m[2]}`))
      .sort()
  const errorCodesAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/errors/error.types.ts`]).matchAll(/^\s+'([A-Z_]+)',/gm)].map((m) => m[1])
  // Every applied migration before A8.9, hashed at its own base and at its own tip: none may change.
  const migrationBytesAt = (ref: string, dirs: string[]) => sha256Of(Buffer.from(dirs.map((dir) => gitArgs(['show', `${ref}:${dir}/migration.sql`])).join('\n')))
  const contractsOwn = contractConstantsAt(ownTip)
  const errorsOwn = errorCodesAt(ownTip)
  const errorsBase = errorCodesAt(ownBase)
  const productDiff = ownChangedPaths.filter((p) => /^backend\/src\/modules\//.test(p) && !p.startsWith(`${MODULE_DIR}/`) && p !== 'backend/src/modules/audit/audit.types.ts')
  const ownEarlierSuites = ownChangedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`) && file !== A75_SUITE)
  // The A7.5 correction, as code lines (comments and blank lines aside): exactly one line removed and one added, the old
  // T095 table list and the same list excluding later-phase tables; every A7.5 check id and title is unchanged.
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
  const a75Base = gitArgs(['show', `${ownBase}:${A75_SUITE}`])
  const a75Tip = gitArgs(['show', `${ownTip}:${A75_SUITE}`])
  const a75Removed = multisetMinus(codeLines(a75Base), codeLines(a75Tip))
  const a75Added = multisetMinus(codeLines(a75Tip), codeLines(a75Base))
  const a75Checks = (text: string) => [...text.matchAll(/check\(\s*'(T\d{3})',\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`)
  const a75Correction =
    !ownChangedPaths.includes(A75_SUITE) ||
    (a75Removed.length === 1 && a75Added.length === 1 && /^const closureTables = \(await prisma\.\$queryRaw<.*\.map\(\(row\) => row\.t\)$/.test(a75Removed[0]) &&
      a75Added[0] === `${a75Removed[0]}.filter((t) => !laterPhaseTables.has(t))` && same(a75Checks(a75Base), a75Checks(a75Tip)) && a75Checks(a75Tip).length >= 120)
  const ownEarlierUnits = ownChangedPaths.filter((file) => /\.test\.tsx?$/.test(file) && !file.startsWith(`${MODULE_DIR}/`))
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${FE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file) && file !== A75_SUITE)
  const earlierSuites = changedPaths.filter((file) => file.startsWith('backend/src/integration/') && !file.startsWith(`${HARNESS_DIR}/`) && file !== A75_SUITE)
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a9|dhpo|eclaimlink|coding-release|coding-validation|crg|reopen|queue|\bsla\b|execut|checkpoint-c|a8[-_]?10/i.test(file))
  check(
    'T010',
    'Allowlist excludes A9/CRG/old owner edits',
    changedPaths.length > 0 && outOfScope.length === 0 && earlierSuites.length === 0 && laterDomain.length === 0 && contractsOwn.length >= 25 && same(contractsOwn, contractConstantsAt(ownBase)) && productDiff.length === 0 &&
      ownEarlierSuites.length === 0 && a75Correction && ownEarlierUnits.length === 0 && ownPrismaStatus.every((s) => !/^M\tbackend\/prisma\/migrations\//.test(s)) &&
      migrationBytesAt(ownBase, ownBaseMigrationDirs) === migrationBytesAt(ownTip, ownBaseMigrationDirs) && committedText(`${MODULE_DIR}/exception-closure.types.ts`).includes(`CLOSURE_CONTRACT_VERSION = '${CONTRACT}'`) &&
      errorsBase.every((c) => errorsOwn.includes(c)) &&
      same(errorsOwn.filter((c) => !errorsBase.includes(c)), ['EXCEPTION_CLOSURE_NOT_ELIGIBLE', 'EXCEPTION_CLOSURE_NOT_INDEPENDENT', 'EXCEPTION_CLOSURE_TRANSITION_REFUSED', 'EXCEPTION_CLOSURE_CONFLICT']) &&
      errorsBase.includes('INTEGRITY_CONFLICT') && same(catalogueHead.filter((c) => !catalogueMain.includes(c)).sort(), CLOSURE_PERMISSIONS) && catalogueMain.every((c) => catalogueHead.includes(c)) &&
      same(allCodes.filter((c) => /^exceptionClosure\./.test(c)).sort(), CLOSURE_PERMISSIONS) && (await grantsOf('exceptionClosure.confirm')) === 'ORG_ADMIN' && (await grantsOf('exceptionClosure.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('exceptionResolution.decide')) === 'ORG_ADMIN' && (await grantsOf('exceptionEscalation.read')) === 'ORG_ADMIN,ORG_VIEWER' && (await grantsOf('exceptionTriage.record')) === 'ORG_ADMIN' &&
      !allCodes.some((c) => /^exception/i.test(c) && !knownException.includes(c) && !laterPermissions.includes(c)) && same(auditHead.filter((c) => !auditMain.includes(c)), ['exception_closure.recorded']) &&
      auditMain.every((c) => auditHead.includes(c)),
    outOfScope.length + earlierSuites.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A8.9 module, page, harness, migration and register and the narrow shared additions; no earlier module, unit test or migration changed, and of the earlier suites only A7.5's T095 table list (one line: later-phase tables excluded; every A7.5 check id and title unchanged); all ${contractsOwn.length} A1–A8.8 and CRG owner contract literals identical to main; the error catalogue gains only the four A8.9 codes (INTEGRITY_CONFLICT is reused), the permission catalogue exactly exceptionClosure.confirm (Admin) and .read (Admin, Viewer), the audit catalogue exactly exception_closure.recorded; no CRG, Checkpoint C, A8.10, queue, execution or A9 domain`
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
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /exception_closure_|exception_escalation_|exception_resolution_|exception_remediation_|exception_investigation_|exception_triage_|exception_intake_|claim_freeze|organization_memberships/.test(text)
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

  // B approves home freezes; M1 is the worked scenario's assignee, A8.3/A8.5/A8.6 actor and A8.7 requester; M4 owns the
  // other home intakes and requests their resolutions; RV approves every A8.5 proposal, VR verifies every A8.6 report
  // and DR decides every A8.7 request; T is the nominated member of every A8.8 escalation and RW returns them; CF
  // confirms the closures and CF2 competes with it; CFP confirms P and later loses its role (a current change never
  // rewrites a recorded closure); CF3 loses its role while its closure of G holds the Claim; NR is a member without any
  // role; PT holds a synthetic role this run narrows one permission at a time; O, O2, O3 and O4 are the other tenant's
  // assignee, reviewer, verifier and decider. M1 also holds a second membership in the other tenant (M1X).
  const B = await provisionMember('b')
  const M1 = await provisionMember('m1')
  const M4 = await provisionMember('m4')
  const RV = await provisionMember('rv')
  const VR = await provisionMember('vr')
  const DR = await provisionMember('dr')
  const T = await provisionMember('t')
  const RW = await provisionMember('rw')
  const CF = await provisionMember('cf')
  const CF2 = await provisionMember('cf2')
  const CF3 = await provisionMember('cf3')
  const CFP = await provisionMember('cfp')
  const NR = await provisionMember('norole', org, false)
  const PT = await provisionMember('partial', org, false)
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)
  const O3 = await provisionMember('o3', otherOrg)
  const O4 = await provisionMember('o4', otherOrg)
  const M1X = await prisma.organizationMembership.create({ data: { organizationId: otherOrg, userId: M1.id } })
  await prisma.membershipRole.create({ data: { membershipId: M1X.id, roleId: adminRole.id } })
  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: two organizations; Claims frozen twice without a link, their A8.1 intakes, A8.2 assignments, A8.3 links and findings, A8.5 approved plans, A8.6 verified work, A8.7 resolutions and A8.8 escalations in every position the closure gate distinguishes')
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
  const planFor = async (k: Intake, finding: string, proposer: Who, reviewer: Who = RV.who, actionCode = 'REQUEST_INTERNAL_DOCUMENTATION_CHECK'): Promise<Plan> => {
    const proposed = await post(`${base(k)}/remediation-events`, { eventCode: 'PROPOSE_ACTION', actionCode, findingEventId: finding, rationaleCode: 'INSUFFICIENT_EVIDENCE' }, proposer)
    if (proposed.status !== 201) throw new Error(`fixture ${k.label}: the A8.5 proposal was refused with ${proposed.status} ${errorCode(proposed.body) ?? ''}`)
    const decided = await post(`${base(k)}/remediation-events`, { eventCode: 'REVIEW_ACTION', proposalEventId: proposed.body.remediationEventId, decisionCode: 'APPROVE_PROPOSAL' }, reviewer)
    if (decided.status !== 201) throw new Error(`fixture ${k.label}: the A8.5 approval was refused with ${decided.status} ${errorCode(decided.body) ?? ''}`)
    return { proposalId: proposed.body.remediationEventId, workCode: WORK_CODE_OF_ACTION[actionCode as keyof typeof WORK_CODE_OF_ACTION], statuses: [proposed.status, decided.status] }
  }
  // A8.6 through its own route: the assignee reports the work against the approved plan citing its finding, and VR
  // verifies it EVIDENCE_SUPPORTED there.
  type Work = { reportId: string; verificationId: string; statuses: number[] }
  const workFor = async (k: Intake, plan: Plan, finding: string, reporter: Who, verifier: Who = VR.who): Promise<Work> => {
    const reported = await post(`${base(k)}/remediation-work-events`, { eventCode: 'RECORD_WORK_REPORT', approvedProposalEventId: plan.proposalId, workCode: plan.workCode, basisReferenceKind: 'INVESTIGATION_FINDING', basisReferenceId: finding }, reporter)
    if (reported.status !== 201) throw new Error(`fixture ${k.label}: the A8.6 report was refused with ${reported.status} ${errorCode(reported.body) ?? ''}`)
    const verified = await post(`${base(k)}/remediation-work-events`, { eventCode: 'VERIFY_WORK_REPORT', workReportEventId: reported.body.workEventId, verificationCode: 'EVIDENCE_SUPPORTED' }, verifier)
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
  const decideResolution = async (k: Intake, requestEventId: string, decision: 'CONFIRM_INTERNAL_RESOLUTION' | 'RETURN_FOR_REWORK', decider: Who = DR.who) => {
    const body = decision === 'CONFIRM_INTERNAL_RESOLUTION'
      ? { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId, decisionCode: decision }
      : { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId, decisionCode: decision, returnReasonCode: 'ADDITIONAL_WORK_REQUIRED' }
    const res = await resolutionPost(k, body, decider)
    if (res.status !== 201) throw new Error(`fixture ${k.label}: the A8.7 decision was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.resolutionEventId as string
  }
  // A8.8 through its own route: an escalation by the assignee to T, T's acknowledgement and follow-up citing the A8.3
  // finding, RW's return — as far as each intake's position needs.
  const escalationPost = (k: { claimId: string; intakeId: string }, body: unknown, who: Who) => post(`${base(k)}/escalation-events`, body, who)
  const escalateOf = (member: { membershipId: string }) => ({ eventCode: 'ESCALATE_FOR_REVIEW', reasonCode: 'NEEDS_SUPERVISOR_REVIEW', targetMemberId: member.membershipId })
  const ackOf = (escalationEventId: string) => ({ eventCode: 'ACKNOWLEDGE_ESCALATION', escalationEventId })
  const followupOf = (acknowledgementEventId: string, sourceEventId: string, followupCode = 'SOURCE_RECHECK_RECORDED') => ({ eventCode: 'RECORD_FOLLOWUP', acknowledgementEventId, followupCode, sourceEventId })
  const returnOf = (escalationEventId: string, returnReasonCode = 'FOLLOWUP_RECORDED') => ({ eventCode: 'RETURN_TO_OWNER', escalationEventId, returnReasonCode })
  const escalationStep = async (k: Intake, body: unknown, who: Who) => {
    const res = await escalationPost(k, body, who)
    if (res.status !== 201) throw new Error(`fixture ${k.label}: the A8.8 event ${JSON.stringify(body)} was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.escalationEventId as string
  }
  type Escalated = { escalationId: string; ackId: string | null; followupIds: string[]; returnId: string | null }
  // W — the worked scenario: resolved by DR on M1's request, never escalated; closed by CF (T041). P — the protocol
  // intake: resolved, closed by CFP (T011). WR — CL-01: escalated by M4 to T, acknowledged, followed up and returned by RW
  // while A8.7 had no request, then resolved; closed on the return (T039). FW — the same, but RW returns it for
  // FURTHER_WORK_REQUIRED: never closed in v1 (CL-01, T039). SR — the same position as WR, direct SQL only. OPN —
  // CL-02: escalated, acknowledged and followed up, then resolved (the escalation outstanding). AWA — escalated, never
  // acknowledged, then resolved. PD — an A8.7 request awaiting a decision. RK — returned for rework, then escalated and
  // returned (A8.8 RETURNED_TO_OWNER, never resolved). VW — verified A8.6 work, no A8.7 request. N0 — investigation only
  // (NO_RESOLUTION_REQUEST), the partial role's intake. TR — resolved, returned to triage while a closure waits. S —
  // resolved, direct SQL only. J — failure injection, retries and unknown outcomes. AT — the atomic commit, a read and a
  // second writer during a write. RC — five identical closures at once. RD — CF and CF2 at once. K — an A8.7 decision
  // while a closure waits, then the unique collision. H — CL-01 with a late A8.8 follow-up while a closure waits. G —
  // CF3's role removal. U — an A8.8 write while a closure holds the Claim. F — the other tenant's resolved intake.
  const W = await intakeFor('worked')
  const P = await intakeFor('protocol')
  const WR = await intakeFor('returned-escalation')
  const FW = await intakeFor('returned-further-work')
  const SR = await intakeFor('sql-returned')
  const OPN = await intakeFor('open-escalation')
  const AWA = await intakeFor('awaiting-escalation')
  const PD = await intakeFor('pending')
  const RK = await intakeFor('rework')
  const VW = await intakeFor('verified-only')
  const N0 = await intakeFor('no-resolution')
  const TR = await intakeFor('returned-triage')
  const S = await intakeFor('sql')
  const J = await intakeFor('inject')
  const AT = await intakeFor('atomic')
  const RC = await intakeFor('race')
  const RD = await intakeFor('race-different')
  const K = await intakeFor('decision-race')
  const H = await intakeFor('escalation-race')
  const G = await intakeFor('revoked')
  const U = await intakeFor('lock-holder')
  const F = await intakeFor('foreign', away, O.who)
  const W_CLASSIFY = await triage(W, classify)
  const W_ASSIGN = await triage(W, assignTo(M1))
  const m4Intakes = [P, WR, FW, SR, OPN, AWA, PD, RK, VW, N0, TR, S, J, AT, RC, RD, K, H, G, U]
  for (const k of m4Intakes) {
    await triage(k, classify)
    await triage(k, assignTo(M4))
  }
  await triage(F, classify, O.who)
  await triage(F, assignTo(O), O.who)
  const investigated = new Map<string, Investigated>()
  investigated.set(W.intakeId, await investigate(W, M1.who))
  for (const k of m4Intakes) investigated.set(k.intakeId, await investigate(k, M4.who))
  investigated.set(F.intakeId, await investigate(F, O.who))
  const inv = (k: Intake) => investigated.get(k.intakeId) as Investigated
  const IW = inv(W)
  const plans = new Map<string, Plan>()
  const works = new Map<string, Work>()
  const planAndWork = async (k: Intake, who: Who, reviewer: Who = RV.who, verifier: Who = VR.who) => {
    const plan = await planFor(k, inv(k).findingId, who, reviewer)
    plans.set(k.intakeId, plan)
    works.set(k.intakeId, await workFor(k, plan, inv(k).findingId, who, verifier))
  }
  await planAndWork(W, M1.who)
  for (const k of m4Intakes.filter((k) => k !== N0)) await planAndWork(k, M4.who)
  await planAndWork(F, O.who, O2.who, O3.who)
  const plan = (k: Intake) => plans.get(k.intakeId) as Plan
  const work = (k: Intake) => works.get(k.intakeId) as Work
  const PW = plan(W)
  const WW = work(W)
  const requests = new Map<string, string>()
  const decisions = new Map<string, string>()
  const resolve = async (k: Intake, requester: Who = M4.who, decider: Who = DR.who) => {
    const requestId = await requestResolution(k, work(k), requester)
    requests.set(k.intakeId, requestId)
    decisions.set(k.intakeId, await decideResolution(k, requestId, 'CONFIRM_INTERNAL_RESOLUTION', decider))
  }
  const requestOf = (k: Intake) => requests.get(k.intakeId) ?? MISSING
  const decisionOf = (k: Intake) => decisions.get(k.intakeId) ?? MISSING
  const escalations = new Map<string, Escalated>()
  const escalateThrough = async (k: Intake, stage: 'AWAITING' | 'ACTIVE' | 'RETURNED', returnReasonCode = 'FOLLOWUP_RECORDED') => {
    const escalationId = await escalationStep(k, escalateOf(T), M4.who)
    let state: Escalated = { escalationId, ackId: null, followupIds: [], returnId: null }
    if (stage !== 'AWAITING') {
      const ackId = await escalationStep(k, ackOf(escalationId), T.who)
      state = { ...state, ackId, followupIds: [await escalationStep(k, followupOf(ackId, inv(k).findingId), T.who)] }
      if (stage === 'RETURNED') state = { ...state, returnId: await escalationStep(k, returnOf(escalationId, returnReasonCode), RW.who) }
    }
    escalations.set(k.intakeId, state)
  }
  const esc = (k: Intake) => escalations.get(k.intakeId) as Escalated
  await resolve(W, M1.who)
  for (const k of [P, TR, S, J, AT, RC, RD, G, U]) await resolve(k)
  // CL-01: escalated, acknowledged, followed up and returned while A8.7 had no request, then resolved.
  for (const k of [WR, SR, H]) {
    await escalateThrough(k, 'RETURNED')
    await resolve(k)
  }
  // CL-01 refused: the same position, returned for further work.
  await escalateThrough(FW, 'RETURNED', 'FURTHER_WORK_REQUIRED')
  await resolve(FW)
  // CL-02 and an escalation never acknowledged: open when A8.7 resolves.
  await escalateThrough(OPN, 'ACTIVE')
  await resolve(OPN)
  await escalateThrough(AWA, 'AWAITING')
  await resolve(AWA)
  for (const k of [PD, K]) requests.set(k.intakeId, await requestResolution(k, work(k), M4.who))
  requests.set(RK.intakeId, await requestResolution(RK, work(RK), M4.who))
  const RK_DECISION = await decideResolution(RK, requestOf(RK), 'RETURN_FOR_REWORK')
  await escalateThrough(RK, 'RETURNED')
  await resolve(F, O.who, O4.who)
  const homeIntakes = [W, P, WR, FW, SR, OPN, AWA, PD, RK, VW, N0, TR, S, J, AT, RC, RD, K, H, G, U]
  const runIntakes = [...homeIntakes, F]
  const runClaims = homeIntakes.map((k) => k.claimId)
  progress(
    `fixtures ready: two synthetic AE-DU/DHA worlds; ${homeIntakes.length} A8.1 intakes on contradicted Claims in Org A (basis ${W.basisCode}) and one in Org B; W assigned to M1, the others to M4; every intake but N0 carries an approved A8.5 plan and verified A8.6 work; A8.7: W, P, WR, FW, SR, OPN, AWA, TR, S, J, AT, RC, RD, H, G and U RESOLVED_INTERNAL, PD and K AWAITING_RESOLUTION_DECISION, RK RETURNED_FOR_REWORK, VW and N0 NO_RESOLUTION_REQUEST; A8.8: WR, SR, H and RK RETURNED_TO_OWNER for FOLLOWUP_RECORDED, FW for FURTHER_WORK_REQUIRED, OPN FOLLOWUP_ACTIVE, AWA AWAITING_ACKNOWLEDGEMENT, every other NO_ESCALATION; F resolved in Org B`,
  )

  // ---------------------------------------------------------------- closure routes, rows and probes
  const closurePost = (k: { claimId: string; intakeId: string }, body: unknown, who: Who) => post(`${base(k)}/closure-events`, body, who)
  const closureHistoryOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/closure-history`, who)
  const reconstructionOf = (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => get(`${base(k)}/closure-reconstruction`, who)
  const REASON = { RESOLUTION_DECISION: 'VERIFIED_INTERNAL_RESOLUTION', ESCALATION_RETURN: 'TERMINAL_FOLLOWUP_REVIEWED' } as const
  const OWNER_CONTRACT = { RESOLUTION_DECISION: 'A8-RESOLUTION-DECISION-1', ESCALATION_RETURN: 'A8-ESCALATION-1' } as const
  type Kind = keyof typeof REASON
  const closeBody = (decisionId: string, kind: Kind = 'RESOLUTION_DECISION', basisId: string = decisionId) => ({
    eventCode: 'CONFIRM_INTERNAL_CLOSURE', resolutionDecisionEventId: decisionId, closureReasonCode: REASON[kind], basisReferenceKind: kind, basisReferenceId: basisId,
  })
  // The one lawful closure of an intake: on its A8.7 confirmation, or on its A8.8 return when it was escalated.
  const closeOf = (k: Intake) => (escalations.get(k.intakeId)?.returnId ? closeBody(decisionOf(k), 'ESCALATION_RETURN', esc(k).returnId as string) : closeBody(decisionOf(k)))
  const eventsOf = (intakeId: string) => prisma.exceptionClosureEvent.findMany({ where: { exceptionIntakeId: intakeId }, orderBy: { sequence: 'asc' } })
  const auditsOfEvent = (eventId: string) => prisma.auditEvent.findMany({ where: { entityType: 'EXCEPTION_CLOSURE_EVENT', entityId: eventId } })
  const auditsOfIntake = (intakeId: string) => prisma.auditEvent.count({ where: { actionCode: 'exception_closure.recorded', afterState: { path: ['exceptionIntakeId'], equals: intakeId } } })
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
  const rolledBack = async <R>(job: (tx: DbClient) => Promise<R>): Promise<{ value?: R; message: string; clean: boolean }> => {
    const before = await counts()
    const out: { value?: R } = {}
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
  // One direct closure row of intake `k`: by default its valid closure by CF on its A8.7 confirmation (or, where it was
  // escalated and returned, on that return).
  const rowOf = (k: Intake, o: Row = {}): Row => {
    const returned = escalations.get(k.intakeId)?.returnId ?? null
    const kind: Kind = returned ? 'ESCALATION_RETURN' : 'RESOLUTION_DECISION'
    return {
      id: randomUUID(), exception_intake_id: k.intakeId, organization_id: k.organizationId, claim_id: k.claimId, contract_version: CONTRACT, sequence: 1, event_code: 'CONFIRM_INTERNAL_CLOSURE',
      resolution_decision_event_id: decisionOf(k), basis_reference_kind: kind, basis_reference_id: returned ?? decisionOf(k), basis_owner_contract_version: OWNER_CONTRACT[kind],
      closure_reason_code: REASON[kind], recorded_by_membership_id: CF.membershipId, recorded_by_user_id: CF.id, recorded_at: null, ...o,
    }
  }
  const COLUMN_LIST =
    'id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, resolution_decision_event_id, basis_reference_kind, basis_reference_id, basis_owner_contract_version, closure_reason_code, recorded_by_membership_id, recorded_by_user_id'
  const VALUES = '$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8::uuid, $9, $10::uuid, $11, $12, $13::uuid, $14::uuid'
  const insertRow = (tx: DbClient, row: Row) => {
    const values = [
      row.id, row.exception_intake_id, row.organization_id, row.claim_id, row.contract_version, row.sequence, row.event_code, row.resolution_decision_event_id, row.basis_reference_kind,
      row.basis_reference_id, row.basis_owner_contract_version, row.closure_reason_code, row.recorded_by_membership_id, row.recorded_by_user_id,
    ]
    return row.recorded_at === null
      ? tx.$executeRawUnsafe(`INSERT INTO ${TABLE} (${COLUMN_LIST}) VALUES (${VALUES})`, ...values)
      : tx.$executeRawUnsafe(`INSERT INTO ${TABLE} (${COLUMN_LIST}, recorded_at, created_at) VALUES (${VALUES}, $15::timestamptz, $15::timestamptz)`, ...values, row.recorded_at)
  }
  // Every direct attempt of this run, archived for T124 (the adversarial matrix).
  const sqlMatrix: { label: string; refused: boolean; clean: boolean; message: string }[] = []
  // Direct rows in order, in one transaction that is always rolled back: against the live guards, or with the triggers
  // off (replica) so that only a CHECK, a unique index or a NOT NULL can refuse. `before` runs first. Answers the first
  // refusal.
  const directInsert = async (label: string, rows: Row[], options: { triggersOff?: boolean; before?: (tx: DbClient) => Promise<unknown> } = {}) => {
    const attempt = await rolledBack(async (tx) => {
      if (options.before) await options.before(tx)
      if (options.triggersOff) await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      for (const row of rows) await insertRow(tx, row)
    })
    const result = { refused: !attempt.message.includes(NOT_COMMITTED), message: attempt.message, clean: attempt.clean }
    sqlMatrix.push({ label, ...result, message: result.message.replace(/\s+/g, ' ').slice(0, 240) })
    return result
  }
  // A stored history planted with the triggers off (and, where named, DDL such as a dropped CHECK) inside a rolled-back
  // transaction; the production reads answer on THAT transaction.
  const plantedRead = async (k: Intake, plant: (tx: DbClient) => Promise<unknown>, ddl?: string) =>
    rolledBack(async (tx) => {
      if (ddl) await tx.$executeRawUnsafe(ddl)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await plant(tx)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      return { history: await getClosureHistoryOf(k.claimId, k.intakeId, tx), reconstruction: await getClosureReconstructionOf(k.claimId, k.intakeId, tx) }
    })
  const plantRows = (rows: Row[]) => async (tx: DbClient) => {
    for (const row of rows) await insertRow(tx, row)
  }
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
  // Every A8.2 triage, A8.7 resolution and A8.8 escalation event that exists before the first closure: A8.9 must never
  // change one of them (later A8.2, A8.7 and A8.8 events are their owners' own new events, judged where they are made).
  const idsOf = async (table: string) => (await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text AS id FROM ${table} WHERE exception_intake_id = ANY($1::uuid[])`, runIntakes.map((k) => k.intakeId))).map((r) => r.id)
  const triageIdsBefore = await idsOf(TRIAGE_TABLE)
  const resolutionIdsBefore = await idsOf(RESOLUTION_TABLE)
  const escalationIdsBefore = await idsOf(ESCALATION_TABLE)
  const idsHash = (table: string, ids: string[]) => hashOf(`SELECT t.* FROM ${table} t WHERE t.id = ANY($1::uuid[])`, ids)
  const triageHashBefore = await idsHash(TRIAGE_TABLE, triageIdsBefore)
  const resolutionHashBefore = await idsHash(RESOLUTION_TABLE, resolutionIdsBefore)
  const escalationHashBefore = await idsHash(ESCALATION_TABLE, escalationIdsBefore)
  // Every owner DTO of W and WR before their closures: A8.9 must leave each byte-identical (T050).
  const ownerReads = (k: Intake) => [
    `/api/claims/${k.claimId}/exception-intake`, `${base(k)}/triage-disposition`, `${base(k)}/triage-history`, `${base(k)}/investigation-summary`, `${base(k)}/investigation-history`,
    `${base(k)}/remediation-disposition`, `${base(k)}/remediation-history`, `${base(k)}/remediation-work-disposition`, `${base(k)}/remediation-work-history`, `${base(k)}/resolution-disposition`,
    `${base(k)}/resolution-history`, `${base(k)}/escalation-disposition`, `${base(k)}/escalation-history`,
  ]
  const ownerDtos = async (k: Intake) => Promise.all(ownerReads(k).map(async (path) => withoutEvaluatedAt((await get(path)).body)))
  const wOwnerDtosBefore = await ownerDtos(W)
  const wrOwnerDtosBefore = await ownerDtos(WR)

  // D2 — the seven upstream read permissions, each on its own. PT holds one synthetic role granting exactly what
  // ORG_ADMIN grants; one permission at a time is taken from it and every A8.9 route is tried on N0, then given back. The
  // role exists only for these calls and is removed again before anything else runs.
  const partialRole = await prisma.role.create({ data: { code: `SYNTHETIC_${runId.replace('-', '_')}_PARTIAL`, name: `Synthetic partial role ${runId}` } })
  const adminGrants = await prisma.rolePermission.findMany({ where: { roleId: adminRole.id }, select: { permissionId: true, permission: { select: { code: true } } } })
  const permissionIdOf = new Map(adminGrants.map((g) => [g.permission.code, g.permissionId]))
  await prisma.rolePermission.createMany({ data: adminGrants.map((g) => ({ roleId: partialRole.id, permissionId: g.permissionId })) })
  await prisma.membershipRole.create({ data: { membershipId: PT.membershipId, roleId: partialRole.id } })
  const withoutPermission = async <R>(code: string, job: () => Promise<R>): Promise<R> => {
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: partialRole.id, permissionId: permissionIdOf.get(code) as string } } })
    try {
      return await job()
    } finally {
      await prisma.rolePermission.create({ data: { roleId: partialRole.id, permissionId: permissionIdOf.get(code) as string } })
    }
  }
  const allRoutes = async () => [(await closurePost(N0, closeBody(MISSING), PT.who)).status, (await closureHistoryOf(N0, PT.who)).status, (await reconstructionOf(N0, PT.who)).status]
  const partialControl = { close: await closurePost(N0, closeBody(MISSING), PT.who), history: await closureHistoryOf(N0, PT.who), reconstruction: await reconstructionOf(N0, PT.who) }
  const parentReadProof: { code: string; statuses: number[] }[] = []
  for (const code of SEVEN_READS) parentReadProof.push({ code, statuses: await withoutPermission(code, allRoutes) })
  const ownPermissionProof = { confirm: await withoutPermission('exceptionClosure.confirm', allRoutes), read: await withoutPermission('exceptionClosure.read', allRoutes) }
  await prisma.membershipRole.deleteMany({ where: { roleId: partialRole.id } })
  await prisma.rolePermission.deleteMany({ where: { roleId: partialRole.id } })
  await prisma.role.delete({ where: { id: partialRole.id } })
  const partialGone = (await prisma.role.count({ where: { code: { startsWith: 'SYNTHETIC_' } } })) === 0

  // ---------------------------------------------------------------- contract, strict input, outputs (T011–T020)
  section('Contract, strict input and outputs: the v1 literal on the row and every DTO, exact request keys, the controlled reasons and typed basis kinds, server-owned actor, tenant, clock and version, malformed ids, unsupported codes, no free text or PHI, no reopen or second writer')
  const countsAtStart = await counts()
  const noClosureP = { history: await closureHistoryOf(P), reconstruction: await reconstructionOf(P), rows: (await eventsOf(P.intakeId)).length }
  const C_P = await closurePost(P, closeOf(P), CFP.who)
  const C_P_ID = (C_P.body?.closureEventId ?? MISSING) as string
  const cpHashAtCreation = await rowHash(C_P_ID)
  const contractDef = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${TABLE}_contract_chk'`))[0]?.d ?? ''
  const cpRow = (await eventsOf(P.intakeId))[0]
  const historyP = await closureHistoryOf(P)
  const reconstructionP = await reconstructionOf(P)
  check(
    'T011',
    'A8-CLOSURE-1 exact TS/SQL/DTO literal',
    C_P.status === 201 && C_P.body.contractVersion === CONTRACT && CLOSURE_CONTRACT_VERSION === CONTRACT && cpRow?.contractVersion === CONTRACT && same(Object.keys(C_P.body), EVENT_KEYS) &&
      same(Object.keys(historyP.body), HISTORY_KEYS) && same(Object.keys(reconstructionP.body), RECONSTRUCTION_KEYS) && historyP.body.contractVersion === CONTRACT && reconstructionP.body.contractVersion === CONTRACT &&
      same(Object.keys(reconstructionP.body.recordedClosure ?? {}), EVENT_KEYS) && reconstructionP.body.chain.length > 0 && reconstructionP.body.chain.every((e: any) => same(Object.keys(e), ENTRY_KEYS)) &&
      reconstructionP.body.submissions.length > 0 && reconstructionP.body.submissions.every((s: any) => same(Object.keys(s), SUBMISSION_KEYS)) && contractDef.includes(`'${CONTRACT}'`) && /IS NOT NULL/.test(contractDef) &&
      migrationText.includes(`'${CONTRACT}'`),
    `CFP's closure of P carries ${CONTRACT} on its stored row and in exactly the ${EVENT_KEYS.length} event keys; the history, the reconstruction, its recorded closure, every chain entry and every submission carry exactly theirs; the types file, the migration and the database CHECK pin the literal`,
  )
  const rcRows = async () => (await eventsOf(RC.intakeId)).length
  const isValidation = (r: { status: number; body: any }) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR'
  const without = (body: Record<string, unknown>, field: string) => {
    const copy: Record<string, unknown> = { ...body }
    delete copy[field]
    return copy
  }
  const rcBody = closeOf(RC) as Record<string, unknown>
  const missingKeys = await Promise.all(Object.keys(rcBody).filter((k) => k !== 'eventCode').map((field) => closurePost(RC, without(rcBody, field), CF.who)))
  const extraKeys = await Promise.all([{ closureEventId: C_P_ID }, { sequence: 1 }, { state: 'CLOSED_INTERNAL' }, { extra: 1 }].map((extra) => closurePost(RC, { ...rcBody, ...extra }, CF.who)))
  const oddBodies = [await closurePost(RC, [rcBody], CF.who), await closurePost(RC, {}, CF.who), await closurePost(RC, 7, CF.who), await closurePost(RC, 'CONFIRM_INTERNAL_CLOSURE', CF.who), await closurePost(RC, null, CF.who)]
  const nullService = await recordClosureEvent(RC.claimId, RC.intakeId, null, CF.id)
  check(
    'T012',
    'Request exact keys and no extra properties',
    missingKeys.length === 4 && missingKeys.every((r) => isValidation(r) && /missing field/.test(errorMessage(r.body))) && extraKeys.every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) &&
      oddBodies.every((r) => r.status === 400 && !rawError(r.body)) && nullService.ok === false && nullService.code === 'VALIDATION_ERROR' && (await rcRows()) === 0,
    `a closure without its decision, reason, basis kind or basis is a 400 (missing field); with an event id, sequence, state or unknown property a 400 (unsupported field); an array, empty, numeric, string or null body is a 400 (${oddBodies.map((r) => r.status).join('/')}) and the service itself refuses null; nothing recorded`,
  )
  const decisionRC = decisionOf(RC)
  const badReasons = await Promise.all(['RESOLVED', 'PAID', 'verified_internal_resolution', '', null, 7].map((closureReasonCode) => closurePost(RC, { ...rcBody, closureReasonCode }, CF.who)))
  const mismatchedReason = await closurePost(RC, { ...rcBody, closureReasonCode: 'TERMINAL_FOLLOWUP_REVIEWED' }, CF.who)
  const shapeDef = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${TABLE}_shape_chk'`))[0]?.d ?? ''
  check(
    'T013',
    'Controlled reason list exact and approved',
    same([...closureReasonCodes], ['VERIFIED_INTERNAL_RESOLUTION', 'TERMINAL_FOLLOWUP_REVIEWED']) && badReasons.every((r) => isValidation(r) && /unknown closure reason code/.test(errorMessage(r.body))) &&
      isValidation(mismatchedReason) && /a RESOLUTION_DECISION basis carries the reason VERIFIED_INTERNAL_RESOLUTION/.test(errorMessage(mismatchedReason.body)) &&
      closureReasonCodes.every((code) => shapeDef.includes(`'${code}'`) && registerAtHead.includes(`\`${code}\``)) && (await rcRows()) === 0,
    `the reasons are exactly ${closureReasonCodes.join(' and ')} (the register, the types and the shape CHECK agree); an uncontrolled, lower-case, empty, null or numeric reason is a 400, and a reason that is not the one its basis kind names is a 400; nothing recorded`,
  )
  const badKinds = await Promise.all(['A8_7_DECISION', 'ESCALATION', 'resolution_decision', 'WORK_VERIFICATION', '', null].map((basisReferenceKind) => closurePost(RC, { ...rcBody, basisReferenceKind }, CF.who)))
  const decisionNotItself = await closurePost(RC, { ...rcBody, basisReferenceId: requestOf(RC) }, CF.who)
  const returnIsDecision = await closurePost(RC, closeBody(decisionRC, 'ESCALATION_RETURN', decisionRC), CF.who)
  const ownerContractInBody = await closurePost(RC, { ...rcBody, basisOwnerContractVersion: 'A8-RESOLUTION-DECISION-1' }, CF.who)
  check(
    'T014',
    'Typed basis owner/contract keys exact',
    same([...basisReferenceKinds], ['RESOLUTION_DECISION', 'ESCALATION_RETURN']) && badKinds.every((r) => isValidation(r) && /unknown basis reference kind/.test(errorMessage(r.body))) &&
      [decisionNotItself, returnIsDecision].every((r) => isValidation(r) && /a RESOLUTION_DECISION basis is the named decision itself; an ESCALATION_RETURN basis is another record/.test(errorMessage(r.body))) &&
      isValidation(ownerContractInBody) && /unsupported field/.test(errorMessage(ownerContractInBody.body)) && C_P.body.basisOwnerContractVersion === 'A8-RESOLUTION-DECISION-1' &&
      cpRow?.basisOwnerContractVersion === 'A8-RESOLUTION-DECISION-1' && ['A8-RESOLUTION-DECISION-1', 'A8-ESCALATION-1'].every((c) => shapeDef.includes(`'${c}'`)) && (await rcRows()) === 0,
    "the basis kinds are exactly RESOLUTION_DECISION (owner A8-RESOLUTION-DECISION-1) and ESCALATION_RETURN (owner A8-ESCALATION-1); an unknown kind is a 400; a RESOLUTION_DECISION basis other than the decision, or an ESCALATION_RETURN basis that is the decision, is a 400; the owner contract is the server's (in the body a 400) and P's row carries A8-RESOLUTION-DECISION-1",
  )
  const serverOwned = await Promise.all(
    ['id', 'organizationId', 'claimId', 'exceptionIntakeId', 'recordedByUserId', 'recordedByMembershipId', 'actorUserId', 'membershipId', 'recordedAt', 'createdAt', 'timestamp'].map((k) =>
      closurePost(RC, { ...rcBody, [k]: k === 'recordedAt' || k === 'createdAt' || k === 'timestamp' ? '2020-01-01T00:00:00.000Z' : MISSING }, CF.who),
    ),
  )
  const queried = await post(`${base(RC)}/closure-events?actor=${CF.id}`, rcBody, CF.who)
  check(
    'T015',
    'No caller actor, tenant or clock inputs',
    serverOwned.every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) && isValidation(queried) && C_P.body.recordedByMembershipId === CFP.membershipId && C_P.body.recordedByUserId === CFP.id &&
      C_P.body.organizationId === org && C_P.body.claimId === P.claimId && C_P.body.exceptionIntakeId === P.intakeId && (await rcRows()) === 0,
    "an id, organization, Claim, intake, actor, membership or time in the body, or a query parameter, is refused (400); P's closure took its actor and membership (CFP), organization and Claim from the server",
  )
  const stateFields = await Promise.all(
    [['contractVersion', CONTRACT], ['state', 'CLOSED_INTERNAL'], ['status', 'CLOSED'], ['current', true], ['latest', true], ['outcome', 'X'], ['closed', true], ['version', 2]].map(([field, value]) => closurePost(RC, { ...rcBody, [field as string]: value }, CF.who)),
  )
  const selectorReads = [
    await get(`${base(RC)}/closure-history?latest=1`), await get(`${base(RC)}/closure-reconstruction?state=CLOSED_INTERNAL`), await get(`${base(RC)}/closure-reconstruction?asOf=2026-01-01`),
    await get(`${base(RC)}/closure-current`), await get(`${base(RC)}/closure-events`), await get(`${base(P)}/closure-events/${C_P_ID}`), await api('PATCH', `${base(P)}/closure-events`, {}),
    await api('PUT', `${base(P)}/closure-events`, {}), await api('DELETE', `${base(P)}/closure-events`),
  ]
  check(
    'T016',
    'No caller version/current/status selector',
    stateFields.every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body))) && selectorReads.slice(0, 3).every(isValidation) && selectorReads.slice(3).every((r) => r.status === 404) &&
      !COLUMNS.some((c) => /state|status|current|latest|closed|flag/.test(c)) && (await rcRows()) === 0 && (await eventsOf(P.intakeId)).length === 1,
    'a contract version, state, status, current, latest, outcome, closed or version field is refused (400); a latest, state or as-of selector on either read is a 400; a current read, an event collection, an event by id and PATCH/PUT/DELETE do not exist (404); the table has no state, status, current or closed column',
  )
  const badIds = ['not-a-uuid', MISSING.replace(/-/g, ''), `${MISSING}0`, encodeURIComponent("1' OR '1'='1")]
  const malformedPath = [
    ...(await Promise.all(badIds.map((id) => closurePost({ claimId: id, intakeId: RC.intakeId }, rcBody, CF.who)))), ...(await Promise.all(badIds.map((id) => closurePost({ claimId: RC.claimId, intakeId: id }, rcBody, CF.who)))),
    ...(await Promise.all(badIds.map((id) => closureHistoryOf({ claimId: id, intakeId: RC.intakeId })))), ...(await Promise.all(badIds.map((id) => reconstructionOf({ claimId: RC.claimId, intakeId: id })))),
  ]
  const malformedBodyIds = [
    await closurePost(RC, { ...rcBody, resolutionDecisionEventId: 'not-a-uuid' }, CF.who), await closurePost(RC, { ...rcBody, resolutionDecisionEventId: 7 }, CF.who),
    await closurePost(RC, { ...rcBody, basisReferenceId: `${MISSING}0` }, CF.who), await closurePost(RC, { ...rcBody, basisReferenceId: '' }, CF.who),
  ]
  check(
    'T017',
    'Malformed paths and UUIDs answered 400',
    malformedPath.every((r) => isValidation(r) && /invalid (claim|exception intake) id/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      malformedBodyIds.every((r) => isValidation(r) && /invalid (resolution decision event|basis reference) id/.test(errorMessage(r.body)) && !rawError(r.body)) && (await rcRows()) === 0,
    'malformed and SQL-shaped Claim and intake ids on all three routes, and malformed decision and basis ids in the body, are each a safe 400; nothing recorded',
  )
  const unknownEvents = await Promise.all(['CLOSE', 'REOPEN', 'REOPEN_CLOSURE', 'AUTO_CLOSE', 'CONFIRM_INTERNAL_RESOLUTION', 'confirm_internal_closure', '', null, 7].map((eventCode) => closurePost(RC, { ...rcBody, eventCode }, CF.who)))
  check(
    'T018',
    'Unsupported event or code refused',
    same([...closureEventCodes], ['CONFIRM_INTERNAL_CLOSURE']) && same([...closureStates], ['NO_CLOSURE', 'CLOSED_INTERNAL']) && unknownEvents.every((r) => isValidation(r) && /unknown closure event code/.test(errorMessage(r.body))) && (await rcRows()) === 0,
    `only ${closureEventCodes.join(', ')} (states ${closureStates.join(', ')}); a close, reopen, automatic, A8.7, lower-case, empty, null or numeric event code is a 400; nothing recorded`,
  )
  const injection = [
    await closurePost(RC, { ...rcBody, resolutionDecisionEventId: "1' OR '1'='1" }, CF.who), await closurePost(RC, { ...rcBody, resolutionDecisionEventId: { $ne: null } }, CF.who),
    await closurePost(RC, { ...rcBody, closureReasonCode: "VERIFIED_INTERNAL_RESOLUTION'; DROP TABLE claims; --" }, CF.who), await closurePost(RC, { ...rcBody, basisReferenceId: '../closure' }, CF.who),
    await closurePost(RC, JSON.parse(`{"__proto__": {"eventCode": "CONFIRM_INTERNAL_CLOSURE"}, ${JSON.stringify(without(rcBody, 'eventCode')).slice(1)}`), CF.who),
    await closurePost(RC, JSON.parse(`{"constructor": {"prototype": {"admin": true}}, ${JSON.stringify(rcBody).slice(1)}`), CF.who),
  ]
  const freeText = await Promise.all(
    [
      { note: 'free text' }, { narrative: 'free text' }, { comment: 'free text' }, { reasonText: 'free text' }, { patientName: `${runId}-home-P` }, { diagnosisCode: key('home-DXA') }, { amount: '125.25' },
      { currencyCode: 'AED' }, { url: 'https://example.invalid/evidence' }, { attachment: 'c3ludGhldGlj' }, { payload: { a: 1 } }, { payerId: MISSING }, { remark: 'ملاحظة داخلية' },
    ].map((extra) => closurePost(RC, { ...rcBody, ...extra }, CF.who)),
  )
  check(
    'T019',
    'No free text, PHI, amount or attachment',
    injection.every((r) => r.status === 400 && !rawError(r.body)) && freeText.every((r) => isValidation(r) && /unsupported field/.test(errorMessage(r.body)) && !JSON.stringify(r.body).includes('ملاحظة')) && (await rcRows()) === 0 &&
      !COLUMNS.some((c) => /note|narrative|text|patient|diagnos|amount|currency|payer|url|attachment|payload/.test(c)),
    'SQL-, operator-, traversal- and prototype-shaped values are a safe 400; a note, narrative, comment, reason text, patient name, diagnosis, amount, currency, URL, attachment, payload, payer or Arabic remark is refused (400, never echoed); the table has no such column; nothing recorded',
  )
  const reopenRoutes = await Promise.all(['closure-reopen', 'reopen', `closure-events/${C_P_ID}/reopen`, 'auto-close', 'closure-bulk', 'closures'].map((p) => post(`${base(P)}/${p}`, {})))
  const secondP = [await closurePost(P, closeOf(P), CF.who), await closurePost(P, closeOf(P), CFP.who)]
  // Every other module whose committed production code (comments aside) names A8.9; the audit catalogue only lists its
  // action code.
  const callerFiles = gitArgs(['grep', '-l', '-E', 'exception-closure|exceptionClosure|exception_closure', 'HEAD', '--', 'backend/src/modules']).split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^HEAD:/, ''))
  const callers = callerFiles.filter((f) => !f.startsWith(`${MODULE_DIR}/`) && f !== 'backend/src/modules/audit/audit.types.ts' && /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && /exception-closure|exceptionClosure|exception_closure/.test(committedCode(f)))
  const moduleCodeEarly = committedProductionCodeOf([MODULE_DIR]).code
  check(
    'T020',
    'No re-open, auto-close or second writer',
    reopenRoutes.every((r) => r.status === 404) && secondP.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_TRANSITION_REFUSED' && /CLOSED_INTERNAL, which is terminal in v1/.test(errorMessage(r.body))) &&
      callers.length === 0 && !/setInterval|setTimeout\([^)]*clos|cron|enqueue|worker_threads/.test(moduleCodeEarly) &&
      (await eventsOf(P.intakeId)).length === 1 && (await unchanged(plus(countsAtStart, 1))),
    "no reopen, automatic, bulk or collection route exists (404); a second closure of P — by another confirmer or by CFP again — is refused 409 (terminal in v1); no other module calls A8.9 and nothing closes on a timer; only P's one closure and its audit were added",
  )

  // ---------------------------------------------------------------- authorization and tenant (T021–T030)
  section('Authorization and tenant: 401 before lookup, Viewer and role-less 403, the seven upstream reads and the two own permissions each on their own, an authorized current member confirms, independence of the A8.7 requester and decider, a role removed before commit, foreign Claim, intake and source = missing, forged members, Admin and Viewer read the same')
  const anonPost = [await closurePost(RC, rcBody, anonymous), await closurePost({ claimId: MISSING, intakeId: MISSING }, rcBody, anonymous)]
  check('T021', 'Anonymous POST 401 before lookup', anonPost.every((r) => r.status === 401) && (await rcRows()) === 0, 'no session: 401 on RC and on a missing Claim alike (the lookup never ran); nothing recorded')
  const anonGet = [await closureHistoryOf(RC, anonymous), await reconstructionOf(RC, anonymous), await closureHistoryOf({ claimId: MISSING, intakeId: MISSING }, anonymous), await reconstructionOf({ claimId: MISSING, intakeId: MISSING }, anonymous)]
  check('T022', 'Anonymous GET 401 before lookup', anonGet.every((r) => r.status === 401), 'no session: 401 on the history and the reconstruction of RC and of a missing Claim')
  const noPermission = [await closurePost(RC, rcBody, asViewer), await closurePost(RC, rcBody, NR.who)]
  const parentProofOk = parentReadProof.length === 7 && parentReadProof.every((p) => same(p.statuses, [403, 403, 403]))
  const controlOk = partialControl.close.status === 404 && /resolution decision not found for this exception/.test(errorMessage(partialControl.close.body)) && partialControl.history.status === 200 && partialControl.reconstruction.status === 200
  check(
    'T023',
    'Viewer cannot confirm closure',
    noPermission.every((r) => r.status === 403) && same([...PARENT_READ_PERMISSIONS], SEVEN_READS) && parentProofOk && controlOk && same(ownPermissionProof.confirm, [403, 200, 200]) && same(ownPermissionProof.read, [404, 403, 403]) && partialGone && (await rcRows()) === 0,
    `a Viewer (exceptionClosure.read only) and a role-less member are refused 403; a member holding everything else but one upstream read is refused 403 on all three routes for each of the seven (${parentReadProof.map((p) => `${p.code}: ${p.statuses.join('/')}`).join('; ')}); without .confirm the POST is 403 and the reads 200, without .read the reads are 403 while the POST reaches the service (404: no such decision); with all of them ${partialControl.close.status}/${partialControl.history.status}/${partialControl.reconstruction.status}; the synthetic role is gone`,
  )
  const cfpAccess = await prisma.organizationMembership.findUniqueOrThrow({ where: { id: CFP.membershipId }, select: { roles: { select: { role: { select: { code: true } } } } } })
  check(
    'T024',
    'Authorized current member may confirm',
    C_P.status === 201 && C_P.body.recordedByMembershipId === CFP.membershipId && C_P.body.recordedByUserId === CFP.id && C_P.body.sequence === 1 && C_P.body.eventCode === 'CONFIRM_INTERNAL_CLOSURE' &&
      cfpAccess.roles.some((r) => r.role.code === 'ORG_ADMIN') && CFP.membershipId !== M4.membershipId && C_P.body.resolutionDecisionEventId === decisionOf(P),
    "CFP, a current member of Org A whose role grants exceptionClosure.confirm (not the assignee M4: the confirmer need not be the assignee), confirms P's closure (201) as itself through its own membership, numbered 1, on P's A8.7 confirmation",
  )
  const notIndependent = [await closurePost(RC, rcBody, M4.who), await closurePost(RC, rcBody, DR.who), await closurePost(W, closeOf(W), M1.who), await closurePost(W, closeOf(W), DR.who)]
  const notIndependentService = [await recordClosureEvent(RC.claimId, RC.intakeId, rcBody, M4.id), await recordClosureEvent(RC.claimId, RC.intakeId, rcBody, DR.id)]
  check(
    'T025',
    'Independence policy enforced for confirmer',
    notIndependent.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_NOT_INDEPENDENT' && /never closed by its A8\.7 resolution's own requester or decider/.test(errorMessage(r.body)) && !rawError(r.body)) &&
      notIndependentService.every((r) => r.ok === false && r.code === 'EXCEPTION_CLOSURE_NOT_INDEPENDENT') && (await rcRows()) === 0 && (await eventsOf(W.intakeId)).length === 0,
    "M4 (RC's A8.7 requester and assignee) and DR (its A8.7 decider), and M1 and DR on W, each holding exceptionClosure.confirm, are refused 409 NOT_INDEPENDENT through the route and the service; nothing recorded (D1)",
  )
  // G: CF3's role is removed while its closure holds G's Claim lock.
  const holdG = holdAt('exceptionClosure.claim_locked')
  const gClose = recordClosureEvent(G.claimId, G.intakeId, closeOf(G), CF3.id)
  await Promise.race([holdG.arrived, gClose])
  await prisma.membershipRole.deleteMany({ where: { membershipId: CF3.membershipId } })
  holdG.release()
  const gResult = await gClose
  clearConcurrencyProbes()
  const gHttp = await closurePost(G, closeOf(G), CF3.who)
  const gDirect = await directInsert('G: a closure by CF3 after its role was removed', [rowOf(G, { recorded_by_membership_id: CF3.membershipId, recorded_by_user_id: CF3.id })])
  check(
    'T026',
    'Permission removed before commit refused',
    gResult.ok === false && gResult.code === 'EXCEPTION_CLOSURE_NOT_INDEPENDENT' && /holding the closure confirm permission now/.test(gResult.message) && gHttp.status === 403 && gDirect.refused &&
      /exception_closure_independence: the confirmer''?s roles must grant exceptionClosure\.confirm/.test(gDirect.message) && gDirect.clean && (await eventsOf(G.intakeId)).length === 0,
    "CF3's role was removed while its closure of G held the Claim lock: the closure re-read CF3's permissions under the lock and was refused 409; its next attempt is 403 and a direct row by CF3 is refused by the database guard; nothing recorded",
  )
  const missingEnvelope = (r: { body: any }) => ({ ...r.body?.error, requestId: null })
  const foreignClaim = [await closurePost(F, closeOf(F), asAdmin), await closureHistoryOf(F), await reconstructionOf(F)]
  const missingClaim = [await closurePost({ claimId: MISSING, intakeId: F.intakeId }, closeOf(F), asAdmin), await closureHistoryOf({ claimId: MISSING, intakeId: F.intakeId }), await reconstructionOf({ claimId: MISSING, intakeId: F.intakeId })]
  const foreignIntake = [await closurePost({ claimId: RC.claimId, intakeId: F.intakeId }, rcBody, CF.who), await closureHistoryOf({ claimId: RC.claimId, intakeId: F.intakeId }), await reconstructionOf({ claimId: RC.claimId, intakeId: F.intakeId })]
  const missingIntake = [await closurePost({ claimId: RC.claimId, intakeId: MISSING }, rcBody, CF.who), await closureHistoryOf({ claimId: RC.claimId, intakeId: MISSING }), await reconstructionOf({ claimId: RC.claimId, intakeId: MISSING })]
  const otherClaimIntake = [await closurePost({ claimId: RC.claimId, intakeId: S.intakeId }, closeOf(S), CF.who), await reconstructionOf({ claimId: RC.claimId, intakeId: S.intakeId })]
  check(
    'T027',
    'Foreign Claim/intake privacy-safe 404',
    foreignClaim.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingClaim[i]))) && foreignIntake.every((r, i) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[i]))) &&
      otherClaimIntake.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingIntake[0]))) && (await eventsOf(F.intakeId)).length === 0 && (await eventsOf(S.intakeId)).length === 0,
    "another organization's Claim and intake get exactly the missing-Claim envelope on all three routes; the other tenant's intake, or another Claim's intake of this tenant, named under RC's Claim is exactly the missing-intake 404; nothing recorded",
  )
  const missingDecision = await closurePost(RC, closeBody(MISSING), CF.who)
  const foreignDecisions = [await closurePost(RC, closeBody(decisionOf(F)), CF.who), await closurePost(RC, closeBody(decisionOf(W)), CF.who), await closurePost(RC, closeBody(inv(RC).findingId), CF.who)]
  const missingBasis = await closurePost(RC, closeBody(decisionRC, 'ESCALATION_RETURN', MISSING), CF.who)
  const foreignBasis = [await closurePost(RC, closeBody(decisionRC, 'ESCALATION_RETURN', esc(WR).returnId as string), CF.who), await closurePost(RC, closeBody(decisionRC, 'ESCALATION_RETURN', work(RC).verificationId), CF.who)]
  const requestAsDecision = await closurePost(RC, closeBody(requestOf(RC)), CF.who)
  check(
    'T028',
    'Foreign source owner identity refused',
    missingDecision.status === 404 && /resolution decision not found for this exception/.test(errorMessage(missingDecision.body)) &&
      foreignDecisions.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingDecision)) && !JSON.stringify(r.body).includes(decisionOf(F))) && missingBasis.status === 404 &&
      /basis record not found for this exception/.test(errorMessage(missingBasis.body)) && foreignBasis.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingBasis))) &&
      requestAsDecision.status === 409 && errorCode(requestAsDecision.body) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && /names exactly the exception's confirmed A8\.7 decision/.test(errorMessage(requestAsDecision.body)) && (await rcRows()) === 0,
    "on RC the other tenant's A8.7 decision, W's decision and RC's own A8.3 finding named as the decision are exactly the missing-decision 404; WR's A8.8 return and RC's A8.6 verification named as an ESCALATION_RETURN basis are exactly the missing-basis 404 (each owner identity is the intake's own, never a generic UUID); RC's own A8.7 request named as the decision is 409 NOT_ELIGIBLE; nothing recorded",
  )
  const forgedMembers = {
    mismatched: await directInsert('S: CF membership with M4 user', [rowOf(S, { recorded_by_user_id: M4.id })]),
    foreign: await directInsert("S: the other tenant's member", [rowOf(S, { recorded_by_membership_id: O.membershipId, recorded_by_user_id: O.id })]),
    missing: await directInsert('S: a missing membership', [rowOf(S, { recorded_by_membership_id: MISSING })]),
    otherTenantOfUser: await directInsert("S: M1's membership in the other tenant", [rowOf(S, { recorded_by_membership_id: M1X.id, recorded_by_user_id: M1.id })]),
  }
  check(
    'T029',
    'Direct SQL forged user/member refused',
    Object.values(forgedMembers).every((r) => r.refused && /exception_closure_member/.test(r.message) && r.clean) && (await eventsOf(S.intakeId)).length === 0,
    "a direct closure on S through a membership of another user, the other tenant's member, a missing membership or M1's own membership in the other tenant is refused by the member guard; each rolled back",
  )
  const sameOrgReads = [await closureHistoryOf(P), await reconstructionOf(P), await closureHistoryOf(P, asViewer), await reconstructionOf(P, asViewer), await closureHistoryOf(P, CF2.who), await reconstructionOf(P, CF2.who)]
  const readProofOk = parentReadProof.every((p) => p.statuses[1] === 403 && p.statuses[2] === 403) && same(ownPermissionProof.read.slice(1), [403, 403])
  check(
    'T030',
    'Admin/Viewer reads same authorized facts',
    sameOrgReads.every((r) => r.status === 200 && r.body.contractVersion === CONTRACT) && sameOrgReads[0].body.items.length === 1 && sameOrgReads[1].body.state === 'CLOSED_INTERNAL' &&
      withoutEvaluatedAt(sameOrgReads[0].body) === withoutEvaluatedAt(sameOrgReads[2].body) && withoutEvaluatedAt(sameOrgReads[1].body) === withoutEvaluatedAt(sameOrgReads[3].body) &&
      withoutEvaluatedAt(sameOrgReads[0].body) === withoutEvaluatedAt(sameOrgReads[4].body) && withoutEvaluatedAt(sameOrgReads[1].body) === withoutEvaluatedAt(sameOrgReads[5].body) && readProofOk,
    "the Admin, a Viewer and another member of Org A read P's history and reconstruction with 200 and identical bodies (CLOSED_INTERNAL, one event); without any one of the seven upstream reads, or without exceptionClosure.read, both reads are 403",
  )

  // ---------------------------------------------------------------- upstream state and closure gate (T031–T040)
  section('Upstream state and the closure gate: NO_CLOSURE is zero rows; A8.7 RESOLVED_INTERNAL by a confirmed decision is required; a pending, returned or absent resolution refuses; A8.6 verification is bound through A8.7; an outstanding A8.8 escalation refuses; a returned one is closed on its return (CL-01); an inconsistent owner fails closed')
  check(
    'T031',
    'No closure derives NO_CLOSURE',
    noClosureP.rows === 0 && noClosureP.history.status === 200 && same(noClosureP.history.body.items, []) && noClosureP.reconstruction.status === 200 && noClosureP.reconstruction.body.state === 'NO_CLOSURE' &&
      noClosureP.reconstruction.body.recordedClosure === null && same(noClosureP.reconstruction.body.chain, []) && same(noClosureP.reconstruction.body.submissions, []) &&
      (await reconstructionOf(RC)).body.state === 'NO_CLOSURE' && (await reconstructionOf(VW)).body.state === 'NO_CLOSURE' && !COLUMNS.some((c) => /state|status|closed/.test(c)),
    'before its closure P (A8.7 RESOLVED_INTERNAL) had zero rows and derived NO_CLOSURE with no recorded closure, chain or submission; RC (resolved) and VW (verified work only) derive NO_CLOSURE: a closure is never inferred from another owner; the table has no state or closed column',
  )
  const resolutionDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/resolution-disposition`)
  const escalationDispositionOf = (k: { claimId: string; intakeId: string }) => get(`${base(k)}/escalation-disposition`)
  const pResolution = (await resolutionDispositionOf(P)).body
  const factsOf = (state: string) => ({
    state,
    request: { resolutionEventId: MISSING, requestedByMembershipId: M4.membershipId, requestedByUserId: M4.id },
    decision: state === 'RESOLVED_INTERNAL' ? { resolutionEventId: MISSING, decisionCode: 'CONFIRM_INTERNAL_RESOLUTION', decidedByMembershipId: DR.membershipId, decidedByUserId: DR.id } : null,
  }) as any
  const gate = ['NO_RESOLUTION_REQUEST', 'AWAITING_RESOLUTION_DECISION', 'RETURNED_FOR_REWORK', 'RESOLVED_INTERNAL'].map((state) => eligibilityOf(factsOf(state), { state: 'NO_ESCALATION', returned: null }).ok)
  const pdDirect = await directInsert("PD: its A8.7 request named as the decision", [rowOf(PD, { resolution_decision_event_id: requestOf(PD), basis_reference_id: requestOf(PD) })])
  check(
    'T032',
    'A8.7 RESOLVED_INTERNAL explicitly required',
    pResolution.state === 'RESOLVED_INTERNAL' && pResolution.decision?.resolutionEventId === C_P.body.resolutionDecisionEventId && pResolution.decision?.decisionCode === 'CONFIRM_INTERNAL_RESOLUTION' &&
      same(gate, [false, false, false, true]) && pdDirect.refused && /exception_closure_eligibility: a closure names exactly the intake''?s confirmed A8\.7 internal resolution/.test(pdDirect.message) && pdDirect.clean,
    "P's closure names exactly the decision its A8.7 owner reports as CONFIRM_INTERNAL_RESOLUTION (RESOLVED_INTERNAL); the pure gate admits RESOLVED_INTERNAL only (NO_RESOLUTION_REQUEST, AWAITING_RESOLUTION_DECISION and RETURNED_FOR_REWORK refused); a direct row naming anything but a confirmed decision is refused by the guard",
  )
  const pdRoute = await closurePost(PD, closeBody(requestOf(PD)), CF.who)
  const pdService = await recordClosureEvent(PD.claimId, PD.intakeId, closeBody(requestOf(PD)), CF.id)
  check(
    'T033',
    'A8.7 pending decision blocks closure',
    (await resolutionDispositionOf(PD)).body.state === 'AWAITING_RESOLUTION_DECISION' && pdRoute.status === 409 && errorCode(pdRoute.body) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && /awaits a decision/.test(errorMessage(pdRoute.body)) &&
      pdService.ok === false && pdService.code === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && (await eventsOf(PD.intakeId)).length === 0,
    "while PD's A8.7 request awaits a decision a closure naming it is refused 409 NOT_ELIGIBLE (route and service; the guard in T032); nothing recorded",
  )
  const rkRoutes = [await closurePost(RK, closeBody(RK_DECISION), CF.who), await closurePost(RK, closeBody(RK_DECISION, 'ESCALATION_RETURN', esc(RK).returnId as string), CF.who)]
  const rkDirect = await directInsert('RK: its RETURN_FOR_REWORK decision', [rowOf(RK, { resolution_decision_event_id: RK_DECISION, basis_reference_kind: 'ESCALATION_RETURN', basis_reference_id: esc(RK).returnId, basis_owner_contract_version: 'A8-ESCALATION-1', closure_reason_code: 'TERMINAL_FOLLOWUP_REVIEWED' })])
  check(
    'T034',
    'A8.7 returned for rework blocks closure',
    (await resolutionDispositionOf(RK)).body.state === 'RETURNED_FOR_REWORK' && rkRoutes.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && /returned for rework/.test(errorMessage(r.body))) &&
      rkDirect.refused && /exception_closure_eligibility: a closure names exactly the intake''?s confirmed A8\.7/.test(rkDirect.message) && rkDirect.clean && (await eventsOf(RK.intakeId)).length === 0,
    "RK's A8.7 request was RETURNED_FOR_REWORK: a closure naming that decision — on it, or on RK's later A8.8 return — is refused 409 NOT_ELIGIBLE and a direct row by the guard; nothing recorded",
  )
  const noDecision = [await closurePost(VW, closeBody(decisionOf(W)), CF.who), await closurePost(N0, closeBody(decisionOf(W)), CF.who), await closurePost(VW, closeBody(MISSING), CF.who)]
  const vwDirect = await directInsert("VW: W's decision", [rowOf(VW, { resolution_decision_event_id: decisionOf(W), basis_reference_id: decisionOf(W) })])
  check(
    'T035',
    'A8.7 no decision blocks closure',
    (await resolutionDispositionOf(VW)).body.state === 'NO_RESOLUTION_REQUEST' && (await resolutionDispositionOf(N0)).body.state === 'NO_RESOLUTION_REQUEST' &&
      noDecision.every((r) => r.status === 404 && same(missingEnvelope(r), missingEnvelope(missingDecision))) && vwDirect.refused && /exception_closure_eligibility/.test(vwDirect.message) && vwDirect.clean &&
      gate[0] === false && (await eventsOf(VW.intakeId)).length === 0 && (await eventsOf(N0.intakeId)).length === 0,
    "VW (verified work, no A8.7 request) and N0 (no work) hold no A8.7 decision: a closure naming W's or a missing decision is exactly the missing-decision 404, a direct row is refused by the guard, and the pure gate refuses NO_RESOLUTION_REQUEST; nothing recorded",
  )
  const brokenVerification = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
    await tx.$executeRawUnsafe(`UPDATE ${RESOLUTION_TABLE} SET verification_event_id = $1::uuid WHERE id = $2::uuid`, WW.verificationId, requestOf(P))
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    return getClosureReconstructionOf(P.claimId, P.intakeId, tx)
  })
  const pWork = (await get(`${base(P)}/remediation-work-disposition`)).body
  const pChain = reconstructionP.body.chain as any[]
  check(
    'T036',
    'A8.6 missing/broken verification refused',
    pWork.state === 'VERIFIED_INTERNAL_WORK' && pResolution.request?.verificationEventId === work(P).verificationId && pChain.some((e) => e.owner === 'A8.6' && e.recordId === work(P).verificationId && e.eventCode === 'VERIFY_WORK_REPORT') &&
      brokenVerification.value?.ok === false && brokenVerification.value.code === 'INTEGRITY_CONFLICT' && brokenVerification.clean,
    "P's closure rests on its A8.7 request, which binds P's own EVIDENCE_SUPPORTED A8.6 verification, anchored in the reconstruction; with that request planted to cite W's verification instead (rolled back) P's reconstruction refuses whole (409 INTEGRITY_CONFLICT) — a missing or broken verification never yields a trusted basis",
  )
  const awaRoutes = [await closurePost(AWA, closeBody(decisionOf(AWA)), CF.who), await closurePost(AWA, closeBody(decisionOf(AWA), 'ESCALATION_RETURN', esc(AWA).escalationId), CF.who)]
  const awaDirect = await directInsert('AWA: its decision while its escalation awaits acknowledgement', [rowOf(AWA)])
  check(
    'T037',
    'A8.8 pending acknowledgement blocks closure',
    (await escalationDispositionOf(AWA)).body.state === 'AWAITING_ACKNOWLEDGEMENT' && (await resolutionDispositionOf(AWA)).body.state === 'RESOLVED_INTERNAL' &&
      awaRoutes.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && /AWAITING_ACKNOWLEDGEMENT: it is still outstanding/.test(errorMessage(r.body))) && awaDirect.refused &&
      /exception_closure_eligibility: the intake''?s A8\.8 escalation is still outstanding/.test(awaDirect.message) && awaDirect.clean && (await eventsOf(AWA.intakeId)).length === 0,
    "AWA is RESOLVED_INTERNAL under A8.7 but its A8.8 escalation awaits acknowledgement: a closure on its decision or naming the escalation is refused 409 NOT_ELIGIBLE (outstanding) and a direct row by the guard; nothing recorded",
  )
  const opnRoutes = [await closurePost(OPN, closeBody(decisionOf(OPN)), CF.who), await closurePost(OPN, closeBody(decisionOf(OPN), 'ESCALATION_RETURN', esc(OPN).followupIds[0]), CF.who)]
  const opnDirect = await directInsert('OPN: its decision while follow-up is active (CL-02)', [rowOf(OPN)])
  check(
    'T038',
    'A8.8 active follow-up blocks closure',
    (await escalationDispositionOf(OPN)).body.state === 'FOLLOWUP_ACTIVE' && (await resolutionDispositionOf(OPN)).body.state === 'RESOLVED_INTERNAL' &&
      opnRoutes.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && /FOLLOWUP_ACTIVE: it is still outstanding/.test(errorMessage(r.body))) && opnDirect.refused &&
      /exception_closure_eligibility: the intake''?s A8\.8 escalation is still outstanding/.test(opnDirect.message) && opnDirect.clean && (await eventsOf(OPN.intakeId)).length === 0,
    "OPN is RESOLVED_INTERNAL with its A8.8 follow-up still active (CL-02): a closure on its decision or naming its follow-up is refused 409 NOT_ELIGIBLE and a direct row by the guard; nothing recorded (a v1 dead end: A8.8 accepts no return once A8.7 resolved)",
  )
  const wrWrong = [
    await closurePost(WR, closeBody(decisionOf(WR)), CF.who), await closurePost(WR, closeBody(decisionOf(WR), 'ESCALATION_RETURN', esc(WR).escalationId), CF.who),
    await closurePost(WR, closeBody(decisionOf(WR), 'ESCALATION_RETURN', esc(WR).followupIds[0]), CF.who),
  ]
  // CL-01 refused: FW is in WR's position, but its escalation was returned for FURTHER_WORK_REQUIRED.
  const fwRoutes = [
    await closurePost(FW, closeOf(FW), CF.who), await closurePost(FW, closeBody(decisionOf(FW)), CF.who),
    await closurePost(FW, closeBody(decisionOf(FW), 'ESCALATION_RETURN', esc(FW).escalationId), CF.who),
  ]
  const fwDirect = await directInsert('FW: its return for FURTHER_WORK_REQUIRED as the basis (CL-01, v1)', [rowOf(FW)])
  const fwReturn = (await escalationDispositionOf(FW)).body
  const countsBeforeWR = await counts()
  const C_WR = await closurePost(WR, closeOf(WR), CF.who)
  const C_WR_ID = (C_WR.body?.closureEventId ?? MISSING) as string
  check(
    'T039',
    'A8.8 returned terminal follows approved policy',
    (await escalationDispositionOf(WR)).body.state === 'RETURNED_TO_OWNER' && wrWrong.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && /the return of its completed A8\.8 escalation/.test(errorMessage(r.body))) &&
      C_WR.status === 201 && C_WR.body.basisReferenceKind === 'ESCALATION_RETURN' && C_WR.body.basisReferenceId === esc(WR).returnId && C_WR.body.closureReasonCode === 'TERMINAL_FOLLOWUP_REVIEWED' &&
      C_WR.body.basisOwnerContractVersion === 'A8-ESCALATION-1' && C_WR.body.resolutionDecisionEventId === decisionOf(WR) && same(await counts(), plus(countsBeforeWR, 1)) &&
      (await escalationDispositionOf(WR)).body.returned?.returnReasonCode === 'FOLLOWUP_RECORDED' && fwReturn.state === 'RETURNED_TO_OWNER' && fwReturn.returned?.returnReasonCode === 'FURTHER_WORK_REQUIRED' &&
      (await resolutionDispositionOf(FW)).body.state === 'RESOLVED_INTERNAL' && fwRoutes.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE') &&
      /further work is required \(FURTHER_WORK_REQUIRED\); it is not closed in v1/.test(errorMessage(fwRoutes[0].body)) && fwDirect.refused &&
      /exception_closure_eligibility: the intake''?s A8\.8 escalation was returned for further work/.test(fwDirect.message) && fwDirect.clean && (await eventsOf(FW.intakeId)).length === 0,
    "WR (A8.7 RESOLVED_INTERNAL after its A8.8 escalation was RETURNED_TO_OWNER): a closure on the decision alone, or naming the escalation or a follow-up, is refused 409; on its exact RETURN_TO_OWNER event, returned for FOLLOWUP_RECORDED (ESCALATION_RETURN, TERMINAL_FOLLOWUP_REVIEWED, A8-ESCALATION-1), CF closes it (201) naming its exact A8.7 decision. FW, in the same position but returned for FURTHER_WORK_REQUIRED, is refused 409 NOT_ELIGIBLE on its return, its decision and its escalation, and a direct row by the guard; nothing recorded — CL-01 as approved",
  )
  const plantResolution = (tx: DbClient, k: Intake, sequence: number) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${RESOLUTION_TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, request_event_id, decision_code, recorded_by_membership_id, recorded_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'A8-RESOLUTION-DECISION-1', $5::int, 'DECIDE_INTERNAL_RESOLUTION', $6::uuid, 'CONFIRM_INTERNAL_RESOLUTION', $7::uuid, $8::uuid)`,
      randomUUID(), k.intakeId, k.organizationId, k.claimId, sequence, MISSING, DR.membershipId, DR.id,
    )
  const onPlanted = (plant: (tx: DbClient) => Promise<unknown>, k: Intake, body: unknown) =>
    rolledBack(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await plant(tx)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      return recordClosureEventOn(k.claimId, k.intakeId, body, CF.id, tx)
    })
  const gapOf = (table: string, k: Intake, extra = '') => (tx: DbClient) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(t) || jsonb_build_object('id', gen_random_uuid(), 'sequence', t.sequence + 5)${extra})).* FROM ${table} t WHERE t.exception_intake_id = $1::uuid ORDER BY t.sequence DESC LIMIT 1`,
      k.intakeId,
    )
  const inconsistentResolution = await onPlanted((tx) => plantResolution(tx, VW, 2), VW, closeBody(decisionOf(W)))
  const inconsistentTriage = await onPlanted(gapOf(TRIAGE_TABLE, RC), RC, rcBody)
  const followupGap = (k: Intake, extra = '') => (tx: DbClient) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${ESCALATION_TABLE} SELECT (jsonb_populate_record(NULL::${ESCALATION_TABLE}, to_jsonb(t) || jsonb_build_object('id', gen_random_uuid(), 'sequence', t.sequence + 5, 'followup_code', 'INTERNAL_POLICY_REVIEWED'${extra}))).* FROM ${ESCALATION_TABLE} t WHERE t.exception_intake_id = $1::uuid AND t.event_code = 'RECORD_FOLLOWUP' LIMIT 1`,
      k.intakeId,
    )
  const inconsistentEscalation = await onPlanted(followupGap(H), H, closeOf(H))
  check(
    'T040',
    'Unknown/contradictory owner history 409',
    [inconsistentResolution, inconsistentTriage, inconsistentEscalation].every((r) => r.value?.ok === false && r.value.code === 'EXCEPTION_CLOSURE_CONFLICT' && r.clean) &&
      (await eventsOf(VW.intakeId)).length === 0 && (await rcRows()) === 0 && (await eventsOf(H.intakeId)).length === 0,
    "with an A8.7 history planted out of sequence on VW, an A8.2 history planted with a gap on RC and an A8.8 history planted with a gap on H (each rolled back), the owner cannot answer for itself and the closure fails closed (409 CONFLICT) — terminal truth is never inferred; nothing recorded",
  )

  // ---------------------------------------------------------------- legal transition and semantics (T041–T050)
  section("Legal transition on W (A8.7 RESOLVED_INTERNAL, no escalation): one human confirmation, CLOSED_INTERNAL, one closure per intake, a repeat or a different second closure writes nothing, nothing implicit from A8.6 or A8.8, no payer, payment, clinical or resolution meaning, every earlier owner DTO unchanged")
  const countsBeforeW = await counts()
  const C_W = await closurePost(W, closeOf(W), CF.who)
  const C_W_ID = (C_W.body?.closureEventId ?? MISSING) as string
  const cwHashAtCreation = await rowHash(C_W_ID)
  const countsAfterW = await counts()
  const cwAudits = await auditsOfEvent(C_W_ID)
  check(
    'T041',
    'Human CONFIRM_INTERNAL_CLOSURE accepted once',
    C_W.status === 201 && C_W.body.eventCode === 'CONFIRM_INTERNAL_CLOSURE' && C_W.body.sequence === 1 && C_W.body.recordedByMembershipId === CF.membershipId && C_W.body.recordedByUserId === CF.id &&
      C_W.body.resolutionDecisionEventId === decisionOf(W) && C_W.body.basisReferenceKind === 'RESOLUTION_DECISION' && C_W.body.basisReferenceId === decisionOf(W) && C_W.body.closureReasonCode === 'VERIFIED_INTERNAL_RESOLUTION' &&
      same(countsAfterW, plus(countsBeforeW, 1)) && cwAudits.length === 1 && cwAudits[0].actionCode === 'exception_closure.recorded' && cwAudits[0].organizationId === org && cwAudits[0].actorUserId === CF.id && cwAudits[0].beforeState === null,
    "CF — a human member independent of W's A8.7 requester M1 and decider DR — confirms W's internal closure on its A8.7 confirmation (201, event 1, VERIFIED_INTERNAL_RESOLUTION); exactly one closure row and one audit (exception_closure.recorded, Org A, actor CF) were added and nothing else changed",
  )
  const wHistory = (await closureHistoryOf(W)).body
  const wReconstruction = (await reconstructionOf(W)).body
  check(
    'T042',
    'Successful event derives CLOSED_INTERNAL',
    wReconstruction.state === 'CLOSED_INTERNAL' && JSON.stringify(wReconstruction.recordedClosure) === JSON.stringify(C_W.body) && wHistory.items.length === 1 && JSON.stringify(wHistory.items[0]) === JSON.stringify(C_W.body) &&
      deriveClosure({ exceptionIntakeId: W.intakeId, organizationId: W.organizationId, claimId: W.claimId }, await eventsOf(W.intakeId)).ok,
    "W derives CLOSED_INTERNAL; its recorded closure and its one history item are byte-for-byte the event the route answered; the pure reducer derives the same from the stored row",
  )
  const multi = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM (SELECT exception_intake_id FROM ${TABLE} GROUP BY exception_intake_id HAVING count(*) > 1) x`)
  const intakeKey = await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT indexdef AS d FROM pg_indexes WHERE indexname = '${TABLE}_exception_intake_id_key'`)
  check(
    'T043',
    'One terminal closure per intake',
    Number(multi[0].n) === 0 && /UNIQUE INDEX/.test(intakeKey[0]?.d ?? '') && /\(exception_intake_id\)/.test(intakeKey[0]?.d ?? '') && (await eventsOf(W.intakeId)).length === 1 && (await eventsOf(P.intakeId)).length === 1 &&
      (await eventsOf(WR.intakeId)).length === 1,
    'no intake in the database holds more than one closure; one closure per intake is a UNIQUE index of its own (exception_intake_id); W, P and WR each hold exactly one',
  )
  const wHistoryBytes = withoutEvaluatedAt(wHistory)
  const countsBeforeRepeat = await counts()
  const repeatW = [await closurePost(W, closeOf(W), CF.who), await closurePost(W, closeOf(W), CF.who)]
  const repeatWService = await recordClosureEvent(W.claimId, W.intakeId, closeOf(W), CF.id)
  check(
    'T044',
    'Duplicate identical closure writes nothing',
    repeatW.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_TRANSITION_REFUSED' && /CLOSED_INTERNAL, which is terminal in v1/.test(errorMessage(r.body))) && repeatWService.ok === false &&
      repeatWService.code === 'EXCEPTION_CLOSURE_TRANSITION_REFUSED' && (await unchanged(countsBeforeRepeat)) && withoutEvaluatedAt((await closureHistoryOf(W)).body) === wHistoryBytes,
    "CF repeating exactly its closure of W, twice through the route and once through the service, is refused 409 each time (D4: never a replayed 201); no row, no audit, and W's history reads back byte-identical",
  )
  const differentSecond = [await closurePost(W, closeOf(W), CF2.who), await closurePost(WR, closeOf(WR), CF2.who), await closurePost(P, closeOf(P), CF2.who)]
  const secondDirect = await directInsert('W: a second closure by CF2', [rowOf(W, { recorded_by_membership_id: CF2.membershipId, recorded_by_user_id: CF2.id })])
  check(
    'T045',
    'Different second closure refused',
    differentSecond.every((r) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_TRANSITION_REFUSED') && secondDirect.refused && /exception_closure_transition: the exception is already CLOSED_INTERNAL/.test(secondDirect.message) &&
      secondDirect.clean && (await unchanged(countsBeforeRepeat)),
    "a second closure by another confirmer (CF2) of W, WR or P is refused 409, and a direct second row on W by the guard; nothing recorded",
  )
  const quietIntakes = [VW, N0, PD, RK, AWA, OPN, FW, S, SR]
  const quietRows = await prisma.exceptionClosureEvent.count({ where: { exceptionIntakeId: { in: quietIntakes.map((k) => k.intakeId) } } })
  const vwWork = (await get(`${base(VW)}/remediation-work-disposition`)).body
  check(
    'T046',
    'No implicit closure from A8.6 VERIFIED_INTERNAL_WORK',
    vwWork.state === 'VERIFIED_INTERNAL_WORK' && (await eventsOf(VW.intakeId)).length === 0 && (await reconstructionOf(VW)).body.state === 'NO_CLOSURE' && quietRows === 0 && callers.length === 0,
    `VW's A8.6 work reads VERIFIED_INTERNAL_WORK, yet VW holds no closure and derives NO_CLOSURE; none of the ${quietIntakes.length} intakes nobody closed (${quietIntakes.map((k) => k.label).join(', ')}) holds a closure row; no other module's production code calls A8.9`,
  )
  check(
    'T047',
    'No implicit closure from A8.8 RETURNED_TO_OWNER',
    (await escalationDispositionOf(RK)).body.state === 'RETURNED_TO_OWNER' && (await escalationDispositionOf(H)).body.state === 'RETURNED_TO_OWNER' && (await escalationDispositionOf(SR)).body.state === 'RETURNED_TO_OWNER' &&
      (await eventsOf(RK.intakeId)).length === 0 && (await eventsOf(H.intakeId)).length === 0 && (await eventsOf(SR.intakeId)).length === 0 && (await reconstructionOf(H)).body.state === 'NO_CLOSURE' &&
      !callers.some((f) => f.includes('exception-escalation')),
    "RK, H and SR read A8.8 RETURNED_TO_OWNER (H and SR also A8.7 RESOLVED_INTERNAL), yet none holds a closure: H derives NO_CLOSURE until a human confirms it (T086), and RK (A8.7 returned for rework) is refused (T034)",
  )
  const wClaimNow = await hashOf(`SELECT c.* FROM claims c WHERE c.id = ANY($1::uuid[])`, [...runClaims, F.claimId])
  const closureText = JSON.stringify([C_W.body, C_WR.body, C_P.body, wReconstruction])
  check(
    'T048',
    'Not a payer adjudication or payment status',
    wClaimNow === ownerSnapshotBefore.claims && !/PAID|DENIED|SETTLED|ADJUDICAT|REMIT|PAYMENT|PAYER|APPROVED_CLAIM|COMPLIANT/i.test(closureText.replace(/[0-9a-f-]{36}/g, '')) &&
      ![...EVENT_KEYS, ...RECONSTRUCTION_KEYS, ...ENTRY_KEYS, ...SUBMISSION_KEYS].some((k) => /payer|payment|amount|currency|adjudicat|remit|settle|paid|denial|claimStatus/i.test(k)) &&
      registerFlat.includes('a payer adjudication or a resolved external claim') && registerFlat.includes('a remittance, a financial settlement or a payment outcome'),
    'no Claim of this run changed; no closure DTO, reconstruction or key names a payer, payment, amount, adjudication, remittance or compliance outcome; the register states that CLOSED_INTERNAL is none of these',
  )
  const resolutionHash = () => idsHash(RESOLUTION_TABLE, resolutionIdsBefore)
  check(
    'T049',
    'No clinical/resolution override',
    (await resolutionHash()) === resolutionHashBefore && (await resolutionDispositionOf(W)).body.state === 'RESOLVED_INTERNAL' && !/recordResolutionEvent|INSERT INTO "?exception_resolution/.test(moduleCodeEarly) &&
      !/clinical|diagnos|procedure/i.test(COLUMNS.join(' ')) && withoutEvaluatedAt((await get(`${base(W)}/resolution-history`)).body) === wOwnerDtosBefore[10],
    `all ${resolutionIdsBefore.length} A8.7 events of this run are byte-identical after the closures; W still reads RESOLVED_INTERNAL with the same history; the module writes no A8.7 record and holds no clinical value`,
  )
  check(
    'T050',
    'Prior A8.1–A8.8 DTO bytes unchanged',
    same(await ownerDtos(W), wOwnerDtosBefore) && same(await ownerDtos(WR), wrOwnerDtosBefore) && (await rowHash(C_P_ID)) === cpHashAtCreation && (await rowHash(C_W_ID)) === cwHashAtCreation,
    `each of the ${ownerReads(W).length} A8.1–A8.8 reads of W and of WR (intake list, triage, investigation, remediation, work, resolution and escalation dispositions and histories) answers byte-for-byte as before its closure; P's and W's closure rows hash as when written`,
  )

  // ---------------------------------------------------------------- historical reconstruction (T051–T060)
  section("Historical reconstruction of W and WR: the exact A8.7 decision and A8.8 return, the A8.5 plan, the A8.6 verification, the A8.3 link and finding, the A8.2 history, the A8.1 intake, the frozen submissions through their owner, the CRG status verbatim, nothing rewritten by a later change")
  const wChain = wReconstruction.chain as any[]
  const wrReconstruction = (await reconstructionOf(WR)).body
  const wrChain = wrReconstruction.chain as any[]
  const ownerIds = async (k: Intake, path: string, idKey: string) => ((await get(`${base(k)}/${path}`)).body.items as any[]).map((item) => [item[idKey], item.sequence, item.eventCode, item.contractVersion])
  const entriesOf = (chain: any[], owner: string) => chain.filter((e) => e.owner === owner).map((e) => [e.recordId, e.sequence, e.eventCode, e.ownerContractVersion])
  const wResolutionHistory = await ownerIds(W, 'resolution-history', 'resolutionEventId')
  check(
    'T051',
    'Closure anchors exact A8.7 decision ID',
    wReconstruction.recordedClosure?.resolutionDecisionEventId === decisionOf(W) && same(entriesOf(wChain, 'A8.7'), wResolutionHistory) &&
      same(wResolutionHistory.map((e) => [e[0], e[2]]), [[requestOf(W), 'REQUEST_INTERNAL_RESOLUTION'], [decisionOf(W), 'DECIDE_INTERNAL_RESOLUTION']]) && (await eventsOf(W.intakeId))[0]?.resolutionDecisionEventId === decisionOf(W),
    "W's recorded closure names exactly DR's CONFIRM decision; the reconstruction's A8.7 entries are exactly the A8.7 owner's history (M1's request 1 → DR's decision 2, each with its contract); the stored row holds that decision under a RESTRICT key",
  )
  const wrEscalationHistory = await ownerIds(WR, 'escalation-history', 'escalationEventId')
  check(
    'T052',
    'Closure anchors correct A8.8 state ID if any',
    wrReconstruction.state === 'CLOSED_INTERNAL' && wrReconstruction.recordedClosure?.basisReferenceId === esc(WR).returnId && same(entriesOf(wrChain, 'A8.8'), wrEscalationHistory) &&
      same(wrEscalationHistory.map((e) => e[0]), [esc(WR).escalationId, esc(WR).ackId, ...esc(WR).followupIds, esc(WR).returnId]) && wrEscalationHistory[wrEscalationHistory.length - 1][2] === 'RETURN_TO_OWNER' &&
      entriesOf(wChain, 'A8.8').length === 0 && wReconstruction.recordedClosure?.basisReferenceKind === 'RESOLUTION_DECISION',
    "WR's recorded closure names exactly RW's RETURN_TO_OWNER event; its A8.8 entries are exactly the A8.8 owner's history (escalation → acknowledgement → follow-up → return); W, never escalated, has no A8.8 entry and its basis is its A8.7 decision",
  )
  const wRemediationHistory = await ownerIds(W, 'remediation-history', 'remediationEventId')
  const wRemediation = (await get(`${base(W)}/remediation-disposition`)).body
  const wWork = (await get(`${base(W)}/remediation-work-disposition`)).body
  check(
    'T053',
    'A8.5 approved proposal linkage exact',
    same(entriesOf(wChain, 'A8.5'), wRemediationHistory) && wRemediationHistory.length === 2 && wRemediationHistory[0][0] === PW.proposalId && wRemediationHistory[0][2] === 'PROPOSE_ACTION' &&
      wRemediation.approvedProposalEventId === PW.proposalId && wWork.approvedProposalEventId === PW.proposalId,
    "the A8.5 entries are exactly the A8.5 owner's history (M1's proposal → RV's approval); the proposal is the one the A8.5 owner reports as approved and the one W's verified A8.6 work sits on",
  )
  const wWorkHistory = await ownerIds(W, 'remediation-work-history', 'workEventId')
  const wResolutionDisposition = (await resolutionDispositionOf(W)).body
  check(
    'T054',
    'A8.6 verification linkage exact',
    same(entriesOf(wChain, 'A8.6'), wWorkHistory) && same(wWorkHistory.map((e) => [e[0], e[2]]), [[WW.reportId, 'RECORD_WORK_REPORT'], [WW.verificationId, 'VERIFY_WORK_REPORT']]) &&
      wWork.verification?.workEventId === WW.verificationId && wResolutionDisposition.request?.verificationEventId === WW.verificationId,
    "the A8.6 entries are exactly the A8.6 owner's history (M1's report → VR's EVIDENCE_SUPPORTED verification); that verification is the one W's A8.7 request was decided on",
  )
  const wInvestigationHistory = await ownerIds(W, 'investigation-history', 'investigationEventId')
  check(
    'T055',
    'A8.3 evidence contract/identity exact',
    same(entriesOf(wChain, 'A8.3'), wInvestigationHistory) && same(wInvestigationHistory.map((e) => e[0]), [IW.linkId, IW.findingId]) && wInvestigationHistory.every((e) => typeof e[3] === 'string' && e[3].length > 0),
    `the A8.3 entries are exactly the A8.3 owner's history — the INTAKE_BASIS link and the finding naming it — each with its owner contract (${wInvestigationHistory[0]?.[3] ?? 'none'})`,
  )
  const wTriageHistory = await ownerIds(W, 'triage-history', 'triageEventId')
  const wTriage = (await get(`${base(W)}/triage-disposition`)).body
  check(
    'T056',
    'A8.2 history and assignment identity exact',
    same(entriesOf(wChain, 'A8.2'), wTriageHistory) && same(wTriageHistory.map((e) => e[0]), [W_CLASSIFY.triageEventId, W_ASSIGN.triageEventId]) && wTriage.dispositionCode === 'ASSIGNED' && wTriage.assignedMemberId === M1.membershipId,
    "the A8.2 entries are exactly the A8.2 owner's history (classification 1 → assignment 2); W is assigned to M1, exactly as A8.2 recorded it",
  )
  const expectedOwners = ['A8.1', 'A8.2', 'A8.2', 'A8.3', 'A8.3', 'A8.5', 'A8.5', 'A8.6', 'A8.6', 'A8.7', 'A8.7', 'A8.9']
  check(
    'T057',
    'A8.1 intake/basis identity exact',
    same(wChain[0], { position: 1, owner: 'A8.1', ownerContractVersion: INTAKE_CONTRACT, recordId: W.intakeId, sequence: null, eventCode: null }) && same(wChain.map((e) => e.owner), expectedOwners) &&
      same(wChain.map((e) => e.position), expectedOwners.map((_o, i) => i + 1)) && same(wChain[wChain.length - 1], { position: 12, owner: 'A8.9', ownerContractVersion: CONTRACT, recordId: C_W_ID, sequence: 1, eventCode: 'CONFIRM_INTERNAL_CLOSURE' }) &&
      same(wrChain.map((e) => e.owner), ['A8.1', 'A8.2', 'A8.2', 'A8.3', 'A8.3', 'A8.5', 'A8.5', 'A8.6', 'A8.6', 'A8.7', 'A8.7', 'A8.8', 'A8.8', 'A8.8', 'A8.8', 'A8.9']),
    `W's chain opens with its A8.1 intake (${INTAKE_CONTRACT}, the intake id, no sequence) and runs in the canonical order ${expectedOwners.join(' → ')} at positions 1..12, ending with the recorded closure; WR's adds its four A8.8 events before its closure`,
  )
  const wSubmissions = wReconstruction.submissions as any[]
  const reconstructionModuleCode = committedProductionCodeOf([MODULE_DIR]).code
  check(
    'T058',
    'Frozen A6/A7 evidence only via owner readers',
    same(wSubmissions.map((s) => s.submissionId).sort(), [...W.freezes].sort()) && /findFreezesOfClaim\(claim, tx\)/.test(reconstructionModuleCode) && /getSubmissionCodingProvenanceOf\(freeze\.id, tx\)/.test(reconstructionModuleCode) &&
      !/claim_freezes|claimFreeze\.|claimSubmission\.|revenue_source|revenueSourceEvidence|evidence_case/.test(reconstructionModuleCode) && (await snap()).freezes === ownerSnapshotBefore.freezes,
    `W's reconstruction lists exactly its ${W.freezes.length} frozen submissions, read through the A6.7 owner and the CRG owner on the read's own snapshot; the module queries no A6 or A7 table itself and every freeze and manifest of this run is byte-identical`,
  )
  const ownerStatuses = await Promise.all(wSubmissions.map(async (s) => (await getSubmissionCodingProvenance(s.submissionId)) as any))
  check(
    'T059',
    'CRG legacy remains LEGACY_PROVENANCE_UNVERIFIED',
    wSubmissions.length > 0 && wSubmissions.every((s, i) => ownerStatuses[i]?.ok && s.codingVerificationStatus === ownerStatuses[i].value.verificationStatus && s.submissionContractVersion === ownerStatuses[i].value.submissionContractVersion) &&
      wSubmissions.every((s) => (s.submissionContractVersion === 'A6-SUBMISSION-2' ? s.codingVerificationStatus === 'VERIFIED_AS_RECORDED' : s.codingVerificationStatus === 'LEGACY_PROVENANCE_UNVERIFIED')) &&
      wSubmissions.some((s) => s.codingVerificationStatus === 'LEGACY_PROVENANCE_UNVERIFIED') && !/COMPLIANT|REGULATORY_PASS|PASSED/.test(JSON.stringify(wSubmissions)),
    `each of W's submissions carries exactly the status the CRG owner reports (${wSubmissions.map((s) => `${s.submissionContractVersion}: ${s.codingVerificationStatus}`).join('; ')}); a legacy freeze stays LEGACY_PROVENANCE_UNVERIFIED, never upgraded or called compliant`,
  )
  const pReconstructionBefore = withoutEvaluatedAt(reconstructionP.body)
  const pHistoryBefore = withoutEvaluatedAt(historyP.body)
  const codingBefore = await tableCounts(CODING_TABLES)
  await prisma.membershipRole.deleteMany({ where: { membershipId: CFP.membershipId } })
  const pReconstructionAfter = await reconstructionOf(P)
  const pHistoryAfter = await closureHistoryOf(P)
  check(
    'T060',
    'No current rights/edition alters historic result',
    withoutEvaluatedAt(pReconstructionAfter.body) === pReconstructionBefore && withoutEvaluatedAt(pHistoryAfter.body) === pHistoryBefore && pReconstructionAfter.body.recordedClosure?.recordedByMembershipId === CFP.membershipId &&
      (await tableCounts(CODING_TABLES)) === codingBefore && !/getEffectivePermissions\(/.test(committedCode(`${MODULE_DIR}/exception-closure.service.ts`).slice(committedCode(`${MODULE_DIR}/exception-closure.service.ts`).indexOf('// ---- reads'))),
    "after CFP — P's confirmer — lost its role, P's history and reconstruction read back byte-identical and still name CFP; the reads consult no current permission, right, edition or membership, and no coding-release or validation row changed",
  )

  // ---------------------------------------------------------------- SQL integrity and immutability on S and SR (T061–T070, always rolled back)
  section('SQL integrity on S and SR (always rolled back): RESTRICT keys, valid direct closures, cross-intake, foreign tenant and Claim, forged references, forged permission and actors, CHECKs with triggers off, sequence, UPDATE/DELETE/TRUNCATE, the one-closure backstop')
  const fksOf = (table: string) => prisma.$queryRawUnsafe<{ name: string; del: string }[]>(`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid = '${table}'::regclass ORDER BY conname`)
  const fks = await fksOf(TABLE)
  const parentDeletes = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${INTAKE_TABLE} WHERE id = $1::uuid`, W.intakeId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${RESOLUTION_TABLE} WHERE id = $1::uuid`, decisionOf(W))),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM organization_memberships WHERE id = $1::uuid`, CF.membershipId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id = $1::uuid`, CF.id)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM claims WHERE id = $1::uuid`, W.claimId)), await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, C_W_ID)),
  ]
  // W's A8.7 decision with the A8.7 table's own triggers off: only this table's RESTRICT key can refuse.
  const restrictAlone = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE ${RESOLUTION_TABLE} DISABLE TRIGGER USER`)
    await tx.$executeRawUnsafe(`DELETE FROM ${RESOLUTION_TABLE} WHERE id = $1::uuid`, decisionOf(W))
  })
  check(
    'T061',
    'All parent FKs RESTRICT scoped',
    fks.length === 6 && fks.every((fk) => fk.del === 'r') && parentDeletes.every((r) => !r.message.includes(NOT_COMMITTED) && /append-only|foreign key|23503|cannot be deleted/.test(r.message) && r.clean) &&
      /foreign key|23503/.test(restrictAlone.message) && /exception_closure_events_resolution_decision_event_id_fkey/.test(restrictAlone.message) && restrictAlone.clean,
    `${fks.map((f) => f.name.replace(`${TABLE}_`, '')).join(', ')}: all ON DELETE RESTRICT; deleting W's intake, its A8.7 decision, CF's membership or user, the Claim or the closure itself is refused; with the A8.7 table's own triggers disabled, W's decision is still held by this table's RESTRICT key alone`,
  )
  const validDirect = [
    await directInsert('S: a valid closure by CF', [rowOf(S)]), await directInsert('S: a valid closure by CF2', [rowOf(S, { recorded_by_membership_id: CF2.membershipId, recorded_by_user_id: CF2.id })]),
    await directInsert('SR: a valid closure on its return (CL-01)', [rowOf(SR)]),
  ]
  check(
    'T062',
    'Direct valid closure then rollback',
    validDirect.every((r) => !r.refused && r.clean) && (await eventsOf(S.intakeId)).length === 0 && (await eventsOf(SR.intakeId)).length === 0,
    'valid direct closures — on S by CF and by CF2 on its A8.7 confirmation, and on SR on its A8.8 return — pass every guard and roll back; neither holds a committed closure',
  )
  const crossIntake = {
    otherIntake: await directInsert("S: RC's intake under S's Claim", [rowOf(S, { exception_intake_id: RC.intakeId })]),
    otherDecision: await directInsert("S: W's decision", [rowOf(S, { resolution_decision_event_id: decisionOf(W), basis_reference_id: decisionOf(W) })]),
    otherReturn: await directInsert("SR: WR's return as its basis", [rowOf(SR, { basis_reference_id: esc(WR).returnId })]),
  }
  check(
    'T063',
    'Cross-intake direct insertion refused',
    crossIntake.otherIntake.refused && /exception_closure_coherence/.test(crossIntake.otherIntake.message) && crossIntake.otherDecision.refused && /exception_closure_eligibility: a closure names exactly the intake''?s confirmed/.test(crossIntake.otherDecision.message) &&
      crossIntake.otherReturn.refused && /exception_closure_eligibility: after a completed escalation the basis is exactly its A8\.8 return/.test(crossIntake.otherReturn.message) && Object.values(crossIntake).every((r) => r.clean),
    "a direct closure of RC's intake carrying S's Claim is refused by the coherence guard; one on S naming W's A8.7 decision, and one on SR naming WR's A8.8 return, by the eligibility guard",
  )
  const foreignDirect = {
    tenant: await directInsert('S: under the other organization', [rowOf(S, { organization_id: otherOrg })]), claim: await directInsert("S: under W's Claim", [rowOf(S, { claim_id: W.claimId })]),
    foreignIntake: await directInsert("F's intake under S's organization and Claim", [rowOf(S, { exception_intake_id: F.intakeId })]),
    foreignDecision: await directInsert("S: the other tenant's decision", [rowOf(S, { resolution_decision_event_id: decisionOf(F), basis_reference_id: decisionOf(F) })]),
  }
  check(
    'T064',
    'Foreign tenant/Claim direct insertion refused',
    [foreignDirect.tenant, foreignDirect.claim, foreignDirect.foreignIntake].every((r) => r.refused && /exception_closure_coherence/.test(r.message)) && foreignDirect.foreignDecision.refused &&
      /exception_closure_eligibility/.test(foreignDirect.foreignDecision.message) && Object.values(foreignDirect).every((r) => r.clean),
    "a direct closure on S under the other organization or W's Claim, and one of the other tenant's intake under Org A, are refused by the coherence guard; one naming the other tenant's A8.7 decision by the eligibility guard",
  )
  const forgedReference = [
    await directInsert("S: an ESCALATION_RETURN basis without an escalation", [rowOf(S, { basis_reference_kind: 'ESCALATION_RETURN', basis_reference_id: esc(SR).returnId, basis_owner_contract_version: 'A8-ESCALATION-1', closure_reason_code: 'TERMINAL_FOLLOWUP_REVIEWED' })]),
    await directInsert('SR: its decision as the basis after a completed escalation', [rowOf(SR, { basis_reference_kind: 'RESOLUTION_DECISION', basis_reference_id: decisionOf(SR), basis_owner_contract_version: 'A8-RESOLUTION-DECISION-1', closure_reason_code: 'VERIFIED_INTERNAL_RESOLUTION' })]),
    await directInsert('SR: its escalation (not its return) as the basis', [rowOf(SR, { basis_reference_id: esc(SR).escalationId })]),
    await directInsert('SR: its follow-up as the basis', [rowOf(SR, { basis_reference_id: esc(SR).followupIds[0] })]),
    await directInsert('S: its A8.7 request as the decision', [rowOf(S, { resolution_decision_event_id: requestOf(S), basis_reference_id: requestOf(S) })]),
  ]
  check(
    'T065',
    'Forged closure reference refused',
    forgedReference.every((r) => r.refused && /exception_closure_eligibility/.test(r.message) && r.clean) && /without an escalation the basis is exactly the A8\.7 confirmation/.test(forgedReference[0].message) &&
      forgedReference.slice(1, 4).every((r) => /after a completed escalation the basis is exactly its A8\.8 return/.test(r.message)),
    "on S an ESCALATION_RETURN basis without an escalation, on SR its decision, its escalation or its follow-up as the basis instead of its return, and on S its A8.7 request as the decision, are each refused by the eligibility guard — a typed basis, never a generic UUID",
  )
  const forgedPermission = {
    roleless: await directInsert('S: a role-less member', [rowOf(S, { recorded_by_membership_id: NR.membershipId, recorded_by_user_id: NR.id })]),
    viewer: await directInsert('S: the Viewer', [rowOf(S, { recorded_by_membership_id: viewerMembershipId, recorded_by_user_id: viewerUser.id })]),
    requester: await directInsert("S: its A8.7 requester", [rowOf(S, { recorded_by_membership_id: M4.membershipId, recorded_by_user_id: M4.id })]),
    decider: await directInsert("S: its A8.7 decider", [rowOf(S, { recorded_by_membership_id: DR.membershipId, recorded_by_user_id: DR.id })]),
    revoked: await directInsert('S: CFP after its role was removed', [rowOf(S, { recorded_by_membership_id: CFP.membershipId, recorded_by_user_id: CFP.id })]),
  }
  check(
    'T066',
    'Forged permission/member direct insertion refused',
    [forgedPermission.roleless, forgedPermission.viewer, forgedPermission.revoked].every((r) => r.refused && /exception_closure_independence: the confirmer''?s roles must grant exceptionClosure\.confirm/.test(r.message)) &&
      [forgedPermission.requester, forgedPermission.decider].every((r) => r.refused && /exception_closure_independence: an exception is never closed by its A8\.7 resolution''?s own requester or decider/.test(r.message)) &&
      Object.values(forgedPermission).every((r) => r.clean),
    "a direct closure on S by a role-less member, the Viewer or CFP (its role removed) is refused by the permission guard, and by S's own A8.7 requester M4 or decider DR by the independence guard",
  )
  const off = { triggersOff: true }
  const codeChecks = {
    contract: await directInsert('S: contract A8-CLOSURE-2 (triggers off)', [rowOf(S, { contract_version: 'A8-CLOSURE-2' })], off),
    event: await directInsert('S: event REOPEN_CLOSURE (triggers off)', [rowOf(S, { event_code: 'REOPEN_CLOSURE' })], off),
  }
  const shapes = [
    await directInsert('S: reason TERMINAL_FOLLOWUP_REVIEWED on a decision basis', [rowOf(S, { closure_reason_code: 'TERMINAL_FOLLOWUP_REVIEWED' })], off),
    await directInsert('S: owner contract A8-ESCALATION-1 on a decision basis', [rowOf(S, { basis_owner_contract_version: 'A8-ESCALATION-1' })], off),
    await directInsert('S: a decision basis other than the decision', [rowOf(S, { basis_reference_id: requestOf(S) })], off),
    await directInsert('S: a return basis that is the decision', [rowOf(S, { basis_reference_kind: 'ESCALATION_RETURN', basis_owner_contract_version: 'A8-ESCALATION-1', closure_reason_code: 'TERMINAL_FOLLOWUP_REVIEWED' })], off),
    await directInsert('S: an unknown basis kind', [rowOf(S, { basis_reference_kind: 'WORK_VERIFICATION' })], off),
    await directInsert('S: an uncontrolled reason', [rowOf(S, { closure_reason_code: 'PAID' })], off),
    await directInsert('SR: reason VERIFIED_INTERNAL_RESOLUTION on a return basis', [rowOf(SR, { closure_reason_code: 'VERIFIED_INTERNAL_RESOLUTION' })], off),
  ]
  check(
    'T067',
    'Wrong controlled code/version CHECK refused',
    codeChecks.contract.refused && /exception_closure_events_contract_chk/.test(codeChecks.contract.message) && codeChecks.event.refused && /exception_closure_events_event_code_chk/.test(codeChecks.event.message) &&
      shapes.every((r) => r.refused && /exception_closure_events_shape_chk/.test(r.message)) && [...Object.values(codeChecks), ...shapes].every((r) => r.clean),
    `with every trigger off a future contract (A8-CLOSURE-2) is refused by the contract CHECK, a REOPEN_CLOSURE event by the event CHECK, and ${shapes.length} malformed shapes — a reason or owner contract of the other kind, a decision basis that is not the decision, a return basis that is, an unknown kind, an uncontrolled reason — by the shape CHECK`,
  )
  const sequenceRows = {
    two: await directInsert('S: a first closure numbered 2', [rowOf(S, { sequence: 2 })]), zero: await directInsert('S: number 0 (triggers off)', [rowOf(S, { sequence: 0 })], off),
    reusedOff: await directInsert('S: number 1 twice (triggers off)', [rowOf(S), rowOf(S, { recorded_by_membership_id: CF2.membershipId, recorded_by_user_id: CF2.id })], off),
    secondLive: await directInsert('S: closures 1 and 2', [rowOf(S), rowOf(S, { sequence: 2 })]),
  }
  check(
    'T068',
    'Zero or duplicate sequence refused',
    sequenceRows.two.refused && /exception_closure_sequence/.test(sequenceRows.two.message) && sequenceRows.zero.refused && /exception_closure_events_sequence_chk/.test(sequenceRows.zero.message) &&
      sequenceRows.reusedOff.refused && /exception_closure_events_(sequence_key|exception_intake_id_key)|23505/.test(sequenceRows.reusedOff.message) && sequenceRows.secondLive.refused &&
      /exception_closure_transition/.test(sequenceRows.secondLive.message) && Object.values(sequenceRows).every((r) => r.clean),
    'a first closure numbered 2 is refused by the sequence guard, number 0 by its CHECK; with every trigger off a reused number 1 by the unique index; live, a second closure after the first by the terminal guard',
  )
  const wRowsHash = await rowsHash([W.intakeId])
  const mutations = [
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET sequence = sequence WHERE id = $1::uuid`, C_W_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET closure_reason_code = 'TERMINAL_FOLLOWUP_REVIEWED' WHERE id = $1::uuid`, C_W_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET recorded_by_membership_id = $1::uuid WHERE id = $2::uuid`, CF2.membershipId, C_W_ID)),
    await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, C_W_ID)),
  ]
  const truncation = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`))
  const cascade = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`))
  // A later owner's ON DELETE RESTRICT key into this table would make PostgreSQL refuse a plain TRUNCATE before any
  // trigger runs; TRUNCATE ... CASCADE still reaches this guard. Judged on behaviour: every wipe is refused.
  const referencedBy = await prisma.$queryRawUnsafe<{ del: string; self: boolean }[]>(`SELECT confdeltype::text AS del, conrelid = confrelid AS self FROM pg_constraint WHERE contype = 'f' AND confrelid = '${TABLE}'::regclass`)
  const truncationRefused = /append-only/.test(truncation.message) || (/cannot truncate a table referenced in a foreign key constraint/.test(truncation.message) && referencedBy.some((row) => !row.self) && referencedBy.every((row) => row.del === 'r'))
  check(
    'T069',
    'UPDATE/DELETE/TRUNCATE including no-op refused',
    mutations.every((r) => /append-only/.test(r.message) && r.clean) && truncationRefused && truncation.clean && /append-only/.test(cascade.message) && cascade.clean && (await rowsHash([W.intakeId])) === wRowsHash,
    "a no-op UPDATE of W's closure, changing its reason or its confirmer, deleting it, a TRUNCATE and a TRUNCATE … CASCADE are each refused (append-only); nothing changed",
  )
  const backstop = {
    secondOff: await directInsert('W: a second closure numbered 2 (triggers off)', [rowOf(W, { sequence: 2, recorded_by_membership_id: CF2.membershipId, recorded_by_user_id: CF2.id })], off),
    twoOff: await directInsert('S: closures 1 and 2 (triggers off)', [rowOf(S), rowOf(S, { sequence: 2 })], off),
    secondLive: await directInsert('W: a second closure numbered 2', [rowOf(W, { sequence: 2 })]),
  }
  check(
    'T070',
    'Duplicate terminal event unique guard refused',
    [backstop.secondOff, backstop.twoOff].every((r) => r.refused && /exception_closure_events_exception_intake_id_key|23505/.test(r.message)) && backstop.secondLive.refused &&
      /exception_closure_transition: the exception is already CLOSED_INTERNAL/.test(backstop.secondLive.message) && Object.values(backstop).every((r) => r.clean) && (await eventsOf(W.intakeId)).length === 1,
    'with every trigger off a second closure of W (number 2) and closures 1 and 2 of S are still refused by the one-closure-per-intake unique index; live, a second closure of W by the terminal guard',
  )

  // ---------------------------------------------------------------- audit and atomicity (T071–T080), AT's and J's writers
  section("Audit and atomicity on AT and J: one closure and one audit commit together (a read and a second writer meanwhile), crashes after the insert and after the audit, a retry after a proven rollback, exact audits, database time, metadata only, no audit on reads or refusals, the rows across a database restart, no orphan")
  const serviceCode = committedCode(`${MODULE_DIR}/exception-closure.service.ts`)
  const onTx = serviceCode.slice(serviceCode.indexOf('async function recordOnTransaction'), serviceCode.indexOf('async function reconcileUnknownOutcome'))
  const firstStatement = onTx.split('\n').slice(1).find((line) => /^\s*(if|const|await|return)\b/.test(line)) ?? ''
  // T071, T081 and T098 on AT: while CF's closure of AT is inserted but uncommitted, no other connection sees it or its
  // audit, a read answers the committed history at once, and CF2's identical closure waits for the Claim.
  const holdInsert = holdAt('exceptionClosure.inserted')
  const committing = recordClosureEvent(AT.claimId, AT.intakeId, closeOf(AT), CF.id)
  await Promise.race([holdInsert.arrived, committing])
  const during = { rows: (await eventsOf(AT.intakeId)).length, audits: await auditsOfIntake(AT.intakeId) }
  const readDuring = reconstructionOf(AT)
  const readReturned = await settledWithin(readDuring, 5000)
  const readDuringBody = (await readDuring).body
  const secondWriter = recordClosureEvent(AT.claimId, AT.intakeId, closeOf(AT), CF2.id)
  const secondWaited = !(await settledWithin(secondWriter, 1500))
  holdInsert.release()
  const [RAT, secondAT] = await Promise.all([committing, secondWriter])
  clearConcurrencyProbes()
  const atRows = await eventsOf(AT.intakeId)
  const ratAudit = RAT.ok ? (await auditsOfEvent(RAT.value.closureEventId))[0] : undefined
  check(
    'T071',
    'One closure and one metadata audit atomic',
    during.rows === 0 && during.audits === 0 && RAT.ok && atRows.length === 1 && (await auditsOfIntake(AT.intakeId)) === 1 && !!ratAudit && ratAudit.actionCode === 'exception_closure.recorded' &&
      ratAudit.beforeState === null && (ratAudit.afterState as any)?.recordedAt === atRows[0].recordedAt.toISOString() && ratAudit.organizationId === AT.organizationId && ratAudit.actorUserId === CF.id,
    "while CF's closure of AT was uncommitted no other connection saw it or its audit; after commit exactly one of each, the audit holding the closure's own database time, organization and actor",
  )
  const failAfterInsert = failOnce('exceptionClosure.inserted', 'injected failure after the closure insert')
  const crashedInsert = await attemptAdversarial(() => recordClosureEvent(J.claimId, J.intakeId, closeOf(J), CF.id))
  const afterCrash1 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T072', 'Crash after event rolls back both', failAfterInsert.reached === 1 && /injected failure after the closure insert/.test(crashedInsert) && afterCrash1.rows === 0 && afterCrash1.audits === 0, "a failure right after CF's closure insert on J rolled back the whole transaction: no closure, no audit, no retry")
  const failAfterAudit = failOnce('exceptionClosure.audited', 'injected failure after the closure audit')
  const crashedAudit = await attemptAdversarial(() => recordClosureEvent(J.claimId, J.intakeId, closeOf(J), CF.id))
  const afterCrash2 = { rows: (await eventsOf(J.intakeId)).length, audits: await auditsOfIntake(J.intakeId) }
  clearConcurrencyProbes()
  check('T073', 'Crash after audit rolls back both', failAfterAudit.reached === 1 && /injected failure after the closure audit/.test(crashedAudit) && afterCrash2.rows === 0 && afterCrash2.audits === 0, 'a failure after the audit rolled back both: no closure, no audit, no retry')
  // T088 and T090's writers: exhausted retries and unknown outcomes on J, before its one accepted retry.
  const always = failEveryTime('exceptionClosure.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const exhausted = await recordClosureEvent(J.claimId, J.intakeId, closeOf(J), CF.id)
  const lost = failEveryTime('exceptionClosure.audited', 'Connection terminated unexpectedly')
  const unknownOutcome = await recordClosureEvent(J.claimId, J.intakeId, closeOf(J), CF.id)
  const early = failEveryTime('exceptionClosure.claim_locked', 'Connection terminated unexpectedly')
  const earlyOutcome = await recordClosureEvent(J.claimId, J.intakeId, closeOf(J), CF.id)
  clearConcurrencyProbes()
  const jBeforeRetry = (await eventsOf(J.intakeId)).length
  const once = failOnce('exceptionClosure.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const C_J = await recordClosureEvent(J.claimId, J.intakeId, closeOf(J), CF.id)
  clearConcurrencyProbes()
  check(
    'T074',
    'Confirmed rollback new attempt writes once',
    once.reached === 1 && C_J.ok && C_J.value.sequence === 1 && jBeforeRetry === 0 && (await eventsOf(J.intakeId)).length === 1 && (await auditsOfIntake(J.intakeId)) === 1,
    "one provably aborted serialization failure is retried on a fresh transaction that re-reads every owner and records CF's closure of J exactly once with one audit",
  )
  const runEventsSoFar = await prisma.exceptionClosureEvent.findMany({ where: { recordedAt: { gte: runStartedAt } } })
  const runAuditsSoFar = await prisma.auditEvent.findMany({ where: { actionCode: 'exception_closure.recorded', occurredAt: { gte: runStartedAt } } })
  const auditOf = (eventId: string) => runAuditsSoFar.filter((a) => a.entityId === eventId)
  check(
    'T075',
    'Audit actor/tenant/closure ID exact',
    runEventsSoFar.length >= 5 && runAuditsSoFar.length === runEventsSoFar.length &&
      runEventsSoFar.every((e) => {
        const audits = auditOf(e.id)
        const after = audits[0]?.afterState as any
        return audits.length === 1 && audits[0].organizationId === e.organizationId && audits[0].actorUserId === e.recordedByUserId && audits[0].entityType === 'EXCEPTION_CLOSURE_EVENT' && audits[0].beforeState === null &&
          same(Object.keys(after ?? {}).sort(), [...AUDIT_KEYS].sort()) && after?.closureEventId === e.id && after?.recordedByMembershipId === e.recordedByMembershipId && after?.exceptionIntakeId === e.exceptionIntakeId &&
          after?.claimId === e.claimId && after?.resolutionDecisionEventId === e.resolutionDecisionEventId && after?.basisReferenceId === e.basisReferenceId && after?.basisReferenceKind === e.basisReferenceKind
      }),
    `each of the ${runEventsSoFar.length} closures this run has exactly one audit — exactly ${AUDIT_KEYS.length} keys — under its own organization, acting user and membership, closure id, intake, Claim, decision and basis`,
  )
  const timeRows = await prisma.$queryRawUnsafe<{ n: bigint; differ: bigint; early: bigint }[]>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE recorded_at <> created_at) AS differ, count(*) FILTER (WHERE recorded_at < $1::timestamptz) AS early FROM ${TABLE} WHERE exception_intake_id = ANY($2::uuid[])`,
    runStartedAt.toISOString(), runIntakes.map((k) => k.intakeId),
  )
  const pastTime = await directInsert('S: recorded in 2020', [rowOf(S, { recorded_at: '2020-01-01T00:00:00.000Z' })])
  const futureTime = await directInsert('S: recorded tomorrow', [rowOf(S, { recorded_at: new Date(Date.now() + 86_400_000).toISOString() })])
  const retime = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET recorded_at = recorded_at - interval '1 day' WHERE id = $1::uuid`, C_W_ID))
  check(
    'T076',
    'Server-owned recorded timestamp enforced',
    Number(timeRows[0].n) >= 5 && Number(timeRows[0].differ) === 0 && Number(timeRows[0].early) === 0 && [pastTime, futureTime].every((r) => r.refused && /exception_closure_time/.test(r.message) && r.clean) &&
      /append-only/.test(retime.message) && retime.clean && runEventsSoFar.every((e) => (auditOf(e.id)[0]?.afterState as any)?.recordedAt === e.recordedAt.toISOString()),
    `every one of the ${Number(timeRows[0].n)} closures this run was recorded and created at the database's own transaction time (equal, never before the run); a past or future time in a direct row is refused by the time guard and re-timing a closure is refused (append-only); each audit carries the closure's own time`,
  )
  const auditText = JSON.stringify(runAuditsSoFar.map((a) => a.afterState))
  check(
    'T077',
    'Audit has no PHI or payment details',
    ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), 'AED', '125.25', CF.email, M1.email, 'Synthetic member', 'Synthetic finding.', 'FURTHER_REVIEW_REQUIRED', 'ملاحظة'].some((value) => auditText.includes(value)) &&
      !AUDIT_KEYS.some((k) => /patient|name|amount|currency|payer|payment|narrative|note|text|finding|diagnos|email/i.test(k)),
    'no closure audit holds a patient, date of birth, diagnosis, member contact, synthetic text, the A8.3 finding code, an amount, a currency or Arabic text, and no audit key names one: ids, codes, the acting membership and time only',
  )
  const auditsBeforeReads = await prisma.auditEvent.count()
  const countsBeforeReads = await counts()
  for (const k of [W, WR, P, J, S, OPN]) for (const who of [asAdmin, asViewer]) {
    await closureHistoryOf(k, who)
    await reconstructionOf(k, who)
  }
  const readRefusals = [
    await closureHistoryOf(W, anonymous), await reconstructionOf(F), await closureHistoryOf({ claimId: W.claimId, intakeId: MISSING }), await get(`${base(W)}/closure-reconstruction?current=1`),
    await closurePost(W, closeOf(W), asViewer), await closurePost(OPN, closeOf(OPN), CF.who), await closurePost(W, closeOf(W), CF.who), await closurePost(S, closeOf(S), M4.who), await closurePost(W, { eventCode: 'NOPE' }, CF.who),
  ]
  check(
    'T078',
    'Reads and refusals produce no audit',
    (await prisma.auditEvent.count()) === auditsBeforeReads && (await unchanged(countsBeforeReads)) && readRefusals.map((r) => r.status).join('/') === '401/404/404/400/403/409/409/409/400',
    `twenty-four reads by an Admin and a Viewer and nine refused requests (${readRefusals.map((r) => r.status).join('/')}) wrote no audit and changed no row`,
  )
  // T079, T100 and T116 — one database outage and restart: health stays truthful, ready reports the outage, and every
  // closure row and audit of this run survives the restart byte-identical.
  const replayIndependently = (items: any[]) => ({ state: items.length === 0 ? 'NO_CLOSURE' : items.length === 1 && items[0].sequence === 1 ? 'CLOSED_INTERNAL' : 'INVALID', recorded: items[0] ?? null })
  const agree = async (k: Intake) => {
    const history = (await closureHistoryOf(k)).body
    const reconstruction = (await reconstructionOf(k)).body
    const mine = replayIndependently(history.items)
    return mine.state === reconstruction.state && JSON.stringify(mine.recorded) === JSON.stringify(reconstruction.recordedClosure)
  }
  const agreeIntakes = homeIntakes
  const agreeAll = async () => (await Promise.all(agreeIntakes.map(agree))).every(Boolean)
  const auditsHash = () => hashOf(`SELECT a.id, a.action_code, a.entity_id, a.actor_user_id, a.after_state, a.occurred_at FROM audit_events a WHERE a.action_code = 'exception_closure.recorded' AND a.occurred_at >= $1::timestamptz`, runStartedAt.toISOString())
  const rowsBeforeOutage = await rowsHash(runIntakes.map((k) => k.intakeId))
  const auditsBeforeOutage = await auditsHash()
  const readsBeforeOutage = await Promise.all(agreeIntakes.map(async (k) => [withoutEvaluatedAt((await closureHistoryOf(k)).body), withoutEvaluatedAt((await reconstructionOf(k)).body)]))
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
  const auditsAfterOutage = await auditsHash()
  const readsAfterOutage = await Promise.all(agreeIntakes.map(async (k) => [withoutEvaluatedAt((await closureHistoryOf(k)).body), withoutEvaluatedAt((await reconstructionOf(k)).body)]))
  const agreeAfterRestart = await agreeAll()
  check(
    'T079',
    'Restart preserves event and audit bytes',
    stopped && restarted && recovered && rowsAfterOutage === rowsBeforeOutage && auditsAfterOutage === auditsBeforeOutage && same(readsAfterOutage, readsBeforeOutage),
    `the database was stopped and started again: every closure row and every closure audit of this run hashes exactly as before, and the history and reconstruction of all ${agreeIntakes.length} home intakes read back byte-identical`,
  )
  const orphanAudits = runAuditsSoFar.filter((a) => !runEventsSoFar.some((e) => e.id === a.entityId))
  const orphanRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM ${TABLE} e WHERE e.recorded_at >= $1::timestamptz AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.entity_type = 'EXCEPTION_CLOSURE_EVENT' AND a.entity_id = e.id)`,
    runStartedAt.toISOString(),
  )
  check(
    'T080',
    'No orphan event or orphan audit',
    runEventsSoFar.every((e) => auditOf(e.id).length === 1) && orphanAudits.length === 0 && Number(orphanRows[0].n) === 0 && (await auditsOfIntake(J.intakeId)) === 1 && (await auditsOfIntake(AT.intakeId)) === 1,
    `${runEventsSoFar.length} closures and ${runAuditsSoFar.length} closure audits this run pair one to one; no audit names a missing closure and no closure lacks its audit; J and AT hold one of each after every crash and retry`,
  )

  // ---------------------------------------------------------------- concurrency, retries, unknown (T081–T090)
  section('Concurrency: the Claim lock first in one SERIALIZABLE transaction shared by every owner read, identical and competing closures at once, an A8.7 decision, an A8.8 follow-up and an A8.2 return to triage while a closure waits, bounded retries, the unique collision, unknown commits')
  check(
    'T081',
    'Claim NOWAIT lock first statement',
    /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(firstStatement) && secondWaited && RAT.ok && secondAT.ok === false && secondAT.code === 'EXCEPTION_CLOSURE_TRANSITION_REFUSED',
    "the Claim row NOWAIT lock is the first statement of the write; while CF's closure of AT held it, CF2's closure waited, then was judged on the committed state (CLOSED_INTERNAL: 409)",
  )
  // U: a closure holds U's Claim while an A8.8 escalation by its assignee waits for the same lock.
  const holdU = holdAt('exceptionClosure.claim_locked')
  const uClose = recordClosureEvent(U.claimId, U.intakeId, closeOf(U), CF.id)
  await Promise.race([holdU.arrived, uClose])
  const uEscalate = recordEscalationEvent(U.claimId, U.intakeId, escalateOf(T), M4.id)
  const uWaited = !(await settledWithin(uEscalate, 1500))
  holdU.release()
  const [uClosed, uEscalated] = await Promise.all([uClose, uEscalate])
  clearConcurrencyProbes()
  check(
    'T082',
    'SERIALIZABLE over owner reads and closure',
    /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && (serviceCode.match(/prisma\.\$transaction\(\(tx\) => recordOnTransaction\(/g) ?? []).length === 1 &&
      [
        /getExceptionIntakesOf\(claimId, tx\)/, /getTriageDispositionOf\(claimId, parent\.exceptionIntakeId, tx\)/, /getTriageHistoryOf\(claimId, intakeId, tx\)/, /getInvestigationHistoryOf\(claimId, intakeId, tx\)/,
        /getRemediationDispositionOf\(claimId, intakeId, tx\)/, /getRemediationHistoryOf\(claimId, intakeId, tx\)/, /getWorkDispositionOf\(claimId, intakeId, tx\)/, /getWorkHistoryOf\(claimId, intakeId, tx\)/,
        /getResolutionDispositionOf\(claimId, intakeId, tx\)/, /getResolutionHistoryOf\(claimId, intakeId, tx\)/, /getEscalationDispositionOf\(claimId, intakeId, tx\)/, /getEscalationHistoryOf\(claimId, intakeId, tx\)/,
      ].every((p) => p.test(serviceCode)) && /recordAuditEvent\(/.test(onTx) && /insertClosureEvent\(/.test(onTx) && uWaited && uClosed.ok && uEscalated.ok === false && (await eventsOf(U.intakeId)).length === 1,
    "one SERIALIZABLE transaction re-reads the A8.1, A8.2, A8.3, A8.5, A8.6, A8.7 and A8.8 owners on the same client and writes the closure and its audit; an A8.8 escalation of U while U's closure held the Claim waited for that lock and was then judged by A8.8 itself (resolved: refused)",
  )
  const isRefusedStep = (r: { status: number; body: any }) => r.status === 409 && errorCode(r.body) === 'EXCEPTION_CLOSURE_TRANSITION_REFUSED'
  const sameRace = await Promise.all(Array.from({ length: 5 }, () => closurePost(RC, closeOf(RC), CF.who)))
  check(
    'T083',
    'Two same concurrent closes one commits',
    sameRace.filter((r) => r.status === 201).length === 1 && sameRace.filter(isRefusedStep).length === 4 && (await rcRows()) === 1 && (await auditsOfIntake(RC.intakeId)) === 1,
    `five identical closures of RC by CF at once (${sameRace.map((r) => r.status).join('/')}): one 201 and four 409; one closure, one audit`,
  )
  const differentRace = await Promise.all([CF, CF2, CF, CF2].map((who) => closurePost(RD, closeOf(RD), who.who)))
  const rdRows = await eventsOf(RD.intakeId)
  check(
    'T084',
    'Two different competing closes one commits',
    differentRace.filter((r) => r.status === 201).length === 1 && differentRace.filter(isRefusedStep).length === 3 && rdRows.length === 1 && (await auditsOfIntake(RD.intakeId)) === 1 &&
      [CF.membershipId, CF2.membershipId].includes(rdRows[0].recordedByMembershipId),
    `CF and CF2 each closing RD twice at once (${differentRace.map((r) => r.status).join('/')}): exactly one closure, by ${rdRows[0]?.recordedByMembershipId === CF.membershipId ? 'CF' : 'CF2'}, with one audit; the three others 409`,
  )
  // K: DR's A8.7 confirmation holds K's Claim while a closure naming K's request waits.
  const kBefore = await closurePost(K, closeBody(requestOf(K)), CF.who)
  const holdDecision = holdAt('exceptionResolution.claim_locked')
  const kDecision = recordResolutionEvent(K.claimId, K.intakeId, { eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId: requestOf(K), decisionCode: 'CONFIRM_INTERNAL_RESOLUTION' }, DR.id)
  await Promise.race([holdDecision.arrived, kDecision])
  const kClose = recordClosureEvent(K.claimId, K.intakeId, closeBody(requestOf(K)), CF.id)
  const kWaited = !(await settledWithin(kClose, 1500))
  holdDecision.release()
  const [kDecided, kRejudged] = await Promise.all([kDecision, kClose])
  clearConcurrencyProbes()
  if (kDecided.ok) decisions.set(K.intakeId, kDecided.value.resolutionEventId)
  // T089's writer: K's lawful closure, its first insert refused by a unique collision and retried on a fresh transaction.
  const uniqueOnce = failOnce('exceptionClosure.inserted', 'duplicate key value violates unique constraint "exception_closure_events_sequence_key"')
  const C_K = await recordClosureEvent(K.claimId, K.intakeId, closeOf(K), CF.id)
  clearConcurrencyProbes()
  check(
    'T085',
    'Concurrent A8.7 decision rejudged after lock',
    kBefore.status === 409 && /awaits a decision/.test(errorMessage(kBefore.body)) && kWaited && kDecided.ok && kRejudged.ok === false && kRejudged.code === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' &&
      /names exactly the exception's confirmed A8\.7 decision/.test(kRejudged.message) && C_K.ok && C_K.value.resolutionDecisionEventId === decisionOf(K),
    "K's closure was refused while its A8.7 request awaited a decision; while DR's confirmation held K's Claim the same closure waited, re-read A8.7 under the lock (now RESOLVED_INTERNAL) and was refused for naming the request instead of the new decision; a closure on that decision is then recorded",
  )
  // H (CL-01) and OPN (CL-02): T's late A8.8 follow-up holds the Claim while a closure waits.
  const lateFollowup = async (k: Intake) => {
    const hold = holdAt('exceptionEscalation.claim_locked')
    const followup = recordEscalationEvent(k.claimId, k.intakeId, followupOf(esc(k).ackId as string, inv(k).linkId), T.id)
    await Promise.race([hold.arrived, followup])
    const closure = recordClosureEvent(k.claimId, k.intakeId, closeOf(k), CF.id)
    const waited = !(await settledWithin(closure, 1500))
    hold.release()
    const [followed, closed] = await Promise.all([followup, closure])
    clearConcurrencyProbes()
    return { waited, followed, closed }
  }
  const hRace = await lateFollowup(H)
  const opnRace = await lateFollowup(OPN)
  check(
    'T086',
    'Concurrent A8.8 follow-up rejudged after lock',
    hRace.waited && hRace.followed.ok === false && hRace.closed.ok && hRace.closed.value.basisReferenceKind === 'ESCALATION_RETURN' && hRace.closed.value.basisReferenceId === esc(H).returnId && opnRace.waited &&
      opnRace.followed.ok === false && opnRace.closed.ok === false && opnRace.closed.code === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && /still outstanding/.test(opnRace.closed.message) &&
      (await eventsOf(H.intakeId)).length === 1 && (await eventsOf(OPN.intakeId)).length === 0,
    "while T's late A8.8 follow-up held H's Claim (CL-01) the closure waited, then — A8.8 having refused the follow-up — was judged on the committed A8.8 history and recorded on H's exact return; on OPN (CL-02) the same race leaves the escalation outstanding and the closure is refused 409",
  )
  // TR: an A8.2 return to triage holds TR's Claim while a closure waits; once assigned again TR is closed.
  const holdTriage = holdAt('exceptionTriage.inserted')
  const trReturn = recordTriageEvent(TR.claimId, TR.intakeId, returnToTriage, creatorId)
  await Promise.race([holdTriage.arrived, trReturn])
  const trClose = recordClosureEvent(TR.claimId, TR.intakeId, closeOf(TR), CF.id)
  const trWaited = !(await settledWithin(trClose, 1500))
  holdTriage.release()
  const [trReturned, trRejudged] = await Promise.all([trReturn, trClose])
  clearConcurrencyProbes()
  const trDirect = await directInsert('TR: while returned to triage', [rowOf(TR)])
  await triage(TR, assignTo(M4))
  const C_TR = await closurePost(TR, closeOf(TR), CF.who)
  check(
    'T087',
    'A8.2 assignment/permission change rejudged',
    trWaited && trReturned.ok && trRejudged.ok === false && trRejudged.code === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && /not assigned now/.test(trRejudged.message) && trDirect.refused &&
      /exception_closure_eligibility: the exception is not assigned/.test(trDirect.message) && trDirect.clean && C_TR.status === 201 && gResult.ok === false,
    "while an A8.2 return to triage held TR's Claim the closure waited, re-read the assignment under the lock and was refused 409 (not assigned now), and a direct row by the guard; once A8.2 assigned TR again the closure was recorded (201); a permission removed under the lock is refused likewise (G, T026)",
  )
  check(
    'T088',
    'Serialization/deadlock retry limited to three',
    always.reached === 3 && exhausted.ok === false && exhausted.code === 'EXCEPTION_CLOSURE_CONFLICT' && /kept conflicting; nothing was recorded/.test(exhausted.message) && /const MAX_CLOSURE_ATTEMPTS = 3/.test(serviceCode) &&
      /deadlock detected/.test(serviceCode) && /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode),
    'a serialization failure on every attempt stops after exactly 3 fresh transactions with a 409 and nothing recorded; a deadlock is retried the same way; busy locks are waited for within the 30 s budget',
  )
  check(
    'T089',
    'Stale unique conflict re-reads complete history',
    uniqueOnce.reached === 1 && C_K.ok && C_K.value.sequence === 1 && (await eventsOf(K.intakeId)).length === 1 && (await auditsOfIntake(K.intakeId)) === 1 && /isUniqueViolation\(error\)/.test(serviceCode) &&
      /if \(isWriteConflict\(error\) \|\| isUniqueViolation\(error\)\)/.test(serviceCode),
    "a unique (intake, sequence) collision on K's closure was retried on a fresh transaction that re-read the complete owner and closure history (now RESOLVED_INTERNAL with DR's decision) and recorded it once as number 1 with one audit",
  )
  check(
    'T090',
    'Unknown commit reconciled, no blind replay',
    lost.reached === 1 && unknownOutcome.ok === false && unknownOutcome.code === 'EXCEPTION_CLOSURE_CONFLICT' && /holds no event at sequence 1; nothing was recorded/.test(unknownOutcome.message) && early.reached === 1 &&
      earlyOutcome.ok === false && /failed before an event was written/.test(earlyOutcome.message) && jBeforeRetry === 0 && /reconcileAttempt\(records, attempted\)/.test(serviceCode),
    "a connection lost after the audit is reconciled against the committed history (no closure 1: nothing recorded) and a loss before the insert is reported as such; each reached once — never resubmitted, never a 201 (RECORDED and OTHER_EVENT are proven by the reducer's unit tests, T091)",
  )

  // ---------------------------------------------------------------- reads, replay, fail-closed (T091–T100)
  section('Reads: unit tests over the gate, the reducer and the reconstruction, 100 identical reconstructions, an independent replay and chain, unknown contracts, gapped and misnumbered histories, cross-tenant records, READ ONLY snapshot reads, database read time, agreement after the restart')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  const reducerCode = committedCode(`${MODULE_DIR}/exception-closure.reducer.ts`)
  const reducerTests = committedText(`${MODULE_DIR}/exception-closure.reducer.test.ts`)
  check(
    'T091',
    'Pure deterministic closure reducer',
    ownUnit.ok && /ℹ pass 12/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output) && /CL-01/.test(reducerTests) && /CL-02/.test(reducerTests) && /TZ/.test(reducerTests) &&
      !/prisma|await |async |Date\.now|Math\.random|new Date|toLocale|Intl\.|from '\.\.\/\.\.\/shared/.test(reducerCode),
    'the 12 reducer and request tests pass (the gate over every A8.7/A8.8 pair with CL-01 and CL-02, independence, the terminal closure, whole histories, the reconstruction anchors, the unknown-outcome reconciliation, time-zone and locale independence); the reducer reads no database, clock, locale or randomness',
  )
  const reconstructions = new Set<string>()
  for (let i = 0; i < 100; i += 1) {
    const r = await getClosureReconstruction(W.claimId, W.intakeId)
    reconstructions.add(r.ok ? withoutEvaluatedAt(r.value) : `refused ${r.code}`)
  }
  const derivations = new Set<string>()
  const wStored = await eventsOf(W.intakeId)
  for (let i = 0; i < 100; i += 1) derivations.add(JSON.stringify(deriveClosure({ exceptionIntakeId: W.intakeId, organizationId: W.organizationId, claimId: W.claimId }, wStored)))
  check(
    'T092',
    '100 identical reconstructions identical',
    reconstructions.size === 1 && [...reconstructions][0] === withoutEvaluatedAt(wReconstruction) && derivations.size === 1,
    "100 reconstructions of W through the production read are byte-identical (bar evaluatedAt) and equal the route's answer; 100 derivations of W's stored closure are byte-identical",
  )
  const independentChain = async (k: Intake) => {
    const intake = ((await get(`/api/claims/${k.claimId}/exception-intake`)).body.items as any[]).find((item) => item.exceptionIntakeId === k.intakeId)
    const groups: [string, string, string][] = [
      ['A8.2', 'triage-history', 'triageEventId'], ['A8.3', 'investigation-history', 'investigationEventId'], ['A8.5', 'remediation-history', 'remediationEventId'], ['A8.6', 'remediation-work-history', 'workEventId'],
      ['A8.7', 'resolution-history', 'resolutionEventId'], ['A8.8', 'escalation-history', 'escalationEventId'], ['A8.9', 'closure-history', 'closureEventId'],
    ]
    const entries: { owner: string; ownerContractVersion: string; recordId: string; sequence: number | null; eventCode: string | null }[] = [
      { owner: 'A8.1', ownerContractVersion: intake?.contractVersion, recordId: intake?.exceptionIntakeId, sequence: null, eventCode: null },
    ]
    for (const [owner, path, idKey] of groups) for (const item of (await get(`${base(k)}/${path}`)).body.items as any[]) entries.push({ owner, ownerContractVersion: item.contractVersion, recordId: item[idKey], sequence: item.sequence, eventCode: item.eventCode })
    return entries.map((entry, i) => ({ position: i + 1, ...entry }))
  }
  const closedIntakes = [W, P, WR, J, AT, RC, RD, K, H, TR, U]
  const chainsAgree = await Promise.all(closedIntakes.map(async (k) => JSON.stringify((await reconstructionOf(k)).body.chain) === JSON.stringify(await independentChain(k))))
  const replays = await Promise.all(agreeIntakes.map(agree))
  check(
    'T093',
    'Independent reducer agrees with history',
    replays.every(Boolean) && chainsAgree.every(Boolean),
    `this suite's own replay of the closure history of all ${agreeIntakes.length} home intakes gives exactly each reconstruction's state and recorded closure, and the chain this suite builds from the eight owners' own history routes equals the reconstruction's chain for each of the ${closedIntakes.length} closed intakes (${closedIntakes.map((k) => k.label).join(', ')})`,
  )
  const refusedWhole = (r: { value?: { history: any; reconstruction: any }; clean: boolean }) =>
    r.value?.history.ok === false && r.value.history.code === 'EXCEPTION_CLOSURE_CONFLICT' && r.value.reconstruction.ok === false && r.value.reconstruction.code === 'EXCEPTION_CLOSURE_CONFLICT' && r.clean
  const integrityRefused = (r: { value?: { history: any; reconstruction: any }; clean: boolean }) =>
    r.value?.history.ok === true && r.value.reconstruction.ok === false && r.value.reconstruction.code === 'INTEGRITY_CONFLICT' && r.clean
  const futureContract = await plantedRead(S, plantRows([rowOf(S, { contract_version: 'A8-CLOSURE-2' })]), `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_contract_chk`)
  const ownerFutureContract = await plantedRead(
    W,
    (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO ${RESOLUTION_TABLE} (id, exception_intake_id, organization_id, claim_id, contract_version, sequence, event_code, request_event_id, decision_code, recorded_by_membership_id, recorded_by_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'A8-RESOLUTION-DECISION-2', 3, 'DECIDE_INTERNAL_RESOLUTION', $5::uuid, 'CONFIRM_INTERNAL_RESOLUTION', $6::uuid, $7::uuid)`,
        randomUUID(), W.intakeId, W.organizationId, W.claimId, MISSING, DR.membershipId, DR.id,
      ),
    `ALTER TABLE ${RESOLUTION_TABLE} DROP CONSTRAINT ${RESOLUTION_TABLE}_contract_chk`,
  )
  check(
    'T094',
    'Unknown owner contract refuses full read',
    refusedWhole(futureContract) && integrityRefused(ownerFutureContract),
    "a planted closure under A8-CLOSURE-2 (its CHECK dropped) makes S's history and reconstruction refuse 409; an A8.7 event planted under A8-RESOLUTION-DECISION-2 makes W's reconstruction refuse whole (409 INTEGRITY_CONFLICT) — never repaired, never partial",
  )
  const gapped = await plantedRead(S, plantRows([rowOf(S, { sequence: 2 })]))
  const ownerGap = await plantedRead(W, gapOf(TRIAGE_TABLE, W))
  check('T095', 'Gapped sequence refuses full read', refusedWhole(gapped) && integrityRefused(ownerGap), "a planted closure numbered 2 makes S's reads refuse 409; an A8.2 history planted with a gap makes W's reconstruction refuse whole (INTEGRITY_CONFLICT)")
  const badFirst = await plantedRead(S, plantRows([rowOf(S, { closure_reason_code: 'TERMINAL_FOLLOWUP_REVIEWED' })]), `ALTER TABLE ${TABLE} DROP CONSTRAINT ${TABLE}_shape_chk`)
  const twoClosures = await plantedRead(S, plantRows([rowOf(S), rowOf(S, { sequence: 2 })]), `DROP INDEX ${TABLE}_exception_intake_id_key`)
  check('T096', 'Invalid first event refuses full read', refusedWhole(badFirst) && refusedWhole(twoClosures), "a planted first closure whose reason is not its basis kind's (shape CHECK dropped), and a planted second closure after the first (one-closure index dropped), each make S's reads refuse 409")
  const foreignPlanted = await plantedRead(S, plantRows([rowOf(S, { organization_id: otherOrg })]))
  const foreignOwner = await plantedRead(WR, followupGap(WR, `, 'organization_id', '${otherOrg}'`))
  const foreignHttp = [await reconstructionOf({ claimId: WR.claimId, intakeId: F.intakeId }), await reconstructionOf(F)]
  check(
    'T097',
    'Cross-tenant evidence forces 409/404 safely',
    refusedWhole(foreignPlanted) && integrityRefused(foreignOwner) && foreignHttp.every((r) => r.status === 404) && same(missingEnvelope(foreignHttp[0]), missingEnvelope(missingIntake[2])) &&
      same(missingEnvelope(foreignHttp[1]), missingEnvelope(missingClaim[2])),
    `a planted closure under the other organization makes S's reads refuse 409 (${refusedWhole(foreignPlanted)}); an A8.8 event of the other organization planted in WR's history makes WR's reconstruction refuse whole (${integrityRefused(foreignOwner) ? 'INTEGRITY_CONFLICT' : JSON.stringify(foreignOwner.value?.reconstruction ?? foreignOwner.message).slice(0, 120)}); the other tenant's intake or Claim is the identical 404 (${foreignHttp.map((r) => `${r.status} ${errorMessage(r.body)}`).join(' / ')})`,
  )
  const countsBeforeGet = await counts()
  for (const k of [W, WR, RC, RD, K]) for (const who of [asAdmin, asViewer]) {
    await closureHistoryOf(k, who)
    await reconstructionOf(k, who)
  }
  const snapshotCode = committedCode('backend/src/shared/database/read-snapshot.ts')
  check(
    'T098',
    'GET uses one READ ONLY snapshot',
    (await unchanged(countsBeforeGet)) && /SET TRANSACTION READ ONLY/.test(snapshotCode) && /withReadSnapshot\(undefined, \(tx\) => getClosureHistoryOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode) &&
      /withReadSnapshot\(undefined, \(tx\) => getClosureReconstructionOf\(claimId, exceptionIntakeId, tx\)\)/.test(serviceCode) && readReturned && readDuringBody?.state === 'NO_CLOSURE' && readDuringBody?.recordedClosure === null,
    "twenty reads by an Admin and a Viewer changed no row; each read runs in one READ ONLY snapshot; while AT's closure was inserted but uncommitted a reconstruction returned at once with the committed state (NO_CLOSURE), never blocked and never the uncommitted closure",
  )
  const dbNow = async () => (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts.getTime()
  const beforeRead = await dbNow()
  const reconstructionAgain = (await reconstructionOf(W)).body
  const historyAgain = (await closureHistoryOf(W)).body
  const afterRead = await dbNow()
  const evaluated = [Date.parse(reconstructionAgain.evaluatedAt), Date.parse(historyAgain.evaluatedAt)]
  check(
    'T099',
    'evaluatedAt DB time, event time stable',
    evaluated.every((t) => t >= beforeRead - 1 && t <= afterRead + 1) && evaluated[1] >= evaluated[0] && historyAgain.items[0]?.recordedAt === wStored[0].recordedAt.toISOString() &&
      historyAgain.items[0]?.recordedAt === C_W.body.recordedAt && reconstructionAgain.recordedClosure?.recordedAt === C_W.body.recordedAt,
    "each read's evaluatedAt lies between two database clock readings around it; W's closure recordedAt is its stored database time and still reads exactly as answered when recorded",
  )
  check(
    'T100',
    'History/reconstruction agree after restart',
    agreeAfterRestart && (await agreeAll()),
    `after the database restart (T079) and again now, the history and the reconstruction of every one of the ${agreeIntakes.length} home intakes agree with this suite's own replay`,
  )

  // ---------------------------------------------------------------- preservation regressions (T101–T110)
  section('Preservation regressions — A8.8 invoked, nesting A8.7 -> A8.6 -> A8.5 -> A8.3 -> A8.2 -> A8.1 -> A7.10 -> … -> A7.1 -> A6.10 -> … -> A5 -> A1; CRG-A/B unchanged')
  await apiReady('the A8.8 and backward regression chain')
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const goldenNow = async () => ({
    history: withoutEvaluatedAt((await closureHistoryOf(W)).body),
    reconstruction: withoutEvaluatedAt((await reconstructionOf(W)).body),
    audits: JSON.stringify((await auditsOfEvent(C_W_ID)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))),
    rows: await rowsHash(runIntakes.map((k) => k.intakeId)),
  })
  const goldenBefore = await goldenNow()
  // The owner records as this suite leaves them, taken before the nested chain (as A8.8 does): every earlier suite in
  // the chain creates its own synthetic records, which are that suite's to judge, not a closure's side effect.
  const ownerSnapshotNow = await snap()
  const chain = run('npm run test:a8:exception-escalation')
  const nestedLog = `a89-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A8.8')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A8.8] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A8.8 asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD, its own two runs) and re-proves
  // A8.7's branch-only causes against its own branch. On A8.9 those statements are obsolete by design; every other A8.8
  // check is substantive. T128 below proves each cause independently on this branch, down to A7.9.
  const a88NonApplicable: Record<string, string> = {
    T001: "A8.8 'A8.5 accepted merge SHA confirmed' requires the A8.8 feature branch name; A8.9 is cut from the main that contains A8.5, Checkpoint B, A8.6, A8.7 and A8.8 (T001–T003 and T006 here)",
    T005: "A8.8 'Feature from clean synchronized main' compares this tree with origin/feature/a8-8-…; THIS branch's clean tree, synchronization and parity are proved by T005 and T126 here",
    T010: "A8.8 'Diff scope excludes CRG and A9' lists the paths A8.8 was allowed to change and names closure as later work; A8.9 legitimately changes its own (T010 here)",
    T120: "A8.8 'Historical phase-only N/A individually proven' proves A8.7's branch-only causes against the A8.8 branch; here every one is re-proved on this branch, down to A7.9 (T128)",
    T128: "A8.8 'Two independent 130/130 exact-head runs' is the identity of A8.8's own two submitted runs at origin/feature/a8-8-…; THIS run's identity is proved by T125 and T126 here",
    T129: "A8.8 'Origin parity, clean tree, evidence hashes' compares HEAD with origin/feature/a8-8-…; THIS branch's parity, clean tree and hashes are proved by T126, T127 and T129 here",
  }
  const undocumented = failing.filter((id) => !(id in a88NonApplicable))
  const summary = chain.output.match(/\[A8\.8\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.8\] RUN ABORTED|\[A8\.8\] uncaught error|\[A8\.8\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const a88Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  check(
    'T101',
    'A8.8 substantive regression PASS',
    ran && reconciled && undocumented.length === 0 && a88Passing === 130 - failing.length && a88Passing >= 124 &&
      [
        'T002', 'T003', 'T004', 'T006', 'T007', 'T008', 'T009', 'T011', 'T023', 'T032', 'T041', 'T048', 'T050', 'T061', 'T071', 'T081', 'T091', 'T101', 'T106', 'T109', 'T110', 'T121', 'T122', 'T123',
        'T124', 'T125', 'T126', 'T127', 'T130',
      ].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A8.8 suite did not complete'
      : !reconciled
        ? `A8.8 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A8.8 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A8\.8\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A8.8] automated summary: ', 'A8.8 ')}; all ${a88Passing} substantive checks PASS (its own-scope T006/T009, its later-phase-aware T110 and T125 included) and every failure is documented`,
  )
  check('T102', 'A8.7 substantive regression PASS', verdictOf('T111') === 'PASS', `A8.8 T111 (A8.7, with its own documented branch-only items) ${verdictOf('T111')}`)
  check('T103', 'A8.6 substantive regression PASS', verdictOf('T112') === 'PASS', `A8.8 T112 (A8.6) ${verdictOf('T112')}`)
  check('T104', 'A8.5 and A8.3 substantive regressions PASS', verdictOf('T113') === 'PASS' && verdictOf('T114') === 'PASS', `A8.8 T113 (A8.5) ${verdictOf('T113')} and T114 (A8.3) ${verdictOf('T114')}`)
  check('T105', 'A8.2 and A8.1 substantive regressions PASS', verdictOf('T115') === 'PASS' && a84Paths.length === 0, `A8.8 T115 (A8.2, A8.1 and the A8.4 closure) ${verdictOf('T115')}`)
  check('T106', 'A7.1–A7.10 regression chain PASS', verdictOf('T116') === 'PASS', `A8.8 T116 (A7.10 and A7.1–A7.9) ${verdictOf('T116')}`)
  check(
    'T107',
    'A6.1–A6.10 and frozen vectors PASS',
    verdictOf('T117') === 'PASS' && ownerSnapshotNow.freezes === ownerSnapshotBefore.freezes && ownerSnapshotNow.lifecycle === ownerSnapshotBefore.lifecycle && ownerSnapshotNow.links === ownerSnapshotBefore.links &&
      ownerSnapshotNow.claims === ownerSnapshotBefore.claims,
    `A8.8 T117 (A6.10, which nests A6.9 → A6.1 and its frozen vectors) ${verdictOf('T117')}; each freeze, sealed manifest, lifecycle event, correction link and Claim of the ${runClaims.length + 1} run Claims is byte-identical`,
  )
  check('T108', 'A5.1–A5.10 substantive regressions PASS', verdictOf('T118') === 'PASS', `A8.8 T118 (the chain reaching A5.10 → A5.1) ${verdictOf('T118')}`)
  const a3Scope = run('npm run test:a3:scope')
  check('T109', 'A1–A4 governance and access PASS', verdictOf('T119') === 'PASS' && a3Scope.ok, `A8.8 T119 (A4 → A1, A3 included, and A2) ${verdictOf('T119')}; the A3.9 scope suite over this branch's files ${a3Scope.ok ? 'PASS' : 'FAIL'}`)
  const moduleCode = committedProductionCodeOf([MODULE_DIR]).code
  const untouched = (paths: string[]) => gitArgs(['diff', '--name-only', ownRange, '--', ...paths.map((p) => `:/${p}`)]) === ''
  check(
    'T110',
    'CRG-A/B receipts, scopes and histories unchanged',
    verdictOf('T109') === 'PASS' && ownerSnapshotNow.coding === ownerSnapshotBefore.coding && untouched(['backend/src/modules/coding-release', 'backend/src/modules/coding-validation']) &&
      !/crg_|coding-release|codingRelease|code_system|procedure-code|diagnosis-code|drg|tariff/i.test(moduleCode) &&
      same(serviceImports.filter((i) => i.from.includes('/coding-validation/')).flatMap((i) => i.names), ['getSubmissionCodingProvenanceOf']),
    `A8.8 T109 (CRG activation, coding and DRG) ${verdictOf('T109')}; every CRG-01 coding-release and validation table (rights, imports, memberships, scopes, receipts, manifests) and the A2 code masters hold exactly the rows they held; the CRG modules are unchanged; the module reads the CRG owner only through getSubmissionCodingProvenanceOf`,
  )

  // ---------------------------------------------------------------- operational hard gates (T111–T120)
  section('Operational hard gates: units, typecheck, frontend lint and build, the replay, checksums and constraint catalog, outage and recovery, no 5xx, UTC/locale and Arabic determinism, no DHA scope, import or A9 side effect')
  const allUnit = run('npm run test:unit')
  check('T111', 'Backend unit tests PASS', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok, `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 12 A8.9 reducer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T112', 'Backend typecheck PASS', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T113', 'Frontend lint PASS', lint.ok, 'frontend lint clean, including the read-only closure check page')
  const build = run('npm run build --prefix ../frontend')
  check('T114', 'Frontend production build PASS', build.ok, `frontend production build ${(build.output.match(/built in [\dms.]+/) ?? ['ok'])[0]}`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = applied.filter((row) => {
    const blob = committedBlob(`backend/prisma/migrations/${row.name}/migration.sql`)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  const restrictLines = (replay.output.match(/PASS {2}exception_closure_events_\w+_fkey is present after a clean replay/g) ?? []).length
  const names = async (sql: string) => (await prisma.$queryRawUnsafe<{ n: string }[]>(sql)).map((r) => r.n.replace(`${TABLE}_`, '')).sort()
  const catalog = {
    indexes: await names(`SELECT indexname AS n FROM pg_indexes WHERE tablename = '${TABLE}'`),
    checks: await names(`SELECT conname AS n FROM pg_constraint WHERE conrelid = '${TABLE}'::regclass AND contype = 'c'`),
    triggers: await names(`SELECT tgname AS n FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND NOT tgisinternal`),
    foreignKeys: (await fksOf(TABLE)).map((r) => `${r.name.replace(`${TABLE}_`, '')}:${r.del === 'r' ? 'RESTRICT' : r.del}`),
  }
  const generatedAgain = run('npm run db:generate')
  const a89Checksum = applied.find((row) => row.name === MIGRATION_NAME)?.checksum ?? ''
  check(
    'T115',
    'All migration checksums and scratch replay PASS',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && restrictLines === 6 && /PASS {2}the A8\.9 tables are exactly exception_closure_events/.test(replay.output) &&
      /PASS {2}exception_closure_events_insert_guard_trg is present/.test(replay.output) && /PASS {2}exception_closure_events_append_only_trg is present/.test(replay.output) &&
      /PASS {2}exception_closure_events_no_truncate_trg is present/.test(replay.output) && /PASS {2}one closure event per \(intake, sequence\) and one closure per intake are unique/.test(replay.output) &&
      /PASS {2}the A8\.9 CHECKs pin A8-CLOSURE-1/.test(replay.output) && /PASS {2}exception_closure_events carries exactly its 16 A8\.9 columns/.test(replay.output) &&
      /PASS {2}the A8\.8 tables are exactly exception_escalation_events/.test(replay.output) && status.ok && applied.length === headMigrationDirs.length &&
      same(applied.map((r) => r.name), headMigrationDirs.map((d) => d.split('/').pop())) && checksumMismatch.length === 0 && a89Checksum === sha256Of(committedBlob(MIGRATION)) && generatedAgain.ok &&
      same(catalog.indexes, ['basis_reference_id_idx', 'claim_id_idx', 'exception_intake_id_key', 'organization_id_idx', 'pkey', 'recorded_by_membership_id_idx', 'recorded_by_user_id_idx', 'resolution_decision_event_id_idx', 'sequence_key']) &&
      same(catalog.checks, ['contract_chk', 'event_code_chk', 'sequence_chk', 'shape_chk']) && same(catalog.triggers, ['append_only_trg', 'insert_guard_trg', 'no_truncate_trg']) && catalog.foreignKeys.length === 6 &&
      catalog.foreignKeys.every((fk) => fk.endsWith(':RESTRICT')),
    `scratch replay from empty: ${appliedCount} migrations, ALL CHECKS PASS, all ${restrictLines} RESTRICT keys and every A8.9 trigger, CHECK, unique index and column survive (and every A8.8 one); exactly the ${headMigrationDirs.length} committed migrations are applied, in order, each with its committed checksum (A8.9 ${a89Checksum.slice(0, 16)}); live catalog — indexes ${catalog.indexes.join(', ')}; CHECKs ${catalog.checks.join(', ')}; triggers ${catalog.triggers.join(', ')}; keys ${catalog.foreignKeys.join(', ')}`,
  )
  check(
    'T116',
    'Health/ready outage recovery truthful',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered && rowsAfterOutage === rowsBeforeOutage && agreeAfterRestart,
    'up 200/200; with the database stopped (T079) health stayed 200 and ready reported 503; recovery 200; every closure row and audit of this run hashed exactly as before the outage and the reads agreed for every home intake after the restart',
  )
  // No pg "client.query() while already executing" deprecation in this process or in any process of the nested chain
  // (its output carries each suite's stderr).
  const nestedDriverWarnings = (chain.output.match(/Calling client\.query\(\) when the client is already executing a query/g) ?? []).length
  check(
    'T117',
    'No unexpected HTTP 5xx or pg deprecation',
    serverErrors === 0 && connectionResets === 0 && driverWarnings.length === 0 && nestedDriverWarnings === 0,
    `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run; ${driverWarnings.length + nestedDriverWarnings} pg client.query() deprecation warnings in this process and the nested chain`,
  )
  // T118 — the production reads of W in two child processes under far-apart time zones and locales (one Arabic) answer
  // exactly the bytes this process reads.
  const stripTime = (value: unknown) => JSON.stringify(value, (k, v) => (k === 'evaluatedAt' ? undefined : v))
  const CHILD = [
    "const { getClosureReconstruction, getClosureHistory } = await import('./src/modules/exception-closure/exception-closure.service.ts');",
    "const strip = (value) => JSON.stringify(value, (k, v) => (k === 'evaluatedAt' ? undefined : v));",
    'const [claimId, intakeId] = process.argv.slice(1);',
    'const reconstruction = await getClosureReconstruction(claimId, intakeId);',
    'const history = await getClosureHistory(claimId, intakeId);',
    "console.log('CHILD ' + JSON.stringify({ reconstruction: strip(reconstruction), history: strip(history), offset: new Date(Date.UTC(2026, 5, 15)).getTimezoneOffset(), locale: Intl.DateTimeFormat().resolvedOptions().locale, sample: (12345.5).toLocaleString() }));",
    'process.exit(0);',
  ].join('\n')
  const inChild = (extra: Record<string, string>) => {
    const out = spawnSync(process.execPath, ['--env-file=.env', '--input-type=module', '-e', CHILD, W.claimId, W.intakeId], { encoding: 'utf8', cwd: process.cwd(), env: childEnv(extra), maxBuffer: 16 * 1024 * 1024 })
    const line = (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('CHILD ')) ?? ''
    try {
      return JSON.parse(line.slice(6)) as { reconstruction: string; history: string; offset: number; locale: string; sample: string }
    } catch {
      return null
    }
  }
  const here = { reconstruction: stripTime(await getClosureReconstruction(W.claimId, W.intakeId)), history: stripTime(await getClosureHistory(W.claimId, W.intakeId)) }
  const kiritimati = inChild({ TZ: 'Pacific/Kiritimati', LANG: 'ar_AE.UTF-8', LC_ALL: 'ar_AE.UTF-8' })
  const honolulu = inChild({ TZ: 'Pacific/Honolulu', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' })
  const t118Unit = /ℹ pass 12/.test(ownUnit.output) && /the same answers under any time zone and locale, Arabic UTF-8 safe/.test(reducerTests)
  check(
    'T118',
    'UTC/locale deterministic, Arabic UTF-8 safe',
    !!kiritimati && !!honolulu && kiritimati.offset !== honolulu.offset && kiritimati.reconstruction === here.reconstruction && honolulu.reconstruction === here.reconstruction && kiritimati.history === here.history &&
      honolulu.history === here.history && t118Unit && freeText[freeText.length - 1].status === 400 && !auditText.includes('ملاحظة') && !closureText.includes('ملاحظة'),
    `W's reconstruction and history read in a child process under Pacific/Kiritimati with an Arabic locale (offset ${kiritimati?.offset}) and under Pacific/Honolulu (offset ${honolulu?.offset}) are byte-identical to this process's; the unit test proves the reducer the same way with Arabic UTF-8 synthetic text; an Arabic remark in a request is refused (400) and reaches no DTO or audit`,
  )
  check(
    'T119',
    'No real DHA scope or licensed import activated',
    ownerSnapshotNow.coding === ownerSnapshotBefore.coding && registerFlat.includes('It enables no real DHA/DOH scope, imports nothing and selects no coding release') &&
      !/import\w*Release|activate|codeSystemRights|dha|doh/i.test(moduleCode.replace(/getSubmissionCodingProvenanceOf/g, '')) && !COLUMNS.some((c) => /dha|scope|release|edition|right/.test(c)),
    'every CRG-01 rights, import, release-membership, scope and receipt table holds exactly the rows it held; the module activates, imports or selects nothing, names no DHA/DOH scope and stores no release, edition or right; the register says so',
  )
  const tablesAt = (ref: string) => new Set(migrationDirsAt(ref).flatMap((dir) => [...gitArgs(['show', `${ref}:${dir}/migration.sql`]).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])))
  const mainTables = tablesAt(ownBase)
  // Tables that existed on main belong to earlier phases; only what this branch adds is judged. Later phases' tables are
  // those created by migrations committed after A8.9's own merge (none on its own branch).
  const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])) : [])
  const newTablesLike = async (pattern: string) =>
    (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`, pattern)).map((r) => r.t).filter((t) => !mainTables.has(t) && !laterPhaseTables.has(t) && t !== TABLE)
  const forbiddenRoutes = await Promise.all(['reopen', 'payer-submission', 'transmit', 'remittance', 'payment', 'claim-correction', 'claim-adjustment', 'release', 'drg', 'export', 'sla', 'queue'].map((p) => post(`${base(W)}/${p}`, {})))
  const searches = await Promise.all(['/api/exception-closure', '/api/closure-events', '/api/closures', `/api/organizations/${org}/closure-events`, `/api/claims/${W.claimId}/closure-events`, `/api/organizations/${org}/closures`].map((p) => get(p)))
  const inserts = [...moduleCode.matchAll(/INSERT INTO "?([a-z_]+)"?/g)].map((m) => m[1])
  const feCode = committedProductionCodeOf([FE_DIR]).code
  const repositoryCode = committedCode(`${MODULE_DIR}/exception-closure.repository.ts`)
  const dtoKeys = [...deepKeys([(await closureHistoryOf(W)).body, (await reconstructionOf(W)).body, (await reconstructionOf(WR)).body])]
  const storedText = JSON.stringify(await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${TABLE} WHERE claim_id = ANY($1::uuid[])`, runClaims), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  check(
    'T120',
    'No A9 transmission/financial/DRG side effects',
    forbiddenRoutes.every((r) => r.status === 404) && searches.every((r) => r.status === 404) && mainTables.size > 50 && (await newTablesLike('(sla|deadline|due_|queue|outbox|_job|reopen|timer|payment|remit|transmi|drg)')).length === 0 &&
      same(inserts, [TABLE]) && !/UPDATE "|DELETE FROM|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\.create\(|\.createMany\(/.test(moduleCode) && /orderBy: \{ sequence: 'asc' \}/.test(repositoryCode) &&
      !dtoKeys.some((k) => /patient|birth|email|diagnos|amount|currency|payer|payment|narrative|note|payload|hash|digest|priority|deadline|due|drg|tariff/i.test(k)) &&
      ![`${runId}-home-P`, '1990-01-01', key('home-DXA'), key('home-PA'), 'AED', '125.25', '12.125', M1.email, CF.email, 'Synthetic member', 'Synthetic finding.'].some((value) => storedText.includes(value) || auditText.includes(value)) &&
      !/from 'node:(http|https|net|tls|dgram|fs|child_process)'|\bfetch\(|axios|console\.|logger\.|process\.stdout|enqueue|setInterval|worker_threads|cron/.test(moduleCode) &&
      !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|setInterval|setTimeout|navigator\.sendBeacon|WebSocket|EventSource/.test(feCode) && !/method: '(POST|PUT|PATCH|DELETE)'/.test(feCode),
    `no reopen, payer submission, transmission, remittance, payment, Claim correction or adjustment, release, DRG, export, SLA or queue route, no organization-wide list or search, and no such table; the module's only write is its own append-only INSERT into ${TABLE} (and the audit through its owner); no patient, contact, clinical, amount, payer or narrative value is stored, answered or audited; the module logs nothing and opens no network, file or queue; the page only reads and stores nothing`,
  )

  // ---------------------------------------------------------------- evidence and handoff (T121–T130)
  section('Evidence and handoff: the start gates and exact base, the synthetic worked closure, the refused pending escalation, the archived SQL matrix, the run identity at the exact pushed HEAD, the clean tree, the nested original failures, hashes, and A8.10 and A9 kept later')
  check(
    'T121',
    'Approved start gates and exact base SHA',
    [A85_MERGE, CRGB_MERGE, A86_MERGE, A87_MERGE, A88_MERGE].every((sha) => registerAtHead.includes(sha)) && registerFlat.includes(`\`${a89Branch}\` is cut from clean, synchronized main`) &&
      gitArgs(['merge-base', 'HEAD', 'origin/main']) === gitArgs(['rev-parse', 'origin/main']) && [a85Merge, a86Merge, a87Merge, a88Merge, crgbMerge].every((sha) => sha.length === 40),
    `the register records A8.5 ${A85_MERGE.slice(0, 7)}, Checkpoint B ${CRGB_MERGE.slice(0, 7)}, A8.6 ${A86_MERGE.slice(0, 7)}, A8.7 ${A87_MERGE.slice(0, 7)} and A8.8 ${A88_MERGE.slice(0, 7)}; the branch is cut from, and synchronized with, main ${shortMain}`,
  )
  const goldenAfter = await goldenNow()
  const wFinal = (await reconstructionOf(W)).body
  progress(
    `worked closure: Claim W ${W.claimId}, intake ${W.intakeId} (A8.2 classify → assign M1; A8.3 link → finding; A8.5 plan by M1 → approval by RV; A8.6 report by M1 → EVIDENCE_SUPPORTED by VR; A8.7 request by M1 → CONFIRM_INTERNAL_RESOLUTION by DR; no A8.8 escalation): CONFIRM_INTERNAL_CLOSURE (VERIFIED_INTERNAL_RESOLUTION on RESOLUTION_DECISION ${decisionOf(W)}) by CF; CLOSED_INTERNAL, one closure, one audit, a ${wFinal.chain.length}-entry reconstruction and ${wFinal.submissions.length} submission(s) ${wFinal.submissions.map((s: any) => s.codingVerificationStatus).join(', ')}; nothing adjudicated, paid, corrected, reopened or sent`,
  )
  check(
    'T122',
    'One synthetic authorized complete closure',
    same(goldenAfter, goldenBefore) && W.status === 201 && W_CLASSIFY.sequence === 1 && W_ASSIGN.sequence === 2 && IW.statuses.every((s) => s === 201) && same(PW.statuses, [201, 201]) && same(WW.statuses, [201, 201]) &&
      C_W.status === 201 && wFinal.state === 'CLOSED_INTERNAL' && same(wFinal.chain.map((e: any) => e.owner), expectedOwners) && (await auditsOfIntake(W.intakeId)) === 1,
    "W was built entirely through its owners' routes and closed by an independent human confirmer; after the nested chain its history, reconstruction, audit and every run row read back identically",
  )
  check(
    'T123',
    'One synthetic invalid pending escalation refused',
    awaRoutes.every((r) => r.status === 409) && opnRoutes.every((r) => r.status === 409) && opnRace.closed.ok === false && (await eventsOf(AWA.intakeId)).length === 0 && (await eventsOf(OPN.intakeId)).length === 0 &&
      (await escalationDispositionOf(AWA)).body.state === 'AWAITING_ACKNOWLEDGEMENT' && (await escalationDispositionOf(OPN)).body.state === 'FOLLOWUP_ACTIVE',
    "AWA (A8.7 RESOLVED_INTERNAL, escalation awaiting acknowledgement) and OPN (RESOLVED_INTERNAL, follow-up active, CL-02) are refused at every attempt — route, race and direct row — and hold no closure; their escalations are untouched",
  )
  const sqlMatrixLog = `a89-sql-matrix-${runId}.log`
  const VALID_LABELS = ['S: a valid closure by CF', 'S: a valid closure by CF2', 'SR: a valid closure on its return (CL-01)']
  const sqlText = [
    `A8.9 — direct SQL adversarial matrix, run ${runId} at HEAD ${git('rev-parse HEAD')}`,
    'Every direct write of this run, in order: each ran in one transaction that was always rolled back; "clean" means every counted table read back exactly.',
    '',
    ...sqlMatrix.map((r, i) => `${String(i + 1).padStart(3, '0')} ${r.refused ? 'REFUSED' : 'ACCEPTED'} ${r.clean ? 'clean' : 'DIRTY'} | ${r.label} | ${r.message}`),
    '',
  ].join('\n')
  writeFileSync(sqlMatrixLog, sqlText)
  check(
    'T124',
    'Direct SQL bypass/adversarial matrix archived',
    sqlMatrix.length >= 50 && sqlMatrix.every((r) => r.clean) && sqlMatrix.every((r) => (VALID_LABELS.includes(r.label) ? !r.refused : r.refused)) && existsSync(sqlMatrixLog),
    `all ${sqlMatrix.length} direct writes of this run — ${sqlMatrix.filter((r) => r.refused).length} refused by a guard, CHECK or index and the ${VALID_LABELS.length} valid ones accepted — rolled back clean, archived in backend/${sqlMatrixLog}`,
  )
  const runEventMembers = await prisma.$queryRawUnsafe<{ org: string; member: string | null }[]>(
    `SELECT e.organization_id::text AS org, u.email AS member FROM ${TABLE} e JOIN organization_memberships m ON m.id = e.recorded_by_membership_id JOIN "user" u ON u.id = m.user_id WHERE e.recorded_at >= $1::timestamptz AND e.recorded_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  const headNow = git('rev-parse HEAD')
  const originHead = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a89Branch}`])
  const checksBefore125 = passed + failed
  const earlierRuns = readdirSync('.')
    .filter((name) => /^a89-nested-A89-\d{13}\.log$/.test(name) && name !== nestedLog)
    .filter((name) => readFileSync(name, 'utf8').includes(`[A8.8] HEAD ${headNow}`))
    .map((name) => name.replace(/^a89-nested-|\.log$/g, ''))
  const runIntakeIds = new Set(runIntakes.map((k) => k.intakeId))
  const runClosures = await prisma.exceptionClosureEvent.findMany({ where: { recordedAt: { gte: runStartedAt } } })
  check(
    'T125',
    'Two independently numbered 130/130 runs',
    checksBefore125 === 124 && /^A89-\d{13}$/.test(runId) && !earlierRuns.includes(runId) && headNow === headAtStart && headNow === originHead && runClosures.every((e) => runIntakeIds.has(e.exceptionIntakeId)) &&
      runEventMembers.length >= 10 && runEventMembers.every((e) => e.org === org && /@reviewers\.sbn\.test$/.test(e.member ?? '')) && (await eventsOf(F.intakeId)).length === 0,
    `run ${runId} at ${headNow}: all 124 checks before this one executed (${passed} PASS) with fixtures and members it created itself; all ${runEventMembers.length} closures this run belong to the synthetic Org A and were confirmed by synthetic members only; ${earlierRuns.length > 0 ? `earlier kept run(s) at this HEAD: ${earlierRuns.join(', ')}` : 'no earlier run at this HEAD is kept here, so this is the first'}; the two submitted runs must both state HEAD ${headNow.slice(0, 12)} with different runIds`,
  )
  check(
    'T126',
    'Same exact pushed HEAD and origin parity',
    headNow === headAtStart && headNow === originHead && headNow.length === 40 && tracking.includes(`origin/${a89Branch}`) && !/ahead|behind/.test(tracking),
    `HEAD ${headNow} = origin/${a89Branch}; ${tracking}; the same HEAD at the start and the end of the run`,
  )
  check(
    'T127',
    'Clean tracked tree and scope allowlist',
    git('status --porcelain') === '' && outOfScope.length === 0 && earlierSuites.length === 0 && laterDomain.length === 0 && dirty.length === 0,
    `${tracking}; the tree is clean after every check (the nested logs, the evidence and the SQL matrix are ignored output); every changed path is on the A8.9 allowlist`,
  )
  let naPrinted = 0
  for (const id of Object.keys(a88NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) {
      notApplicableCheck(`T128/${id}`, `A8.8 ${titleOf(row.line)}`, a88NonApplicable[id])
      naPrinted += 1
    }
  }
  // Each documented failure must fail for its branch-only cause, proved independently on this branch from its own line
  // and this branch's state, all the way down: A8.8 T120's A8.7 items, A8.7 T120's A8.6 items, A8.6 T110's A8.5 items,
  // A8.5 T110's A8.3 items, A8.3 T119's A8.2 items, A8.2 T120's A8.1 items, A8.1 T110's A7.10 items and A7.10 T111's
  // A7.9 items, down to A7.9 T120's A8.7 items. A depth may fail only with its documented branch-only items, each exactly
  // once; every item its aggregator names must fail at the next depth.
  const headSha = headNow
  const shortMainDefault = git('rev-parse --short origin/main')
  const thisBranchClean = (line: string) => line.includes(`## ${a89Branch}...origin/${a89Branch}`) && !/ahead|behind/.test(line.split(`## ${a89Branch}...origin/${a89Branch}`)[1]?.split(';')[0] ?? 'ahead')
  const NESTED_BRANCH_ONLY: { tag: string; aggregator: string; ids: string[] }[] = [
    { tag: 'A8.7', aggregator: 'T120', ids: ['T001', 'T004', 'T010', 'T120', 'T128', 'T129'] },
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
    const pattern = new RegExp(`^\\[A8\\.8\\] +${NESTED_BRANCH_ONLY.slice(0, depth + 1).map((d) => `nested: \\[${escapeTag(d.tag)}\\] +`).join('')}(T\\d{3}) .* \\.{3,} FAIL - (.*)$`)
    return chain.output.split(/\r?\n/).map((line) => line.match(pattern)).filter((m): m is RegExpMatchArray => m !== null).map((m) => ({ id: m[1], detail: m[2] }))
  }
  const listAfter = (text: string, label: RegExp) => ((text.match(label) ?? ['', ''])[1] ?? '').split(', ').map((s) => s.trim()).filter(Boolean)
  const detailOf = (line: string) => (line.match(/ \.{3,} FAIL - (.*)$/) ?? ['', ''])[1]
  // A nested line is cut at a fixed width, so only its last listed path may be a prefix.
  const pathsInScope = (paths: string[]) => paths.length > 0 && paths.every((p, i) => changedPaths.includes(p) || (i === paths.length - 1 && changedPaths.some((c) => c.startsWith(p))))
  const ancestorsNamed = (detail: string) => /\bas [0-9a-f]{7,40}\b/.test(detail) && [...detail.matchAll(/\bas ([0-9a-f]{7,40})\b/g)].every((m) => gitOk(`merge-base --is-ancestor ${m[1]} HEAD`))
  const headItemProved = (id: string, detail: string) =>
    (id === 'T127' && originHead === headSha && detail.includes(`HEAD ${headSha}`) && thisBranchClean(detail) && /the tree is clean after every check/.test(detail)) ||
    (id === 'T129' && originHead === headSha && detail.includes(`HEAD ${headSha.slice(0, 12)}`))
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
      // A8.7's own items: its base, its parity and its run identity, each naming THIS branch and HEAD.
      if (id === 'T001') return detail.startsWith(`branch ${a89Branch};`) && detail.includes(`latest main ${shortMain} contained`) && ancestorsNamed(detail) && gitOk(`merge-base --is-ancestor ${A87_MERGE} HEAD`)
      if (id === 'T004') return detail.startsWith('working tree clean;') && thisBranchClean(detail)
      if (id === 'T128') return originHead === headSha && detail.includes(` at ${headSha}: all 127 checks before this one executed`)
      if (id === 'T129') return originHead === headSha && detail.includes(`HEAD ${headSha}`) && thisBranchClean(detail) && /the tree is clean after every check/.test(detail)
      return false
    }
    if (depth === 1) {
      // A8.6's own items: its base, its branch, its parity and its run identity.
      if (id === 'T001') return /^A8\.5 merged as [0-9a-f]{7} /.test(detail) && detail.includes(`latest main ${shortMainDefault} contained`) && ancestorsNamed(detail)
      if (id === 'T003') return detail.startsWith(`branch ${a89Branch}; working tree clean;`) && thisBranchClean(detail)
      return headItemProved(id, detail)
    }
    if (depth === 2) {
      // A8.5's own items, the same four kinds.
      if (id === 'T001') return /^A8\.3 merged as [0-9a-f]{7} .*an ancestor/.test(detail) && detail.includes(`latest main ${shortMainDefault} contained`) && ancestorsNamed(detail)
      if (id === 'T003') return detail.startsWith(`branch ${a89Branch}; working tree clean;`) && thisBranchClean(detail)
      return headItemProved(id, detail)
    }
    if (id === 'T001') return detail.startsWith(`branch ${a89Branch};`) && detail.includes(`latest main ${shortMain}`) && ancestorsNamed(detail)
    if (id === 'T002') return detail.startsWith('working tree clean;') && thisBranchClean(detail)
    // T122, T123 and T130 are the identity of the historical branch's own runs: here they name THIS exact pushed HEAD.
    const counted = detail.match(/^(\d+) of the 129 checks before this one PASS, (\d+) FAIL/)
    return originHead === headSha && (detail.includes(headSha) || thisBranchClean(detail)) && (!counted || (Number(counted[2]) === count - 1 && Number(counted[1]) === 129 - (count - 1)))
  }
  const a88Line = (id: string) => rows.find((r) => r.id === id && r.verdict === 'FAIL')?.line ?? ''
  const causes: Record<string, () => boolean> = {
    T001: () => detailOf(a88Line('T001')).startsWith(`branch ${a89Branch};`) && a88Line('T001').includes(`latest main ${shortMain} contained`) && ancestorsNamed(detailOf(a88Line('T001'))) && gitOk(`merge-base --is-ancestor ${A88_MERGE} HEAD`),
    T005: () => detailOf(a88Line('T005')).startsWith('working tree clean;') && thisBranchClean(a88Line('T005')),
    T010: () => outOfScope.length === 0 && pathsInScope(listAfter(detailOf(a88Line('T010')), /^unexpected: (.*)$/)),
    T120: () => originHead === headSha && nestedDepthProved(0, listAfter(detailOf(a88Line('T120')), /^cause not proven for: (.*)$/)),
    T128: () => originHead === headSha && a88Line('T128').includes(` at ${headSha}: all 127 checks before this one executed`),
    T129: () => originHead === headSha && a88Line('T129').includes(`HEAD ${headSha}`) && thisBranchClean(a88Line('T129')) && /the tree is clean after every check/.test(a88Line('T129')),
  }
  const unprovenHere = failing.filter((id) => !(id in causes) || !causes[id]())
  // Every original nested FAIL result is kept verbatim with its N/A category. An N/A may only be a BRANCH item (branch
  // name or base ancestry), a HEAD item (clean tree, origin parity, or a run's own identity at its exact HEAD), a SCOPE
  // item (the paths that package was allowed to change) or an AGGREGATE item (a suite's own "every branch-only N/A
  // justified" check, whose items are each re-proved above). Any other kind fails T128.
  type Category = 'BRANCH' | 'HEAD' | 'SCOPE' | 'AGGREGATE'
  const topCategory: Record<string, Category> = { T001: 'BRANCH', T005: 'HEAD', T010: 'SCOPE', T120: 'AGGREGATE', T128: 'HEAD', T129: 'HEAD' }
  const a87Category: Record<string, Category> = { T001: 'BRANCH', T004: 'HEAD', T010: 'SCOPE', T120: 'AGGREGATE', T128: 'HEAD', T129: 'HEAD' }
  const ownLevelCategory: Record<string, Category> = { T001: 'BRANCH', T003: 'BRANCH', T010: 'SCOPE', T110: 'AGGREGATE', T127: 'HEAD', T129: 'HEAD' }
  const categoryOf = (tags: string[], id: string): Category | null => {
    if (tags.length === 0) return topCategory[id] ?? null
    if (tags.length > NESTED_BRANCH_ONLY.length || tags.some((tag, i) => tag !== NESTED_BRANCH_ONLY[i].tag)) return null
    const level = NESTED_BRANCH_ONLY[tags.length - 1]
    if (!level.ids.includes(id)) return null
    if (tags.length === 1) return a87Category[id] ?? null
    if (tags.length <= 3) return ownLevelCategory[id] ?? null
    return id === 'T001' ? 'BRANCH' : id === 'T010' ? 'SCOPE' : id === level.aggregator ? 'AGGREGATE' : ['T002', 'T122', 'T123', 'T130'].includes(id) ? 'HEAD' : null
  }
  const nestedEvidence = chain.output
    .split(/\r?\n/)
    .map((line) => ({ line, m: line.match(/^\[([^\]]+)\]((?: +nested: \[[^\]]+\])*) +(\S+) .* \.{3,} FAIL - /) }))
    .filter((x): x is { line: string; m: RegExpMatchArray } => x.m !== null && x.m[1] === 'A8.8')
    .map(({ line, m }) => {
      const tags = [...m[2].matchAll(/nested: \[([^\]]+)\]/g)].map((t) => t[1])
      return { line, tags, id: m[3], category: categoryOf(tags, m[3]), reason: tags.length === 0 ? (a88NonApplicable[m[3]] ?? '') : '' }
    })
  const uncategorized = nestedEvidence.filter((e) => e.category === null)
  const evidenceLog = `a89-nested-evidence-${runId}.log`
  const evidenceText = [
    `A8.9 — nested regression evidence, run ${runId} at HEAD ${headSha}`,
    'Every original nested FAIL result, verbatim, with its N/A category (BRANCH | HEAD | SCOPE | AGGREGATE); a top-level item also carries its reason.',
    `The full nested output is kept in ${nestedLog}.`,
    '',
    ...nestedEvidence.flatMap((e) => [`[${e.category ?? 'UNCATEGORIZED'}] ${e.line}`, ...(e.reason ? [`    reason: ${e.reason}`] : [])]),
    '',
  ].join('\n')
  writeFileSync(evidenceLog, evidenceText)
  const categoryCounts = (['BRANCH', 'HEAD', 'SCOPE', 'AGGREGATE'] as Category[]).map((c) => `${nestedEvidence.filter((e) => e.category === c).length} ${c}`).join(', ')
  check(
    'T128',
    'Nested original failures retained and justified',
    ran && undocumented.length === 0 && unprovenHere.length === 0 && failing.length > 0 && naPrinted === failing.length && failing.every((id) => a88NonApplicable[id].length > 80) && uncategorized.length === 0 &&
      failing.every((id) => nestedEvidence.some((e) => e.tags.length === 0 && e.id === id)) && existsSync(evidenceLog),
    undocumented.length > 0
      ? `undocumented A8.8 failures: ${undocumented.join(', ')}`
      : unprovenHere.length > 0
        ? `cause not proven for: ${unprovenHere.join(', ')}`
        : uncategorized.length > 0
          ? `not a branch, HEAD or scope item: ${uncategorized.map((e) => [...e.tags, e.id].join('>')).join(', ').slice(0, 300)}`
          : `each documented A8.8 failure (${failing.join(', ')}) is printed individually with its reason and fails only for its branch-only cause, proved on this branch from its own line — T120's A8.7 items re-proved at every depth down to A7.9; all ${nestedEvidence.length} original nested FAIL lines kept verbatim in backend/${evidenceLog} — ${categoryCounts}, no other kind`,
  )
  const versions = [`${CONTRACT}`, ...contractsOwn.filter((c) => /exception-(intake|triage|investigation|remediation|remediation-work|resolution|escalation)\//.test(c)).map((c) => c.split('=')[1])]
  check(
    'T129',
    'Evidence hashes and source versions recorded',
    existsSync(nestedLog) && existsSync(evidenceLog) && existsSync(sqlMatrixLog) && a89Checksum.length === 64 && versions.length >= 8 && versions.includes('A8-ESCALATION-1') && versions.includes('A8-RESOLUTION-DECISION-1'),
    `HEAD ${headNow.slice(0, 12)}; nested output backend/${nestedLog} (SHA-256 ${sha256Of(Buffer.from(chain.output))}), nested evidence backend/${evidenceLog} (SHA-256 ${sha256Of(Buffer.from(evidenceText))}), SQL matrix backend/${sqlMatrixLog} (SHA-256 ${sha256Of(Buffer.from(sqlText))}); migration ${MIGRATION_NAME} checksum ${a89Checksum}; source contracts ${versions.join(', ')}`,
  )
  const typesText = committedText(`${MODULE_DIR}/exception-closure.types.ts`)
  const vocabulary = [...closureEventCodes, ...closureReasonCodes, ...basisReferenceKinds, ...closureStates, CONTRACT]
  check(
    'T130',
    'A8.10 phase acceptance and A9 remain later',
    registerFlat.includes('## Out of scope (handoff)') && registerFlat.includes('## A7.5 T095 later-phase recognition (included in this PR)') && registerFlat.includes('the A8.10 phase acceptance') && registerFlat.includes('any CRG activation, Checkpoint C, real DHA activation, and A9') &&
      registerFlat.includes('reopening a closure, a second closure, or closing a CL-02 or `RETURNED_FOR_REWORK` intake') && registerFlat.includes('Production use additionally needs the A10 release gates') &&
      vocabulary.every((code) => registerAtHead.includes(`\`${code}\``) && typesText.includes(`'${code}'`)) && !headTree.some((p) => /a8[-_]?10|integration\/a9/i.test(p)),
    `the register records the start gate, the reconciliation and decisions CL-01, CL-02 and D1–D9, the owner readers, ${CONTRACT} and all ${vocabulary.length} controlled codes (each identical in the module), CLOSED_INTERNAL as an internal process position only, the A7.5 T095 later-phase correction, and reopening, a second closure, A8.10 phase acceptance, queues and SLAs, coding, payer facts, CRG activation, Checkpoint C, real DHA activation and A9 as later, separately approved work; no A8.10 or A9 path exists`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] EXCEPTION CLOSURE ACCEPTANCE COMPLETE` : `[${TAG}] A8.9 FINAL FAIL`)
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
