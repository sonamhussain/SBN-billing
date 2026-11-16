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
import { WORK_CODE_OF_ACTION } from '../../modules/exception-remediation-work/exception-remediation-work.types.ts'
import { recordWorkEvent } from '../../modules/exception-remediation-work/exception-remediation-work.service.ts'
import { recordResolutionEvent } from '../../modules/exception-resolution/exception-resolution.service.ts'
import { activateReferenceDatasetVersion, importReferenceDataset, importReferenceDatasetVersion, validateReferenceDatasetVersion } from '../../modules/reference-dataset/reference-dataset.maintenance.ts'
import { getCodingReleaseCheckOf, importRelease, recordRightsDecision, registerDatasetCodeSystem } from '../../modules/coding-release/coding-release.service.ts'
import { evaluateCodingRelease, recordCodingReceipts, recordValidationScope } from '../../modules/coding-validation/coding-validation.service.ts'
import { getClosureHistory, getClosureHistoryOf, getClosureReconstruction, getClosureReconstructionOf, recordClosureEvent } from '../../modules/exception-closure/exception-closure.service.ts'

// A8.10 — Exception Operations Integration Acceptance & Phase Closure (report label A8-PHASE-ACCEPTANCE-1, T001–T130).
//
// This suite owns NO runtime: no table, model, migration, permission, audit action, route, reducer or writer. It proves
// that the accepted A8 owners (A8.1 intake, A8.2 triage, A8.3 investigation, A8.5 plan, A8.6 work, A8.7 resolution, A8.8
// escalation, A8.9 closure; A8.4 closed as a duplicate of A8.3) form one internally consistent, tenant-safe and
// historically reconstructable workflow, built only through each owner's accepted route by synthetic members. Where a
// probe must pause or fail one writer, the owner's production service is called in this process exactly as that owner's
// own suite does. Direct SQL is adversarial only and ALWAYS rolled back. Every synthetic member is provisioned per run
// through Better Auth's own server-side creation with a random password that is never printed. CLOSED_INTERNAL is an
// internal process position only: nothing here expects or finds anything adjudicated, paid, remitted, transmitted,
// corrected externally or clinically cured, and nothing here is evidence of production or regulatory readiness.

const TAG = 'A8.10'
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
const committedFiles = (dir: string, ref = 'HEAD') => gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, dir]).split(/\r?\n/).filter(Boolean)
const committedText = (path: string, ref = 'HEAD') => gitArgs(['show', `${ref}:${path}`])
const committedCode = (path: string, ref = 'HEAD') =>
  committedText(path, ref)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

// The harness's own detectors are regex literals that spell the very words they look for (CREATE TABLE,
// isolationLevel, ...). A scan of this harness therefore runs over its code with every regex literal replaced by /RE/,
// so it judges what the code does, never the words its detectors spell. Strings and template literals, including every
// SQL text the harness sends, are kept and still scanned. T009 and T062 also prove, on real committed owner code, that a
// real call is still caught.
function withoutRegexLiterals(code: string): string {
  let out = ''
  let i = 0
  let prev = ''
  const regexMayStart = () => prev === '' || /[(,=:!&|?{};[+\-*%<>~^]/.test(prev) || /(^|[^\w$])(return|typeof|case|in|of|void|delete|throw)$/.test(out.trimEnd())
  const skipString = (quote: string) => {
    let j = i + 1
    while (j < code.length && code[j] !== quote && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1
    out += code.slice(i, j + 1)
    i = j + 1
    prev = quote
  }
  const skipTemplate = (): void => {
    out += '`'
    i += 1
    while (i < code.length && code[i] !== '`') {
      if (code[i] === '\\') {
        out += code.slice(i, i + 2)
        i += 2
      } else if (code[i] === '$' && code[i + 1] === '{') {
        out += '${'
        i += 2
        prev = '{'
        scan('}')
        out += '}'
        i += 1
      } else {
        out += code[i]
        i += 1
      }
    }
    out += '`'
    i += 1
    prev = '`'
  }
  const scan = (until: string): void => {
    let depth = 0
    while (i < code.length) {
      const c = code[i]
      if (c === until && depth === 0) return
      if (c === "'" || c === '"') {
        skipString(c)
        continue
      }
      if (c === '`') {
        skipTemplate()
        continue
      }
      if (c === '/' && regexMayStart()) {
        let j = i + 1
        let inClass = false
        while (j < code.length && code[j] !== '\n' && (inClass || code[j] !== '/')) {
          if (code[j] === '\\') j += 1
          else if (code[j] === '[') inClass = true
          else if (code[j] === ']') inClass = false
          j += 1
        }
        if (code[j] === '/') {
          j += 1
          while (/[a-z]/i.test(code[j] ?? '')) j += 1
          out += '/RE/'
          prev = '/'
          i = j
          continue
        }
      }
      if (c === '{') depth += 1
      if (c === '}') depth -= 1
      out += c
      if (!/\s/.test(c)) prev = c
      i += 1
    }
  }
  scan('\u0000')
  return out
}

class RunAborted extends Error {}

const runId = `A810-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(5)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a810Branch = 'feature/a8-10-phase-closure'
const a89Branch = 'feature/a8-9-closure-and-reconstruction'
const a88Branch = 'feature/a8-8-exception-escalation-followup'
const a87Branch = 'feature/a8-7-internal-exception-resolution'
const a86Branch = 'feature/a8-6-remediation-work-verification'
const a85Branch = 'feature/a8-5-exception-remediation'
const crgbBranch = 'feature/crg-01b-coding-validation-freeze'
const crgBranch = 'fix/crg-01-final-coding-release'
// The accepted predecessor merges, each recorded in the register (start gate). A8.10 is cut from the main holding the
// A8.9 merge: PR #109, merged as bb82b01 after its independent FINAL PASS. Its tree is exactly the accepted HEAD 34608a9.
const A85_MERGE = '0f8f9d3bc18347b1360b72b93056724b594a6e00'
const CRGB_MERGE = '4869df3c81ac4af5dcec988768666f7acd3d809e'
const A86_MERGE = '18de6c81f9f47374d011cfe9a688b500b8c17beb'
const A86_ACCEPTED_HEAD = 'f8ea4d2e28bf98b4711d79ebd60cb6cf4a26b314'
const A87_MERGE = '8af18916428bf173d87c33653ed8350c75c1edcb'
const A87_ACCEPTED_HEAD = '194430b'
const A88_MERGE = '012d6fd92b3b1990ff72a662a33a9a800328a9b6'
const A88_ACCEPTED_HEAD = '76aaaa2e5f44e1ec303de0e6762c4df621e44de2'
const A89_MERGE = 'bb82b01a5941cc22a6ec43517a21e0fab233b674'
const A89_ACCEPTED_HEAD = '34608a92585ae5c397e92b2af1eae3e64671914b'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const HARNESS_DIR = 'backend/src/integration/a8-phase-closure'
const REGISTER_DOC = 'docs/A8_Phase_Closure.md'
const A89_REGISTER = 'docs/A8_Exception_Closure.md'
const SCRIPT = 'test:a8:phase-closure'
const SCRIPT_LINE = `"${SCRIPT}": "node --env-file=.env src/integration/a8-phase-closure/a8-phase-closure.integration.ts"`
// The one earlier harness corrected in this PR by the head developer's decision (docs/Harness_Corrections.md §4):
// CRG-01A CRG-G08 recognizes tables of accepted later owners by provenance. T010 proves the change is bounded.
const CORRECTED_HARNESS = 'backend/src/integration/crg-01-coding-release/crg-01-coding-release.integration.ts'
const CORRECTIONS_DOC = 'docs/Harness_Corrections.md'
const ALLOWED = ['backend/package.json', REGISTER_DOC, CORRECTED_HARNESS, CORRECTIONS_DOC]
const LABEL = 'A8-PHASE-ACCEPTANCE-1'
// The accepted A8 owners, in workflow order: module, table, contract literal and constant, nested suite.
const OWNERS = [
  { tag: 'A8.1', module: 'exception-intake', table: 'exception_intake_records', contract: 'A8-EXCEPTION-INTAKE-1', constant: 'EXCEPTION_INTAKE_CONTRACT_VERSION', suite: 'test:a8:exception-intake' },
  { tag: 'A8.2', module: 'exception-triage', table: 'exception_triage_events', contract: 'A8-EXCEPTION-TRIAGE-1', constant: 'TRIAGE_CONTRACT_VERSION', suite: 'test:a8:exception-triage' },
  { tag: 'A8.3', module: 'exception-investigation', table: 'exception_investigation_events', contract: 'A8-EXCEPTION-INVESTIGATION-1', constant: 'INVESTIGATION_CONTRACT_VERSION', suite: 'test:a8:exception-investigation' },
  { tag: 'A8.5', module: 'exception-remediation', table: 'exception_remediation_events', contract: 'A8-REMEDIATION-PLAN-1', constant: 'REMEDIATION_CONTRACT_VERSION', suite: 'test:a8:exception-remediation' },
  { tag: 'A8.6', module: 'exception-remediation-work', table: 'exception_remediation_work_events', contract: 'A8-REMEDIATION-WORK-1', constant: 'WORK_CONTRACT_VERSION', suite: 'test:a8:remediation-work' },
  { tag: 'A8.7', module: 'exception-resolution', table: 'exception_resolution_events', contract: 'A8-RESOLUTION-DECISION-1', constant: 'RESOLUTION_CONTRACT_VERSION', suite: 'test:a8:exception-resolution' },
  { tag: 'A8.8', module: 'exception-escalation', table: 'exception_escalation_events', contract: 'A8-ESCALATION-1', constant: 'ESCALATION_CONTRACT_VERSION', suite: 'test:a8:exception-escalation' },
  { tag: 'A8.9', module: 'exception-closure', table: 'exception_closure_events', contract: 'A8-CLOSURE-1', constant: 'CLOSURE_CONTRACT_VERSION', suite: 'test:a8:exception-closure' },
] as const
const A8_TABLES = OWNERS.map((o) => o.table)
const INTAKE_TABLE = 'exception_intake_records'
const CLOSURE_TABLE = 'exception_closure_events'
const INTAKE_CONTRACT = 'A8-EXCEPTION-INTAKE-1'
const TIMELINE_CONTRACT = 'A7-REVENUE-TIMELINE-1'
// Every table an A8 write could conceivably touch, in a fixed key order.
const COUNT_TABLES = [...A8_TABLES, 'audit_events', 'claims', 'claim_freezes', 'claim_freeze_lifecycle_events', 'claim_correction_links', 'organization_memberships', 'membership_roles']
// The CRG-01 coding-release and validation tables and the A2 code masters.
const CODING_TABLES = [
  'crg_code_system_datasets', 'crg_code_system_rights', 'crg_release_imports', 'crg_release_code_memberships', 'crg_retirement_classifications', 'crg_validation_scopes', 'crg_validation_code_receipts',
  'crg_validation_receipt_manifests', 'procedure_codes', 'diagnosis_codes',
]
// The A7 historical records.
const A7_TABLES = ['revenue_source_evidence', 'source_evidence_classifications', 'evidence_gate_results', 'evidence_case_snapshots', 'evidence_case_entries', 'evidence_prereq_results']

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
  // pg's concurrent-query deprecation, if it ever fires in this process (it is still printed); T120 requires none here
  // and none in any process of the nested chains.
  const driverWarnings: string[] = []
  process.on('warning', (warning) => {
    if (/Calling client\.query\(\) when the client is already executing a query/.test(warning.message)) driverWarnings.push(warning.message)
  })

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] A8.10 exception operations integration acceptance and phase closure (${LABEL}, a report label only) — run ${runId}`)
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

  // A synthetic partial role left by an interrupted earlier run (T052/T058) is removed before anything is judged.
  for (const role of await prisma.role.findMany({ where: { code: { startsWith: 'SYNTHETIC_A810_' } }, select: { id: true } })) {
    await prisma.membershipRole.deleteMany({ where: { roleId: role.id } })
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
    await prisma.role.delete({ where: { id: role.id } })
  }

  // ---------------------------------------------------------------- ancestry, start gates, unchanged scope (T001–T010)
  section('Ancestry, start gates and unchanged scope: the accepted A8.6, A8.7, A8.8 and A8.9 merges, the A8.4 closure, A8.5 and Checkpoint B, CL-01 approved and reachable, one clean branch from main, a test-and-documentation-only diff, every earlier owner unchanged')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const shortMain = git('rev-parse --short=7 origin/main')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const onMainAndHead = (sha: string) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} origin/main`) && gitOk(`merge-base --is-ancestor ${sha} HEAD`)
  const acceptedTree = (merge: string, head: string) => merge.length === 40 && gitArgs(['rev-parse', `${merge}^2`]).startsWith(head) && gitArgs(['rev-parse', `${merge}^{tree}`]) === gitArgs(['rev-parse', `${head}^{tree}`])
  const a85Merge = mergeOf(a85Branch)
  const a86Merge = mergeOf(a86Branch)
  const a87Merge = mergeOf(a87Branch)
  const a88Merge = mergeOf(a88Branch)
  const a89Merge = mergeOf(a89Branch)
  const crgbMerge = mergeOf(crgbBranch)
  const crgMerge = mergeOf(crgBranch)
  const typesAt = (module: string, ref = 'HEAD') => committedText(`backend/src/modules/${module}/${module}.types.ts`, ref)
  const serviceCodeAt = (module: string, ref = 'HEAD') => committedCode(`backend/src/modules/${module}/${module}.service.ts`, ref)
  check(
    'T001',
    'A8.9 FINAL PASS merge ancestor of main',
    A89_MERGE.length === 40 && a89Merge === A89_MERGE && onMainAndHead(a89Merge) && gitOk(`merge-base --is-ancestor ${A88_MERGE} ${A89_MERGE}`) && acceptedTree(A89_MERGE, A89_ACCEPTED_HEAD) &&
      gitOk('merge-base --is-ancestor origin/main HEAD'),
    A89_MERGE.length === 40
      ? `branch ${branch}; A8.9 merged as ${a89Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A89_MERGE.slice(0, 7)}, FINAL PASS), an ancestor of main and HEAD and a descendant of the A8.8 merge; its tree is exactly the accepted HEAD ${A89_ACCEPTED_HEAD.slice(0, 7)}; latest main ${shortMain} contained`
      : `the A8.9 merge is not recorded: A8.9 has no FINAL PASS merge on main yet (main ${shortMain}); A8.10 must not start`,
  )
  const escalationTypes = typesAt('exception-escalation')
  const escalationMachine = (text: string) => [
    (text.match(/export const escalationStates = \[[^\]]+\]/) ?? [''])[0],
    (text.match(/export const escalationEventCodes = \[[^\]]+\]/) ?? [''])[0],
    (text.match(/ESCALATION_CONTRACT_VERSION = '[^']+'/) ?? [''])[0],
  ]
  check(
    'T002',
    'A8.8 FINAL PASS merge; state machine frozen',
    a88Merge === A88_MERGE && onMainAndHead(a88Merge) && gitOk(`merge-base --is-ancestor ${A87_MERGE} ${A88_MERGE}`) && acceptedTree(A88_MERGE, A88_ACCEPTED_HEAD) &&
      escalationMachine(escalationTypes).every((s) => s.length > 0) && same(escalationMachine(escalationTypes), escalationMachine(typesAt('exception-escalation', A88_MERGE))) &&
      escalationTypes.includes(`'NO_ESCALATION', 'AWAITING_ACKNOWLEDGEMENT', 'FOLLOWUP_ACTIVE', 'RETURNED_TO_OWNER'`),
    `A8.8 merged as ${a88Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A88_MERGE.slice(0, 7)}), tree = accepted HEAD ${A88_ACCEPTED_HEAD.slice(0, 7)}; its states, event codes and contract literal at HEAD are byte-identical to its merge`,
  )
  const resolutionService = serviceCodeAt('exception-resolution')
  check(
    'T003',
    'A8.7 FINAL PASS merge; decision export known',
    a87Merge === A87_MERGE && onMainAndHead(a87Merge) && gitOk(`merge-base --is-ancestor ${A86_MERGE} ${A87_MERGE}`) && acceptedTree(A87_MERGE, A87_ACCEPTED_HEAD) &&
      /export async function getResolutionDispositionOf\(/.test(resolutionService) && /export async function getResolutionHistoryOf\(/.test(resolutionService) &&
      same(typesAt('exception-resolution'), typesAt('exception-resolution', A87_MERGE)),
    `A8.7 merged as ${a87Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A87_MERGE.slice(0, 7)}), tree = accepted HEAD ${A87_ACCEPTED_HEAD}; the decision is read through its own exports getResolutionDispositionOf and getResolutionHistoryOf; its types are byte-identical to its merge`,
  )
  const workTypes = typesAt('exception-remediation-work')
  check(
    'T004',
    'A8.6 FINAL PASS merge; report/verification known',
    a86Merge === A86_MERGE && onMainAndHead(a86Merge) && gitOk(`merge-base --is-ancestor ${A85_MERGE} ${A86_MERGE}`) && acceptedTree(A86_MERGE, A86_ACCEPTED_HEAD) &&
      ["'RECORD_WORK_REPORT'", "'VERIFY_WORK_REPORT'", "'EVIDENCE_SUPPORTED'", "'EVIDENCE_NOT_VERIFIED'", "'VERIFIED_INTERNAL_WORK'", "'NOT_VERIFIED'"].every((c) => workTypes.includes(c)) &&
      same(workTypes, typesAt('exception-remediation-work', A86_MERGE)),
    `A8.6 merged as ${a86Merge.slice(0, 7) || 'NOT FOUND'} (the register's ${A86_MERGE.slice(0, 7)}), tree = accepted HEAD ${A86_ACCEPTED_HEAD.slice(0, 7)}; a report is RECORD_WORK_REPORT and its separate verification VERIFY_WORK_REPORT (EVIDENCE_SUPPORTED or EVIDENCE_NOT_VERIFIED); its types are byte-identical to its merge`,
  )
  const registerAtHead = committedText(REGISTER_DOC)
  const registerFlat = registerAtHead.replace(/\s+/g, ' ')
  const a89Register = committedText(A89_REGISTER).replace(/\s+/g, ' ')
  const headTree = committedFiles('')
  const a84Paths = headTree.filter((path) => /(^|[\\/_-])a8[-_]?4([\\/_.-]|$)/i.test(path))
  const packageJson = JSON.parse(committedText('backend/package.json') || '{}') as { scripts?: Record<string, string> }
  check(
    'T005',
    'A8.4 closed as a duplicate of A8.3',
    a84Paths.length === 0 && !Object.keys(packageJson.scripts ?? {}).some((s) => /a8[-:_]?4\b/.test(s)) && (await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* 'a8_?4'`))[0].n === 0n &&
      registerFlat.includes('A8.4 was closed by the architecture owner on 2026-11-04 as a duplicate of A8.3') && a89Register.includes('closed the earlier A8.4 specification as a duplicate of A8.3'),
    a84Paths.length === 0 ? 'no A8.4 module, table, migration, route, suite or script exists; this register and the A8.9 register record the 2026-11-04 closure as a duplicate of A8.3' : `A8.4 paths exist: ${a84Paths.join(', ').slice(0, 200)}`,
  )
  const branchMerges = git('rev-list --merges origin/main..HEAD').split(/\r?\n/).filter(Boolean)
  check(
    'T006',
    'A8.5 and CRG-01B merges ancestors; no stacking',
    a85Merge === A85_MERGE && onMainAndHead(a85Merge) && crgbMerge === CRGB_MERGE && onMainAndHead(crgbMerge) && crgMerge.length === 40 && onMainAndHead(crgMerge) && branchMerges.length === 0 &&
      gitArgs(['merge-base', 'HEAD', 'origin/main']) === gitArgs(['rev-parse', 'origin/main']),
    `A8.5 merged as ${a85Merge.slice(0, 7) || 'NOT FOUND'}, Checkpoint B as ${crgbMerge.slice(0, 7) || 'NOT FOUND'} and Checkpoint A as ${crgMerge.slice(0, 7) || 'NOT FOUND'}, all ancestors of main and HEAD; the branch's merge base is origin/main itself and it holds no merge commit (nothing stacked)`,
  )
  const closureReducer = committedCode('backend/src/modules/exception-closure/exception-closure.reducer.ts')
  const closureMigration = committedText('backend/prisma/migrations/20261112090000_a8_9_exception_closure/migration.sql')
  check(
    'T007',
    'A8.9 CL-01 and A8.7/A8.8 states approved',
    a89Register.includes('**Architecture approval (2026-11-13).**') && a89Register.includes('| `RESOLVED_INTERNAL` | `RETURNED_TO_OWNER`, returned for `FOLLOWUP_RECORDED` | eligible (CL-01): basis `ESCALATION_RETURN`') &&
      a89Register.includes('| `RESOLVED_INTERNAL` | `RETURNED_TO_OWNER`, returned for `FURTHER_WORK_REQUIRED` | refused (CL-01, v1)') && a89Register.includes('| `RESOLVED_INTERNAL` | `NO_ESCALATION` | eligible: basis `RESOLUTION_DECISION`') &&
      /returnReasonCode === 'FOLLOWUP_RECORDED'/.test(closureReducer) && /escalation was returned for further work/.test(closureMigration) && escalationTypes.includes("'FOLLOWUP_RECORDED'") && escalationTypes.includes("'FURTHER_WORK_REQUIRED'") &&
      registerFlat.includes('CL-01 is resolved as the architecture owner approved it on 2026-11-13'),
    'the A8.9 register records the 2026-11-13 approval and its eligibility rows (RESOLVED_INTERNAL with NO_ESCALATION, or with a return for FOLLOWUP_RECORDED, eligible; a return for FURTHER_WORK_REQUIRED refused); the A8.9 reducer and DB guard hold the rule; both return reasons are A8.8 literals; both paths are exercised live below (W1, W4a, W4b)',
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  const branchCommits = git('rev-list origin/main..HEAD').split(/\r?\n/).filter(Boolean)
  check(
    'T008',
    'One clean branch from main, remote parity',
    branch === a810Branch && dirty.length === 0 && tracking.includes(`origin/${a810Branch}`) && !/ahead|behind/.test(tracking) && gitArgs(['merge-base', 'HEAD', 'origin/main']) === gitArgs(['rev-parse', 'origin/main']) &&
      branchCommits.length >= 1 && branchMerges.length === 0,
    dirty.length === 0 ? `branch ${branch}; working tree clean; ${tracking}; origin/main ${shortMain} is the merge base; ${branchCommits.length} commit(s) of this branch alone` : `uncommitted: ${dirty.length} path(s)`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file))
  const packageDiff = gitArgs(['diff', '-U0', 'origin/main...HEAD', '--', 'backend/package.json']).split(/\r?\n/).filter((l) => /^[+-](?![+-])/.test(l))
  const harnessFiles = changedPaths.filter((file) => file.startsWith(`${HARNESS_DIR}/`))
  const harnessCode = withoutRegexLiterals(harnessFiles.map((file) => committedCode(file)).join('\n'))
  // Any router (exceptionClosureRouter.post( included), a SERIALIZABLE writer, DDL, a permission or an audit write.
  const T009_SCAN = /[rR]outer\.(get|post|put|patch|delete)\(|prisma\.\$transaction\([^)]*Serializable|CREATE TABLE|permission\.create\(|auditEvent\.create\(/
  // Negative test on real committed code: the scan still catches the accepted A8.9 router and the DDL of its migration.
  const t009StillCatches = T009_SCAN.test(withoutRegexLiterals(committedCode('backend/src/modules/exception-closure/exception-closure.route.ts'))) &&
    T009_SCAN.test(withoutRegexLiterals(committedText('backend/prisma/migrations/20261112090000_a8_9_exception_closure/migration.sql')))
  check(
    'T009',
    'Diff: tests and docs only, no runtime',
    changedPaths.length > 0 && outOfScope.length === 0 && same(packageDiff.filter((l) => l.startsWith('-')), []) && packageDiff.filter((l) => l.startsWith('+')).length === 1 &&
      packageDiff.some((l) => l.replace(/^\+\s*/, '').replace(/,$/, '') === SCRIPT_LINE) && !changedPaths.some((p) => /^backend\/prisma\/|^backend\/src\/(modules|shared|scripts|jobs)\/|^backend\/src\/app\.ts$|^frontend\//.test(p)) &&
      !T009_SCAN.test(harnessCode) && t009StillCatches,
    outOfScope.length === 0
      ? `${changedPaths.length} path(s): the harness (${harnessFiles.length} file(s)), the register, exactly one added package.json line (${SCRIPT}) and the one disclosed earlier-harness correction with its record (${[CORRECTED_HARNESS, CORRECTIONS_DOC].filter((p) => changedPaths.includes(p)).length} of 2 path(s)); no migration, Prisma model, module, shared, script, route, permission, audit action, frontend or A9 path`
      : `unexpected: ${outOfScope.join(', ').slice(0, 300)}`,
  )
  // Every earlier owner, unchanged: every committed contract literal, error code, permission and audit code, every
  // migration's bytes, and the checksum the database recorded for each applied migration.
  const contractConstantsAt = (ref: string) =>
    gitArgs(['ls-tree', '-r', '--name-only', '--full-tree', ref, 'backend/src/modules'])
      .split(/\r?\n/)
      .filter((path) => /\.types\.ts$/.test(path))
      .flatMap((path) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(/export const ([A-Z_0-9]*CONTRACT_VERSION[A-Z_0-9]*) = '([^']+)'/g)].map((m) => `${path}:${m[1]}=${m[2]}`))
      .sort()
  const listAt = (ref: string, path: string, pattern: RegExp) => [...gitArgs(['show', `${ref}:${path}`]).matchAll(pattern)].map((m) => m[1])
  const errorsAt = (ref: string) => listAt(ref, 'backend/src/shared/errors/error.types.ts', /^\s+'([A-Z_]+)',/gm)
  const permissionsAt = (ref: string) => listAt(ref, 'backend/src/shared/authorization/authorization.types.ts', /^\s+'([A-Za-z_]+\.[A-Za-z_]+)',/gm)
  const auditsAt = (ref: string) => listAt(ref, 'backend/src/modules/audit/audit.types.ts', /^\s+'([a-z_]+\.[a-z_]+)',/gm)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const migrationDirs = migrationDirsAt('HEAD')
  const migrationBytes = (ref: string) => sha256Of(Buffer.from(migrationDirsAt(ref).map((dir) => gitArgs(['show', `${ref}:${dir}/migration.sql`])).join('\n')))
  const appliedChecksums = await prisma.$queryRawUnsafe<{ migration_name: string; checksum: string }[]>(`SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)
  // As the accepted A8.9 suite judges it: the raw committed blob, or the bytes on disk (line endings as checked out).
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = migrationDirs.filter((dir) => {
    const name = dir.split('/').pop() as string
    const applied = appliedChecksums.find((row) => row.migration_name === name)
    const blob = committedBlob(`${dir}/migration.sql`)
    const onDisk = `prisma/migrations/${name}/migration.sql`
    return !applied || !((blob.length > 0 && sha256Of(blob) === applied.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === applied.checksum))
  })
  const contractsHead = contractConstantsAt('HEAD')
  const correctedLines = committedText(CORRECTED_HARNESS).split('\n')
  const reviewStart = correctedLines.findIndex((line) => line.includes('review of the four bundled A7 harness corrections')) + 1
  const reviewEnd = correctedLines.findIndex((line) => line.includes("check('CRG-126'")) + 1
  const correctionHunks = gitArgs(['diff', '-U0', 'origin/main...HEAD', '--', CORRECTED_HARNESS])
    .split(/\r?\n/)
    .map((line) => line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ from: Number(m[1]), to: Number(m[1]) + Math.max(Number(m[2] ?? '1'), 1) - 1 }))
  const V1_TERMS = ["same(r.excluded, ['crg_release_imports'])", 'r.stillJudged.length === 0', 'caught.includes(probeTable)', "createdAfter(r.merge).includes('crg_release_imports')"]
  const correctionBounded = reviewStart > 0 && reviewEnd > reviewStart && correctionHunks.every((h) => h.from > reviewStart && h.to < reviewEnd) && V1_TERMS.every((term) => correctedLines.join('\n').includes(term))
  check(
    'T010',
    'Earlier owners, literals and migrations unchanged',
    contractsHead.length >= 25 && same(contractsHead, contractConstantsAt('origin/main')) && same(errorsAt('HEAD'), errorsAt('origin/main')) && same(permissionsAt('HEAD'), permissionsAt('origin/main')) &&
      same(auditsAt('HEAD'), auditsAt('origin/main')) && same(migrationDirs, migrationDirsAt('origin/main')) && migrationBytes('HEAD') === migrationBytes('origin/main') && checksumMismatch.length === 0 &&
      appliedChecksums.length === migrationDirs.length && OWNERS.every((o) => typesAt(o.module).includes(`${o.constant} = '${o.contract}'`)) && correctionBounded,
    checksumMismatch.length === 0
      ? `all ${contractsHead.length} owner contract literals, ${errorsAt('HEAD').length} error codes, ${permissionsAt('HEAD').length} permissions and ${auditsAt('HEAD').length} audit codes identical to main; all ${migrationDirs.length} migrations byte-identical to main and each applied checksum equals its committed file; every A8 owner literal (${OWNERS.map((o) => o.contract).join(', ')}) as accepted; the one corrected earlier harness (CRG-01A, ${correctionHunks.length} hunk(s)) changes only inside CRG-G08's review block (lines ${reviewStart}–${reviewEnd}) and keeps every V1 term`
      : `checksum differs or not applied: ${checksumMismatch.join(', ').slice(0, 300)}`,
  )

  // ---------------------------------------------------------------- members, sign-in and owner builders
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
  const answers: { path: string; status: number; body: unknown }[] = []
  const api = async (method: string, path: string, body?: unknown, who: Who = asAdmin) => {
    const res = await httpCall(path, who(body === undefined ? { method } : { method, body: JSON.stringify(body) }))
    if (res.status >= 500) serverErrors += 1
    if (res.status >= 400) answers.push({ path, status: res.status, body: res.body })
    return { status: res.status, body: res.body as any }
  }
  const post = (path: string, body: unknown, who: Who = asAdmin) => api('POST', path, body, who)
  const get = (path: string, who: Who = asAdmin) => api('GET', path, undefined, who)
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`

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
    return { id: user.id as string, email, membershipId: membership.id as string, who: as(signed.cookie) }
  }
  // B approves the A6 freezes. M1 carries W1 (assignee, investigator, proposer, reporter, resolution requester); M4 carries
  // every other home intake; M5 is the reassignment target of the stale-actor proof. RV reviews A8.5 proposals, VR
  // verifies A8.6 reports, DR decides A8.7 requests, T is the A8.8 nominee and RW its reviewer, CF confirms A8.9
  // closures and CF2 competes with it; CF3 loses its role while its closure holds the Claim. NR has no role; PT holds a
  // synthetic role this run narrows one permission at a time. O, O2, O3 and O4 are Org B's assignee, reviewer, verifier
  // and decider; OC is Org B's confirmer.
  const B = await provisionMember('b')
  const M1 = await provisionMember('m1')
  const M4 = await provisionMember('m4')
  const M5 = await provisionMember('m5')
  const RV = await provisionMember('rv')
  const VR = await provisionMember('vr')
  const DR = await provisionMember('dr')
  const T = await provisionMember('t')
  const RW = await provisionMember('rw')
  const CF = await provisionMember('cf')
  const CF2 = await provisionMember('cf2')
  const CF3 = await provisionMember('cf3')
  const NR = await provisionMember('norole', org, false)
  const PT = await provisionMember('partial', org, false)
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)
  const O3 = await provisionMember('o3', otherOrg)
  const O4 = await provisionMember('o4', otherOrg)
  const OC = await provisionMember('oc', otherOrg)

  // ---------------------------------------------------------------- synthetic worlds and A6 freezes (A6 owners)
  section('Synthetic worlds through the accepted owners: two organizations, A6 Claims frozen twice without an A6.9 link (the A7.7 contradiction that is the A8.1 basis), and every A8 owner position W1–W6 and the adversarial proofs need')
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
      return { claimId: claim.id as string, freezes, patientFamilyName: `${runId}-${label}-P` }
    }
    return { series, patientFamilyName: `${runId}-${label}-P`, diagnosisName: `${runId} ${label} diagnosis A` }
  }
  const home = await tenantWorld('home', org, asAdmin, creatorId, B.who)
  const away = await tenantWorld('away', otherOrg, O.who, O.id, O2.who)
  const timelineBody = (claimId: string) => ({ sourceKind: 'REVENUE_TIMELINE', sourceRecordId: claimId, sourceContractVersion: TIMELINE_CONTRACT, exceptionReasonCode: 'PROVENANCE_CONFLICT' })
  type Intake = { label: string; claimId: string; intakeId: string; organizationId: string; freezes: string[]; basisCode: string; basisRecordId: string; status: number }
  const intakeFor = async (label: string, world = home, who: Who = asAdmin): Promise<Intake> => {
    const claim = await world.series(label, 2)
    const res = await post(`/api/claims/${claim.claimId}/exception-intake`, timelineBody(claim.claimId), who)
    if (res.status !== 201) throw new Error(`fixture ${label}: the A8.1 intake was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return { label, claimId: claim.claimId, intakeId: res.body.exceptionIntakeId, organizationId: res.body.organizationId, freezes: claim.freezes, basisCode: res.body.basisCode, basisRecordId: res.body.basisRecordId, status: res.status }
  }
  const base = (k: { claimId: string; intakeId: string }) => `/api/claims/${k.claimId}/exceptions/${k.intakeId}`
  // Each owner's write route, exactly as its own suite calls it; `step` fails the run when a fixture step is refused.
  const ROUTE = { triage: 'triage-events', investigation: 'investigation-events', remediation: 'remediation-events', work: 'remediation-work-events', resolution: 'resolution-events', escalation: 'escalation-events', closure: 'closure-events' } as const
  type Owner = keyof typeof ROUTE
  const ID_KEY = { triage: 'triageEventId', investigation: 'investigationEventId', remediation: 'remediationEventId', work: 'workEventId', resolution: 'resolutionEventId', escalation: 'escalationEventId', closure: 'closureEventId' } as const
  const write = (owner: Owner, k: { claimId: string; intakeId: string }, body: unknown, who: Who) => post(`${base(k)}/${ROUTE[owner]}`, body, who)
  const step = async (owner: Owner, k: Intake, body: unknown, who: Who) => {
    const res = await write(owner, k, body, who)
    if (res.status !== 201) throw new Error(`fixture ${k.label}: the ${owner} event ${JSON.stringify(body)} was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body[ID_KEY[owner]] as string
  }
  const classify = { eventCode: 'TRIAGE_CLASSIFY', categoryCode: 'PROVENANCE_INTEGRITY', priorityCode: 'ELEVATED' }
  const assignTo = (member: { membershipId: string }) => ({ eventCode: 'ASSIGN_OWNER', assignedMemberId: member.membershipId })
  const reassignTo = (member: { membershipId: string }) => ({ eventCode: 'REASSIGN_OWNER', assignedMemberId: member.membershipId })
  const linkOf = (k: Intake) => ({ eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS', evidenceRecordId: k.basisRecordId, evidenceContractVersion: INTAKE_CONTRACT })
  const findingOf = (linkedEvidenceEventId: string) => ({ eventCode: 'RECORD_FINDING', linkedEvidenceEventId, findingCode: 'FURTHER_REVIEW_REQUIRED' })
  const ACTION = 'REQUEST_INTERNAL_DOCUMENTATION_CHECK'
  const proposeOf = (findingEventId: string) => ({ eventCode: 'PROPOSE_ACTION', actionCode: ACTION, findingEventId, rationaleCode: 'INSUFFICIENT_EVIDENCE' })
  const approveOf = (proposalEventId: string) => ({ eventCode: 'REVIEW_ACTION', proposalEventId, decisionCode: 'APPROVE_PROPOSAL' })
  const returnProposalOf = (proposalEventId: string) => ({ eventCode: 'REVIEW_ACTION', proposalEventId, decisionCode: 'RETURN_PROPOSAL', reviewReasonCode: 'NEEDS_MORE_INVESTIGATION' })
  const WORK_CODE = WORK_CODE_OF_ACTION[ACTION]
  const reportOf = (approvedProposalEventId: string, findingId: string) => ({ eventCode: 'RECORD_WORK_REPORT', approvedProposalEventId, workCode: WORK_CODE, basisReferenceKind: 'INVESTIGATION_FINDING', basisReferenceId: findingId })
  const verifyOf = (workReportEventId: string) => ({ eventCode: 'VERIFY_WORK_REPORT', workReportEventId, verificationCode: 'EVIDENCE_SUPPORTED' })
  const notVerifiedOf = (workReportEventId: string) => ({ eventCode: 'VERIFY_WORK_REPORT', workReportEventId, verificationCode: 'EVIDENCE_NOT_VERIFIED', reasonCode: 'INSUFFICIENT_SUPPORT' })
  const requestOf = (verificationEventId: string) => ({ eventCode: 'REQUEST_INTERNAL_RESOLUTION', verificationEventId, reasonCode: 'VERIFIED_INTERNAL_WORK' })
  const confirmOf = (requestEventId: string) => ({ eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId, decisionCode: 'CONFIRM_INTERNAL_RESOLUTION' })
  const reworkOf = (requestEventId: string) => ({ eventCode: 'DECIDE_INTERNAL_RESOLUTION', requestEventId, decisionCode: 'RETURN_FOR_REWORK', returnReasonCode: 'ADDITIONAL_WORK_REQUIRED' })
  const escalateOf = (member: { membershipId: string }) => ({ eventCode: 'ESCALATE_FOR_REVIEW', reasonCode: 'NEEDS_SUPERVISOR_REVIEW', targetMemberId: member.membershipId })
  const ackOf = (escalationEventId: string) => ({ eventCode: 'ACKNOWLEDGE_ESCALATION', escalationEventId })
  const followupOf = (acknowledgementEventId: string, sourceEventId: string) => ({ eventCode: 'RECORD_FOLLOWUP', acknowledgementEventId, followupCode: 'SOURCE_RECHECK_RECORDED', sourceEventId })
  const returnOf = (escalationEventId: string, returnReasonCode = 'FOLLOWUP_RECORDED') => ({ eventCode: 'RETURN_TO_OWNER', escalationEventId, returnReasonCode })
  const REASON = { RESOLUTION_DECISION: 'VERIFIED_INTERNAL_RESOLUTION', ESCALATION_RETURN: 'TERMINAL_FOLLOWUP_REVIEWED' } as const
  type Kind = keyof typeof REASON
  const closeBody = (decisionId: string, kind: Kind = 'RESOLUTION_DECISION', basisId: string = decisionId) => ({
    eventCode: 'CONFIRM_INTERNAL_CLOSURE', resolutionDecisionEventId: decisionId, closureReasonCode: REASON[kind], basisReferenceKind: kind, basisReferenceId: basisId,
  })

  // Every id each owner recorded for an intake, as the owner answered it (the lineage W1 and the reconstruction compare).
  type Lineage = {
    classifyId?: string; assignId?: string; linkId?: string; findingId?: string; proposalId?: string; reviewId?: string; reportId?: string; verificationId?: string; requestId?: string; decisionId?: string
    escalationId?: string; ackId?: string; followupId?: string; returnId?: string; closureId?: string
  }
  const lineage = new Map<string, Lineage>()
  const L = (k: Intake) => {
    if (!lineage.has(k.intakeId)) lineage.set(k.intakeId, {})
    return lineage.get(k.intakeId) as Lineage
  }
  type Stage = 'TRIAGED' | 'ASSIGNED' | 'INVESTIGATED' | 'PROPOSED' | 'APPROVED' | 'RETURNED_PROPOSAL' | 'REPORTED' | 'VERIFIED' | 'NOT_VERIFIED' | 'REQUESTED' | 'RESOLVED' | 'REWORK'
  const ORDER: Stage[] = ['TRIAGED', 'ASSIGNED', 'INVESTIGATED', 'PROPOSED', 'APPROVED', 'REPORTED', 'VERIFIED', 'REQUESTED', 'RESOLVED']
  // Carries intake `k` through the accepted owners from where it stands up to `stage`, every event by the member each
  // owner requires.
  const reachedAt = new Map<string, number>()
  const advance = async (k: Intake, stage: Stage, owner = { assignee: M4, reviewer: RV, verifier: VR, decider: DR }) => {
    const l = L(k)
    const target = ORDER.indexOf(stage === 'RETURNED_PROPOSAL' ? 'PROPOSED' : stage === 'NOT_VERIFIED' ? 'REPORTED' : stage === 'REWORK' ? 'REQUESTED' : stage)
    const from = reachedAt.get(k.intakeId) ?? -1
    const upTo = (s: Stage) => ORDER.indexOf(s) > from && ORDER.indexOf(s) <= target
    reachedAt.set(k.intakeId, target)
    const admin = k.organizationId === org ? asAdmin : O.who
    if (upTo('TRIAGED')) l.classifyId = await step('triage', k, classify, admin)
    if (upTo('ASSIGNED')) l.assignId = await step('triage', k, assignTo(owner.assignee), admin)
    if (upTo('INVESTIGATED')) {
      l.linkId = await step('investigation', k, linkOf(k), owner.assignee.who)
      l.findingId = await step('investigation', k, findingOf(l.linkId), owner.assignee.who)
    }
    if (upTo('PROPOSED')) l.proposalId = await step('remediation', k, proposeOf(l.findingId as string), owner.assignee.who)
    if (stage === 'RETURNED_PROPOSAL') l.reviewId = await step('remediation', k, returnProposalOf(l.proposalId as string), owner.reviewer.who)
    if (upTo('APPROVED')) l.reviewId = await step('remediation', k, approveOf(l.proposalId as string), owner.reviewer.who)
    if (upTo('REPORTED')) l.reportId = await step('work', k, reportOf(l.proposalId as string, l.findingId as string), owner.assignee.who)
    if (stage === 'NOT_VERIFIED') l.verificationId = await step('work', k, notVerifiedOf(l.reportId as string), owner.verifier.who)
    if (upTo('VERIFIED')) l.verificationId = await step('work', k, verifyOf(l.reportId as string), owner.verifier.who)
    if (upTo('REQUESTED')) l.requestId = await step('resolution', k, requestOf(l.verificationId as string), owner.assignee.who)
    if (stage === 'REWORK') l.decisionId = await step('resolution', k, reworkOf(l.requestId as string), owner.decider.who)
    if (upTo('RESOLVED')) l.decisionId = await step('resolution', k, confirmOf(l.requestId as string), owner.decider.who)
    return l
  }
  const escalate = async (k: Intake, upTo: 'AWAITING' | 'ACTIVE' | 'RETURNED', returnReasonCode = 'FOLLOWUP_RECORDED', assignee = M4) => {
    const l = L(k)
    l.escalationId = await step('escalation', k, escalateOf(T), assignee.who)
    if (upTo === 'AWAITING') return l
    l.ackId = await step('escalation', k, ackOf(l.escalationId), T.who)
    l.followupId = await step('escalation', k, followupOf(l.ackId, l.findingId as string), T.who)
    if (upTo === 'RETURNED') l.returnId = await step('escalation', k, returnOf(l.escalationId, returnReasonCode), RW.who)
    return l
  }
  // The one lawful closure of an intake: on its A8.7 confirmation, or on its A8.8 return when it was escalated and returned.
  const closeOf = (k: Intake) => {
    const l = L(k)
    return l.returnId ? closeBody(l.decisionId as string, 'ESCALATION_RETURN', l.returnId) : closeBody(l.decisionId ?? MISSING)
  }

  // W1 — the clean terminal exception, carried through every owner by M1 (T021–T030). W2 — work not verified. W3a and
  // W3b — escalation awaiting acknowledgement and with follow-ups active (CL-02). W4a and W4b — returned for
  // FOLLOWUP_RECORDED (CL-01 eligible) and for FURTHER_WORK_REQUIRED (refused in v1). W5 — a Claim with no intake (its
  // Claim only). W6 — Org B's resolved intake F, and Org B's members against Org A's W1.
  // Adversarial positions: UN untriaged, UA classified but unassigned, NF assigned without a finding, PP a pending A8.5
  // proposal, RP a returned A8.5 proposal, N0 verified work with no A8.7 request, PD an A8.7 request awaiting its
  // decision, RK returned for rework. Races and write-time rejudging: R6 (identical A8.6 reports), V6 (competing A8.6
  // verifications), D7 (competing A8.7 decisions), E8 (competing A8.8 events), C9 (competing A8.9 closures), SA (an A8.6
  // report while M4 is reassigned to M5), PR (an A8.9 closure while CF3's role is removed). S is the direct-SQL target and
  // SD (an A8.7 request awaiting its decision) the direct self-decision probe.
  const W1 = await intakeFor('w1-terminal')
  const W2 = await intakeFor('w2-not-verified')
  const W3A = await intakeFor('w3a-awaiting')
  const W3B = await intakeFor('w3b-active')
  const W4A = await intakeFor('w4a-followup-recorded')
  const W4B = await intakeFor('w4b-further-work')
  const W5 = await home.series('w5-no-intake', 2)
  const F = await intakeFor('w6-foreign', away, O.who)
  const UN = await intakeFor('untriaged')
  const UA = await intakeFor('unassigned')
  const NF = await intakeFor('no-finding')
  const PP = await intakeFor('pending-plan')
  const RP = await intakeFor('returned-plan')
  const N0 = await intakeFor('no-request')
  const PD = await intakeFor('pending-decision')
  const RK = await intakeFor('rework')
  const R6 = await intakeFor('race-report')
  const V6 = await intakeFor('race-verify')
  const D7 = await intakeFor('race-decide')
  const E8 = await intakeFor('race-escalate')
  const C9 = await intakeFor('race-close')
  const SA = await intakeFor('stale-actor')
  const PR = await intakeFor('permission-removed')
  const S = await intakeFor('sql')
  const SD = await intakeFor('self-decide')
  const EQ = await intakeFor('escalation-sequence')
  const homeIntakes = [W1, W2, W3A, W3B, W4A, W4B, UN, UA, NF, PP, RP, N0, PD, RK, R6, V6, D7, E8, C9, SA, PR, S, SD, EQ]
  const runIntakes = [...homeIntakes, F]
  const runClaims = [...homeIntakes.map((k) => k.claimId), W5.claimId]

  // W1 — every step through its owner, each answer kept (T021–T030).
  const w1Steps: { owner: string; status: number; id: string }[] = []
  const w1Step = async (owner: Owner, body: unknown, who: Who, field: keyof Lineage) => {
    const res = await write(owner, W1, body, who)
    const id = res.body?.[ID_KEY[owner]] as string
    w1Steps.push({ owner, status: res.status, id })
    if (res.status === 201) L(W1)[field] = id
    return res
  }
  const w1Classify = await w1Step('triage', classify, asAdmin, 'classifyId')
  const w1Assign = await w1Step('triage', assignTo(M1), asAdmin, 'assignId')
  const w1Link = await w1Step('investigation', linkOf(W1), M1.who, 'linkId')
  const w1Finding = await w1Step('investigation', findingOf(L(W1).linkId as string), M1.who, 'findingId')
  const w1Propose = await w1Step('remediation', proposeOf(L(W1).findingId as string), M1.who, 'proposalId')
  const w1Approve = await w1Step('remediation', approveOf(L(W1).proposalId as string), RV.who, 'reviewId')
  const w1Report = await w1Step('work', reportOf(L(W1).proposalId as string, L(W1).findingId as string), M1.who, 'reportId')
  const w1Verify = await w1Step('work', verifyOf(L(W1).reportId as string), VR.who, 'verificationId')
  const w1Request = await w1Step('resolution', requestOf(L(W1).verificationId as string), M1.who, 'requestId')
  const w1Decide = await w1Step('resolution', confirmOf(L(W1).requestId as string), DR.who, 'decisionId')
  if (w1Steps.some((s) => s.status !== 201)) throw new Error(`fixture W1: a step was refused (${w1Steps.map((s) => `${s.owner} ${s.status}`).join(', ')})`)

  // The other positions, each through its owners.
  await advance(W2, 'NOT_VERIFIED')
  for (const k of [W3A, W3B, W4A, W4B]) await advance(k, 'VERIFIED')
  await escalate(W3A, 'AWAITING')
  await escalate(W3B, 'ACTIVE')
  await escalate(W4A, 'RETURNED', 'FOLLOWUP_RECORDED')
  await escalate(W4B, 'RETURNED', 'FURTHER_WORK_REQUIRED')
  for (const k of [W3A, W3B, W4A, W4B]) await advance(k, 'RESOLVED')
  await advance(F, 'RESOLVED', { assignee: O, reviewer: O2, verifier: O3, decider: O4 })
  await advance(UA, 'TRIAGED')
  await advance(NF, 'ASSIGNED')
  await advance(PP, 'PROPOSED')
  await advance(RP, 'RETURNED_PROPOSAL')
  await advance(N0, 'VERIFIED')
  await advance(PD, 'REQUESTED')
  await advance(RK, 'REWORK')
  await advance(R6, 'APPROVED')
  await advance(V6, 'REPORTED')
  await advance(D7, 'REQUESTED')
  await advance(E8, 'VERIFIED')
  for (const k of [C9, PR, S]) await advance(k, 'RESOLVED')
  await advance(SA, 'APPROVED')
  await advance(SD, 'REQUESTED')
  await advance(EQ, 'VERIFIED')
  await escalate(EQ, 'AWAITING')
  progress(
    `fixtures ready: two synthetic AE-DU/DHA worlds; ${homeIntakes.length} A8.1 intakes on contradicted Claims in Org A (basis ${W1.basisCode}) plus W5's Claim with no intake, and F in Org B; W1 carried through A8.2–A8.7 by M1 (${w1Steps.length} owner events, all 201); W2 NOT_VERIFIED; W3a AWAITING_ACKNOWLEDGEMENT and W3b FOLLOWUP_ACTIVE, then RESOLVED_INTERNAL; W4a returned for FOLLOWUP_RECORDED and W4b for FURTHER_WORK_REQUIRED, then RESOLVED_INTERNAL; UN untriaged, UA unassigned, NF without a finding, PP pending and RP returned A8.5 proposals, N0 without a request, PD awaiting a decision, RK returned for rework; R6, V6, D7, E8, C9, SA and PR staged for the races and the write-time proofs`,
  )
  // ---------------------------------------------------------------- DB helpers (read-only, or always rolled back)
  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const tableCounts = async (tables: string[]) => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(`${tables.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL ')} ORDER BY t`)
    return JSON.stringify(rows.map((row) => [row.t, Number(row.n)]))
  }
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const ownerRowsHash = (table: string, intakeIds: string[]) =>
    hashOf(table === INTAKE_TABLE ? `SELECT t.* FROM ${table} t WHERE t.id = ANY($1::uuid[])` : `SELECT t.* FROM ${table} t WHERE t.exception_intake_id = ANY($1::uuid[])`, intakeIds)
  const a8Hashes = async (intakeIds: string[]) => Object.fromEntries(await Promise.all(A8_TABLES.map(async (table) => [table, await ownerRowsHash(table, intakeIds)] as const)))
  const auditHash = (intakeIds: string[], actions: string[]) =>
    hashOf(`SELECT a.id, a.action_code, a.entity_type, a.entity_id, a.actor_user_id, a.after_state, a.occurred_at FROM audit_events a WHERE a.action_code = ANY($2::text[]) AND (a.entity_id = ANY($1::uuid[]) OR a.after_state->>'exceptionIntakeId' = ANY($1::text[]))`, intakeIds, actions)
  const A8_AUDIT_ACTIONS = [
    'exception_intake.recorded', 'exception_triage.recorded', 'exception_investigation.recorded', 'exception_remediation.recorded', 'exception_remediation_work.recorded', 'exception_resolution.recorded',
    'exception_escalation.recorded', 'exception_closure.recorded',
  ]
  const NOT_COMMITTED = 'ROLLED_BACK'
  // A rolled-back transaction: the mutation runs, its outcome is captured, then everything is undone; every counted table
  // must read back exactly.
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
  // A copy of an intake's newest event in `table` planted with the triggers off (and DDL first, where named), with some
  // columns overridden; the production A8.9 reconstruction answers on THAT transaction, then everything rolls back.
  const plantCopy = (table: string, k: Intake, overrides: string) => (tx: DbClient) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(t) || jsonb_build_object('id', gen_random_uuid(), 'sequence', t.sequence + 1${overrides}))).* FROM ${table} t WHERE t.exception_intake_id = $1::uuid ORDER BY t.sequence DESC LIMIT 1`,
      k.intakeId,
    )
  const plantedReconstruction = async (k: Intake, plant: (tx: DbClient) => Promise<unknown>, ddl?: string) =>
    rolledBack(async (tx) => {
      if (ddl) await tx.$executeRawUnsafe(ddl)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await plant(tx)
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
      return { history: await getClosureHistoryOf(k.claimId, k.intakeId, tx), reconstruction: await getClosureReconstructionOf(k.claimId, k.intakeId, tx) }
    })
  // The A6 and A7 records and the CRG and code-master tables of the run, hashed (W8, T048).
  const snap = async () => ({
    freezes: await hashOf(`SELECT f.*, m.id AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    lifecycle: await hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    links: await hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    claims: await hashOf(`SELECT c.* FROM claims c WHERE c.id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    encounters: await hashOf(`SELECT e.* FROM encounters e JOIN claims c ON c.encounter_id = e.id WHERE c.id = ANY($1::uuid[])`, [...runClaims, F.claimId]),
    a7: await tableCounts(A7_TABLES),
    coding: await tableCounts(CODING_TABLES),
  })
  // Every owner read route of an intake, in workflow order (the A8 owner DTOs).
  const ownerReads = (k: { claimId: string; intakeId: string }) => [
    `/api/claims/${k.claimId}/exception-intake`, `${base(k)}/triage-history`, `${base(k)}/triage-disposition`, `${base(k)}/investigation-history`, `${base(k)}/investigation-summary`,
    `${base(k)}/remediation-history`, `${base(k)}/remediation-disposition`, `${base(k)}/remediation-work-history`, `${base(k)}/remediation-work-disposition`, `${base(k)}/resolution-history`,
    `${base(k)}/resolution-disposition`, `${base(k)}/escalation-history`, `${base(k)}/escalation-disposition`, `${base(k)}/closure-history`, `${base(k)}/closure-reconstruction`,
  ]
  const readAll = async (k: { claimId: string; intakeId: string }, who: Who = asAdmin) => {
    const out: Record<string, { status: number; body: any }> = {}
    for (const path of ownerReads(k)) out[path.split('/').pop() as string] = await get(path, who)
    return out
  }
  const dtoText = (reads: Record<string, { body: any }>, omit: string[] = []) =>
    JSON.stringify(Object.fromEntries(Object.entries(reads).filter(([name]) => !omit.includes(name)).map(([name, r]) => [name, JSON.parse(withoutEvaluatedAt(r.body))])))

  // ---------------------------------------------------------------- before the closures: owner state of the run
  const snapBefore = await snap()
  const homeIds = homeIntakes.map((k) => k.intakeId)
  const w1Before = await readAll(W1)
  const a8Before = await a8Hashes([W1.intakeId, W4A.intakeId])
  const auditsBefore = await auditHash([W1.intakeId, W4A.intakeId], A8_AUDIT_ACTIONS.slice(0, 7))

  // ---------------------------------------------------------------- owner contract and workflow boundaries (T011–T020)
  section('Owner contract and workflow boundaries: W1 read stage by stage through each accepted owner only; no A8.10 runtime; every contract literal on every DTO is the owner\'s own, and an unknown stored version refuses')
  const intakeRead = w1Before['exception-intake'].body
  const intakeItem = (intakeRead?.items ?? []).find((i: any) => i.exceptionIntakeId === W1.intakeId)
  const intakeRow = await prisma.$queryRawUnsafe<{ claim_id: string; organization_id: string; basis_code: string; basis_record_id: string }[]>(`SELECT claim_id::text, organization_id::text, basis_code, basis_record_id::text FROM ${INTAKE_TABLE} WHERE id = $1::uuid`, W1.intakeId)
  check(
    'T011',
    'A8.1 intake and exact basis from A8.1 only',
    w1Before['exception-intake'].status === 200 && intakeItem?.claimId === W1.claimId && intakeItem?.organizationId === org && intakeItem?.basisCode === W1.basisCode && intakeItem?.basisRecordId === W1.basisRecordId &&
      intakeItem?.contractVersion === 'A8-EXCEPTION-INTAKE-1' && intakeRow.length === 1 && intakeRow[0].claim_id === W1.claimId && intakeRow[0].organization_id === org && intakeRow[0].basis_record_id === W1.basisRecordId,
    `W1's intake ${W1.intakeId.slice(0, 8)} read through GET exception-intake (A8.1): Claim ${W1.claimId.slice(0, 8)}, Org A, basis ${W1.basisCode} ${W1.basisRecordId.slice(0, 8)} (the A6.7 freeze contradiction), A8-EXCEPTION-INTAKE-1 — exactly the stored record`,
  )
  const itemsOf = (name: string) => (w1Before[name]?.body?.items ?? []) as any[]
  const triageItems = itemsOf('triage-history')
  check(
    'T012',
    'A8.2 assignment and triage chain from A8.2 only',
    w1Before['triage-history'].status === 200 && same(triageItems.map((e) => [e.sequence, e.eventCode]), [[1, 'TRIAGE_CLASSIFY'], [2, 'ASSIGN_OWNER']]) &&
      triageItems[0].triageEventId === L(W1).classifyId && triageItems[1].triageEventId === L(W1).assignId && triageItems[1].assignedMemberId === M1.membershipId &&
      w1Before['triage-disposition'].body?.dispositionCode === 'ASSIGNED' && w1Before['triage-disposition'].body?.assignedMemberId === M1.membershipId,
    `GET triage-history: 1 TRIAGE_CLASSIFY, 2 ASSIGN_OWNER to M1 (the ids the A8.2 route answered); GET triage-disposition: ASSIGNED to M1's membership`,
  )
  const invItems = itemsOf('investigation-history')
  check(
    'T013',
    'A8.3 finding and typed evidence from A8.3 only',
    w1Before['investigation-history'].status === 200 && same(invItems.map((e) => e.eventCode), ['LINK_EVIDENCE_REFERENCE', 'RECORD_FINDING']) && invItems[0].investigationEventId === L(W1).linkId &&
      invItems[0].evidenceKind === 'INTAKE_BASIS' && invItems[0].evidenceRecordId === W1.basisRecordId && invItems[1].investigationEventId === L(W1).findingId && invItems[1].linkedEvidenceEventId === L(W1).linkId &&
      w1Before['investigation-summary'].body?.investigationCode === 'FINDING_RECORDED',
    'GET investigation-history: the INTAKE_BASIS link to the A8.1 basis record, then the finding naming that link; GET investigation-summary: FINDING_RECORDED',
  )
  const remItems = itemsOf('remediation-history')
  check(
    'T014',
    'A8.5 proposal and independent approval from A8.5',
    w1Before['remediation-history'].status === 200 && same(remItems.map((e) => e.eventCode), ['PROPOSE_ACTION', 'REVIEW_ACTION']) && remItems[0].remediationEventId === L(W1).proposalId &&
      remItems[0].findingEventId === L(W1).findingId && remItems[1].decisionCode === 'APPROVE_PROPOSAL' && remItems[1].proposalEventId === L(W1).proposalId &&
      remItems[1].recordedByMembershipId === RV.membershipId && remItems[0].recordedByMembershipId === M1.membershipId && w1Before['remediation-disposition'].body?.state === 'APPROVED_FOR_PLANNING',
    'GET remediation-history: M1 proposed on the A8.3 finding and RV (another member) approved it; GET remediation-disposition: APPROVED_FOR_PLANNING (planning only)',
  )
  const workItems = itemsOf('remediation-work-history')
  check(
    'T015',
    'A8.6 report and separate verification from A8.6',
    w1Before['remediation-work-history'].status === 200 && same(workItems.map((e) => e.eventCode), ['RECORD_WORK_REPORT', 'VERIFY_WORK_REPORT']) && workItems[0].workEventId === L(W1).reportId &&
      workItems[0].approvedProposalEventId === L(W1).proposalId && workItems[0].basisReferenceId === L(W1).findingId && workItems[1].verificationCode === 'EVIDENCE_SUPPORTED' &&
      workItems[1].recordedByMembershipId === VR.membershipId && workItems[0].recordedByMembershipId === M1.membershipId && w1Before['remediation-work-disposition'].body?.state === 'VERIFIED_INTERNAL_WORK',
    'GET remediation-work-history: M1 reported the work on the approved plan citing the finding, VR verified it EVIDENCE_SUPPORTED as a separate event; GET remediation-work-disposition: VERIFIED_INTERNAL_WORK',
  )
  const resItems = itemsOf('resolution-history')
  check(
    'T016',
    'A8.7 request and decision from A8.7 only',
    w1Before['resolution-history'].status === 200 && same(resItems.map((e) => e.eventCode), ['REQUEST_INTERNAL_RESOLUTION', 'DECIDE_INTERNAL_RESOLUTION']) && resItems[0].resolutionEventId === L(W1).requestId &&
      resItems[0].verificationEventId === L(W1).verificationId && resItems[1].resolutionEventId === L(W1).decisionId && resItems[1].decisionCode === 'CONFIRM_INTERNAL_RESOLUTION' &&
      resItems[1].recordedByMembershipId === DR.membershipId && w1Before['resolution-disposition'].body?.state === 'RESOLVED_INTERNAL',
    "GET resolution-history: M1's request on the exact A8.6 verification and DR's confirmation; GET resolution-disposition: RESOLVED_INTERNAL",
  )
  const w4aEsc = await get(`${base(W4A)}/escalation-history`)
  const w4aEscDisp = await get(`${base(W4A)}/escalation-disposition`)
  check(
    'T017',
    'A8.8 escalation, ack, follow-up, return from A8.8',
    w4aEsc.status === 200 && same((w4aEsc.body?.items ?? []).map((e: any) => e.eventCode), ['ESCALATE_FOR_REVIEW', 'ACKNOWLEDGE_ESCALATION', 'RECORD_FOLLOWUP', 'RETURN_TO_OWNER']) &&
      same((w4aEsc.body?.items ?? []).map((e: any) => e.escalationEventId), [L(W4A).escalationId, L(W4A).ackId, L(W4A).followupId, L(W4A).returnId]) && w4aEscDisp.body?.state === 'RETURNED_TO_OWNER' &&
      w4aEscDisp.body?.returned?.returnReasonCode === 'FOLLOWUP_RECORDED' && w1Before['escalation-disposition'].body?.state === 'NO_ESCALATION' && itemsOf('escalation-history').length === 0,
    "W4a through GET escalation-history and -disposition: escalated to T, acknowledged, followed up and returned by RW for FOLLOWUP_RECORDED (RETURNED_TO_OWNER); W1: NO_ESCALATION, zero events",
  )
  // The closures of the run's eligible intakes, each through the A8.9 route by CF (T018, T029, W4a).
  const w1Close = await write('closure', W1, closeOf(W1), CF.who)
  if (w1Close.status === 201) L(W1).closureId = w1Close.body.closureEventId
  const w4aClose = await write('closure', W4A, closeOf(W4A), CF.who)
  if (w4aClose.status === 201) L(W4A).closureId = w4aClose.body.closureEventId
  const w1History = await get(`${base(W1)}/closure-history`)
  const w1Recon = await get(`${base(W1)}/closure-reconstruction`)
  check(
    'T018',
    'A8.9 closure and reconstruction from A8.9 only',
    w1Close.status === 201 && w1History.status === 200 && same((w1History.body?.items ?? []).map((e: any) => e.closureEventId), [L(W1).closureId]) && w1Recon.status === 200 &&
      w1Recon.body?.state === 'CLOSED_INTERNAL' && w1Recon.body?.recordedClosure?.closureEventId === L(W1).closureId && w1Recon.body?.contractVersion === 'A8-CLOSURE-1',
    `W1 closed through POST closure-events (201) and read back through GET closure-history (1 event) and GET closure-reconstruction (CLOSED_INTERNAL, the same closure ${String(L(W1).closureId).slice(0, 8)})`,
  )
  const harnessDirFiles = committedFiles(HARNESS_DIR)
  const thisHarness = withoutRegexLiterals(committedCode(`${HARNESS_DIR}/a8-phase-closure.integration.ts`))
  const ownDbObjects = await prisma.$queryRawUnsafe<{ n: string }[]>(
    `SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(phase_accept|a8_?10|phase_closure)' UNION ALL SELECT proname FROM pg_proc WHERE proname ~* '(phase_accept|a8_?10|phase_closure)' UNION ALL SELECT tgname FROM pg_trigger WHERE tgname ~* '(phase_accept|a8_?10|phase_closure)'`,
  )
  check(
    'T019',
    'No A8.10 reducer, persistence, permission or API',
    harnessDirFiles.length === 1 && !/^export\s/m.test(thisHarness) && !/from '\.\.\/\.\.\/app\.ts'|express\(|\.(get|post|put|patch|delete)\(\s*['`]\/api/.test(thisHarness) && ownDbObjects.length === 0 &&
      !(await prisma.permission.findMany({ select: { code: true } })).some((p) => /phase|a8_?10/i.test(p.code)) && !/CREATE (TABLE|FUNCTION|TRIGGER)/.test(thisHarness.replace(/`[^`]*`/g, '')),
    `the A8.10 directory holds only its harness (${harnessDirFiles.length} file), which exports nothing, mounts no route and defines no reducer or table; the database has no A8.10 table, function or trigger and the catalogue no A8.10 permission`,
  )
  // Every contractVersion on every owner DTO of W1 is the owner's own literal; an unknown stored version refuses.
  const versionOf = (name: string) => w1Before[name]?.body?.contractVersion as string | undefined
  const itemVersions = (name: string) => itemsOf(name).map((e) => e.contractVersion)
  const versionsMatch =
    versionOf('triage-history') === 'A8-EXCEPTION-TRIAGE-1' && itemVersions('triage-history').every((v) => v === 'A8-EXCEPTION-TRIAGE-1') && versionOf('investigation-history') === 'A8-EXCEPTION-INVESTIGATION-1' &&
    versionOf('remediation-history') === 'A8-REMEDIATION-PLAN-1' && versionOf('remediation-work-history') === 'A8-REMEDIATION-WORK-1' && versionOf('resolution-history') === 'A8-RESOLUTION-DECISION-1' &&
    versionOf('escalation-history') === 'A8-ESCALATION-1' && w1Recon.body?.contractVersion === 'A8-CLOSURE-1' && itemsOf('remediation-work-history').every((e) => e.contractVersion === 'A8-REMEDIATION-WORK-1')
  // The copy is the owner's newest event under a later version; a column its own unique index binds to one event (the
  // verified report, the decided request) gets a fresh id so that only the version is out of place.
  const futureVersion = async (table: string, contract: string, unique = '') =>
    plantedReconstruction(W1, plantCopy(table, W1, `, 'contract_version', '${contract.replace(/\d+$/, '9')}'${unique ? `, '${unique}', gen_random_uuid()` : ''}`), `ALTER TABLE ${table} DROP CONSTRAINT ${table}_contract_chk`)
  const futureReads = [
    await futureVersion('exception_triage_events', 'A8-EXCEPTION-TRIAGE-1'), await futureVersion('exception_remediation_work_events', 'A8-REMEDIATION-WORK-1', 'work_report_event_id'),
    await futureVersion('exception_resolution_events', 'A8-RESOLUTION-DECISION-1', 'request_event_id'),
  ]
  const unknownIntakeVersion = await post(`/api/claims/${W5.claimId}/exception-intake`, { ...timelineBody(W5.claimId), sourceContractVersion: 'A7-REVENUE-TIMELINE-9' })
  check(
    'T020',
    'Owner versions match; unknown versions refuse',
    versionsMatch && futureReads.every((r) => r.value?.reconstruction?.ok === false && (r.value.reconstruction as { code: string }).code === 'INTEGRITY_CONFLICT' && r.clean) && unknownIntakeVersion.status === 400 &&
      (await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${INTAKE_TABLE} WHERE claim_id = $1::uuid`, W5.claimId))[0].n === 0n,
    `every W1 DTO and item carries its owner's literal (A8-EXCEPTION-TRIAGE-1 … A8-CLOSURE-1); an A8.2, A8.6 or A8.7 event stored under an unknown version (planted, CHECK dropped, rolled back) makes the A8.9 reconstruction refuse INTEGRITY_CONFLICT (${futureReads.map((r) => (r.value?.reconstruction && !r.value.reconstruction.ok ? r.value.reconstruction.code : r.message.slice(0, 40))).join('/')}); an A8.1 request naming an unknown source version is 400 and records nothing`,
  )

  // ---------------------------------------------------------------- one controlled synthetic successful path (T021–T030)
  section('W1 — one controlled synthetic successful path: A6 frozen Claim → A8.1 → A8.2 → A8.3 → A8.5 → A8.6 → A8.7 → A8.8 NO_ESCALATION → A8.9 explicit human closure and reconstruction')
  const freezeRows = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text FROM claim_freezes WHERE claim_id = $1::uuid ORDER BY created_at`, W1.claimId)
  const linkRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM claim_correction_links WHERE claim_id = $1::uuid`, W1.claimId)
  check(
    'T021',
    'W1 A6 frozen Claim supplies the A8.1 basis',
    W1.status === 201 && freezeRows.length === 2 && same(freezeRows.map((r) => r.id), W1.freezes) && linkRows[0].n === 0n && W1.basisCode === 'UNLINKED_FROZEN_SUBMISSION' && W1.freezes.includes(W1.basisRecordId),
    `W1's Claim holds exactly its two A6.7 freezes (${W1.freezes.map((f) => f.slice(0, 8)).join(', ')}) and no A6.9 link; the A8.1 intake (201) names one of them as its basis (${W1.basisCode})`,
  )
  check(
    'T022',
    'W1 A8.2 assigns the same-tenant intake',
    w1Classify.status === 201 && w1Assign.status === 201 && w1Assign.body?.assignedMemberId === M1.membershipId && w1Assign.body?.organizationId === org && w1Assign.body?.exceptionIntakeId === W1.intakeId,
    "the harness's Admin classified W1 (201) and assigned it to M1, an Org A member (201); the event names W1's own intake and Org A",
  )
  check(
    'T023',
    'W1 A8.3 finding with typed supporting evidence',
    w1Link.status === 201 && w1Finding.status === 201 && w1Link.body?.evidenceKind === 'INTAKE_BASIS' && w1Link.body?.evidenceRecordId === W1.basisRecordId && w1Link.body?.evidenceContractVersion === INTAKE_CONTRACT &&
      w1Finding.body?.linkedEvidenceEventId === L(W1).linkId && w1Finding.body?.recordedByMembershipId === M1.membershipId,
    'M1 (the assignee) linked the typed evidence INTAKE_BASIS → the A8.1 basis record under A8-EXCEPTION-INTAKE-1 (201) and recorded a finding naming exactly that link (201)',
  )
  check(
    'T024',
    'W1 A8.5 approved by another member (planning)',
    w1Propose.status === 201 && w1Approve.status === 201 && w1Propose.body?.findingEventId === L(W1).findingId && w1Approve.body?.decisionCode === 'APPROVE_PROPOSAL' &&
      w1Approve.body?.recordedByMembershipId === RV.membershipId && RV.membershipId !== M1.membershipId && w1Before['remediation-disposition'].body?.state === 'APPROVED_FOR_PLANNING' &&
      w1Before['remediation-work-history'].body?.items?.[0]?.eventCode === 'RECORD_WORK_REPORT',
    'M1 proposed REQUEST_INTERNAL_DOCUMENTATION_CHECK on the finding and RV approved it (201, 201): APPROVED_FOR_PLANNING authorizes planning only — the work itself is a separate A8.6 record',
  )
  check(
    'T025',
    'W1 A8.6 report names the plan and A8.3 evidence',
    w1Report.status === 201 && w1Report.body?.approvedProposalEventId === L(W1).proposalId && w1Report.body?.basisReferenceKind === 'INVESTIGATION_FINDING' && w1Report.body?.basisReferenceId === L(W1).findingId &&
      w1Report.body?.workCode === WORK_CODE,
    `M1's work report (201) names the approved proposal ${String(L(W1).proposalId).slice(0, 8)} and the A8.3 finding ${String(L(W1).findingId).slice(0, 8)} (${WORK_CODE})`,
  )
  check(
    'T026',
    'W1 A8.6 verified independently (evidence only)',
    w1Verify.status === 201 && w1Verify.body?.verificationCode === 'EVIDENCE_SUPPORTED' && w1Verify.body?.recordedByMembershipId === VR.membershipId && VR.membershipId !== M1.membershipId &&
      !/PAID|ADJUDICAT|CURED|PAYER/i.test(JSON.stringify(w1Verify.body)),
    "VR (not the reporter) verified the report EVIDENCE_SUPPORTED (201): an internal statement about recorded evidence, with no payer, clinical or adjudication field",
  )
  check(
    'T027',
    'W1 A8.7 RESOLVED_INTERNAL by an independent decider',
    w1Request.status === 201 && w1Decide.status === 201 && w1Request.body?.verificationEventId === L(W1).verificationId && w1Decide.body?.decisionCode === 'CONFIRM_INTERNAL_RESOLUTION' &&
      w1Decide.body?.recordedByMembershipId === DR.membershipId && DR.membershipId !== M1.membershipId && w1Before['resolution-disposition'].body?.state === 'RESOLVED_INTERNAL',
    "M1 requested an internal resolution on the exact verification and DR (neither requester nor verifier) confirmed it: RESOLVED_INTERNAL",
  )
  check(
    'T028',
    'W1 A8.8 NO_ESCALATION; CL-01 return also lawful',
    w1Before['escalation-disposition'].body?.state === 'NO_ESCALATION' && itemsOf('escalation-history').length === 0 && w4aClose.status === 201 &&
      w4aClose.body?.basisReferenceKind === 'ESCALATION_RETURN' && w4aClose.body?.basisReferenceId === L(W4A).returnId && w4aClose.body?.closureReasonCode === 'TERMINAL_FOLLOWUP_REVIEWED',
    "W1 is NO_ESCALATION (zero A8.8 events); the one other approved terminal combination, W4a's return for FOLLOWUP_RECORDED, is closed on that exact return (201, ESCALATION_RETURN, TERMINAL_FOLLOWUP_REVIEWED)",
  )
  const w1Repeat = await write('closure', W1, closeOf(W1), CF.who)
  const w1RepeatOther = await write('closure', W1, closeOf(W1), CF2.who)
  const w1ClosureRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${CLOSURE_TABLE} WHERE exception_intake_id = $1::uuid`, W1.intakeId)
  check(
    'T029',
    'W1 A8.9 one explicit human closure',
    w1Close.status === 201 && w1Close.body?.recordedByMembershipId === CF.membershipId && w1Close.body?.basisReferenceKind === 'RESOLUTION_DECISION' && w1Close.body?.basisReferenceId === L(W1).decisionId &&
      w1Close.body?.resolutionDecisionEventId === L(W1).decisionId && w1Repeat.status === 409 && w1RepeatOther.status === 409 && w1ClosureRows[0].n === 1n && w1Before['closure-history'].body?.items?.length === 0,
    `no closure existed before CF's request (NO_CLOSURE, zero rows); CF's one explicit confirmation on DR's decision is 201; a repeat by CF and another by CF2 are 409 (${errorCode(w1Repeat.body)}, ${errorCode(w1RepeatOther.body)}); exactly one A8.9 row`,
  )
  const chain = (w1Recon.body?.chain ?? []) as any[]
  const idsInChain = new Set(chain.map((e) => e.recordId))
  const expectedIds = [W1.intakeId, L(W1).classifyId, L(W1).assignId, L(W1).linkId, L(W1).findingId, L(W1).proposalId, L(W1).reviewId, L(W1).reportId, L(W1).verificationId, L(W1).requestId, L(W1).decisionId, L(W1).closureId]
  check(
    'T030',
    'W1 reconstruction reproduces the full lineage',
    w1Recon.status === 200 && expectedIds.every((id) => typeof id === 'string' && idsInChain.has(id)) && chain.every((e, i) => e.position === i + 1) &&
      same(chain.map((e) => e.owner).filter((o, i, all) => all.indexOf(o) === i).length >= 7, true) && (w1Recon.body?.submissions ?? []).length === 2,
    `the A8.9 reconstruction of W1 names all ${expectedIds.length} ids the owners answered (intake, 2 triage, 2 investigation, 2 plan, 2 work, 2 resolution, the closure) in one ordered chain of ${chain.length} entries, and W1's 2 frozen submissions`,
  )
  // ---------------------------------------------------------------- incomplete, contradictory, forbidden (T031–T040)
  section('Incomplete, contradictory and forbidden transitions: nothing inferred from a Claim; no work before assignment, no plan without a finding, no work on an unapproved plan; NOT_VERIFIED, no request, pending, rework and open escalations never close; an unknown combination fails closed')
  const countsBeforeRefusals = await counts()
  const refused = (r: { status: number }) => r.status === 404 || r.status === 409 || r.status === 400
  const codeOf = (r: { body: any }) => errorCode(r.body) ?? ''
  // W5 — a Claim with no A8.1 intake: every A8 owner route answers 404; nothing is inferred from the Claim or a freeze.
  const w5k = { claimId: W5.claimId, intakeId: W5.freezes[0] }
  const w5Intake = await get(`/api/claims/${W5.claimId}/exception-intake`)
  const w5Reads = await Promise.all(ownerReads(w5k).slice(1).map((path) => get(path)))
  const w5Writes = [
    await write('triage', w5k, classify, asAdmin), await write('investigation', w5k, { eventCode: 'LINK_EVIDENCE_REFERENCE', evidenceKind: 'INTAKE_BASIS', evidenceRecordId: W5.freezes[0], evidenceContractVersion: INTAKE_CONTRACT }, M4.who),
    await write('closure', w5k, closeBody(MISSING), CF.who),
  ]
  check(
    'T031',
    'No intake is inferred from a Claim or freeze',
    w5Intake.status === 200 && (w5Intake.body?.items ?? []).length === 0 && w5Reads.every((r) => r.status === 404) && w5Writes.every((r) => r.status === 404) &&
      (await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${INTAKE_TABLE} WHERE claim_id = $1::uuid`, W5.claimId))[0].n === 0n,
    `W5's Claim (frozen twice, never taken in by A8.1) lists no intake; its freeze id used as an intake id is 404 on all ${w5Reads.length} A8 read routes and on the A8.2, A8.3 and A8.9 writes; zero A8.1 rows`,
  )
  // UN never triaged, UA classified but never assigned: no investigation and no work report is accepted.
  const unLink = await write('investigation', UN, linkOf(UN), M4.who)
  const uaLink = await write('investigation', UA, linkOf(UA), M4.who)
  const unReport = await write('work', UN, reportOf(MISSING, MISSING), M4.who)
  const uaReport = await write('work', UA, reportOf(MISSING, MISSING), M4.who)
  check(
    'T032',
    'Untriaged or unassigned: no work report',
    [unLink, uaLink, unReport, uaReport].every(refused) && /NOT_ASSIGNEE|TRANSITION_REFUSED/.test(codeOf(unLink)) && /NOT_ASSIGNEE|TRANSITION_REFUSED/.test(codeOf(uaLink)) &&
      (await get(`${base(UN)}/triage-disposition`)).body?.dispositionCode === 'UNTRIAGED' && (await get(`${base(UA)}/triage-disposition`)).body?.dispositionCode === 'TRIAGED',
    `UN (UNTRIAGED) and UA (TRIAGED, no assignee): the A8.3 link is refused (${unLink.status} ${codeOf(unLink)}, ${uaLink.status} ${codeOf(uaLink)}) and an A8.6 report is refused (${unReport.status} ${codeOf(unReport)}, ${uaReport.status} ${codeOf(uaReport)})`,
  )
  // NF assigned but without a finding: no A8.5 proposal on a missing, foreign or non-finding event, and no A8.6 work.
  const nfMissing = await write('remediation', NF, proposeOf(MISSING), M4.who)
  const nfForeign = await write('remediation', NF, proposeOf(L(W1).findingId as string), M4.who)
  const nfLinkAsFinding = await write('remediation', NF, proposeOf(L(W1).linkId as string), M4.who)
  const nfReport = await write('work', NF, reportOf(L(W1).proposalId as string, L(W1).findingId as string), M4.who)
  check(
    'T033',
    'No valid finding: no plan and no work basis',
    [nfMissing, nfForeign, nfLinkAsFinding, nfReport].every(refused) && (await get(`${base(NF)}/investigation-summary`)).body?.investigationCode === 'NOT_STARTED' &&
      (await get(`${base(NF)}/remediation-disposition`)).body?.state === 'NO_PROPOSAL',
    `NF (assigned, NOT_STARTED): a proposal on a missing finding ${nfMissing.status}, on W1's finding ${nfForeign.status}, on W1's evidence link ${nfLinkAsFinding.status}; a report on W1's plan and finding ${nfReport.status}; NF stays NO_PROPOSAL`,
  )
  const ppReport = await write('work', PP, reportOf(L(PP).proposalId as string, L(PP).findingId as string), M4.who)
  const rpReport = await write('work', RP, reportOf(L(RP).proposalId as string, L(RP).findingId as string), M4.who)
  check(
    'T034',
    'Pending or returned A8.5 plan is not approved',
    refused(ppReport) && refused(rpReport) && (await get(`${base(PP)}/remediation-disposition`)).body?.state === 'AWAITING_REVIEW' &&
      (await get(`${base(RP)}/remediation-disposition`)).body?.state === 'RETURNED_FOR_REVISION' && (await get(`${base(PP)}/remediation-work-disposition`)).body?.state === 'NO_WORK_REPORT',
    `a work report on PP's pending proposal (${ppReport.status} ${codeOf(ppReport)}) and on RP's returned proposal (${rpReport.status} ${codeOf(rpReport)}) is refused; both stay without work`,
  )
  const w2Request = await write('resolution', W2, requestOf(L(W2).verificationId as string), M4.who)
  const w2Close = await write('closure', W2, closeBody(L(W2).verificationId as string), CF.who)
  check(
    'T035',
    'EVIDENCE_NOT_VERIFIED never resolves or closes',
    (await get(`${base(W2)}/remediation-work-disposition`)).body?.state === 'NOT_VERIFIED' && w2Request.status === 409 && codeOf(w2Request) === 'EXCEPTION_RESOLUTION_BASIS_NOT_VERIFIED' &&
      refused(w2Close) && (await get(`${base(W2)}/resolution-disposition`)).body?.state === 'NO_RESOLUTION_REQUEST' && (await get(`${base(W2)}/closure-reconstruction`)).body?.state === 'NO_CLOSURE',
    `W2's work is NOT_VERIFIED (VR: EVIDENCE_NOT_VERIFIED); the A8.7 request on it is ${w2Request.status} ${codeOf(w2Request)} and the A8.9 closure ${w2Close.status} ${codeOf(w2Close)}; W2 stays NO_RESOLUTION_REQUEST and NO_CLOSURE`,
  )
  const n0Close = await write('closure', N0, closeBody(MISSING), CF.who)
  const pdClose = await write('closure', PD, closeBody(L(PD).requestId as string), CF.who)
  check(
    'T036',
    'No request or pending decision never closes',
    (await get(`${base(N0)}/resolution-disposition`)).body?.state === 'NO_RESOLUTION_REQUEST' && (await get(`${base(PD)}/resolution-disposition`)).body?.state === 'AWAITING_RESOLUTION_DECISION' &&
      refused(n0Close) && refused(pdClose) && (await get(`${base(PD)}/closure-history`)).body?.items?.length === 0,
    `N0 (NO_RESOLUTION_REQUEST) closure ${n0Close.status} ${codeOf(n0Close)}; PD (AWAITING_RESOLUTION_DECISION) closure naming its request ${pdClose.status} ${codeOf(pdClose)}; no closure recorded`,
  )
  const rkConfirm = await write('resolution', RK, confirmOf(L(RK).requestId as string), DR.who)
  const rkClose = await write('closure', RK, closeBody(L(RK).decisionId as string), CF.who)
  check(
    'T037',
    'RETURNED_FOR_REWORK never becomes RESOLVED',
    refused(rkConfirm) && refused(rkClose) && (await get(`${base(RK)}/resolution-disposition`)).body?.state === 'RETURNED_FOR_REWORK',
    `a confirmation of RK's already returned request is ${rkConfirm.status} ${codeOf(rkConfirm)}; a closure naming the rework decision is ${rkClose.status} ${codeOf(rkClose)}; RK stays RETURNED_FOR_REWORK`,
  )
  const w3aClose = await write('closure', W3A, closeOf(W3A), CF.who)
  check(
    'T038',
    'AWAITING_ACKNOWLEDGEMENT is not a closed follow-up',
    (await get(`${base(W3A)}/escalation-disposition`)).body?.state === 'AWAITING_ACKNOWLEDGEMENT' && (await get(`${base(W3A)}/resolution-disposition`)).body?.state === 'RESOLVED_INTERNAL' &&
      w3aClose.status === 409 && codeOf(w3aClose) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' && (await get(`${base(W3A)}/closure-reconstruction`)).body?.state === 'NO_CLOSURE',
    `W3a is RESOLVED_INTERNAL with its escalation AWAITING_ACKNOWLEDGEMENT: the closure is ${w3aClose.status} ${codeOf(w3aClose)} (CL-02) and W3a stays NO_CLOSURE`,
  )
  const w3bClose = await write('closure', W3B, closeOf(W3B), CF.who)
  check(
    'T039',
    'FOLLOWUP_ACTIVE does not authorize closure',
    (await get(`${base(W3B)}/escalation-disposition`)).body?.state === 'FOLLOWUP_ACTIVE' && w3bClose.status === 409 && codeOf(w3bClose) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE' &&
      (await get(`${base(W3B)}/closure-reconstruction`)).body?.state === 'NO_CLOSURE',
    `W3b is RESOLVED_INTERNAL with follow-ups active: the closure is ${w3bClose.status} ${codeOf(w3bClose)} (CL-02); NO_CLOSURE`,
  )
  // An unreachable combination: W4b's return for FURTHER_WORK_REQUIRED (refused in v1) on every basis; and an A8.8
  // history planted with a second return of the same escalation (rolled back) is not read as any state at all.
  const w4bRoutes = [
    await write('closure', W4B, closeOf(W4B), CF.who), await write('closure', W4B, closeBody(L(W4B).decisionId as string), CF.who),
  ]
  const doubleReturn = await plantedReconstruction(W3B, plantCopy('exception_escalation_events', W4A, `, 'exception_intake_id', '${W3B.intakeId}', 'claim_id', '${W3B.claimId}'`))
  check(
    'T040',
    'Unknown A8.7+A8.8 combination fails closed',
    w4bRoutes.every((r) => r.status === 409 && codeOf(r) === 'EXCEPTION_CLOSURE_NOT_ELIGIBLE') && (await get(`${base(W4B)}/escalation-disposition`)).body?.returned?.returnReasonCode === 'FURTHER_WORK_REQUIRED' &&
      doubleReturn.value?.reconstruction?.ok === false && doubleReturn.clean && (await unchanged(countsBeforeRefusals)),
    `W4b (RESOLVED_INTERNAL, returned for FURTHER_WORK_REQUIRED) is refused on its return and on its decision (${w4bRoutes.map((r) => `${r.status} ${codeOf(r)}`).join(', ')}); a foreign RETURN_TO_OWNER planted into W3b's history (rolled back) gives no reconstruction (${doubleReturn.value?.reconstruction && !doubleReturn.value.reconstruction.ok ? doubleReturn.value.reconstruction.code : 'answered'}); every refusal above wrote nothing`,
  )

  // ---------------------------------------------------------------- historical reconstruction and terminal truth (T041–T050)
  section('Historical reconstruction and terminal truth: one ordered closure, no second closure, the exact A8.7 decision, A8.6 events and A8.5 basis, attributable A8.2 history, A8.8 history as recorded, earlier owners byte-identical, distinct terminal states, present-day changes never rewrite the past')
  const w1HistoryAgain = [await get(`${base(W1)}/closure-history`), await get(`${base(W1)}/closure-history`, asViewer), await get(`${base(W1)}/closure-history`)]
  check(
    'T041',
    'One completed closure, ordered and unchanged',
    w1HistoryAgain.every((r) => r.status === 200 && withoutEvaluatedAt(r.body) === withoutEvaluatedAt(w1History.body)) && (w1History.body?.items ?? []).length === 1 && w1History.body.items[0].sequence === 1,
    'W1 closure-history read three times (Admin, Viewer, Admin) answers the same single closure at sequence 1, byte-identical apart from evaluatedAt',
  )
  const countsBeforeSecond = await counts()
  const w1Second = [await write('closure', W1, closeOf(W1), CF.who), await write('closure', W1, { ...closeOf(W1), closureReasonCode: 'TERMINAL_FOLLOWUP_REVIEWED' }, CF2.who)]
  const w4aSecond = await write('closure', W4A, closeOf(W4A), CF2.who)
  check(
    'T042',
    'No second closure, identical or different',
    [...w1Second, w4aSecond].every((r) => r.status === 409 || r.status === 400) && w1Second[0].status === 409 && (await unchanged(countsBeforeSecond)),
    `an identical second closure of W1 (${w1Second[0].status} ${codeOf(w1Second[0])}), a different one (${w1Second[1].status} ${codeOf(w1Second[1])}) and a second closure of W4a (${w4aSecond.status} ${codeOf(w4aSecond)}) write nothing`,
  )
  const chainEntry = (owner: string, eventCode: string) => chain.find((e) => e.owner === owner && e.eventCode === eventCode)
  check(
    'T043',
    'Reconstruction names the exact A8.7 decision',
    w1Recon.body?.recordedClosure?.resolutionDecisionEventId === L(W1).decisionId && chain.some((e) => e.recordId === L(W1).decisionId && e.eventCode === 'DECIDE_INTERNAL_RESOLUTION') &&
      chain.some((e) => e.recordId === L(W1).requestId && e.eventCode === 'REQUEST_INTERNAL_RESOLUTION'),
    `the reconstruction's recorded closure names DR's decision ${String(L(W1).decisionId).slice(0, 8)} and its chain holds that exact decision and its request, as recorded`,
  )
  check(
    'T044',
    'A8.6 report and verification preserved',
    chain.some((e) => e.recordId === L(W1).reportId && e.eventCode === 'RECORD_WORK_REPORT') && chain.some((e) => e.recordId === L(W1).verificationId && e.eventCode === 'VERIFY_WORK_REPORT') &&
      (await get(`${base(W1)}/remediation-work-history`)).body?.items?.[1]?.verificationCode === 'EVIDENCE_SUPPORTED',
    "the chain names M1's report and VR's verification by their A8.6 ids; the A8.6 owner still reads EVIDENCE_SUPPORTED",
  )
  check(
    'T045',
    'A8.5 proposal and review on the A8.3 basis',
    chain.some((e) => e.recordId === L(W1).proposalId) && chain.some((e) => e.recordId === L(W1).reviewId) && chain.some((e) => e.recordId === L(W1).findingId) && chain.some((e) => e.recordId === L(W1).linkId) &&
      remItems[0].findingEventId === L(W1).findingId && invItems[1].linkedEvidenceEventId === L(W1).linkId,
    "the chain names the A8.5 proposal and review and the A8.3 finding and link; the proposal's finding and the finding's link are exactly those",
  )
  // T046 — A8.2 history stays attributable as recorded after a present-day change: M5 is given the W1 assignment's role
  // context changes (a reassignment of another intake) and the W1 history is re-read; nothing about the past is recomputed.
  const w1TriageNow = await get(`${base(W1)}/triage-history`)
  check(
    'T046',
    'A8.2 sequence and actor stay attributable',
    withoutEvaluatedAt(w1TriageNow.body) === withoutEvaluatedAt(w1Before['triage-history'].body) && same((w1TriageNow.body?.items ?? []).map((e: any) => [e.sequence, e.recordedByUserId]), [[1, creatorId], [2, creatorId]]),
    "W1's triage history after its closure is byte-identical (apart from evaluatedAt): sequences 1 and 2, each attributed to the Admin who recorded it",
  )
  const w4aEscNow = await get(`${base(W4A)}/escalation-history`)
  const w4bEscNow = await get(`${base(W4B)}/escalation-history`)
  check(
    'T047',
    'A8.8 history preserved; return never resolution',
    withoutEvaluatedAt(w4aEscNow.body) === withoutEvaluatedAt(w4aEsc.body) && (await get(`${base(W4A)}/escalation-disposition`)).body?.state === 'RETURNED_TO_OWNER' &&
      (w4bEscNow.body?.items ?? []).at(-1)?.returnReasonCode === 'FURTHER_WORK_REQUIRED' && (await get(`${base(W3A)}/escalation-disposition`)).body?.state === 'AWAITING_ACKNOWLEDGEMENT',
    "after W4a's closure its A8.8 history is byte-identical and still RETURNED_TO_OWNER; W4b's return still reads FURTHER_WORK_REQUIRED; W3a still awaits acknowledgement — no return or pending escalation is recast",
  )
  const a8After = await a8Hashes([W1.intakeId, W4A.intakeId])
  const auditsAfter = await auditHash([W1.intakeId, W4A.intakeId], A8_AUDIT_ACTIONS.slice(0, 7))
  const w1After = await readAll(W1)
  check(
    'T048',
    'A8.1–A8.8 bytes, counts and audits unchanged',
    OWNERS.slice(0, 7).every((o) => a8After[o.table] === a8Before[o.table]) && a8After[CLOSURE_TABLE] !== a8Before[CLOSURE_TABLE] && auditsAfter === auditsBefore &&
      dtoText(w1After, ['closure-history', 'closure-reconstruction']) === dtoText(w1Before, ['closure-history', 'closure-reconstruction']),
    'every A8.1–A8.8 row of W1 and W4a and every one of their A8.1–A8.8 audits hashes exactly as before the two closures; only the A8.9 rows changed; all 13 A8.1–A8.8 DTOs of W1 are byte-identical',
  )
  const resolutionState = w1After['resolution-disposition'].body?.state
  const closureState = w1After['closure-reconstruction'].body?.state
  check(
    'T049',
    'CLOSED_INTERNAL distinct from RESOLVED_INTERNAL',
    resolutionState === 'RESOLVED_INTERNAL' && closureState === 'CLOSED_INTERNAL' && w1After['remediation-work-disposition'].body?.state === 'VERIFIED_INTERNAL_WORK' &&
      !/PAID|DENIED|REMITTED|SETTLED|RECONCILED|ADJUDICATED|TRANSMITTED|CURED/.test(JSON.stringify(w1After['closure-reconstruction'].body)),
    "W1 reads RESOLVED_INTERNAL from A8.7 and CLOSED_INTERNAL from A8.9 at the same time: two owners, two different positions; the reconstruction carries no paid, denied, remitted, settled, reconciled, adjudicated, transmitted or cured fact",
  )
  // A present-day change: DR (W1's decider) and CF (W1's confirmer) lose their role; the past reads exactly as before.
  const drRoles = await prisma.membershipRole.findMany({ where: { membershipId: DR.membershipId }, select: { roleId: true } })
  await prisma.membershipRole.deleteMany({ where: { membershipId: DR.membershipId } })
  const w1AfterRoleChange = await readAll(W1)
  for (const r of drRoles) await prisma.membershipRole.create({ data: { membershipId: DR.membershipId, roleId: r.roleId } })
  const codingBefore = snapBefore.coding
  check(
    'T050',
    'Present-day roles or releases do not rewrite',
    dtoText(w1AfterRoleChange) === dtoText(w1After) && (await snap()).coding === codingBefore && drRoles.length > 0,
    "with DR's role removed today, all 15 owner DTOs of W1 (A8.1 through the A8.9 reconstruction) read byte-identical; the role was restored afterwards; no coding release or reference table changed during the A8 writes",
  )
  // ---------------------------------------------------------------- authorization, tenant and privacy (T051–T060)
  section('Authorization, tenant and privacy across every A8 owner route: 401 before lookup, 403 without the grant, a foreign and a missing Claim indistinguishable, no foreign substitution, Viewer read-only, no self-review, assignment and permission rejudged at write time, no PHI or raw schema, Org B isolated')
  const countsBeforeAuth = await counts()
  const WRITE_BODIES: [Owner, unknown][] = [
    ['triage', classify], ['investigation', linkOf(C9)], ['remediation', proposeOf(MISSING)], ['work', reportOf(MISSING, MISSING)], ['resolution', requestOf(MISSING)], ['escalation', escalateOf(T)], ['closure', closeOf(C9)],
  ]
  const intakeWrite = (k: { claimId: string }, who: Who) => post(`/api/claims/${k.claimId}/exception-intake`, timelineBody(k.claimId), who)
  const everyWrite = async (k: { claimId: string; intakeId: string }, who: Who) => [await intakeWrite(k, who), ...(await Promise.all(WRITE_BODIES.map(([owner, body]) => write(owner, k, body, who))))]
  const everyRead = async (k: { claimId: string; intakeId: string }, who: Who) => Promise.all(ownerReads(k).map((path) => get(path, who)))
  const missingK = { claimId: MISSING, intakeId: MISSING }
  const anonReads = await everyRead(C9, anonymous)
  const anonWrites = await everyWrite(C9, anonymous)
  const anonMissing = await everyRead(missingK, anonymous)
  check(
    'T051',
    'Unauthenticated reads and writes: 401 first',
    [...anonReads, ...anonWrites, ...anonMissing].every((r) => r.status === 401) && (await unchanged(countsBeforeAuth)),
    `all ${anonReads.length} A8 read routes and all ${anonWrites.length} A8 write routes answer 401 without a session — for a real intake and for a missing Claim alike (no lookup first); nothing written`,
  )
  const nrReads = await everyRead(C9, NR.who)
  const nrWrites = await everyWrite(C9, NR.who)
  check(
    'T052',
    'Missing owner permission: 403',
    [...nrReads, ...nrWrites].every((r) => r.status === 403) && (await unchanged(countsBeforeAuth)),
    `NR, an Org A member without any role, receives 403 on all ${nrReads.length} read and ${nrWrites.length} write routes of an Org A intake; nothing written`,
  )
  const stripId = (body: unknown) => withoutEvaluatedAt(body)
  const foreignReads = await everyRead(C9, O.who)
  const missingReads = await everyRead({ claimId: MISSING, intakeId: C9.intakeId }, O.who)
  check(
    'T053',
    'Foreign and missing Claim: identical 404',
    foreignReads.every((r) => r.status === 404) && missingReads.every((r) => r.status === 404) && foreignReads.every((r, i) => stripId(r.body) === stripId(missingReads[i].body)),
    `Org B's Admin reading Org A's Claim gets 404 on all ${foreignReads.length} routes, byte-identical (apart from the request id) to the 404 for a Claim that does not exist`,
  )
  // The claim-level A8.1 route takes no intake id; every intake-level route is judged for the swap.
  const swappedIntake = (await everyRead({ claimId: C9.claimId, intakeId: F.intakeId }, asAdmin)).slice(1)
  const otherIntakeOnClaim = (await everyRead({ claimId: C9.claimId, intakeId: W1.intakeId }, asAdmin)).slice(1)
  const foreignPlanReport = await write('work', SA, reportOf(L(W1).proposalId as string, L(W1).findingId as string), M4.who)
  const foreignDecisionClose = await write('closure', C9, closeBody(L(W1).decisionId as string), CF.who)
  const foreignFindingPlan = await write('remediation', NF, proposeOf(L(F).findingId as string), M4.who)
  check(
    'T054',
    'No foreign intake, source or plan substitution',
    swappedIntake.every((r) => r.status === 404) && otherIntakeOnClaim.every((r) => r.status === 404) && [foreignPlanReport, foreignDecisionClose, foreignFindingPlan].every(refused) && (await unchanged(countsBeforeAuth)),
    `under C9's Claim, Org B's intake F and W1's own intake are 404 on every route; SA's report citing W1's approved plan (${foreignPlanReport.status}), C9's closure citing W1's decision (${foreignDecisionClose.status}) and NF's proposal citing Org B's finding (${foreignFindingPlan.status}) are refused; nothing written`,
  )
  const viewerReads = await everyRead(W1, asViewer)
  const viewerWrites = await everyWrite(C9, asViewer)
  check(
    'T055',
    'Viewer reads history only, never writes',
    viewerReads.every((r) => r.status === 200) && viewerWrites.every((r) => r.status === 403) && (await unchanged(countsBeforeAuth)),
    `the Viewer reads all ${viewerReads.length} owner routes of W1 (200) and is refused 403 on all ${viewerWrites.length} write routes`,
  )
  // Independence, each owner's own rule: the proposer never approves, the reporter never verifies, the requester never
  // decides, and neither requester nor decider closes.
  const selfApprove = await write('remediation', PP, approveOf(L(PP).proposalId as string), M4.who)
  const selfVerify = await write('work', V6, verifyOf(L(V6).reportId as string), M4.who)
  const selfDecide = await write('resolution', D7, confirmOf(L(D7).requestId as string), M4.who)
  const selfCloseRequester = await write('closure', C9, closeOf(C9), M4.who)
  const selfCloseDecider = await write('closure', C9, closeOf(C9), DR.who)
  check(
    'T056',
    'No self-approval, verification, decision or closure',
    codeOf(selfApprove) === 'EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT' && codeOf(selfVerify) === 'EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT' && codeOf(selfDecide) === 'EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT' &&
      codeOf(selfCloseRequester) === 'EXCEPTION_CLOSURE_NOT_INDEPENDENT' && codeOf(selfCloseDecider) === 'EXCEPTION_CLOSURE_NOT_INDEPENDENT' && (await unchanged(countsBeforeAuth)),
    `M4 approving its own proposal (${codeOf(selfApprove)}), verifying its own report (${codeOf(selfVerify)}) and deciding its own request (${codeOf(selfDecide)}); M4 and DR closing C9 (${codeOf(selfCloseRequester)}, ${codeOf(selfCloseDecider)}) — each refused by its own owner; nothing written`,
  )
  // T057 — SA is reassigned from M4 to M5 through A8.2; M4's work report is then judged against the CURRENT assignment.
  const saReassign = await write('triage', SA, reassignTo(M5), asAdmin)
  const saStale = await write('work', SA, reportOf(L(SA).proposalId as string, L(SA).findingId as string), M4.who)
  const saCurrent = await write('work', SA, reportOf(L(SA).proposalId as string, L(SA).findingId as string), M5.who)
  check(
    'T057',
    'Reassignment invalidates a stale reporter',
    saReassign.status === 201 && saStale.status === 409 && codeOf(saStale) === 'EXCEPTION_REMEDIATION_WORK_NOT_ASSIGNEE' && saCurrent.status === 201 && saCurrent.body?.recordedByMembershipId === M5.membershipId,
    `SA reassigned to M5 (201): M4's report on SA's approved plan is now ${saStale.status} ${codeOf(saStale)}; M5's report is 201 — the current A8.2 assignee is judged at write time`,
  )
  // T058 — CF3's role is removed while its closure of PR holds PR's Claim lock (the production A8.9 service, in this
  // process): the closure re-reads CF3's permissions under the lock and is refused; nothing is recorded.
  const holdPR = holdAt('exceptionClosure.claim_locked')
  const prClose = recordClosureEvent(PR.claimId, PR.intakeId, closeOf(PR), CF3.id)
  const prArrived = await settledWithin(holdPR.arrived, 30_000)
  const cf3Roles = await prisma.membershipRole.findMany({ where: { membershipId: CF3.membershipId }, select: { roleId: true } })
  await prisma.membershipRole.deleteMany({ where: { membershipId: CF3.membershipId } })
  holdPR.release()
  const prResult = await prClose
  clearConcurrencyProbes()
  const prHttp = await write('closure', PR, closeOf(PR), CF3.who)
  for (const r of cf3Roles) await prisma.membershipRole.create({ data: { membershipId: CF3.membershipId, roleId: r.roleId } })
  check(
    'T058',
    'Permission removed before commit is refused',
    prArrived && prResult.ok === false && /NOT_INDEPENDENT|FORBIDDEN|PERMISSION/.test(prResult.code) && prHttp.status === 403 &&
      (await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${CLOSURE_TABLE} WHERE exception_intake_id = $1::uuid`, PR.intakeId))[0].n === 0n,
    `CF3's role was removed while its closure of PR held the Claim lock: refused at commit (${prResult.ok ? 'recorded' : prResult.code}); its next request is ${prHttp.status}; no closure of PR exists; CF3's role was restored afterwards`,
  )
  // T059 — every refusal body of this run, and every A8 audit of the run's intakes, carries no patient, diagnosis or payer
  // text and no raw schema, SQL or stack.
  const phiNeedles = [home.patientFamilyName, away.patientFamilyName, home.diagnosisName, away.diagnosisName, '1990-01-01', 'Synthetic member']
  const rawSchema = (text: string) => /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |UPDATE |constraint|trigger|exception_[a-z_]+_events|exception_intake_records|organization_memberships/i.test(text)
  const refusalTexts = answers.map((a) => JSON.stringify(a.body ?? {}))
  const auditTexts = (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT coalesce(a.after_state::text, '') AS t FROM audit_events a WHERE a.action_code = ANY($1::text[]) AND (a.entity_id = ANY($2::uuid[]) OR a.after_state->>'exceptionIntakeId' = ANY($2::text[]))`, A8_AUDIT_ACTIONS, runIntakes.map((k) => k.intakeId))).map((r) => r.t)
  const leaks = [...refusalTexts, ...auditTexts].filter((text) => phiNeedles.some((n) => text.includes(n)) || rawSchema(text))
  check(
    'T059',
    'No PHI, private text or raw schema disclosed',
    refusalTexts.length >= 60 && auditTexts.length >= 100 && leaks.length === 0,
    leaks.length === 0
      ? `${refusalTexts.length} refusal bodies of this run and ${auditTexts.length} A8 audit records of its intakes: no patient name or birth date, diagnosis label, member name, SQL, stack frame or physical table name`
      : `leak: ${leaks[0].slice(0, 200)}`,
  )
  const countsBeforeOrgB = await counts()
  const orgBReads = await everyRead(W1, O.who)
  const orgBWrites = await everyWrite(C9, O.who)
  const orgBOwn = await get(`${base(F)}/resolution-disposition`, O.who)
  const orgAOnF = await everyRead(F, asAdmin)
  check(
    'T060',
    'Org B cannot read or affect Org A',
    orgBReads.every((r) => r.status === 404) && orgBWrites.every((r) => r.status === 404) && orgAOnF.every((r) => r.status === 404) && orgBOwn.status === 200 && orgBOwn.body?.state === 'RESOLVED_INTERNAL' &&
      (await unchanged(countsBeforeOrgB)) &&
      (await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM audit_events WHERE actor_user_id = ANY($1::uuid[]) AND action_code = ANY($2::text[]) AND after_state->>'exceptionIntakeId' = ANY($3::text[])`, [O.id, O2.id, O3.id, O4.id, OC.id], A8_AUDIT_ACTIONS, homeIds))[0].n === 0n,
    `Org B's Admin gets 404 on all ${orgBReads.length} reads of W1 and all ${orgBWrites.length} writes on C9 (no Org A row or audit written by Org B); Org A's Admin likewise gets 404 on F; Org B reads its own F (RESOLVED_INTERNAL) — two isolated tenants`,
  )
  // ---------------------------------------------------------------- atomicity, concurrency and failure protocol (T061–T070)
  section('Atomicity, concurrent writes and the failure protocol: each owner locks the Claim NOWAIT first inside one SERIALIZABLE transaction; A8.10 adds no writer; identical and competing A8.6, A8.7, A8.8 and A8.9 events race to one outcome; an uncommitted writer never leaks; bounded fresh-transaction retry; an unknown outcome is reconciled')
  const ownerServices = OWNERS.map((o) => ({ ...o, code: serviceCodeAt(o.module) }))
  const lockFirst = (code: string) => /async function recordOnTransaction\([\s\S]*?\):\s*Promise<[^{]*\{\s*if \(!\(await lockRowForUpdateNowait\(tx, 'claims', claimId\)\)\)/.test(code)
  const serializableWriter = (code: string) => /prisma\.\$transaction\(\s*\(tx\) => recordOnTransaction\([\s\S]{0,240}isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(code)
  check(
    'T061',
    'Each A8 writer locks its Claim NOWAIT first',
    ownerServices.every((o) => lockFirst(o.code) && (o.code.match(/lockRowForUpdateNowait\(tx, 'claims'/g) ?? []).length === 1),
    `in all ${ownerServices.length} owner services (${OWNERS.map((o) => o.tag).join(', ')}) the write transaction's first statement is the Claim's FOR UPDATE NOWAIT lock (shared/database/row-lock.ts), and it is taken exactly once`,
  )
  // Each transaction this harness opens: the body up to its first 400 characters, judged by what it calls.
  const harnessTransactions = [...thisHarness.matchAll(/prisma\.\$transaction\(/g)].map((m) => thisHarness.slice(m.index ?? 0, (m.index ?? 0) + 400))
  const HARNESS_TRANSACTION_KINDS = [
    /^prisma\.\$transaction\(\s*async \(tx\) => \{\s*out\.value = await job\(tx\)\s*throw new Error\(NOT_COMMITTED\)/, // always rolled back
    /^prisma\.\$transaction\(async \(tx\) => recordValidationRunInTransaction\(/, // A5.8's own recorder (fixtures)
    /^prisma\.\$transaction\(async \(tx\) => \{\s*const coding = await evaluateCodingRelease\(built\.id, tx\)/, // A5.8 + CRG-01B owners (W7)
    /^prisma\.\$transaction\(async \(tx\) => getCodingReleaseCheckOf\(EK\.id, tx\)\)/, // CRG-01A's own reader
  ]
  check(
    'T062',
    'Every A8 writer SERIALIZABLE; no A8.10 writer',
    ownerServices.every((o) => serializableWriter(o.code)) && harnessTransactions.length === 4 && harnessTransactions.every((body) => HARNESS_TRANSACTION_KINDS.some((kind) => kind.test(body))) &&
      !/isolationLevel|TransactionIsolationLevel/.test(thisHarness) &&
      /isolationLevel/.test(withoutRegexLiterals(serviceCodeAt('exception-closure'))),
    `every owner runs its writer in one SERIALIZABLE transaction; this harness opens exactly ${harnessTransactions.length} transactions, each either always rolled back (the adversarial probes) or a call of an accepted owner function only (the A5.8 validation recorder for fixtures, the A5.8 recorder with CRG-01B's coding evaluation and receipts for W7, and CRG-01A's coding-release read); it never sets an isolation level, and the same scan still finds the one in A8.9's own service`,
  )
  type Race = { status: number; body: any }[]
  const okCount = (race: Race) => race.filter((r) => r.status === 201).length
  const rowsOf = async (table: string, k: Intake) => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${table} WHERE exception_intake_id = $1::uuid`, k.intakeId))[0].n)
  const auditsOf = async (action: string, k: Intake) =>
    Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM audit_events WHERE action_code = $1 AND after_state->>'exceptionIntakeId' = $2`, action, k.intakeId))[0].n)
  const r6Before = await rowsOf('exception_remediation_work_events', R6)
  const r6Race: Race = await Promise.all(Array.from({ length: 5 }, () => write('work', R6, reportOf(L(R6).proposalId as string, L(R6).findingId as string), M4.who)))
  check(
    'T063',
    'Identical concurrent reports: one event',
    okCount(r6Race) === 1 && r6Race.filter((r) => r.status !== 201).every((r) => r.status === 409) && (await rowsOf('exception_remediation_work_events', R6)) === r6Before + 1 &&
      (await auditsOf('exception_remediation_work.recorded', R6)) === r6Before + 1,
    `five identical A8.6 reports on R6 at once: ${r6Race.map((r) => r.status).join('/')} — exactly one event and one audit, no duplicate and no lost audit`,
  )
  const v6Race: Race = await Promise.all([write('work', V6, verifyOf(L(V6).reportId as string), VR.who), write('work', V6, notVerifiedOf(L(V6).reportId as string), RV.who)])
  const v6Disposition = (await get(`${base(V6)}/remediation-work-disposition`)).body?.state
  check(
    'T064',
    'Concurrent verifications: one terminal outcome',
    okCount(v6Race) === 1 && v6Race.some((r) => r.status === 409) && (v6Disposition === 'VERIFIED_INTERNAL_WORK' || v6Disposition === 'NOT_VERIFIED') && (await rowsOf('exception_remediation_work_events', V6)) === 2,
    `VR (EVIDENCE_SUPPORTED) and RV (EVIDENCE_NOT_VERIFIED) verify V6's report at once: ${v6Race.map((r) => r.status).join('/')}; V6 holds one verification (${v6Disposition})`,
  )
  const d7Race: Race = await Promise.all([write('resolution', D7, confirmOf(L(D7).requestId as string), DR.who), write('resolution', D7, reworkOf(L(D7).requestId as string), CF2.who)])
  const d7State = (await get(`${base(D7)}/resolution-disposition`)).body?.state
  check(
    'T065',
    'Concurrent A8.7 decisions: one terminal outcome',
    okCount(d7Race) === 1 && d7Race.some((r) => r.status === 409) && (d7State === 'RESOLVED_INTERNAL' || d7State === 'RETURNED_FOR_REWORK') && (await rowsOf('exception_resolution_events', D7)) === 2,
    `DR (confirm) and CF2 (return for rework) decide D7's request at once: ${d7Race.map((r) => r.status).join('/')}; one decision (${d7State})`,
  )
  const e8Escalate: Race = await Promise.all([write('escalation', E8, escalateOf(T), M4.who), write('escalation', E8, escalateOf(T), M4.who)])
  const e8EscalationId = e8Escalate.find((r) => r.status === 201)?.body?.escalationEventId as string
  const e8Ack: Race = await Promise.all([write('escalation', E8, ackOf(e8EscalationId), T.who), write('escalation', E8, ackOf(e8EscalationId), T.who)])
  const e8SelfReturn = await write('escalation', E8, returnOf(e8EscalationId), T.who)
  const e8History = await get(`${base(E8)}/escalation-history`)
  check(
    'T066',
    'Concurrent A8.8 events: legal order, independence',
    okCount(e8Escalate) === 1 && okCount(e8Ack) === 1 && same((e8History.body?.items ?? []).map((e: any) => [e.sequence, e.eventCode]), [[1, 'ESCALATE_FOR_REVIEW'], [2, 'ACKNOWLEDGE_ESCALATION']]) &&
      e8SelfReturn.status === 409 && /NOT_INDEPENDENT|TRANSITION_REFUSED/.test(codeOf(e8SelfReturn)),
    `two escalations of E8 at once (${e8Escalate.map((r) => r.status).join('/')}) and two acknowledgements at once (${e8Ack.map((r) => r.status).join('/')}) give one of each, numbered 1, 2; the nominee T returning its own escalation is ${e8SelfReturn.status} ${codeOf(e8SelfReturn)}`,
  )
  const c9Race: Race = await Promise.all([write('closure', C9, closeOf(C9), CF.who), write('closure', C9, closeOf(C9), CF2.who), write('closure', C9, closeOf(C9), CF.who)])
  const c9Reread = await get(`${base(C9)}/closure-history`)
  check(
    'T067',
    'Concurrent A8.9 closures: one commits',
    okCount(c9Race) === 1 && c9Race.filter((r) => r.status !== 201).every((r) => r.status === 409) && (c9Reread.body?.items ?? []).length === 1 && (await rowsOf(CLOSURE_TABLE, C9)) === 1 &&
      (await auditsOf('exception_closure.recorded', C9)) === 1,
    `CF, CF2 and CF again close C9 at once: ${c9Race.map((r) => r.status).join('/')}; the re-read holds exactly one closure and one audit`,
  )
  // T068 — DR's decision on PD commits; then CF's closure of PD is held after its insert, uncommitted, while PD's A8.9
  // reconstruction and A8.7 history are read: both answer at once from the committed snapshot, without the closure.
  const pdDecided = await recordResolutionEvent(PD.claimId, PD.intakeId, confirmOf(L(PD).requestId as string), DR.id)
  if (pdDecided.ok) L(PD).decisionId = pdDecided.value.resolutionEventId
  const holdPD = holdAt('exceptionClosure.inserted')
  const pdClosure = recordClosureEvent(PD.claimId, PD.intakeId, closeOf(PD), CF.id)
  const pdHeld = await settledWithin(holdPD.arrived, 30_000)
  const pdDuring = await Promise.race([get(`${base(PD)}/closure-reconstruction`), pause(10_000).then(() => null)])
  const pdHistoryDuring = await Promise.race([get(`${base(PD)}/closure-history`), pause(10_000).then(() => null)])
  holdPD.release()
  const pdClosed = await pdClosure
  clearConcurrencyProbes()
  const pdAfter = await get(`${base(PD)}/closure-reconstruction`)
  const pdClosureId = pdClosed.ok ? pdClosed.value.closureEventId : MISSING
  check(
    'T068',
    'Uncommitted writer never leaks into A8.9',
    pdDecided.ok && pdHeld && pdDuring?.status === 200 && pdDuring.body?.state === 'NO_CLOSURE' && pdDuring.body?.recordedClosure === null && pdHistoryDuring?.status === 200 &&
      (pdHistoryDuring.body?.items ?? []).length === 0 && pdClosed.ok && pdAfter.body?.state === 'CLOSED_INTERNAL' && pdAfter.body?.recordedClosure?.closureEventId === pdClosureId &&
      (pdAfter.body?.chain ?? []).some((e: any) => e.recordId === pdClosureId),
    `while CF's closure of PD was inserted but uncommitted (held ${pdHeld}), PD's reconstruction (${pdDuring?.status ?? 'blocked'}, ${pdDuring?.body?.state}) and closure history (${(pdHistoryDuring?.body?.items ?? []).length} events) answered at once from the committed snapshot, without it; after the commit the reconstruction is CLOSED_INTERNAL with that closure in its chain`,
  )
  // T069 — bounded fresh-transaction retry, in every owner's code and live on A8.6 (SA) and A8.9 (PR).
  const boundedRetry = (code: string) => /for \(let attempt = 1; ; \)/.test(code) && /isWriteConflict\(error\) \|\| isUniqueViolation\(error\)/.test(code) && /attempt <= MAX_[A-Z_]+_ATTEMPTS\) continue/.test(code)
  const saReport = (await get(`${base(SA)}/remediation-work-history`)).body?.items?.find((e: any) => e.eventCode === 'RECORD_WORK_REPORT')?.workEventId as string
  const workAlways = (() => {
    clearConcurrencyProbes()
    const state = { reached: 0 }
    const handler = async () => {
      state.reached += 1
      setConcurrencyProbe('exceptionRemediationWork.inserted', handler)
      throw new Error('could not serialize access due to read/write dependencies among transactions')
    }
    setConcurrencyProbe('exceptionRemediationWork.inserted', handler)
    return state
  })()
  const workExhausted = await recordWorkEvent(SA.claimId, SA.intakeId, verifyOf(saReport), VR.id)
  const workOnce = failOnce('exceptionRemediationWork.inserted', 'could not serialize access due to read/write dependencies among transactions')
  const workRetried = await recordWorkEvent(SA.claimId, SA.intakeId, verifyOf(saReport), VR.id)
  clearConcurrencyProbes()
  check(
    'T069',
    'Known conflicts: bounded fresh-transaction retry',
    ownerServices.filter((o) => o.tag !== 'A8.1').every((o) => boundedRetry(o.code)) && workExhausted.ok === false && workExhausted.code === 'EXCEPTION_REMEDIATION_WORK_CONFLICT' && workAlways.reached >= 2 &&
      workOnce.reached === 1 && workRetried.ok && (await rowsOf('exception_remediation_work_events', SA)) === 2,
    `every A8.2–A8.9 writer retries a serialization or unique conflict on a fresh transaction a bounded number of times; live on SA: a conflict on every attempt is refused CONFLICT after ${workAlways.reached} attempts with nothing written, one conflict is retried once and VR's verification is recorded exactly once`,
  )
  const lost = (() => {
    clearConcurrencyProbes()
    const state = { reached: 0 }
    const handler = async () => {
      state.reached += 1
      setConcurrencyProbe('exceptionClosure.audited', handler)
      throw new Error('Connection terminated unexpectedly')
    }
    setConcurrencyProbe('exceptionClosure.audited', handler)
    return state
  })()
  const unknownOutcome = await recordClosureEvent(PR.claimId, PR.intakeId, closeOf(PR), CF.id)
  clearConcurrencyProbes()
  const prRowsAfterLoss = await rowsOf(CLOSURE_TABLE, PR)
  const prClosed = await recordClosureEvent(PR.claimId, PR.intakeId, closeOf(PR), CF.id)
  const prAgain = await recordClosureEvent(PR.claimId, PR.intakeId, closeOf(PR), CF.id)
  check(
    'T070',
    'Unknown commit outcome reconciled, no blind append',
    ownerServices.filter((o) => o.tag !== 'A8.1').every((o) => /reconcileUnknownOutcome\(/.test(o.code)) && lost.reached >= 1 && unknownOutcome.ok === false && prRowsAfterLoss === 0 && prClosed.ok &&
      prAgain.ok === false && (await rowsOf(CLOSURE_TABLE, PR)) === 1 && (await auditsOf('exception_closure.recorded', PR)) === 1,
    `a connection lost after PR's closure audit was reconciled against the committed history (nothing committed: ${unknownOutcome.ok ? 'recorded' : unknownOutcome.code}), never re-appended blindly; the next confirmation records exactly one closure and one audit and a repeat is refused (${prAgain.ok ? 'recorded' : prAgain.code})`,
  )
  // ---------------------------------------------------------------- database keys, immutability and adversarial proof (T071–T080)
  section('Database keys, immutability and adversarial proof (every probe ALWAYS rolled back): the migration inventory and a scratch replay; on every A8 table a wrong tenant or Claim, a forged actor, a missing or foreign basis, a self-act, a bad sequence, UPDATE, DELETE and TRUNCATE are refused by the owner backstop')
  const migrationAt = (ref: string, name: string) => (ref === 'HEAD' || /^[0-9a-f]{7,40}$/.test(ref) ? sha256Of(Buffer.from(gitArgs(['show', `${ref}:backend/prisma/migrations/${name}/migration.sql`]))) : '')
  const A8_MIGRATIONS: [string, string][] = [
    ['20261028090000_a8_1_exception_intake', A85_MERGE], ['20261031090000_a8_2_exception_triage', A85_MERGE], ['20261103090000_a8_3_exception_investigation', A85_MERGE],
    ['20261105090000_a8_5_exception_remediation', A85_MERGE], ['20261107090000_a8_6_exception_remediation_work', A86_MERGE], ['20261110090000_a8_7_exception_resolution', A87_MERGE],
    ['20261111090000_a8_8_exception_escalation', A88_MERGE], ['20261112090000_a8_9_exception_closure', A89_MERGE],
  ]
  const a8MigrationsSame = A8_MIGRATIONS.every(([name, merge]) => migrationAt(merge, name) !== '' && migrationAt(merge, name) === migrationAt('HEAD', name))
  check(
    'T071',
    'A8.1–A8.9 migrations unchanged; count known',
    a8MigrationsSame && migrationDirs.length === migrationDirsAt('origin/main').length && appliedChecksums.length === migrationDirs.length && migrationDirs.at(-1)?.endsWith('20261112090000_a8_9_exception_closure') === true,
    `each of the ${A8_MIGRATIONS.length} A8 migrations is byte-identical at HEAD to its own accepted merge; ${migrationDirs.length} committed migrations, all applied, the newest A8.9's; A8.10 adds none`,
  )
  const replay = run('npm run db:verify:replay')
  const replayedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check(
    'T072',
    'Scratch replay applies every migration in order',
    replay.ok && replayedCount === migrationDirs.length && /ALL CHECKS PASS/.test(replay.output),
    `the empty-scratch replay applied ${replayedCount} migrations cleanly in order (ALL CHECKS PASS); the working database was never reset`,
  )
  const columnsOf = async (table: string) => (await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, table)).map((r) => r.c)
  const COLS = Object.fromEntries(await Promise.all(A8_TABLES.map(async (t) => [t, await columnsOf(t)] as const))) as Record<string, string[]>
  const has = (table: string, column: string) => COLS[table].includes(column)
  const a8HashesBeforeSql = await a8Hashes(homeIds)
  // Every direct attempt of this run, with the backstop message that refused it (T080, T124).
  const sqlMatrix: { label: string; refused: boolean; clean: boolean; expected: boolean; message: string }[] = []
  const direct = async (label: string, expect: RegExp, job: (tx: DbClient) => Promise<unknown>) => {
    const attempt = await rolledBack(job)
    const refused = !attempt.message.includes(NOT_COMMITTED)
    const dbMessage = (attempt.message.match(/Message: `([^`]*)`/) ?? [null, attempt.message])[1].replace(/\s+/g, ' ').slice(0, 260)
    const result = { label, refused, clean: attempt.clean, expected: refused && expect.test(dbMessage), message: dbMessage }
    sqlMatrix.push(result)
    return result
  }
  // A new row in `table` for intake `to`, copied from the newest event of intake `from`, at the next sequence (or
  // `step` past it), at the database's own time, with overrides — against the LIVE guards.
  const copyRow = (table: string, from: Intake, to: Intake, overrides = '', step = 1) => (tx: DbClient) =>
    table === INTAKE_TABLE
      ? tx.$executeRawUnsafe(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(t) || jsonb_build_object('id', gen_random_uuid(), 'recorded_at', now(), 'created_at', now()${overrides}))).* FROM ${table} t WHERE t.id = $1::uuid`, from.intakeId)
      : tx.$executeRawUnsafe(
          `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(t) || jsonb_build_object('id', gen_random_uuid(), 'exception_intake_id', $2::text, 'claim_id', $3::text, 'organization_id', $4::text, 'sequence', (SELECT coalesce(max(s.sequence), 0) FROM ${table} s WHERE s.exception_intake_id = $2::uuid) + ${step}, 'recorded_at', now(), 'created_at', now()${overrides}))).* FROM ${table} t WHERE t.exception_intake_id = $1::uuid ORDER BY t.sequence DESC LIMIT 1`,
          from.intakeId, to.intakeId, to.claimId, to.organizationId,
        )
  // The intake whose newest row each A8 table copies: S carries A8.1–A8.7; W4a's return and W1's closure are copied
  // into S as rows of S.
  const FROM_OF: Record<string, Intake> = {
    exception_intake_records: S, exception_triage_events: S, exception_investigation_events: S, exception_remediation_events: S, exception_remediation_work_events: S, exception_resolution_events: S,
    exception_escalation_events: W4A, exception_closure_events: W1,
  }
  const actor = (table: string, user: { id: string; membershipId: string }) =>
    `${has(table, 'recorded_by_user_id') ? `, 'recorded_by_user_id', '${user.id}'` : ''}${has(table, 'recorded_by_membership_id') ? `, 'recorded_by_membership_id', '${user.membershipId}'` : ''}${has(table, 'created_by_user_id') ? `, 'created_by_user_id', '${user.id}'` : ''}`
  const BACKSTOP = /exception_[a-z_]+: |append-only|duplicate key|cannot truncate a table referenced in a foreign key constraint|violates/
  const tenantProbes = []
  for (const table of A8_TABLES) {
    tenantProbes.push(await direct(`${table}: a new row under Org B`, /_coherence|_member|organization/, copyRow(table, FROM_OF[table], S, `, 'organization_id', '${otherOrg}'`)))
    tenantProbes.push(await direct(`${table}: a new row under another Claim`, /_coherence|claim|Claim/, copyRow(table, FROM_OF[table], S, `, 'claim_id', '${C9.claimId}'`)))
  }
  check(
    'T073',
    'Direct SQL wrong tenant or Claim refused',
    tenantProbes.every((p) => p.expected && p.clean),
    tenantProbes.every((p) => p.expected && p.clean) ? `on all ${A8_TABLES.length} A8 tables a direct row under Org B and a direct row under another Claim are refused by the owner's coherence backstop (${tenantProbes.length} probes, each rolled back, every table count unchanged)` : `refused otherwise: ${tenantProbes.filter((p) => !p.expected || !p.clean).map((p) => `${p.label} [${p.message.slice(0, 80)}]`).join('; ').slice(0, 500)}`,
  )
  const forgedProbes = []
  for (const table of A8_TABLES) forgedProbes.push(await direct(`${table}: an Org B member as the recorder`, /_member|_assignee|_verifier|_reviewer|independence|acting user|member of the owning/, copyRow(table, FROM_OF[table], S, actor(table, O))))
  for (const table of A8_TABLES.filter((t) => has(t, 'recorded_by_membership_id')))
    forgedProbes.push(await direct(`${table}: a membership not of the recording user`, /_member|acting user|membership/, copyRow(table, FROM_OF[table], S, `, 'recorded_by_membership_id', '${NR.membershipId}'`)))
  check(
    'T074',
    'Direct SQL forged user or membership refused',
    forgedProbes.every((p) => p.expected && p.clean),
    forgedProbes.every((p) => p.expected && p.clean) ? `${forgedProbes.length} direct rows naming an Org B member as the recorder, or a membership that is not the recording user's, are refused by the owner's member backstop; each rolled back` : `refused otherwise: ${forgedProbes.filter((p) => !p.expected || !p.clean).map((p) => `${p.label} [${p.message.slice(0, 80)}]`).join('; ').slice(0, 500)}`,
  )
  const basisProbes = [
    await direct('remediation: a proposal on a missing A8.3 finding', /_basis|_finding|finding|23503/, copyRow('exception_remediation_events', PP, NF, `, 'finding_event_id', '${MISSING}'`, 1)),
    await direct("remediation: a proposal on Org B's A8.3 finding", /_basis|_finding|finding|_coherence/, copyRow('exception_remediation_events', PP, NF, `, 'finding_event_id', '${L(F).findingId}'`, 1)),
    await direct('work: a report on a missing A8.5 approval', /_plan|approved|23503/, copyRow('exception_remediation_work_events', R6, NF, `, 'approved_proposal_event_id', '${MISSING}'`, 1)),
    await direct("work: a report on Org B's A8.5 approval", /_plan|approved|_coherence/, copyRow('exception_remediation_work_events', R6, NF, `, 'approved_proposal_event_id', '${L(F).proposalId}'`, 1)),
  ]
  check(
    'T075',
    'Direct SQL missing or foreign basis refused',
    basisProbes.every((p) => p.expected && p.clean),
    basisProbes.every((p) => p.expected && p.clean) ? 'a direct A8.5 proposal on a missing or Org B finding and a direct A8.6 report on a missing or Org B approval are each refused by the basis or plan backstop; rolled back' : `refused otherwise: ${basisProbes.filter((p) => !p.expected || !p.clean).map((p) => `${p.label} [${p.message.slice(0, 80)}]`).join('; ').slice(0, 500)}`,
  )
  const r6ReportId = r6Race.find((r) => r.status === 201)?.body?.workEventId as string
  const selfProbes = [
    await direct('work: the reporter verifies its own report', /never verified by its own reporter|_verifier/,
      copyRow('exception_remediation_work_events', W1, R6, `, 'work_report_event_id', '${r6ReportId}', 'approved_proposal_event_id', '${L(R6).proposalId}'${actor('exception_remediation_work_events', M4)}`)),
    await direct('resolution: the requester decides its own request', /never decided by its own requester|_reviewer/,
      copyRow('exception_resolution_events', W1, SD, `, 'request_event_id', '${L(SD).requestId}'${actor('exception_resolution_events', M4)}`)),
    await direct("closure: A8.7's decider closes", /closure_independence/,
      copyRow(CLOSURE_TABLE, W1, S, `, 'resolution_decision_event_id', '${L(S).decisionId}', 'basis_reference_id', '${L(S).decisionId}'${actor(CLOSURE_TABLE, DR)}`)),
    await direct("closure: A8.7's requester closes", /closure_independence/,
      copyRow(CLOSURE_TABLE, W1, S, `, 'resolution_decision_event_id', '${L(S).decisionId}', 'basis_reference_id', '${L(S).decisionId}'${actor(CLOSURE_TABLE, M4)}`)),
  ]
  check(
    'T076',
    'Direct SQL self-verification/decision/closure refused',
    selfProbes.every((p) => p.expected && p.clean),
    selfProbes.every((p) => p.expected && p.clean) ? "a direct verification by R6's reporter, a direct decision of SD's request by its requester, and direct closures of S by its A8.7 decider and by its requester are each refused by the owner's independence backstop; rolled back" : `refused otherwise: ${selfProbes.filter((p) => !p.expected || !p.clean).map((p) => `${p.label} [${p.message.slice(0, 80)}]`).join('; ').slice(0, 500)}`,
  )
  const sequenceProbes = []
  for (const table of A8_TABLES.filter((t) => t !== INTAKE_TABLE && t !== CLOSURE_TABLE && t !== 'exception_escalation_events')) {
    sequenceProbes.push(await direct(`${table}: a gapped sequence`, /_sequence|numbered/, copyRow(table, S, S, '', 5)))
    sequenceProbes.push(await direct(`${table}: a duplicated sequence`, /_sequence|duplicate key|23505/, copyRow(table, S, S, '', 0)))
  }
  // E8's acknowledgement copied as EQ's next event (EQ awaits acknowledgement, unresolved): only the sequence is wrong.
  const eqAck = `, 'escalation_event_id', '${L(EQ).escalationId}'${actor('exception_escalation_events', T)}`
  sequenceProbes.push(await direct('escalation: a gapped sequence', /_sequence|numbered/, copyRow('exception_escalation_events', E8, EQ, eqAck, 5)))
  sequenceProbes.push(await direct('escalation: a duplicated sequence', /_sequence|duplicate key|23505/, copyRow('exception_escalation_events', E8, EQ, eqAck, 0)))
  sequenceProbes.push(await direct('closure: a second closure of W1', /closure|duplicate key|23505/, copyRow(CLOSURE_TABLE, W1, W1, actor(CLOSURE_TABLE, CF2), 1)))
  sequenceProbes.push(await direct('intake: a duplicate intake of the same source', /duplicate key|23505|_conflict|already/, copyRow(INTAKE_TABLE, S, S)))
  check(
    'T077',
    'Direct SQL bad sequence or duplicate refused',
    sequenceProbes.every((p) => p.expected && p.clean),
    sequenceProbes.every((p) => p.expected && p.clean) ? `a gapped and a duplicated sequence on each of the ${A8_TABLES.length - 2} A8 event tables, a second closure of W1 and a duplicate intake of the same source are refused by the sequence or unique backstop (${sequenceProbes.length} probes); rolled back` : `refused otherwise: ${sequenceProbes.filter((p) => !p.expected || !p.clean).map((p) => `${p.label} [${p.message.slice(0, 80)}]`).join('; ').slice(0, 500)}`,
  )
  const idColumn = (table: string) => (table === INTAKE_TABLE ? 'id' : 'exception_intake_id')
  const mutationProbes = []
  for (const table of A8_TABLES) {
    const k = FROM_OF[table]
    mutationProbes.push(await direct(`${table}: a no-op UPDATE`, /append-only/, (tx) => tx.$executeRawUnsafe(`UPDATE ${table} SET id = id WHERE ${idColumn(table)} = $1::uuid`, k.intakeId)))
    mutationProbes.push(await direct(`${table}: an UPDATE of the recorded time`, /append-only/, (tx) => tx.$executeRawUnsafe(`UPDATE ${table} SET ${has(table, 'recorded_at') ? 'recorded_at' : 'created_at'} = now() WHERE ${idColumn(table)} = $1::uuid`, k.intakeId)))
    mutationProbes.push(await direct(`${table}: a DELETE`, /append-only/, (tx) => tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${idColumn(table)} = $1::uuid`, k.intakeId)))
  }
  check(
    'T078',
    'UPDATE and DELETE of A8 history refused',
    mutationProbes.every((p) => p.expected && p.clean),
    mutationProbes.every((p) => p.expected && p.clean) ? `a no-op UPDATE, a changed recorded time and a DELETE are refused as append-only on all ${A8_TABLES.length} A8 tables (${mutationProbes.length} probes); rolled back` : `refused otherwise: ${mutationProbes.filter((p) => !p.expected || !p.clean).map((p) => `${p.label} [${p.message.slice(0, 80)}]`).join('; ').slice(0, 500)}`,
  )
  const truncateProbes = []
  for (const table of A8_TABLES) {
    truncateProbes.push(await direct(`${table}: TRUNCATE`, /append-only|cannot truncate a table referenced in a foreign key constraint/, (tx) => tx.$executeRawUnsafe(`TRUNCATE ${table}`)))
    truncateProbes.push(await direct(`${table}: TRUNCATE CASCADE`, /append-only/, (tx) => tx.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`)))
  }
  check(
    'T079',
    'TRUNCATE and TRUNCATE CASCADE refused',
    truncateProbes.every((p) => p.expected && p.clean),
    truncateProbes.every((p) => p.expected && p.clean) ? `TRUNCATE CASCADE is refused as append-only on all ${A8_TABLES.length} A8 tables, and a plain TRUNCATE is refused (by the append-only trigger, or first by Postgres' foreign-key rule where the table is referenced); rolled back` : `refused otherwise: ${truncateProbes.filter((p) => !p.expected || !p.clean).map((p) => `${p.label} [${p.message.slice(0, 80)}]`).join('; ').slice(0, 500)}`,
  )
  const appliedAfterSql = await prisma.$queryRawUnsafe<{ migration_name: string; checksum: string }[]>(`SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)
  const sqlMatrixLog = `a810-sql-matrix-${runId}.log`
  writeFileSync(
    sqlMatrixLog,
    [`A8.10 direct SQL matrix, run ${runId} (every probe rolled back)`, ...sqlMatrix.map((p, i) => `${String(i + 1).padStart(3)}. ${p.refused ? 'REFUSED' : 'ACCEPTED'} ${p.expected ? 'by its backstop' : 'UNEXPECTED'} ${p.clean ? 'clean' : 'DIRTY'} | ${p.label} | ${p.message}`), ''].join('\n'),
  )
  const unexpected = sqlMatrix.filter((p) => !p.expected || !p.clean || !BACKSTOP.test(p.message))
  check(
    'T080',
    'Every SQL probe rolled back; nothing changed',
    sqlMatrix.length >= 70 && unexpected.length === 0 && same(await a8Hashes(homeIds), a8HashesBeforeSql) && same(appliedAfterSql, appliedChecksums) && existsSync(sqlMatrixLog),
    unexpected.length === 0
      ? `${sqlMatrix.length} direct probes, every one refused by its owner's backstop and rolled back with every counted table unchanged; all A8 rows of the run hash as before; the migration table is identical; the matrix is archived in backend/${sqlMatrixLog} (SHA-256 ${existsSync(sqlMatrixLog) ? sha256Of(readFileSync(sqlMatrixLog)) : 'missing'})`
      : `not refused as expected: ${unexpected.map((p) => `${p.label} [${p.message.slice(0, 90)}]`).join('; ').slice(0, 600)}`,
  )
  // ---------------------------------------------------------------- W7 fixtures: synthetic CRG editions by service date
  // Exactly as the accepted CRG-01B suite builds them, through the CRG owners' own writers: a synthetic authority with
  // APPROVED ICD-10-CM rights, one dataset with edition 2021 (2021-01-01 – 2026-12-31, active) and edition 2027
  // (2027-01-01 –, activated later), an ENABLED validation scope; A5-VAL-2 runs through A5.8's own write path, then the A6
  // owners. No real code set, rights or DHA scope is touched.
  const snapBeforeW7 = await snap()
  const codingRowsBefore = await hashOf(`SELECT r.id, r.validation_run_id, r.reference_dataset_version_id FROM crg_validation_code_receipts r WHERE r.recorded_at < $1::timestamptz`, runStartedAt.toISOString())
  const manifestsBefore = await hashOf(`SELECT m.* FROM crg_validation_receipt_manifests m WHERE m.recorded_at < $1::timestamptz`, runStartedAt.toISOString())
  const okValue = <V>(label: string, result: { ok: true; value: V } | { ok: false; message: string }): V => {
    if (!result.ok) throw new Error(`fixture ${label} was refused: ${result.message}`)
    return result.value
  }
  const runToken = runId.slice(5)
  const JUR = 'AE-DU'
  const AUTH = `SYN-A810-${runToken}`
  const Q1 = `Q${runToken}.1`
  const Q2 = `Q${runToken}.2`
  const Q3 = `Q${runToken}.3`
  const maintenanceActor = { actorRef: `a8-phase-closure-harness:${runId}`, reason: 'synthetic A8.10 W7 fixture' }
  type Release = { datasetId: string; versionId: string }
  const artifactOf = (label: string, codes: readonly string[]) => {
    const lines = codes.map((code, i) => `${label}-r${i + 1}\t${code}`)
    const bytes = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8')
    const rows = codes.map((code, i) => ({ sourceRowId: `${label}-r${i + 1}`, code, sourceRowSha256: sha256Of(Buffer.from(lines[i], 'utf8')) }))
    const fingerprint = sha256Of(Buffer.from([...rows].sort((a, b) => Buffer.compare(Buffer.from(a.sourceRowId), Buffer.from(b.sourceRowId))).map((r) => `${r.sourceRowId}\t${r.code}\t${r.sourceRowSha256}\n`).join(''), 'utf8'))
    return { bytes, sha: sha256Of(bytes), fingerprint }
  }
  okValue('rights', await recordRightsDecision({ jurisdictionCode: JUR, authorityCode: AUTH, codeSystem: 'ICD-10-CM', rightsStatus: 'APPROVED', decisionReference: `synthetic fixture ${runId}` }))
  const DXSET = okValue('dataset', await importReferenceDataset({ datasetKey: key('w7dx'), displayName: `${runId} w7dx`, jurisdictionCode: JUR, authorityCode: AUTH })).id
  okValue('mapping', await registerDatasetCodeSystem({ datasetId: DXSET, codeSystem: 'ICD-10-CM', purpose: 'CLAIM_CODING' }))
  const editionOf = async (label: string, from: string, to: string | null, codes: string[], activate: boolean): Promise<Release> => {
    const artifact = artifactOf(label, codes)
    const versionId = okValue(`${label} version`, await importReferenceDatasetVersion({ datasetId: DXSET, sourceVersionId: null, version: label, retrievedAt: new Date().toISOString(), effectiveFrom: from, effectiveTo: to, contentHash: artifact.sha })).id
    okValue(
      `${label} import`,
      (await importRelease({ datasetVersionId: versionId, artifactFormat: 'CRG-SYNTHETIC-TSV-1', artifactBase64: artifact.bytes.toString('base64'), sourceFileSha256: artifact.sha, membershipFingerprintSha256: artifact.fingerprint, sourceUri: `synthetic:${runId}/${label}`, publisher: 'Synthetic A8.10 fixture', expectedRowCount: codes.length })) as never,
    )
    if (activate) {
      okValue('validate', await validateReferenceDatasetVersion(versionId, 'VALIDATED', maintenanceActor))
      okValue('activate', await activateReferenceDatasetVersion(versionId, maintenanceActor))
    }
    return { datasetId: DXSET, versionId }
  }
  const E2021 = await editionOf('2021', '2021-01-01', '2026-12-31', [Q1, Q2], true)
  const E2027 = await editionOf('2027', '2027-01-01', null, [Q1, Q3], false)
  await recordValidationScope({ jurisdictionCode: JUR, authorityCode: AUTH, scopeStatus: 'ENABLED', decisionReference: `synthetic fixture ${runId}` })
  const w7At = (path: string, body: unknown) => post(path, body, asAdmin)
  const w7Clinician = must('w7 clinician', (await w7At(`/api/organizations/${org}/clinicians`, { displayName: `${runId} w7 clinician` })).body)
  const w7Facility = must('w7 facility', (await w7At(`/api/organizations/${org}/facilities`, { name: `${runId} w7 facility` })).body)
  const w7Profile = must('w7 profile', (await w7At(`/api/facilities/${w7Facility.id}/regulatory-profiles`, { jurisdictionCode: JUR, regulatoryAuthorityCode: AUTH, effectiveFrom: '2020-01-01', effectiveTo: null })).body)
  if ((await w7At(`/api/facility-regulatory-profiles/${w7Profile.id}/activate`, {})).status !== 200) throw new Error('fixture w7 profile activation failed')
  must('w7 assignment', (await w7At(`/api/clinicians/${w7Clinician.id}/facility-assignments`, { facilityId: w7Facility.id, effectiveFrom: '2020-01-01', effectiveTo: null })).body)
  const w7Patient = must('w7 patient', (await w7At(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-w7-P`, dateOfBirth: '1990-01-01' })).body)
  const w7Dx = async (code: string) => must(`w7 diagnosis ${code}`, (await w7At(`/api/organizations/${org}/diagnosis-codes`, { code, displayName: `${runId} synthetic diagnosis` })).body).id as string
  const DXQ2 = await w7Dx(Q2)
  const DXQ3 = await w7Dx(Q3)
  const w7Svc = must('w7 service', (await w7At(`/api/organizations/${org}/services`, { internalCode: key('W7SB'), displayName: `${runId} w7 service` })).body)
  const w7Payer = must('w7 payer', (await w7At(`/api/organizations/${org}/payers`, { displayName: `${runId} w7 payer` })).body)
  const w7Contract = must('w7 contract', (await w7At(`/api/organizations/${org}/provider-contracts`, { contractKey: key('W7C'), displayName: `${runId} w7 contract`, payerId: w7Payer.id, effectiveFrom: '2020-01-01', effectiveTo: null })).body)
  must('w7 contract facility', (await w7At(`/api/provider-contracts/${w7Contract.id}/contract-facilities`, { facilityId: w7Facility.id })).body)
  const w7Schedule = must('w7 schedule', (await w7At(`/api/provider-contracts/${w7Contract.id}/tariff-schedules`, { tariffKey: key('W7T'), displayName: `${runId} w7 tariff` })).body)
  const w7Version = must('w7 tariff version', (await w7At(`/api/tariff-schedules/${w7Schedule.id}/versions`, { version: key('W7V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  must('w7 rate', (await w7At(`/api/tariff-schedule-versions/${w7Version.id}/rates`, { modifierCodes: [], currencyCode: 'AED', selectorKind: 'SERVICE', serviceId: w7Svc.id, unitTariffAmount: '12.1250' })).body)
  if ((await w7At(`/api/tariff-schedule-versions/${w7Version.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error('fixture w7: the tariff version could not be verified')
  type Built = { id: string; diagnoses: string[]; activities: string[] }
  const w7Encounter = async (serviceDate: string, diagnosisCodeId: string): Promise<Built> => {
    const encounter = must(`w7 encounter ${serviceDate}`, (await w7At(`/api/patients/${w7Patient.id}/encounters`, { facilityId: w7Facility.id, clinicianId: w7Clinician.id, serviceDate, insuranceMembershipId: null })).body)
    const dxId = must('w7 encounter diagnosis', (await w7At(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId })).body).id as string
    const actId = must('w7 service activity', (await w7At(`/api/encounters/${encounter.id}/activities`, { serviceId: w7Svc.id, quantity: '1' })).body).id as string
    return { id: encounter.id, diagnoses: [dxId], activities: [actId] }
  }
  const w7Context = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId, insuranceMembershipId: null,
      payerId: w7Payer.id as string | null, tpaId: null, networkId: null, insuranceProductId: null, providerContractId: w7Contract.id as string | null, tariffScheduleId: w7Schedule.id as string | null,
      tariffScheduleVersionId: w7Version.id as string | null,
    }
  }
  const synthetic = (layer: string, findingCode: string, extra: Record<string, unknown> = {}) => ({ layer, outcome: 'PASS', findingCode, message: 'Synthetic finding.', ...extra })
  // A5-VAL-2 through A5.8's own write path: the recorder, then the CRG coding-release findings and receipts on the same
  // transaction.
  const v2Run = async (built: Built) =>
    prisma.$transaction(async (tx) => {
      const coding = await evaluateCodingRelease(built.id, tx)
      const findings = [
        synthetic('TECHNICAL', 'TECHNICAL_CONTEXT_VALID'),
        ...built.diagnoses.map((encounterDiagnosisId) => synthetic('CODING', 'SYNTHETIC_PASS', { encounterDiagnosisId })),
        ...built.activities.map((encounterActivityId) => synthetic('CONTRACT', 'SYNTHETIC_PASS', { encounterActivityId })),
        ...coding.drafts.map((d) => ({ layer: 'CODING', outcome: d.outcome, findingCode: d.findingCode, message: d.message, encounterDiagnosisId: d.encounterDiagnosisId, encounterActivityId: d.encounterActivityId, referenceDatasetVersionId: d.referenceDatasetVersionId })),
      ]
      const recorded = await recordValidationRunInTransaction({ encounterId: built.id, contextSnapshot: await w7Context(built.id), validatorVersion: 'A5-VAL-2', findings }, creatorId, tx)
      if (!recorded.ok) throw new Error(`fixture w7 run refused: ${recorded.message}`)
      await recordCodingReceipts(recorded.value.id, built.id, coding.plans, tx)
      return recorded.value.id
    })
  type Claimed = { claimId: string; pricingRunId: string; draft: { id: string; assemblyFingerprint: string }; approvalId: string; submissionId: string }
  const claimAndFreeze = async (built: Built, validationRunId: string): Promise<Claimed> => {
    const assessed = await w7At(`/api/validation-runs/${validationRunId}/readiness-assessments`, {})
    if (assessed.status !== 201 || assessed.body.state !== 'READY_FOR_REVIEW') throw new Error(`fixture w7 readiness: ${assessed.status} ${JSON.stringify(assessed.body).slice(0, 200)}`)
    const claim = must('w7 claim', (await w7At(`/api/pre-claim-readiness-assessments/${assessed.body.id}/claims`, {})).body)
    const lineId = must('w7 claim line', (await w7At(`/api/claims/${claim.id}/lines`, { encounterActivityId: built.activities[0] })).body).id
    const claimDx = must('w7 claim diagnosis', (await w7At(`/api/claims/${claim.id}/diagnoses`, { encounterDiagnosisId: built.diagnoses[0], roleCode: 'PRIMARY' })).body).id
    if ((await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds: [claimDx] })).status !== 200) throw new Error('fixture w7 pointers refused')
    const pricing = await w7At(`/api/claims/${claim.id}/pricing-runs`, {})
    const draft = await w7At(`/api/claims/${claim.id}/draft-assessments`, { pricingRunId: pricing.body.id })
    if (draft.status !== 201 || draft.body.outcome !== 'REVIEWABLE') throw new Error(`fixture w7 draft ${draft.status} ${draft.body?.outcome}`)
    const approved = await post(`/api/claims/${claim.id}/review-decisions`, { draftAssessmentId: draft.body.id, assemblyFingerprint: draft.body.assemblyFingerprint, decisionCode: 'APPROVE' }, B.who)
    const frozen = await w7At(`/api/claims/${claim.id}/submissions`, { draftAssessmentId: draft.body.id, approvalDecisionId: approved.body?.decision?.id })
    if (frozen.status !== 201) throw new Error(`fixture w7 freeze ${frozen.status} ${errorCode(frozen.body) ?? ''}`)
    return { claimId: claim.id, pricingRunId: pricing.body.id, draft: draft.body, approvalId: approved.body.decision.id, submissionId: frozen.body.submissionId }
  }
  // W7a: a service on 2026-12-31 validated and frozen under 2021; then 2027 is activated; W7b: a service on 2027-01-01.
  const EK = await w7Encounter('2026-12-31', DXQ2)
  const K = await claimAndFreeze(EK, await v2Run(EK))
  okValue('validate 2027', await validateReferenceDatasetVersion(E2027.versionId, 'VALIDATED', maintenanceActor))
  okValue('activate 2027', await activateReferenceDatasetVersion(E2027.versionId, maintenanceActor))
  const EN = await w7Encounter('2027-01-01', DXQ3)
  const N = await claimAndFreeze(EN, await v2Run(EN))
  // W7a continued: K corrected after 2027 is active (revoke, a fresh draft and approval, freeze again, linked through A6.9).
  const kRevoke = await post(`/api/claims/${K.claimId}/review-decisions`, { draftAssessmentId: K.draft.id, assemblyFingerprint: K.draft.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: K.approvalId }, B.who)
  const kDraft2 = await w7At(`/api/claims/${K.claimId}/draft-assessments`, { pricingRunId: K.pricingRunId })
  const kApprove2 = await post(`/api/claims/${K.claimId}/review-decisions`, { draftAssessmentId: kDraft2.body.id, assemblyFingerprint: kDraft2.body.assemblyFingerprint, decisionCode: 'APPROVE' }, B.who)
  const kFreeze2 = await w7At(`/api/claims/${K.claimId}/submissions`, { draftAssessmentId: kDraft2.body.id, approvalDecisionId: kApprove2.body?.decision?.id })
  const kLink = await w7At(`/api/claims/${K.claimId}/correction-links`, { priorSubmissionId: K.submissionId, correctedSubmissionId: kFreeze2.body?.submissionId, reasonCode: 'CORRECTED_CODING' })
  const kFresh = await prisma.$transaction(async (tx) => getCodingReleaseCheckOf(EK.id, tx))
  const provenance = async (submissionId: string) => get(`/api/claim-submissions/${submissionId}/coding-provenance`)
  const editionIn = (p: { body: any }) => (p.body?.manifest?.receipts ?? []).find((r: any) => r.subjectKind === 'DIAGNOSIS')?.referenceDatasetVersionId as string | undefined
  const kProv = await provenance(K.submissionId)
  const k2Prov = kFreeze2.status === 201 ? await provenance(kFreeze2.body.submissionId) : { status: 0, body: {} }
  const nProv = await provenance(N.submissionId)
  const w1Prov = await provenance(W1.freezes[0])
  progress(
    `W7 fixtures ready: synthetic authority ${AUTH} (ICD-10-CM 2021 to 2026-12-31 and 2027 from 2027-01-01, rights APPROVED, scope ENABLED); K (2026-12-31) frozen under 2021, then 2027 activated, N (2027-01-01) frozen, K corrected and re-frozen (${kFreeze2.status}) and linked (${kLink.status})`,
  )

  // ---------------------------------------------------------------- A6/A7 and CRG-A/B noninterference (T081–T090)
  section('A6/A7 and CRG-A/B noninterference: frozen payloads byte-identical, A6.8 never a payer acknowledgement, A6.9 chains immutable, A7 facts and traces read-only, absent remittance never zero, CRG-A and CRG-B untouched by A8, legacy V1 never backfilled, no A9 path')
  const snapAfterA8 = snapBeforeW7
  const w1Freezes = await prisma.claimFreeze.findMany({ where: { claimId: { in: runClaims } }, select: { id: true, canonicalPayloadBytes: true, payloadSha256: true } })
  check(
    'T081',
    'A6.7 frozen payload bytes and digest identical',
    snapAfterA8.freezes === snapBefore.freezes && w1Freezes.length === runClaims.length * 2 && w1Freezes.every((f) => sha256Of(f.canonicalPayloadBytes) === f.payloadSha256),
    `every one of the ${w1Freezes.length} A6.7 freezes of this run's A8 Claims (and each sealed manifest) hashes exactly as before the A8.9 closures and every later A8 write, and each frozen payload's bytes still hash to its stored SHA-256`,
  )
  const lifecycleCodes = await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT DISTINCT e.event_code AS c FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims)
  const w1Lifecycle = await get(`/api/claim-submissions/${W1.freezes[0]}/lifecycle`)
  check(
    'T082',
    'A6.8 lifecycle never a payer acknowledgement',
    snapAfterA8.lifecycle === snapBefore.lifecycle && lifecycleCodes.every((r) => !/ACK|ACCEPT|ADJUDIC|PAID|REMIT|PAYER|TRANSMIT|SENT/.test(r.c)) && w1Lifecycle.status === 200 && !/PAYER_ACK|ACCEPTED_BY_PAYER|ADJUDICATED|PAID/.test(JSON.stringify(w1Lifecycle.body)),
    `the A6.8 lifecycle of every run Claim is unchanged by A8 and holds only internal events (${lifecycleCodes.map((r) => r.c).join(', ') || 'none'}); W1's lifecycle read answers no payer acknowledgement`,
  )
  const a8ModuleCode = OWNERS.map((o) => committedFiles(`backend/src/modules/${o.module}`).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f)).map((f) => committedCode(f)).join('\n')).join('\n')
  const writerImports = [...a8ModuleCode.matchAll(/import \{([^}]+)\} from '\.\.\/(claim-correction|claim-submission|claim-lifecycle|revenue-[a-z-]+|evidence-[a-z-]+|case-prerequisite|closure-basis-trace|coding-release|coding-validation|reference-dataset)\/[^']+'/g)]
    .flatMap((m) => m[1].split(',').map((n) => n.trim()))
    .filter((n) => /^(record|create|insert|update|delete|import|activate|validate|register|freeze|link|correct|write)/i.test(n))
  check(
    'T083',
    'A6.9 correction chains immutable; A8 never writes',
    snapAfterA8.links === snapBefore.links && snapAfterA8.claims === snapBefore.claims && writerImports.length === 0,
    `the A6.9 correction links and the Claims of the run hash as before the A8.9 closures and every later A8 write; no A8 owner imports any A6, A7 or CRG writer (only readers)`,
  )
  const w1Timeline = await get(`/api/claims/${W1.claimId}/revenue-evidence-timeline`)
  const w1TimelineAgain = await get(`/api/claims/${W1.claimId}/revenue-evidence-timeline`)
  check(
    'T084',
    'A7.1–A7.5 facts not reclassified by A8',
    snapAfterA8.a7 === snapBefore.a7 && w1Timeline.status === 409 && withoutEvaluatedAt(w1Timeline.body) === withoutEvaluatedAt(w1TimelineAgain.body),
    `the A7.1–A7.6 record counts are unchanged by every A8 write; W1's contradiction is still reported by its own A7.7 owner (${w1Timeline.status} ${codeOf(w1Timeline)}) after its A8.9 closure — A8 closed the internal process, it did not repair or reclassify the revenue evidence`,
  )
  const nTimeline = await get(`/api/claims/${N.claimId}/revenue-evidence-timeline`)
  const nDelta = await get(`/api/claims/${N.claimId}/revenue-evidence-delta`)
  const nContinuity = await get(`/api/claims/${N.claimId}/revenue-evidence-continuity`)
  const nContinuityAgain = await get(`/api/claims/${N.claimId}/revenue-evidence-continuity`)
  check(
    'T085',
    'A7.6–A7.9 trace/timeline/delta/continuity read-only',
    [nTimeline, nDelta, nContinuity].every((r) => r.status === 200) && withoutEvaluatedAt(nContinuity.body) === withoutEvaluatedAt(nContinuityAgain.body) && snapAfterA8.a7 === snapBefore.a7,
    "N's A7.7 timeline, A7.8 delta and A7.9 continuity answer 200 and repeat byte-identically; A8 wrote no A7 record",
  )
  const continuityText = JSON.stringify(nContinuity.body ?? {})
  const GAPS = ['CASE_NOT_RECORDED', 'PREREQUISITE_NOT_RECORDED', 'NO_SOURCE_BASIS', 'SOURCE_CHAIN_INCOMPLETE', 'REVIEW_REQUIRED', 'UNSUPPORTED_SOURCE', 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT']
  const nGaps = GAPS.filter((g) => continuityText.includes(`"${g}"`))
  check(
    'T086',
    'Absent remittance never zero, paid or denied',
    nGaps.length > 0 && !/"(paidAmount|balance|outstandingBalance|denied|remittedAmount)"\s*:\s*("?0(\.0+)?"?)/.test(continuityText) && !/\bPAID\b|\bDENIED\b|SETTLED/.test(continuityText),
    `N's A7.9 continuity reports the controlled gap ${nGaps.join(', ') || 'none'} for its freeze: no external financial or remittance fact exists, and nothing reads it as a zero balance, paid or denied`,
  )
  check(
    'T087',
    'CRG-A edition/rights/source owner untouched by A8',
    snapAfterA8.coding === snapBefore.coding && !/coding-release\/coding-release\.(service|repository)\.ts'[^\n]*\b(record|import|register|activate)/.test(a8ModuleCode),
    'the CRG-01A dataset, rights, import, membership and retirement tables and the A2 code masters were unchanged by every A8 write of this run (the W7 editions are created afterwards by the CRG owner itself); no A8 owner calls a CRG-A writer',
  )
  check(
    'T088',
    'CRG-B receipts, manifests and links unchanged',
    codingRowsBefore === (await hashOf(`SELECT r.id, r.validation_run_id, r.reference_dataset_version_id FROM crg_validation_code_receipts r WHERE r.recorded_at < $1::timestamptz`, runStartedAt.toISOString())) &&
      manifestsBefore === (await hashOf(`SELECT m.* FROM crg_validation_receipt_manifests m WHERE m.recorded_at < $1::timestamptz`, runStartedAt.toISOString())) && kProv.status === 200 && kProv.body?.verificationStatus === 'VERIFIED_AS_RECORDED',
    "every CRG-B coding receipt and sealed manifest that existed before this run hashes exactly as before; W7's own V2 freeze K reads VERIFIED_AS_RECORDED through coding-provenance",
  )
  const w1ReconSubs = (w1Recon.body?.submissions ?? []) as any[]
  check(
    'T089',
    'Legacy V1 stays LEGACY_PROVENANCE_UNVERIFIED',
    w1Prov.status === 200 && w1Prov.body?.verificationStatus === 'LEGACY_PROVENANCE_UNVERIFIED' && w1Prov.body?.manifest === null && w1ReconSubs.length === 2 && w1ReconSubs.every((s) => s.codingVerificationStatus === 'LEGACY_PROVENANCE_UNVERIFIED'),
    "W1's A5-VAL-1 freezes read LEGACY_PROVENANCE_UNVERIFIED through coding-provenance (no manifest) and in the A8.9 reconstruction — never backfilled as verified",
  )
  const a9Like = [...changedPaths, ...headTree.filter((p) => /^backend\/src\//.test(p))].filter((p) => /integration\/a9|eclaimlink|dhpo|payer-adapter|remittance-parser|transmission|sftp|era-835|x12/i.test(p))
  check(
    'T090',
    'No A9 eClaimLink/DHPO, payer adapter or transport',
    a9Like.length === 0 && !/https?:\/\/(?!localhost)/.test(thisHarness.replace(/services\.dha\.gov\.ae/g, '')) && !/\b(net|tls|dgram)\b'|from 'node:(net|tls|dgram)'/.test(thisHarness),
    'no A9, eClaimLink, DHPO, payer adapter, remittance parser or transport path exists at HEAD or in this diff; this harness talks only to the local API and database',
  )
  // ---------------------------------------------------------------- snapshots, timing and Dubai service-date semantics (T091–T100)
  section('Snapshots, timing and Dubai service-date semantics: one READ ONLY snapshot per reconstruction; reads write nothing and lock nothing; present-day role changes never alter history; deterministic repeats; Asia/Dubai, UTC and another zone equal; Arabic UTF-8 safe; W7 editions by original service date; no real DHA activation')
  const closureService = serviceCodeAt('exception-closure')
  const snapshotCode = committedCode('backend/src/shared/database/read-snapshot.ts')
  const fnBody = (code: string, name: string) => {
    const at = code.indexOf(`function ${name}(`)
    return at < 0 ? '' : code.slice(at, code.indexOf('\n}\n', at))
  }
  const reconstructionBody = fnBody(closureService, 'getClosureReconstructionOf')
  const ownersBody = fnBody(closureService, 'ownersOf')
  check(
    'T091',
    'Reconstruction reads in one READ ONLY snapshot',
    /SET TRANSACTION READ ONLY/.test(snapshotCode) && /RepeatableRead/.test(snapshotCode) && /withReadSnapshot\(undefined, \(tx\) => getClosureReconstructionOf\(claimId, exceptionIntakeId, tx\)\)/.test(closureService) &&
      /ownersOf\(claim, parent, tx\)/.test(reconstructionBody) && /intakeOf\([^)]*, tx\)/.test(reconstructionBody) && (ownersBody.match(/, tx\)/g) ?? []).length >= 8 && pdDuring?.body?.state === 'NO_CLOSURE',
    "the A8.9 reconstruction runs inside withReadSnapshot (REPEATABLE READ, SET TRANSACTION READ ONLY) and hands that one transaction to every owner reader it calls; T068 showed it answering from the committed snapshot while a writer was uncommitted",
  )
  const countsBeforeReads = await counts()
  const auditsCountBefore = await prisma.auditEvent.count()
  const readBurst = Promise.all(Array.from({ length: 12 }, () => get(`${base(W1)}/closure-reconstruction`)))
  const lockWhileReading = await rolledBack((tx) => tx.$executeRawUnsafe(`SELECT id FROM claims WHERE id = $1::uuid FOR UPDATE NOWAIT`, W1.claimId))
  const burst = await readBurst
  const fullReads = await readAll(W1, asViewer)
  check(
    'T092',
    'Reads write nothing, audit nothing, lock nothing',
    burst.every((r) => r.status === 200) && Object.values(fullReads).every((r) => r.status === 200) && (await unchanged(countsBeforeReads)) && (await prisma.auditEvent.count()) === auditsCountBefore &&
      lockWhileReading.message.includes(NOT_COMMITTED) && !lockWhileReading.message.includes('55P03'),
    `${burst.length} reconstructions and the Viewer's ${Object.keys(fullReads).length} owner reads wrote no row and no audit; while they ran, W1's Claim could still be locked FOR UPDATE NOWAIT (no read holds a Claim lock)`,
  )
  const m1Roles = await prisma.membershipRole.findMany({ where: { membershipId: M1.membershipId }, select: { roleId: true } })
  const w1BeforeRoleChange = await readAll(W1)
  await prisma.membershipRole.deleteMany({ where: { membershipId: M1.membershipId } })
  const w1WithoutM1Role = await readAll(W1)
  for (const r of m1Roles) await prisma.membershipRole.create({ data: { membershipId: M1.membershipId, roleId: r.roleId } })
  check(
    'T093',
    'Role change after the fact leaves history',
    m1Roles.length > 0 && dtoText(w1WithoutM1Role, ['triage-disposition']) === dtoText(w1BeforeRoleChange, ['triage-disposition']) &&
      withoutEvaluatedAt({ ...w1WithoutM1Role['triage-disposition'].body, assigneeCurrentlyEligible: null }) === withoutEvaluatedAt({ ...w1BeforeRoleChange['triage-disposition'].body, assigneeCurrentlyEligible: null }),
    `with M1's role removed today (M1 recorded W1's A8.3, A8.5, A8.6 and A8.7 events), all 14 history and position DTOs of W1 read byte-identical; only A8.2's present-day assigneeCurrentlyEligible answers the current truth (${w1BeforeRoleChange['triage-disposition'].body?.assigneeCurrentlyEligible} → ${w1WithoutM1Role['triage-disposition'].body?.assigneeCurrentlyEligible}); the role was restored afterwards`,
  )
  const hundred = [] as string[]
  for (let i = 0; i < 100; i += 1) hundred.push(withoutEvaluatedAt((await get(`${base(W1)}/closure-reconstruction`)).body))
  const positions = (JSON.parse(hundred[0]).chain ?? []).map((e: any) => e.position)
  check(
    'T094',
    'Repeated reconstruction is deterministic',
    new Set(hundred).size === 1 && same(positions, positions.map((_: unknown, i: number) => i + 1)) && positions.length === chain.length,
    `100 reconstructions of W1 are byte-identical (apart from evaluatedAt), the chain in the same order 1..${positions.length} every time`,
  )
  // T095 and T096 — the production reads of W1 in child processes under Asia/Dubai (Arabic locale), UTC and
  // America/New_York answer exactly the bytes this process reads.
  const stripTime = (value: unknown) => JSON.stringify(value, (k, v) => (k === 'evaluatedAt' ? undefined : v))
  const CHILD = [
    "const { getClosureReconstruction, getClosureHistory } = await import('./src/modules/exception-closure/exception-closure.service.ts');",
    "const strip = (value) => JSON.stringify(value, (k, v) => (k === 'evaluatedAt' ? undefined : v));",
    'const [claimId, intakeId] = process.argv.slice(1);',
    'const reconstruction = await getClosureReconstruction(claimId, intakeId);',
    'const history = await getClosureHistory(claimId, intakeId);',
    "console.log('CHILD ' + JSON.stringify({ reconstruction: strip(reconstruction), history: strip(history), offset: new Date(Date.UTC(2026, 11, 31, 22)).getTimezoneOffset(), day: new Date(Date.UTC(2026, 11, 31, 22)).toLocaleDateString(), locale: Intl.DateTimeFormat().resolvedOptions().locale }));",
    'process.exit(0);',
  ].join('\n')
  const inChild = (extra: Record<string, string>) => {
    const out = spawnSync(process.execPath, ['--env-file=.env', '--input-type=module', '-e', CHILD, W1.claimId, W1.intakeId], { encoding: 'utf8', cwd: process.cwd(), env: childEnv(extra), maxBuffer: 16 * 1024 * 1024 })
    const line = (out.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('CHILD ')) ?? ''
    try {
      return JSON.parse(line.slice(6)) as { reconstruction: string; history: string; offset: number; day: string; locale: string }
    } catch {
      return null
    }
  }
  const hereReads = { reconstruction: stripTime(await getClosureReconstruction(W1.claimId, W1.intakeId)), history: stripTime(await getClosureHistory(W1.claimId, W1.intakeId)) }
  const dubai = inChild({ TZ: 'Asia/Dubai', LANG: 'ar_AE.UTF-8', LC_ALL: 'ar_AE.UTF-8' })
  const utc = inChild({ TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' })
  const newYork = inChild({ TZ: 'America/New_York', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' })
  const zones = [dubai, utc, newYork]
  check(
    'T095',
    'Asia/Dubai, UTC and New York give equal history',
    zones.every((z) => !!z && z.reconstruction === hereReads.reconstruction && z.history === hereReads.history) && new Set(zones.map((z) => z?.offset)).size === 3,
    `W1's reconstruction and closure history read in child processes under Asia/Dubai (offset ${dubai?.offset}), UTC (${utc?.offset}) and America/New_York (${newYork?.offset}) are byte-identical to this process's; 2026-12-31 22:00Z is ${dubai?.day} in Dubai and ${newYork?.day} in New York, yet no stored or answered date moves`,
  )
  const arabicLabel = `تشخيص اصطناعي ${runToken}`
  const arabicDx = await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('AR'), displayName: arabicLabel })
  const arabicRead = arabicDx.status === 201 ? await get(`/api/diagnosis-codes/${arabicDx.body.id}`) : { status: 0, body: {} as any }
  const arabicFree = [
    await write('investigation', C9, { ...linkOf(C9), note: 'ملاحظة داخلية' }, M4.who), await write('resolution', SD, { ...confirmOf(L(SD).requestId as string), remark: 'ملاحظة داخلية' }, DR.who),
    await write('closure', S, { ...closeOf(S), comment: 'ملاحظة داخلية' }, CF.who),
  ]
  check(
    'T096',
    'Arabic UTF-8 labels preserved; no locale order',
    arabicDx.status === 201 && arabicRead.status === 200 && arabicRead.body?.displayName === arabicLabel && Buffer.from(arabicRead.body.displayName, 'utf8').equals(Buffer.from(arabicLabel, 'utf8')) &&
      arabicFree.every((r) => r.status === 400 && !JSON.stringify(r.body).includes('ملاحظة')) && dubai?.reconstruction === hereReads.reconstruction,
    `an Arabic synthetic diagnosis label is stored and read back through its A2 owner byte-for-byte in UTF-8; A8 owners take no free text, so an Arabic note on an A8.3, A8.7 or A8.9 request is refused 400 without echoing it; with LANG/LC_ALL set to ar_AE.UTF-8 (resolved ${dubai?.locale}) the reconstruction keeps its sequence order, byte-identical`,
  )
  check(
    'T097',
    'Pre-2027 service keeps its original release',
    kProv.status === 200 && editionIn(kProv) === E2021.versionId && editionIn(kProv) !== E2027.versionId,
    `K (service 2026-12-31) was validated A5-VAL-2 and frozen while only 2021 was active; its frozen receipts bind the 2021 edition ${E2021.versionId.slice(0, 8)} and still do after 2027 was activated`,
  )
  check(
    'T098',
    'On/after 2027 service selects only 2027',
    nProv.status === 200 && nProv.body?.verificationStatus === 'VERIFIED_AS_RECORDED' && editionIn(nProv) === E2027.versionId,
    `N (service 2027-01-01) binds the 2027 edition ${E2027.versionId.slice(0, 8)} and nothing else; no global "latest code" preference exists — each service date resolves the edition valid on that date`,
  )
  const kFreshDiagnosis = kFresh.ok ? kFresh.value.items.find((i: any) => i.subjectKind === 'DIAGNOSIS') : null
  check(
    'T099',
    'Old-DOS correction never adopts the new release',
    kRevoke.status === 201 && kFreeze2.status === 201 && kLink.status === 201 && editionIn(k2Prov) === E2021.versionId && kFreshDiagnosis?.edition?.referenceDatasetVersionId === E2021.versionId,
    "after 2027 was activated, K was corrected (revoked, re-assessed, independently re-approved, frozen again and linked through A6.9 as CORRECTED_CODING): the corrected freeze and a fresh validation of K's 2026-12-31 service both resolve 2021, by the original service date",
  )
  const realRights = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM crg_code_system_rights WHERE authority_code NOT LIKE 'SYN-%'`))[0].n)
  const realScopes = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM crg_validation_scopes WHERE authority_code NOT LIKE 'SYN-%'`))[0].n)
  const runDatasets = await prisma.$queryRawUnsafe<{ a: string }[]>(`SELECT authority_code AS a FROM reference_datasets WHERE created_at >= $1::timestamptz`, runStartedAt.toISOString())
  const runImports = await prisma.$queryRawUnsafe<{ p: string; u: string }[]>(`SELECT publisher AS p, source_uri AS u FROM crg_release_imports WHERE created_at >= $1::timestamptz`, runStartedAt.toISOString())
  check(
    'T100',
    'No real DHA rights, import or price policy',
    realRights === 0 && realScopes === 0 && runDatasets.every((d) => d.a.startsWith('SYN-')) && runImports.every((i) => /^Synthetic /.test(i.p) && i.u.startsWith('synthetic:')) &&
      registerFlat.includes('CIR-2026-00000200') && registerFlat.includes('is not an activation decision'),
    `no rights decision or validation scope exists for any real authority (${realRights}, ${realScopes}); every dataset (${runDatasets.length}) and import (${runImports.length}) of this run is synthetic (SYN- authority, synthetic: source); the register records DHA circular CIR-2026-00000200 as not an activation decision; no tariff, price or modifier policy was changed`,
  )
  // ---------------------------------------------------------------- complete A8 and revenue/claim regressions (T101–T114)
  section('Complete A8 and revenue/claim regressions — A8.9 invoked (nesting A8.8 -> A8.7 -> A8.6 -> A8.5 -> A8.3 -> A8.2 -> A8.1 -> A7.10 -> … -> A1), then CRG-01B (nesting CRG-01A and the A8.5 chain), one after the other, never in parallel')
  await apiReady('the A8.9 and backward regression chain')
  // The owner records as this suite leaves them, before the chains (every nested suite creates and judges its own).
  const snapBeforeChains = await snap()
  const goldenBefore = { w1: dtoText(await readAll(W1)), rows: JSON.stringify(await a8Hashes(homeIds)) }
  const a89Chain = run(`npm run ${OWNERS[7].suite}`)
  const nestedLog = `a810-nested-a89-${runId}.log`
  writeFileSync(nestedLog, a89Chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the CRG-01B suite')
  const crgChain = run('npm run test:crg-01b:coding-validation')
  const crgLog = `a810-nested-crgb-${runId}.log`
  writeFileSync(crgLog, crgChain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chains')
  const rows = suiteLines(a89Chain.output, 'A8.9')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const titleOf = (text: string) => text.replace(/^\[[^\]]+\] /, '').replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A8.9 asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD, its own two runs) and re-proves
  // A8.8's branch-only causes against its own branch. On A8.10 those statements are obsolete by design; every other A8.9
  // check is substantive. T124 below proves each cause independently on THIS branch, down to A7.9.
  const a89NonApplicable: Record<string, string> = {
    T001: "A8.9 'A8.6 approved merge SHA ancestor of main' requires the A8.9 feature branch name; A8.10 is cut from the main that contains A8.6, A8.7, A8.8 and A8.9 (T001–T004 and T006 here)",
    T005: "A8.9 'Clean synchronized main source, no stacking' compares this tree with origin/feature/a8-9-…; THIS branch's clean tree, synchronization and parity are proved by T008 and T128 here",
    T010: "A8.9 'Allowlist excludes A9/CRG/old owner edits' lists the paths A8.9 was allowed to change and names A8.10 as later work; A8.10 legitimately adds its own harness and register (T009 here)",
    T006: "A8.9 'CRG-01B merge ancestor; C remains excluded' also requires that the branch change no CRG-named path; A8.10 changes exactly one, its disclosed CRG-01A CRG-G08 correction (docs/Harness_Corrections.md §4, bounded by T010); every other term (both Checkpoint merges ancestors, no Checkpoint C path, the A8.9 register keeping C, A9, A10 and A11 separate) is re-judged here (T124)",
    T125: "A8.9 'Two independently numbered 130/130 runs' is the identity of A8.9's own runs at origin/feature/a8-9-…; THIS run's identity is proved by T125–T127 here",
    T126: "A8.9 'Same exact pushed HEAD and origin parity' compares HEAD with origin/feature/a8-9-…; THIS branch's parity is proved by T128 here",
    T127: "A8.9 'Clean tracked tree and scope allowlist' applies A8.9's own allowlist; THIS branch's clean tree and allowlist are proved by T009 and T128 here",
    T128: "A8.9 'Nested original failures retained and justified' re-proves A8.8's branch-only causes against the A8.9 branch; here every one is re-proved on this branch, down to A7.9 (T124)",
  }
  const undocumented = failing.filter((id) => !(id in a89NonApplicable))
  const summaryOf = (output: string, tag: string) => output.match(new RegExp(`\\[${tag.replace('.', '\\.')}\\] automated summary: (\\d+)\\/(\\d+) PASS`))
  const summary = summaryOf(a89Chain.output, 'A8.9')
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const ran = rows.some((row) => row.id === 'T130') && !/\[A8\.9\] RUN ABORTED|\[A8\.9\] uncaught error|\[A8\.9\] INVALID RUN/.test(a89Chain.output)
  const a89Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of a89Chain.output.split(/\r?\n/).filter((l) => /^\[A8\.9\] T\d{3} .* \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 300)}`)
  check(
    'T101',
    'A8.9 T001–T130 substantive regression',
    ran && failedCount === failing.length && undocumented.length === 0 && a89Passing === 130 - failing.length && a89Passing >= 120,
    !ran
      ? 'the A8.9 suite did not complete'
      : undocumented.length > 0
        ? `undocumented A8.9 failures: ${undocumented.join(', ')}`
        : `${(a89Chain.output.match(/\[A8\.9\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A8.9] automated summary: ', 'A8.9 ')}; all ${a89Passing} substantive checks PASS and every failure (${failing.join(', ')}) is a documented branch-only item`,
  )
  check('T102', 'A8.8 substantive regression chain', verdictOf('T101') === 'PASS', `A8.9 T101 (A8.8, with its own documented branch-only items) ${verdictOf('T101')}`)
  check('T103', 'A8.7 substantive regression chain', verdictOf('T102') === 'PASS', `A8.9 T102 (A8.7) ${verdictOf('T102')}`)
  check('T104', 'A8.6 substantive regression chain', verdictOf('T103') === 'PASS', `A8.9 T103 (A8.6) ${verdictOf('T103')}`)
  check('T105', 'A8.5 regression; branch-only items classified', verdictOf('T104') === 'PASS', `A8.9 T104 (A8.5 and A8.3) ${verdictOf('T104')}; A8.5's branch-only items are kept and categorized in the evidence log (T124)`)
  check('T106', 'A8.3 regression; no A8.4 runtime', verdictOf('T104') === 'PASS' && a84Paths.length === 0, `A8.9 T104 (A8.3) ${verdictOf('T104')}; no A8.4 path, table or script exists (T005)`)
  check('T107', 'A8.2 assignment/triage regression', verdictOf('T105') === 'PASS', `A8.9 T105 (A8.2 and A8.1) ${verdictOf('T105')}`)
  check('T108', 'A8.1 intake/immutable basis regression', verdictOf('T105') === 'PASS' && same(await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${INTAKE_TABLE} WHERE id = ANY($1::uuid[])`, homeIds), [{ n: homeIds.length }]), `A8.9 T105 (A8.1) ${verdictOf('T105')}; all ${homeIds.length} intakes of this run still exist exactly once`)
  check('T109', 'A7.10 → A7.1 revenue evidence regressions', verdictOf('T106') === 'PASS', `A8.9 T106 (A7.10 and A7.1–A7.9) ${verdictOf('T106')}`)
  const snapAfterChains = await snap()
  check(
    'T110',
    'A6.10 → A6.1 claim lifecycle regressions',
    verdictOf('T107') === 'PASS' && snapAfterChains.freezes === snapBeforeChains.freezes && snapAfterChains.lifecycle === snapBeforeChains.lifecycle && snapAfterChains.links === snapBeforeChains.links &&
      snapAfterChains.claims === snapBeforeChains.claims,
    `A8.9 T107 (A6.10, which nests A6.9 → A6.1 and its frozen vectors) ${verdictOf('T107')}; each freeze, sealed manifest, lifecycle event, correction link and Claim of this run's ${runClaims.length} Claims is byte-identical across both chains`,
  )
  check('T111', 'A5.10 → A5.1, legacy and V2 handoff', verdictOf('T108') === 'PASS', `A8.9 T108 (the chain reaching A5.10 → A5.1) ${verdictOf('T108')}`)
  const a3Scope = run('npm run test:a3:scope')
  check('T112', 'A4 → A1, A3 and A2 controls', verdictOf('T109') === 'PASS' && a3Scope.ok, `A8.9 T109 (A4 → A1, A3 included, and A2) ${verdictOf('T109')}; the A3.9 scope suite over this branch's files ${a3Scope.ok ? 'PASS' : 'FAIL'}`)
  // CRG-01B — its own ids (B-Gnn, CRG-nnn); on A8.10 its branch-only start-gate, parity and scope assertions name the
  // CRG-01B branch, and its own nested-evidence aggregator re-proves CRG-A's and A8.5's items against that branch.
  const crgLines = (output: string, tag: string) =>
    output.split(/\r?\n/).filter((line) => line.startsWith(`[${tag}] `)).map((line) => {
      const rest = line.slice(tag.length + 3)
      const id = rest.split(' ')[0]
      const verdict = / \.{3,} PASS/.test(rest) ? 'PASS' : / \.{3,} FAIL/.test(rest) ? 'FAIL' : / \.{3,} N\/A /.test(rest) ? 'N/A' : null
      return { id, verdict, line }
    }).filter((r) => /^(CRG-\d{3}|CRGB-G\d{2}|B-G\d{2})$/.test(r.id) && r.verdict !== null)
  const crgRows = crgLines(crgChain.output, 'CRG-01B')
  const crgFailing = crgRows.filter((r) => r.verdict === 'FAIL').map((r) => r.id)
  const crgVerdict = (id: string) => crgRows.find((r) => r.id === id)?.verdict ?? 'missing'
  const crgbNonApplicable: Record<string, string> = {
    'CRGB-G01': "CRG-01B's start gate requires a clean main base for its own feature branch; A8.10 is cut from the main that contains Checkpoint B (T006 here)",
    'CRGB-G05': "CRG-01B's changed-file allowlist lists the paths CRG-01B was allowed to change; A8.10 legitimately adds its own harness and register (T009 here)",
    'B-G06': "CRG-01B's 'no other earlier suite changed' compares this branch's integration paths with CRG-01B's own disclosed corrections; A8.10 adds its own harness only (T009 here), and every corrected harness is unchanged (T010 here)",
    'CRG-127': "CRG-01B's allowlist and origin parity name origin/feature/crg-01b-…; THIS branch's parity and allowlist are proved by T009 and T128 here",
    'CRG-124': "CRG-01B's own nested-evidence aggregator re-proves Checkpoint A's and A8.5's branch-only items against the CRG-01B branch; on A8.10 their raw lines are kept and categorized in the evidence log (T124)",
  }
  const crgUndocumented = crgFailing.filter((id) => !(id in crgbNonApplicable))
  const crgSummary = crgChain.output.match(/\[CRG-01B\] automated summary: (\d+)\/(\d+) PASS/)
  const crgRan = crgSummary !== null && crgRows.filter((r) => r.verdict !== 'N/A').length === Number(crgSummary[2]) && !/\[CRG-01B\] RUN ABORTED|\[CRG-01B\] uncaught error|\[CRG-01B\] INVALID RUN/.test(crgChain.output)
  for (const text of crgChain.output.split(/\r?\n/).filter((l) => /^\[CRG-01B\] \S+ .* \.{3,} FAIL|RUN ABORTED|uncaught error/.test(l))) progress(`nested: ${text.slice(0, 300)}`)
  check(
    'T113',
    'CRG-01B V2 frozen coding and golden vectors',
    crgRan && crgUndocumented.length === 0 && ['CRG-087', 'CRG-088', 'CRG-089'].every((id) => crgVerdict(id) === 'PASS'),
    !crgRan
      ? 'the CRG-01B suite did not complete'
      : crgUndocumented.length > 0
        ? `undocumented CRG-01B failures: ${crgUndocumented.join(', ')}`
        : `${(crgChain.output.match(/\[CRG-01B\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[CRG-01B] automated summary: ', 'CRG-01B ')}; the V2 frozen coding, historical V1 bytes and service-date correction checks (CRG-087, CRG-088, CRG-089) PASS; every failure (${crgFailing.join(', ') || 'none'}) is a documented branch-only item`,
  )
  // Checkpoint A's full output is kept by CRG-01B in its own nested log, named with its SHA-256 prefix in CRG-127.
  const crgALogRef = crgChain.output.match(/(crgb-nested-crga-CRGB-\d{13}\.log) \(SHA-256 ([0-9a-f]{10,64})/)
  const crgALog = crgALogRef?.[1] ?? ''
  const crgALogVerified = crgALog !== '' && existsSync(crgALog) && sha256Of(readFileSync(crgALog)).startsWith(crgALogRef?.[2] ?? '-')
  const crgAG08 = crgALogVerified ? (readFileSync(crgALog, 'utf8').split(/\r?\n/).find((line) => /^\[CRG-01\] CRG-G08 .* \.{3,} PASS - /.test(line)) ?? null) : null
  check(
    'T114',
    'CRG-01A release, rights and service date',
    crgRan && crgVerdict('CRG-123') === 'PASS' && crgAG08 !== null && /recognized by provenance/.test(crgAG08) && /closure pattern/.test(crgAG08),
    `CRG-01B CRG-123 (Checkpoint A, with its release identity, rights blocking and service-date resolver, and the A8.5 chain) ${crgVerdict('CRG-123')}; in ${crgALog || 'no named nested log'} (${crgALogVerified ? 'hash verified' : 'hash NOT verified'}) Checkpoint A CRG-G08 (corrected, docs/Harness_Corrections.md §4) ${crgAG08 === null ? 'did not PASS' : 'PASS'}`,
  )
  // ---------------------------------------------------------------- backward, build and recovery gates (T115–T120)
  section('Backward, build and recovery gates: backend units and typecheck, frontend lint and build, Prisma validate/generate/status with checksums and replay, health and ready truthful through a database outage, zero unexpected 5xx and zero pg warnings')
  const allUnit = run('npm run test:unit')
  check('T115', 'Backend full unit suite passes', allUnit.ok && /ℹ fail 0/.test(allUnit.output), `backend unit suite: ${(allUnit.output.match(/ℹ pass \d+/) ?? ['no count'])[0]}, ${(allUnit.output.match(/ℹ fail \d+/) ?? ['no count'])[0]}`)
  const typecheck = run('npm run typecheck')
  check('T116', 'Backend typecheck at exact HEAD', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T117', 'Frontend lint; no UI change needed', lint.ok && !changedPaths.some((p) => p.startsWith('frontend/')), 'frontend lint clean; this branch changes no frontend file')
  const build = run('npm run build --prefix ../frontend')
  check('T118', 'Frontend production build, no new dependency', build.ok && !changedPaths.some((p) => /package-lock\.json$|frontend\/package\.json$/.test(p)), `frontend production build ${(build.output.match(/built in [\dms.]+/) ?? ['ok'])[0]}; no dependency or lockfile changed`)
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check(
    'T119',
    'Prisma validate/generate/status, checksums, replay',
    validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output) && checksumMismatch.length === 0 && replay.ok && replayedCount === migrationDirs.length,
    `the schema validates and generates, the working database is up to date (never reset), every applied checksum equals its committed file, and the scratch replay applied all ${replayedCount} migrations (T072)`,
  )
  // T120 — one database outage and restart: health stays truthful, ready reports the outage, recovery, and the history
  // of every A8 row of this run survives byte-identical; no unexpected 5xx and no pg deprecation anywhere.
  const rowsBeforeOutage = JSON.stringify(await a8Hashes(homeIds))
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
  const rowsAfterOutage = JSON.stringify(await a8Hashes(homeIds))
  const w1AfterOutage = dtoText(await readAll(W1))
  const nestedDriverWarnings = [a89Chain.output, crgChain.output].reduce((n, text) => n + (text.match(/Calling client\.query\(\) when the client is already executing a query/g) ?? []).length, 0)
  check(
    'T120',
    'Outage truthful, recovery, no 5xx or pg warnings',
    upHealth === 200 && upReady === 200 && stopped && downReady && downSamples.every((code) => code === 200) && restarted && recovered && rowsAfterOutage === rowsBeforeOutage && w1AfterOutage === goldenBefore.w1 &&
      serverErrors === 0 && connectionResets === 0 && driverWarnings.length === 0 && nestedDriverWarnings === 0,
    `up ${upHealth}/${upReady}; with the database stopped health stayed 200 and ready reported 503; recovery 200; every A8 row of this run hashed as before and W1's 15 owner DTOs read byte-identical after the restart; ${serverErrors} HTTP 5xx and ${connectionResets} connection resets in this run; ${driverWarnings.length + nestedDriverWarnings} pg client.query() deprecation warnings here and in both chains`,
  )

  // ---------------------------------------------------------------- evidence, handoff and FINAL gate (T121–T130)
  section('Evidence, handoff and FINAL gate: the exact base and accepted merges, the worked W1–W8 records, an executed assertion per check, the raw nested failures with categories, the run identity at the exact pushed HEAD, digests, clean parity, the register and the owner boundary')
  const headNow = git('rev-parse HEAD')
  const originHead = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a810Branch}`])
  check(
    'T121',
    'Exact base, HEAD and A8.6–A8.9 merges recorded',
    [A86_MERGE, A87_MERGE, A88_MERGE, A85_MERGE, CRGB_MERGE].every((sha) => registerAtHead.includes(sha.slice(0, 7))) && A89_MERGE.length === 40 && registerAtHead.includes(A89_MERGE.slice(0, 7)) &&
      registerFlat.includes(`\`${a810Branch}\` is cut from clean, synchronized main holding the A8.9 merge`) && gitArgs(['merge-base', 'HEAD', 'origin/main']) === gitArgs(['rev-parse', 'origin/main']),
    `the register records A8.5 ${A85_MERGE.slice(0, 7)}, Checkpoint B ${CRGB_MERGE.slice(0, 7)}, A8.6 ${A86_MERGE.slice(0, 7)}, A8.7 ${A87_MERGE.slice(0, 7)}, A8.8 ${A88_MERGE.slice(0, 7)} and A8.9 ${A89_MERGE.slice(0, 7) || '(not merged)'}; base main ${shortMain}, HEAD ${headNow.slice(0, 12)}`,
  )
  const workedLog = `a810-worked-${runId}.log`
  const workedRecord = [
    `A8.10 worked synthetic workflows W1–W8, run ${runId} at HEAD ${headNow}`,
    `W1 ${W1.label}: Claim ${W1.claimId}, intake ${W1.intakeId}; ${Object.entries(L(W1)).map(([k, v]) => `${k} ${v}`).join('; ')}; closure 201, repeat 409; reconstruction CLOSED_INTERNAL`,
    `W2 ${W2.label}: intake ${W2.intakeId}; A8.6 ${L(W2).verificationId} EVIDENCE_NOT_VERIFIED; A8.7 request ${w2Request.status} ${codeOf(w2Request)}; A8.9 ${w2Close.status} ${codeOf(w2Close)}`,
    `W3a ${W3A.label}: intake ${W3A.intakeId}; AWAITING_ACKNOWLEDGEMENT; A8.9 ${w3aClose.status} ${codeOf(w3aClose)}`,
    `W3b ${W3B.label}: intake ${W3B.intakeId}; FOLLOWUP_ACTIVE; A8.9 ${w3bClose.status} ${codeOf(w3bClose)}`,
    `W4a ${W4A.label}: intake ${W4A.intakeId}; return ${L(W4A).returnId} FOLLOWUP_RECORDED; A8.9 ${w4aClose.status} on ESCALATION_RETURN`,
    `W4b ${W4B.label}: intake ${W4B.intakeId}; return ${L(W4B).returnId} FURTHER_WORK_REQUIRED; A8.9 ${w4bRoutes.map((r) => `${r.status} ${codeOf(r)}`).join(', ')}`,
    `W5 no intake: Claim ${W5.claimId}; every A8 route 404; planted gap refused INTEGRITY_CONFLICT`,
    `W6 Org B: intake ${F.intakeId}; Org B on Org A ${orgBReads.length} reads 404, ${orgBWrites.length} writes 404`,
    `W7 CRG: authority ${AUTH}; 2021 ${E2021.versionId}, 2027 ${E2027.versionId}; K ${K.submissionId} → ${editionIn(kProv)}; N ${N.submissionId} → ${editionIn(nProv)}; K corrected ${kFreeze2.body?.submissionId} → ${editionIn(k2Prov)}; W1 V1 ${w1Prov.body?.verificationStatus}`,
    `W8 A6/A7: freezes, lifecycle, links and Claims unchanged across every A8 write; W1 A7.7 ${w1Timeline.status}; N A7.9 continuity gap ${nGaps.join(', ')}`,
    '',
  ].join('\n')
  writeFileSync(workedLog, workedRecord)
  const goldenAfter = { w1: dtoText(await readAll(W1)), rows: JSON.stringify(await a8Hashes(homeIds)) }
  check(
    'T122',
    'Worked W1–W8 cases and owner references kept',
    existsSync(workedLog) && ['W1 ', 'W2 ', 'W3a ', 'W3b ', 'W4a ', 'W4b ', 'W5 ', 'W6 ', 'W7 ', 'W8 '].every((w) => workedRecord.includes(`\n${w}`)) && same(goldenAfter, goldenBefore),
    `the worked records of W1–W8 with every owner id are archived in backend/${workedLog} (SHA-256 ${sha256Of(Buffer.from(workedRecord))}); after both chains W1's 15 DTOs and every A8 row of the run read back identically`,
  )
  const printedIds = printed.map((line) => line.match(/^\[A8\.10\] (T\d{3}) /)?.[1]).filter((id): id is string => !!id)
  const expectedSoFar = Array.from({ length: 122 }, (_, i) => `T${String(i + 1).padStart(3, '0')}`)
  check(
    'T123',
    'Every check executed with its observed proof',
    same(printedIds, expectedSoFar) && printed.filter((line) => /^\[A8\.10\] T\d{3} /.test(line)).every((line) => / \.{3,} (PASS|FAIL) - .{12,}/.test(line)),
    `T001–T122 were each printed exactly once, in order, each with PASS or FAIL and its observed proof (status, body, record, constraint, hash, run id or command)`,
  )
  // T124: every original nested FAIL line of both chains, kept verbatim, each placed in a documented branch-only set
  // of its own level, and each cause re-proved on THIS branch from its own line, all the way down to A7.9. This follows
  // the accepted pattern of A8.9 T128 and CRG-01B CRG-124.
  // - A level may fail only with its documented items, and each item only once.
  // - Every item an aggregator names must fail at the next level. An aggregator may omit items it proved itself.
  // - Every failure at every level is re-proved here, whether it is named or not.
  type Category = 'BRANCH' | 'HEAD' | 'SCOPE' | 'AGGREGATE'
  type Level = { tag: string; aggregator: string; ids: Record<string, Category> }
  const A83_DOWN: Level[] = [
    { tag: 'A8.3', aggregator: 'T119', ids: { T001: 'BRANCH', T002: 'HEAD', T010: 'SCOPE', T119: 'AGGREGATE', T130: 'HEAD' } },
    { tag: 'A8.2', aggregator: 'T120', ids: { T001: 'BRANCH', T002: 'HEAD', T010: 'SCOPE', T120: 'AGGREGATE', T130: 'HEAD' } },
    { tag: 'A8.1', aggregator: 'T110', ids: { T001: 'BRANCH', T002: 'HEAD', T010: 'SCOPE', T110: 'AGGREGATE', T130: 'HEAD' } },
    { tag: 'A7.10', aggregator: 'T111', ids: { T001: 'BRANCH', T002: 'HEAD', T010: 'SCOPE', T111: 'AGGREGATE', T122: 'HEAD', T123: 'HEAD', T130: 'HEAD' } },
    { tag: 'A7.9', aggregator: 'T120', ids: { T001: 'BRANCH', T002: 'HEAD', T010: 'SCOPE', T120: 'AGGREGATE', T130: 'HEAD' } },
  ]
  const A78_ITEMS = ['T001', 'T002', 'T010', 'T120', 'T130']
  const A85_LEVEL: Level = { tag: 'A8.5', aggregator: 'T110', ids: { T001: 'BRANCH', T003: 'BRANCH', T010: 'SCOPE', T110: 'AGGREGATE', T127: 'HEAD', T129: 'HEAD' } }
  const A89_PATH: Level[] = [
    { tag: 'A8.8', aggregator: 'T120', ids: { T001: 'BRANCH', T005: 'HEAD', T010: 'SCOPE', T120: 'AGGREGATE', T128: 'HEAD', T129: 'HEAD' } },
    { tag: 'A8.7', aggregator: 'T120', ids: { T001: 'BRANCH', T004: 'HEAD', T010: 'SCOPE', T120: 'AGGREGATE', T128: 'HEAD', T129: 'HEAD' } },
    { tag: 'A8.6', aggregator: 'T110', ids: { T001: 'BRANCH', T003: 'BRANCH', T010: 'SCOPE', T110: 'AGGREGATE', T127: 'HEAD', T129: 'HEAD' } },
    A85_LEVEL,
    ...A83_DOWN,
  ]
  const CRGA_PATH: Level[] = [{ tag: 'CRG-01', aggregator: 'CRG-124', ids: { 'CRG-001': 'BRANCH', 'CRG-002': 'BRANCH', 'CRG-003': 'SCOPE', 'CRG-121': 'HEAD', 'CRG-124': 'AGGREGATE', 'CRG-127': 'HEAD' } }, ...A83_DOWN]
  const CRGB_A85_PATH: Level[] = [A85_LEVEL, ...A83_DOWN]
  const topCategory: Record<string, Record<string, Category>> = {
    'A8.9': { T001: 'BRANCH', T005: 'HEAD', T006: 'SCOPE', T010: 'SCOPE', T125: 'HEAD', T126: 'HEAD', T127: 'HEAD', T128: 'AGGREGATE' },
    'CRG-01B': { 'CRGB-G01': 'BRANCH', 'CRGB-G05': 'SCOPE', 'B-G06': 'SCOPE', 'CRG-124': 'AGGREGATE', 'CRG-127': 'HEAD' },
  }
  const topAggregator: Record<string, string> = { 'A8.9': 'T128', 'CRG-01B': 'CRG-124' }
  type Entry = { line: string; outer: string; tags: string[]; id: string; detail: string; level: Level | null; category: Category | null }
  const pathOf = (outer: string, tags: string[]): Level[] | null => {
    const path = outer === 'A8.9' ? A89_PATH : tags[0] === 'CRG-01' ? CRGA_PATH : tags[0] === 'A8.5' ? CRGB_A85_PATH : null
    return path && tags.length <= path.length && tags.every((tag, i) => tag === path[i].tag) ? path : null
  }
  const entriesOf = (output: string, outer: string): Entry[] =>
    output
      .split(/\r?\n/)
      .map((line) => ({ line, m: line.match(/^\[([^\]]+)\]((?: +nested: \[[^\]]+\])*) +(\S+) .* \.{3,} FAIL - (.*)$/) }))
      .filter((x): x is { line: string; m: RegExpMatchArray } => x.m !== null && x.m[1] === outer)
      .map(({ line, m }) => {
        const tags = [...m[2].matchAll(/nested: \[([^\]]+)\]/g)].map((t) => t[1])
        const path = tags.length === 0 ? null : pathOf(outer, tags)
        const level = path ? path[tags.length - 1] : null
        const category = tags.length === 0 ? (topCategory[outer][m[3]] ?? null) : (level?.ids[m[3]] ?? null)
        return { line, outer, tags, id: m[3], detail: m[4], level, category }
      })
  const nestedEvidence = [...entriesOf(a89Chain.output, 'A8.9'), ...entriesOf(crgChain.output, 'CRG-01B')]
  const levelKey = (e: { outer: string; tags: string[] }) => [e.outer, ...e.tags].join('>')
  const childrenOf = (e: Entry, childTag?: string) => nestedEvidence.filter((c) => c.outer === e.outer && c.tags.length === e.tags.length + 1 && same(c.tags.slice(0, -1), e.tags) && (!childTag || c.tags[c.tags.length - 1] === childTag))
  const listAfter = (text: string, label: RegExp) => ((text.match(label) ?? ['', ''])[1] ?? '').split(/[,;] /).map((s) => s.trim()).filter(Boolean)
  const TRACKING = `${a810Branch}...origin/${a810Branch}`
  const thisBranchClean = (text: string) => {
    const segment = (text.split('## ')[1] ?? '').split(';')[0]
    // Whole: exactly this branch tracking its origin, neither ahead nor behind. Cut: a prefix of that, at the line's end.
    return segment === TRACKING || (segment.length >= 8 && TRACKING.startsWith(segment) && text.endsWith(segment))
  }
  const namedShas = (text: string) => [...text.matchAll(/\bas ([0-9a-f]{7,40})\b/g)].map((m) => m[1])
  const ancestorsNamed = (text: string) => namedShas(text).length > 0 && namedShas(text).every((sha) => gitOk(`merge-base --is-ancestor ${sha} HEAD`))
  // A nested line is cut at a fixed width, so only its last listed path may be a prefix.
  const pathsInScope = (paths: string[]) => paths.length > 0 && paths.every((p, i) => changedPaths.includes(p) || (i === paths.length - 1 && p.length > 0 && changedPaths.some((c) => c.startsWith(p))))
  const atThisHead = originHead === headNow && headNow === headAtStart
  const crgARegister = committedText('docs/CRG-01_Coding_Release_Governance.md')
  const crgACode = committedFiles('backend/src/modules/coding-release').map((file) => committedCode(file)).join('\n') + committedText('backend/prisma/migrations/20261104090000_crg_01_final_coding_release/migration.sql')
  const v1Tables = (await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'coding\\_release%'`))[0]?.n
  const integrationChanged = changedPaths.filter((p) => p.startsWith('backend/src/integration/'))
  const proved = (e: Entry): boolean => {
    const d = e.detail
    if (e.category === null) return false
    if (e.category === 'AGGREGATE') {
      const aggregator = e.tags.length === 0 ? topAggregator[e.outer] : e.level?.aggregator
      if (e.id !== aggregator) return false
      if (e.outer === 'CRG-01B' && e.tags.length === 0) {
        // "undocumented: Checkpoint A <ids>; A8.5 <ids>": each named item fails one level down, in its own subtree.
        const crgANamed = listAfter((d.match(/Checkpoint A ([^;]*)/) ?? ['', ''])[1], /^(.*)$/)
        const a85Named = listAfter((d.match(/A8\.5 ([^;]*)/) ?? ['', ''])[1], /^(.*)$/)
        const crgAFails = childrenOf(e, 'CRG-01').map((c) => c.id)
        const a85Fails = childrenOf(e, 'A8.5').map((c) => c.id)
        return /^undocumented: /.test(d) && crgANamed.length + a85Named.length > 0 && crgANamed.every((id) => crgAFails.includes(id)) && a85Named.every((id) => a85Fails.includes(id))
      }
      const named = listAfter(d, /^cause not proven for: (.*)$/)
      const path = e.tags.length === 0 ? null : pathOf(e.outer, e.tags)
      const deepest = path !== null && e.tags.length === path.length
      if (deepest) return named.length > 0 && new Set(named).size === named.length && named.every((id) => A78_ITEMS.includes(id))
      const below = childrenOf(e).map((c) => c.id)
      return named.length > 0 && new Set(named).size === named.length && named.every((id) => below.includes(id))
    }
    if (e.category === 'BRANCH') {
      if (e.id === 'CRG-001') {
        // Its only branch term is Checkpoint A's own branch name; every other term is re-judged here.
        return /supersedes CRG-01 v1\.0/.test(crgARegister) && /CRG-01 FINAL/.test(crgARegister) && v1Tables === 0 && !/coding_release_codes|coding_release_dataset_systems|CODE_IDENTITY_AMBIGUOUS/.test(crgACode)
      }
      const named = namedShas(d)
      const onThisBranch = d.startsWith(`branch ${a810Branch}`)
      return (onThisBranch || named.length > 0) && named.every((sha) => gitOk(`merge-base --is-ancestor ${sha} HEAD`)) && (!d.includes('## ') || thisBranchClean(d))
    }
    if (e.category === 'SCOPE') {
      if (e.outer === 'A8.9' && e.tags.length === 0 && e.id === 'T006') {
        const crgNamed = changedPaths.filter((p) => /crg|coding-release|coding-validation|checkpoint/i.test(p))
        return outOfScope.length === 0 && same(crgNamed, [CORRECTED_HARNESS]) && namedShas(d).length === 2 && namedShas(d).every((sha) => gitOk(`merge-base --is-ancestor ${sha} HEAD`)) &&
          !committedFiles('.').some((path) => /checkpoint[-_]?c\b|crg[-_]?01[-_]?c\b/i.test(path)) && committedText('docs/A8_Exception_Closure.md').replace(/\s+/g, ' ').includes('Checkpoint C, A9, A10 and A11 stay separate')
      }
      if (e.id === 'B-G06') return outOfScope.length === 0 && integrationChanged.length > 0 && integrationChanged.every((p) => p.startsWith(`${HARNESS_DIR}/`) || p === CORRECTED_HARNESS)
      const listed = listAfter(d, /^(?:unexpected|changed): (.*)$/)
      return outOfScope.length === 0 && pathsInScope(listed)
    }
    // HEAD: the historical branch's tree, parity or run identity, which here names THIS clean, exact pushed HEAD.
    const failCount = nestedEvidence.filter((x) => levelKey(x) === levelKey(e)).length
    const counted = d.match(/^(\d+) of the 129 checks before this one PASS, (\d+) FAIL/)
    return atThisHead && (d.includes(headNow) || d.includes(headNow.slice(0, 12)) || thisBranchClean(d)) && (!counted || (Number(counted[2]) === failCount - 1 && Number(counted[1]) === 129 - (failCount - 1)))
  }
  const uncategorized = nestedEvidence.filter((e) => e.category === null)
  const duplicated = nestedEvidence.filter((e, i) => nestedEvidence.findIndex((x) => levelKey(x) === levelKey(e) && x.id === e.id) !== i)
  const unproved = nestedEvidence.filter((e) => e.category !== null && !proved(e))
  const evidenceLog = `a810-nested-evidence-${runId}.log`
  const reasonOf = (e: Entry) => (e.tags.length > 0 ? '' : e.outer === 'A8.9' ? (a89NonApplicable[e.id] ?? '') : (crgbNonApplicable[e.id] ?? ''))
  const evidenceText = [
    `A8.10 — nested regression evidence, run ${runId} at HEAD ${headNow}`,
    'Every original nested FAIL result of both chains, verbatim, with its N/A category (BRANCH | HEAD | SCOPE | AGGREGATE) and whether its cause was re-proved on this branch; a top-level item also carries its reason.',
    `The full nested outputs are kept in ${nestedLog} and ${crgLog}.`,
    '',
    ...(['A8.9', 'CRG-01B'] as const).flatMap((outer) => [
      `== ${outer} chain (${outer === 'A8.9' ? nestedLog : crgLog})`,
      ...nestedEvidence.filter((e) => e.outer === outer).flatMap((e) => [`[${e.category ?? 'UNCATEGORIZED'}] ${e.line}`, `    cause re-proved on this branch: ${e.category !== null && proved(e) ? 'yes' : 'NO'}`, ...(reasonOf(e) ? [`    reason: ${reasonOf(e)}`] : [])]),
      '',
    ]),
  ].join('\n')
  writeFileSync(evidenceLog, evidenceText)
  for (const id of failing) if (a89NonApplicable[id]) notApplicable += 1
  for (const id of crgFailing) if (crgbNonApplicable[id]) notApplicable += 1
  const categoryCounts = (['BRANCH', 'HEAD', 'SCOPE', 'AGGREGATE'] as Category[]).map((c) => `${nestedEvidence.filter((e) => e.category === c).length} ${c}`).join(', ')
  check(
    'T124',
    'Raw nested failures kept, categorized, replaced',
    ran && crgRan && undocumented.length === 0 && crgUndocumented.length === 0 && nestedEvidence.length > 0 && uncategorized.length === 0 && duplicated.length === 0 && unproved.length === 0 &&
      failing.every((id) => nestedEvidence.some((e) => e.outer === 'A8.9' && e.tags.length === 0 && e.id === id)) &&
      crgFailing.every((id) => nestedEvidence.some((e) => e.outer === 'CRG-01B' && e.tags.length === 0 && e.id === id)) && existsSync(evidenceLog),
    uncategorized.length > 0
      ? `not a documented branch-only item of its level: ${uncategorized.map((e) => `${levelKey(e)} ${e.id}`).join(', ').slice(0, 400)}`
      : duplicated.length > 0
        ? `listed twice at one level: ${duplicated.map((e) => `${levelKey(e)} ${e.id}`).join(', ').slice(0, 400)}`
        : unproved.length > 0
          ? `cause not re-proved on this branch: ${unproved.map((e) => `${levelKey(e)} ${e.id}`).join(', ').slice(0, 400)}`
          : `all ${nestedEvidence.length} original nested FAIL lines of both chains kept verbatim (${categoryCounts}) in backend/${evidenceLog} (SHA-256 ${sha256Of(Buffer.from(evidenceText))}); each is a documented branch-only item of its own level, and its cause is re-proved on this branch down to A7.9`,
  )
  const checksBefore125 = passed + failed
  const earlierRuns = readdirSync('.').filter((name) => /^a810-nested-a89-A810-\d{13}\.log$/.test(name) && name !== nestedLog).map((name) => name.replace(/^a810-nested-a89-|\.log$/g, ''))
  check(
    'T125',
    'Independent complete run at exact pushed HEAD',
    checksBefore125 === 124 && failed === 0 && /^A810-\d{13}$/.test(runId) && !earlierRuns.includes(runId) && headNow === headAtStart && headNow === originHead,
    `run ${runId} at ${headNow}: all 124 checks before this one executed and PASS, with fixtures and members it created itself; HEAD = origin/${a810Branch}`,
  )
  check(
    'T126',
    'Second run at the SAME pushed HEAD',
    headNow === headAtStart && headNow === originHead && headNow.length === 40 && tracking.includes(`origin/${a810Branch}`) && !/ahead|behind/.test(tracking),
    `HEAD ${headNow} = origin/${a810Branch}, the same at the start and the end of the run; each official run records its own run id and HEAD (earlier runs at this HEAD: ${earlierRuns.length})`,
  )
  const digests = [nestedLog, crgLog, evidenceLog, sqlMatrixLog, workedLog].map((f) => `${f} ${existsSync(f) ? sha256Of(readFileSync(f)) : 'MISSING'}`)
  check(
    'T127',
    'Distinct run id, SHA-256 digests, immutable logs',
    digests.every((d) => !d.endsWith('MISSING')) && !earlierRuns.includes(runId),
    `run ${runId} (distinct from ${earlierRuns.length} earlier run(s)); ${digests.join('; ')}`,
  )
  check(
    'T128',
    'Clean status, parity, allowlist, hashes, restart',
    git('status --porcelain') === '' && dirty.length === 0 && outOfScope.length === 0 && headNow === originHead && migrationBytes('HEAD') === migrationBytes('origin/main') && checksumMismatch.length === 0 && recovered && rowsAfterOutage === rowsBeforeOutage,
    `${tracking}; the tree is clean after every check (the run logs are ignored output); the diff is exactly the A8.10 allowlist; every migration is byte-identical to main and its applied checksum matches; the restart evidence is T120`,
  )
  check(
    'T129',
    'Register: ownership, limits, A9 boundary, approvals',
    ['## Accepted owners (read through each owner only)', '## Worked synthetic workflows (W1–W8)', '## Regression chains', '## Boundary and handoff', 'an A9 integration approval', 'an A10 production authorization', 'an A11 pilot release', 'Drafting disclosure', 'Harness_Corrections.md` §4', 'A10-RISK-01'].every((s) =>
      registerFlat.includes(s),
    ) && OWNERS.every((o) => registerAtHead.includes(`\`${o.contract}\``)),
    'the register records every accepted owner and its contract, W1–W8, both regression chains, the drafting disclosure, the external limits (no payer, payment, remittance, licensed coding, DHA activation or production readiness) and that A8 acceptance is not an A9, A10 or A11 approval',
  )
  check(
    'T130',
    'Owner acceptance separate; no self-merge or claim',
    registerFlat.includes('Formal owner acceptance is separate from this test output') && registerFlat.includes('There is no self-merge') && branchMerges.length === 0 && registerFlat.includes(LABEL) &&
      registerFlat.includes('is a documentation and test-evidence label only'),
    `${LABEL} is a documentation and test-evidence label only; formal owner acceptance is separate from this output; this branch holds no merge commit (no self-merge); nothing here claims production or regulatory compliance`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 && passed === 130 ? `[${TAG}] A8 PHASE ENGINEERING ACCEPTANCE COMPLETE (engineering only; no payer, regulatory or production readiness)` : `[${TAG}] A8.10 FINAL FAIL`)
  if (failed > 0 || passed !== 130) process.exitCode = 1
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
  .finally(() => prisma.$disconnect())
