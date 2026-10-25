import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { registerRevenueSourceEvidence, getRevenueSourceEvidenceOf } from '../../modules/revenue-evidence/revenue-evidence.service.ts'
import { classifySourceEvidence } from '../../modules/evidence-classification/evidence-classification.service.ts'
import { recordAdjudicationReadiness } from '../../modules/evidence-gate/evidence-gate.service.ts'
import { assembleRevenueEvidenceCase } from '../../modules/evidence-case/evidence-case.service.ts'
import { assessClosurePrerequisites } from '../../modules/case-prerequisite/case-prerequisite.service.ts'
import { BASIS_OF } from '../../modules/case-prerequisite/case-prerequisite.types.ts'
import { traceClosureBasis } from '../../modules/closure-basis-trace/closure-basis-trace.reducer.ts'
import { getClosureBasisTraceOf } from '../../modules/closure-basis-trace/closure-basis-trace.service.ts'
import type { TraceFacts } from '../../modules/closure-basis-trace/closure-basis-trace.types.ts'

// A7.6 — focused acceptance for Revenue Closure Basis Trace & Source-Gap Explanation (T001–T130).
//
// Every frozen submission is built through its owners, exactly as the A6.7–A7.5 suites build them (tariff world and
// rates, the A5.7 recorder, readiness, the Claim, lines, diagnoses and pointers, pricing, draft assessments,
// APPROVE/REVOKE by a separate synthetic Admin, every freeze through the A6.7 route and the correction link through
// A6.9); every source is registered through the A7.1 route, classified through the A7.2 route, gated through the A7.3
// route, cased through the A7.4 route and assessed through the A7.5 route. The other organization builds its own world
// with its own two Admins. Traces are read through the A7.6 route (or, on a harness-held snapshot, through its
// transaction-aware service). The FUTURE and BROKEN facts no owner can record (REVIEW/UNSUPPORTED readiness, unknown
// codes, forged counts, links, digests and contracts) are planted only in a transaction that is ALWAYS rolled back —
// owner guards off, and where a CHECK or UNIQUE index would refuse the forgery, that one constraint dropped inside the
// same transaction — and judged there by the production service on that transaction. Synthetic Admins are
// provisioned per run through Better Auth's own server-side creation with a random password that is never printed.
// Every value is synthetic and keyed by this run's id.

const TAG = 'A7.6'
let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[${TAG}] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[${TAG}] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[${TAG}] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[${TAG}] ${title}`)

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

const runId = `A76-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a76Branch = 'feature/a7-6-closure-basis-trace'
const a75Branch = 'feature/a7-5-case-closure-prerequisite-assessment'
const a74Branch = 'feature/a7-4-revenue-evidence-case-assembly'
const a73Branch = 'feature/a7-3-adjudication-evidence-readiness'
const a72Branch = 'feature/a7-2-evidence-classification'
const a71Branch = 'feature/a7-1-revenue-source-evidence'
const a610Branch = 'feature/a6-10-a6-integration-acceptance'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/closure-basis-trace'
const FE_DIR = 'frontend/src/modules/closure-basis-trace'
const HARNESS_DIR = 'backend/src/integration/a7-closure-basis-trace'
const A75_MIGRATION_NAME = '20261025090000_a7_5_case_prerequisite'
const A75_MIGRATION = `backend/prisma/migrations/${A75_MIGRATION_NAME}/migration.sql`
const UNIT_TESTS = [`${MODULE_DIR}/closure-basis-trace.reducer.test.ts`, `${MODULE_DIR}/closure-basis-trace.validation.test.ts`]
const PREREQ = 'evidence_prereq_results'
const HEADER = 'evidence_case_snapshots'
const ENTRY = 'evidence_case_entries'
const GATE = 'evidence_gate_results'
const CONTRACT = 'A7-CLOSURE-TRACE-1'
const PREREQ_CONTRACT = 'A7-CLOSURE-PREREQ-1'
const CASE_CONTRACT = 'A7-REVENUE-CASE-1'
const READINESS_CONTRACT = 'A7-ADJ-READINESS-1'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const DTO_KEYS = ['contractVersion', 'assessmentId', 'caseId', 'caseManifestSha256', 'assessmentCode', 'basisCode', 'sourceCount', 'itemCount', 'traceCode', 'traceItems', 'evaluatedAt']
const ITEM_KEYS = ['ordinal', 'sourceEvidenceId', 'classificationId', 'readinessId', 'sourceReasonCode', 'readinessCode', 'readinessReasonCode', 'explanationCode']
const EXPLANATIONS = ['SOURCE_UNCLASSIFIED', 'CLASSIFICATION_NO_READINESS', 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'CLASSIFICATION_REVIEW_REQUIRED', 'CLASSIFICATION_UNSUPPORTED']
const NOT_READY = { readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' }
const REVIEW = { readinessCode: 'SOURCE_REQUIRES_REVIEW', reasonCode: 'CLASSIFICATION_REVIEW_REQUIRED' }
const UNSUPPORTED = { readinessCode: 'SOURCE_UNSUPPORTED', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }
// The owners A7.6 consumes or must leave untouched: the A5/A6 modules and A7.1–A7.5 (backend, pages and suites).
const OWNER_DIRS = [
  ...[
    'claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction',
    'pre-claim-validation', 'pre-claim-readiness', 'validation-run', 'revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'encounter-billing-context',
  ].map((name) => `backend/src/modules/${name}`),
  'backend/src/shared/database',
  'backend/src/shared/authorization',
  'backend/prisma',
  'frontend/src/modules/revenue-evidence',
  'frontend/src/modules/evidence-classification',
  'frontend/src/modules/evidence-gate',
  'frontend/src/modules/evidence-case',
  'frontend/src/modules/case-prerequisite',
  'backend/src/integration/a7-revenue-source-evidence',
  'backend/src/integration/a7-evidence-classification',
  'backend/src/integration/a7-evidence-gate',
  'backend/src/integration/a7-evidence-case',
  'backend/src/integration/a7-case-prerequisite',
]
// Every table a trace could conceivably touch, read in this fixed key order (a UNION ALL may come back in Parallel
// Append order). A trace must leave every one of them exactly as it found it.
const COUNT_TABLES = [PREREQ, HEADER, ENTRY, GATE, 'source_evidence_classifications', 'revenue_source_evidence', 'audit_events', 'claims', 'claim_pricing_runs', 'claim_review_events', 'claim_freezes', 'claim_freeze_evidence_manifests', 'claim_freeze_lifecycle_events', 'claim_correction_links']

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
// A trace without its evaluation instant: the only field that may differ between two reads of the same facts.
const stable = (body: any) => {
  if (!body || typeof body !== 'object') return body
  const { evaluatedAt: _evaluatedAt, ...rest } = body
  return rest
}
const randomUuid = () => randomBytes(16).toString('hex').replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12})$/, '$1-$2-4$3-8$4-$5')

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[${TAG}] A7.6 revenue closure basis trace & source-gap explanation — run ${runId}`)
  console.log(`[${TAG}] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- gates (T001–T009; T010 at the end)
  section('Preflight: accepted A7.5, no migration, Prisma, unchanged replay, no new permission, one GET route, owners untouched')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a75Merge = mergeOf(a75Branch)
  const a74Merge = mergeOf(a74Branch)
  const a73Merge = mergeOf(a73Branch)
  const a72Merge = mergeOf(a72Branch)
  const a71Merge = mergeOf(a71Branch)
  const a610Merge = mergeOf(a610Branch)
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|settlement|receivable|claim-transport|claim-outbox|payer-response|integration\/a(8|9)|integration\/a7-(?!revenue-source-evidence|evidence-classification|evidence-gate|evidence-case|case-prerequisite|closure-basis-trace)|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Correct A7.5 merge prerequisite',
    branch === a76Branch && a75Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a75Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A7.5 merged as ${a75Merge.slice(0, 7) || 'NOT FOUND'} and is an ancestor; contains latest main ${git('rev-parse --short origin/main')}, not stacked on an unmerged branch; no A7.7+/A8/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean tree and exact origin parity', dirty.length === 0 && tracking.includes(`origin/${a76Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  const constantOf = (path: string, name: string) => (committedText(path).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/claim-submission/claim-submission.types.ts', 'SUBMISSION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/revenue-evidence/revenue-evidence.types.ts', 'REVENUE_SOURCE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-classification/evidence-classification.types.ts', 'CLASSIFICATION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-gate/evidence-gate.types.ts', 'READINESS_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-case/evidence-case.types.ts', 'CASE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/case-prerequisite/case-prerequisite.types.ts', 'PREREQ_CONTRACT_VERSION'),
  ]
  const ownerExports = [
    /export async function findAssessmentById\(id: string, db: DbClient = prisma\)/.test(committedCode('backend/src/modules/case-prerequisite/case-prerequisite.repository.ts')),
    /export async function findCaseForPrerequisite\(caseId: string, db: DbClient\)/.test(committedCode('backend/src/modules/case-prerequisite/case-prerequisite.repository.ts')),
    /export async function findCaseById\(id: string, db: DbClient = prisma\)/.test(committedCode('backend/src/modules/evidence-case/evidence-case.repository.ts')),
    /export async function getReadinessOf\(classificationId: string, tx: DbClient\)/.test(committedCode('backend/src/modules/evidence-gate/evidence-gate.service.ts')),
    /export async function getRevenueSourceEvidenceOf\(submissionId: string, tx: DbClient\)/.test(committedCode('backend/src/modules/revenue-evidence/revenue-evidence.service.ts')),
    /export async function withReadSnapshot/.test(committedCode('backend/src/shared/database/read-snapshot.ts')),
  ]
  check(
    'T003',
    'A6.10/A7.1–A7.5 contract ancestry',
    [a610Merge, a71Merge, a72Merge, a73Merge, a74Merge, a75Merge].every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)) &&
      same(contracts, ['A6-SUBMISSION-1', 'A7-REVENUE-SOURCE-1', 'A7-EVIDENCE-CLASS-1', READINESS_CONTRACT, CASE_CONTRACT, PREREQ_CONTRACT]) && ownerExports.every(Boolean),
    `A6.10 ${a610Merge.slice(0, 7)} and A7.1–A7.5 (${[a71Merge, a72Merge, a73Merge, a74Merge, a75Merge].map((s) => s.slice(0, 7)).join(', ')}) are ancestors; contracts ${contracts.join(', ')}; every owner read A7.6 consumes already exists`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  const baseMigrationDirs = migrationDirsAt('origin/main')
  check(
    'T004',
    'No new migration; no schema drift',
    migrationStatus.length === 0 && same(headMigrationDirs, baseMigrationDirs) && headMigrationDirs.some((dir) => A75_MIGRATION.startsWith(`${dir}/`)),
    migrationStatus.length === 0 ? `nothing under backend/prisma changed (schema and all ${headMigrationDirs.length} migrations identical to main; the newest is A7.5's)` : `prisma changes: ${migrationStatus.join(' | ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma validate/generate/status', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, the working database is up to date (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  const replayExpected = [
    /PASS {2}the A7\.5 tables are exactly evidence_prereq_results/,
    /PASS {2}the A7\.4 tables are exactly evidence_case_entries and evidence_case_snapshots/,
    /PASS {2}the A7\.3 tables are exactly evidence_gate_results/,
    /PASS {2}the A7\.2 tables are exactly source_evidence_classifications/,
    /PASS {2}the A7\.1 tables are exactly revenue_source_evidence/,
  ]
  check(
    'T006',
    'From-empty replay of unchanged set',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === headMigrationDirs.length && appliedCount === baseMigrationDirs.length,
    `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${baseMigrationDirs.length} on main; every A7.1–A7.5 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const routeCode = committedCode(`${MODULE_DIR}/closure-basis-trace.route.ts`)
  const authzDiff = gitArgs(['diff', 'origin/main...HEAD', '--', ':/backend/src/shared/authorization', ':/backend/src/scripts/bootstrap-authz-dev.ts'])
  check(
    'T007',
    'No new permission; existing read grant',
    authzDiff === '' && !allCodes.some((code) => /trace|basis/i.test(code)) && same(allCodes.filter((code) => /^evidenceCasePrereq\./.test(code)).sort(), ['evidenceCasePrereq.create', 'evidenceCasePrereq.read']) &&
      (await grantsOf('evidenceCasePrereq.read')) === 'ORG_ADMIN,ORG_VIEWER' && /requireMemberPermission\(organizationIdFromAssessmentChain, 'evidenceCasePrereq\.read'\)/.test(routeCode) && !/evidenceCasePrereq\.create/.test(routeCode),
    'the permission catalogue and its bootstrap are unchanged; the one route requires the existing evidenceCasePrereq.read (Admin, Viewer); no trace or basis permission exists',
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
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  // Raw database text in a response body: SQL keywords, a stack frame or a physical guard name (lower case — the
  // public error codes are upper case and expected).
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /evidence_prereq|evidence_case_|evidence_gate_result|source_evidence_classification|revenue_source_evidence_[a-z]|claim_freeze/.test(text)
  }

  // Synthetic Admins: Better Auth's own server-side user and credential creation, then an ORG_ADMIN membership
  // through the existing tables. The password is random per run and never printed.
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
  // B approves (separation of duties for A6.5) and reads as a second Admin; O and O2 are the two Admins of the OTHER
  // organization, who build its own frozen submission, evidence, case and assessment.
  const B = await provisionAdmin('b')
  const O = await provisionAdmin('o', otherOrg)
  const O2 = await provisionAdmin('o2', otherOrg)

  const tracePath = (assessmentId: string) => `/api/closure-prerequisite-assessments/${assessmentId}/basis-trace`
  const traceOf = (assessmentId: string, who: Who = asAdmin) => get(tracePath(assessmentId), who)
  const wiring = await traceOf(MISSING)
  const absent = [
    await api('POST', tracePath(MISSING), {}),
    await api('PUT', tracePath(MISSING), {}),
    await api('PATCH', tracePath(MISSING), {}),
    await api('DELETE', tracePath(MISSING)),
    await api('GET', `${tracePath(MISSING)}/latest`),
    await api('GET', `${tracePath(MISSING)}/items`),
    await api('POST', `${tracePath(MISSING)}/close`, {}),
    await api('GET', `/api/revenue-evidence-cases/${MISSING}/basis-trace`),
    await api('GET', `/api/claim-submissions/${MISSING}/basis-trace`),
    await api('GET', `/api/claims/${MISSING}/basis-trace`),
  ]
  const unauthenticated = await traceOf(MISSING, anonymous)
  check(
    'T008',
    'Exactly one new GET route',
    wiring.status === 404 && errorCode(wiring.body) === 'NOT_FOUND' && absent.every((res) => res.status === 404) && unauthenticated.status === 401 && (routeCode.match(/basisTraceRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 1 && /basisTraceRouter\.get\('\/:assessmentId\/basis-trace'/.test(routeCode),
    `GET /basis-trace answers a missing assessment with a privacy-safe 404; POST/PUT/PATCH/DELETE, latest, items, close and per-case, per-submission and per-Claim scans are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.status}`,
  )
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file))
  check(
    'T009',
    'No upstream A5/A6/A7.1–A7.5 change',
    ownerChanged.length === 0 && same(contracts, ['A6-SUBMISSION-1', 'A7-REVENUE-SOURCE-1', 'A7-EVIDENCE-CLASS-1', READINESS_CONTRACT, CASE_CONTRACT, PREREQ_CONTRACT]),
    ownerChanged.length === 0 ? 'no A5/A6/A7.1–A7.5 module, page or suite, no shared database or authorization code and nothing under prisma changed; every upstream contract is unchanged' : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: frozen submissions, a correction link, A7.1–A7.3 evidence, A7.4 cases and A7.5 assessments of two organizations')
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
    // draft assessment with its own new approval. Every freeze is its own submission, so one series yields several.
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
      let assessment = await assessDraft(claim.id, pricing.body.id)
      let approvalId = await approve(claim.id, assessment)
      freezes.push(await freezeNow(claim.id, assessment, approvalId))
      for (let i = 1; i < count; i += 1) {
        await revoke(claim.id, assessment, approvalId)
        assessment = await assessDraft(claim.id, pricing.body.id)
        approvalId = await approve(claim.id, assessment)
        freezes.push(await freezeNow(claim.id, assessment, approvalId))
      }
      return { claimId: claim.id as string, freezes, lineIds }
    }
    return { series }
  }
  const home = await tenantWorld('home', org, asAdmin, creatorId, B.who)
  const away = await tenantWorld('away', otherOrg, O.who, O.id, O2.who)
  // §8 — Claim K holds frozen S1; S2 is its corrected freeze (an A6.9 link). F is the other organization's.
  const W = await home.series('worked', 2)
  const F = await away.series('foreign', 1)
  // A pool of independent frozen submissions on one Claim (each freeze is its own submission and case identity).
  const P = await home.series('pool', 12)
  let poolNext = 0
  const fresh = () => {
    const submission = P.freezes[poolNext]
    poolNext += 1
    if (!submission) throw new Error('fixture: the submission pool is exhausted')
    return submission
  }
  const [S1, S2] = W.freezes
  const ref = (suffix: string) => `SYN-${runId.replace(/^A76-/, '')}-${suffix}`.toUpperCase()
  const registerSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref(suffix) }, who)
    if (res.status !== 201) throw new Error(`fixture source ${suffix} could not be registered through A7.1: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.revenueSourceEvidenceId as string
  }
  const classifySource = async (sourceId: string, who: Who = asAdmin) => {
    const res = await post(`/api/revenue-source-evidence/${sourceId}/classifications`, {}, who)
    if (res.status !== 201) throw new Error(`fixture classification could not be recorded through A7.2: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.classificationId as string
  }
  const gateClassification = async (classificationId: string, who: Who = asAdmin) => {
    const res = await post(`/api/revenue-evidence-classifications/${classificationId}/adjudication-readiness`, {}, who)
    if (res.status !== 201) throw new Error(`fixture readiness could not be recorded through A7.3: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.readinessId as string
  }
  const linkedSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const E = await registerSource(submissionId, suffix, who)
    const C = await classifySource(E, who)
    const R = await gateClassification(C, who)
    return { E, C, R }
  }
  const caseOf = async (submissionId: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-evidence-cases`, {}, who)
    if (res.status !== 201) throw new Error(`fixture case could not be assembled through A7.4: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { caseId: string; assemblyCode: string; manifestSha256: string; itemCount: number; items: { sourceEvidenceId: string }[] }
  }
  const assessmentOf = async (caseId: string, who: Who = asAdmin) => {
    const res = await post(`/api/revenue-evidence-cases/${caseId}/closure-prerequisite-assessments`, {}, who)
    if (res.status !== 201) throw new Error(`fixture assessment could not be recorded through A7.5: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { assessmentId: string; caseId: string; assessmentCode: string; basisCode: string; caseManifestSha256: string }
  }
  // A frozen submission with one linked source, its A7.4 case and its A7.5 assessment.
  const assessedCase = async (suffix: string, submissionId = fresh()) => {
    await linkedSource(submissionId, suffix)
    const c = await caseOf(submissionId)
    return { submissionId, case: c, assessment: await assessmentOf(c.caseId) }
  }
  const link = await post(`/api/claims/${W.claimId}/correction-links`, { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'CORRECTED_CODING' })
  if (link.status !== 201) throw new Error(`fixture: the worked correction link was refused with ${link.status}`)
  const K1 = await linkedSource(S1, 'E1')
  const K2 = await linkedSource(S1, 'E2')
  const KS2 = await linkedSource(S2, 'S2-E1')
  await linkedSource(F.freezes[0], 'FOREIGN', O.who)
  const CASE1 = await caseOf(S1)
  const ASSESS1 = await assessmentOf(CASE1.caseId)
  const CASE_F = await caseOf(F.freezes[0], O.who)
  const ASSESS_F = await assessmentOf(CASE_F.caseId, O.who)
  console.log(`[${TAG}]      fixtures ready: two synthetic AE-DU/DHA worlds, a frozen submission and its correction freeze, a pool of ${P.freezes.length} frozen submissions, and evidence, cases and assessments recorded through the A7.1–A7.5 owner routes`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const runToken = runId.replace(/^A76-/, '')
  const freezeHash = (claimId: string) => hashOf(`SELECT f.*, m.id AS manifest_id, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = $1::uuid`, claimId)
  const lifecycleHash = (claimId: string) => hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = $1::uuid`, claimId)
  const correctionHash = (claimId: string) => hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = $1::uuid`, claimId)
  const sourceHash = () => hashOf(`SELECT r.* FROM revenue_source_evidence r WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const classificationHash = () => hashOf(`SELECT c.* FROM source_evidence_classifications c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const readinessHash = () => hashOf(`SELECT g.* FROM ${GATE} g JOIN revenue_source_evidence r ON r.id = g.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const allCasesHash = () => hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM ${HEADER} h UNION ALL SELECT e.id, row_to_json(e)::text FROM ${ENTRY} e) x`)
  const allAssessmentsHash = () => hashOf(`SELECT a.* FROM ${PREREQ} a`)
  const constraintsHash = () => hashOf(`SELECT c.oid::text AS id, c.conrelid::regclass::text AS t, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid IN ('${GATE}'::regclass, '${HEADER}'::regclass, '${ENTRY}'::regclass, '${PREREQ}'::regclass) UNION ALL SELECT i.indexrelid::text, i.indrelid::regclass::text, i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid IN ('${GATE}'::regclass, '${HEADER}'::regclass, '${ENTRY}'::regclass, '${PREREQ}'::regclass)`)
  const NOT_REFUSED = 'ROLLED_BACK'

  // SF carries three registered and classified sources without readiness, and never receives a real case: every
  // planted (future or broken) case below is built on it, always rolled back.
  const SF = fresh()
  const FS: { E: string; C: string }[] = []
  for (const suffix of ['F1', 'F2', 'F3']) {
    const E = await registerSource(SF, `FUTURE-${suffix}`)
    FS.push({ E, C: await classifySource(E) })
  }
  type GatePlan = { of: number; source?: string; readinessCode?: string; reasonCode?: string; contract?: string }
  type EntryRow = { ordinal: number; source: string; classification: string | null; readiness: string | null; reason: string }
  type Plan = {
    relax?: string[]
    gates?: GatePlan[]
    entries: (gates: string[]) => EntryRow[]
    header?: { code?: string; sourceCount?: number; classifiedCount?: number; readinessCount?: number; itemCount?: number; contract?: string }
    assessment?: { code?: string; basis?: string; digest?: string; contract?: string; caseId?: string; guardOn?: boolean }
  }
  // A planted case: the relaxations, A7.3 rows, A7.4 header and entries and the A7.5 assessment go in with row
  // triggers off (assessment: with the A7.5 guard ON when `guardOn`, proving the guard itself accepts it), then the
  // production A7.6 service traces that assessment on THIS transaction, which is then ALWAYS rolled back.
  // Every planted case is measured on its own: all 14 tables and every CHECK and index of the four tables must read
  // back exactly as they were before it.
  const plantedRuns = { total: 0, dirty: 0 }
  const planted = async (plan: Plan) => {
    const countsBefore = await counts()
    const constraintsBeforePlant = await constraintsHash()
    const traced = await plantedOnce(plan)
    plantedRuns.total += 1
    if (!(await unchanged(countsBefore)) || (await constraintsHash()) !== constraintsBeforePlant) plantedRuns.dirty += 1
    return traced
  }
  const plantedOnce = async (plan: Plan) => {
    const out: { result?: Awaited<ReturnType<typeof getClosureBasisTraceOf>> } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          for (const ddl of plan.relax ?? []) await tx.$executeRawUnsafe(ddl)
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
          const gates: string[] = []
          for (const g of plan.gates ?? []) {
            const fp = (await tx.sourceEvidenceClassification.findUniqueOrThrow({ where: { id: FS[g.of].C } })).sourceFingerprintSha256
            const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
              `INSERT INTO ${GATE} (id, organization_id, source_evidence_id, classification_id, contract_version, readiness_code, reason_code, classification_fingerprint_sha256, recorded_by_user_id)
               VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid) RETURNING id::text AS id`,
              org, g.source ?? FS[g.of].E, FS[g.of].C, g.contract ?? READINESS_CONTRACT, g.readinessCode ?? NOT_READY.readinessCode, g.reasonCode ?? NOT_READY.reasonCode, fp, creatorId,
            )
            gates.push(row.id)
          }
          const entries = plan.entries(gates)
          const linkedCount = entries.filter((e) => e.readiness !== null).length
          const h = plan.header ?? {}
          const digest = createHash('sha256').update(`${runId}-${randomBytes(8).toString('hex')}`).digest('hex')
          const [header] = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO ${HEADER} (id, organization_id, claim_submission_id, contract_version, assembly_code, source_count, classified_count, readiness_count, item_count, manifest_sha256, recorded_by_user_id)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid) RETURNING id::text AS id`,
            org, SF, h.contract ?? CASE_CONTRACT,
            h.code ?? (entries.length === 0 ? 'NO_REVENUE_SOURCES' : linkedCount === entries.length ? 'INVENTORY_COMPLETE' : 'INVENTORY_INCOMPLETE'),
            h.sourceCount ?? entries.length, h.classifiedCount ?? entries.filter((e) => e.classification !== null).length, h.readinessCount ?? linkedCount, h.itemCount ?? entries.length, digest, creatorId,
          )
          for (const e of entries)
            await tx.$executeRawUnsafe(
              `INSERT INTO ${ENTRY} (id, assembly_id, ordinal, source_evidence_id, classification_id, readiness_id, item_reason_code) VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6)`,
              header.id, e.ordinal, e.source, e.classification, e.readiness, e.reason,
            )
          const a = plan.assessment ?? {}
          if (a.guardOn) await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
          const code = a.code ?? 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'
          const [assessment] = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO ${PREREQ} (id, organization_id, evidence_case_id, contract_version, assessment_code, basis_code, case_manifest_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid) RETURNING id::text AS id`,
            org, a.caseId ?? header.id, a.contract ?? PREREQ_CONTRACT, code, a.basis ?? BASIS_OF[code as keyof typeof BASIS_OF] ?? 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', a.digest ?? digest, creatorId,
          )
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
          out.result = await getClosureBasisTraceOf(assessment.id, tx)
          throw new Error(NOT_REFUSED)
        },
        { timeout: 60_000 },
      ),
    )
    return { ...out, message }
  }
  const linkedRow = (i: number, gates: string[], ordinal = i + 1): EntryRow => ({ ordinal, source: FS[i].E, classification: FS[i].C, readiness: gates[i], reason: 'LINKED' })
  const classifiedRow = (i: number, ordinal = i + 1): EntryRow => ({ ordinal, source: FS[i].E, classification: FS[i].C, readiness: null, reason: 'CLASSIFIED_NO_READINESS' })
  const refusedConflict = (p: { result?: { ok: boolean; code?: string } | any; message: string }) => p.message.includes(NOT_REFUSED) && p.result?.ok === false && p.result.code === 'CLOSURE_BASIS_PROVENANCE_CONFLICT'
  const tracedAs = (p: { result?: any; message: string }, code: string) => p.message.includes(NOT_REFUSED) && p.result?.ok === true && p.result.value.traceCode === code
  const detailOf = (p: { result?: any; message: string }) => (p.result?.ok === false ? String(p.result.message).replace(/; nothing was explained$/, '') : p.result?.ok ? `traced ${p.result.value.traceCode}` : `not planted: ${p.message.slice(0, 120)}`)

  // ---------------------------------------------------------------- route and authorization (T011–T020)
  section('Route and authorization: contract, malformed and injected ids, query values, session, roles, tenants, spoofing')
  const countsAtStart = await counts()
  const TRACE1 = await traceOf(ASSESS1.assessmentId)
  check(
    'T011',
    'Exact A7-CLOSURE-TRACE-1 contract',
    TRACE1.status === 200 && TRACE1.body?.contractVersion === CONTRACT && constantOf(`${MODULE_DIR}/closure-basis-trace.types.ts`, 'TRACE_CONTRACT_VERSION') === CONTRACT,
    'A7-CLOSURE-TRACE-1 is the literal contract in code and on every trace',
  )
  const malformed = [await traceOf('not-a-uuid'), await traceOf(MISSING.slice(0, 35)), await traceOf(MISSING.replace(/-/g, '')), await traceOf(`${MISSING}0`)]
  check('T012', 'Malformed assessment UUID refused 400', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `malformed ids: ${malformed.map((r) => r.status).join('/')}; no raw database text`)
  const injected = [await traceOf(encodeURIComponent("1' OR '1'='1")), await traceOf(encodeURIComponent(`${ASSESS1.assessmentId}' OR '1'='1`)), await traceOf(encodeURIComponent(`${ASSESS1.assessmentId};DROP TABLE x`)), await traceOf(encodeURIComponent('../../revenue-evidence-cases'))]
  check('T013', 'Injected path segments refused 400', injected.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `SQL-shaped and traversal-shaped path ids are refused before any lookup: ${injected.map((r) => r.status).join('/')}`)
  const queried = await get(`${tracePath(ASSESS1.assessmentId)}?assessmentId=${ASSESS_F.assessmentId}&caseId=${CASE_F.caseId}&traceCode=REVIEW_REQUIRED&latest=true&sourceEvidenceIds=${K1.E}`)
  check('T014', 'Query values cannot control output', queried.status === 200 && same(stable(queried.body), stable(TRACE1.body)) && !/req\.query/.test(routeCode) && !/req\.query/.test(committedCode(`${MODULE_DIR}/closure-basis-trace.service.ts`)), 'an assessment, case, code, latest flag and source list in the query string change nothing; the code never reads the query')
  const anon = await traceOf(ASSESS1.assessmentId, anonymous)
  check('T015', 'No session is 401', anon.status === 401 && unauthenticated.status === 401, 'the trace requires a session: 401 without one, for an existing and a missing assessment')
  const viewerTrace = await traceOf(ASSESS1.assessmentId, asViewer)
  check('T016', 'Viewer with read grant gets 200', viewerTrace.status === 200 && same(stable(viewerTrace.body), stable(TRACE1.body)), 'a Viewer (evidenceCasePrereq.read) reads the trace (200)')
  const adminB = await traceOf(ASSESS1.assessmentId, B.who)
  check('T017', 'Admin with read grant 200 identical', TRACE1.status === 200 && adminB.status === 200 && same(stable(adminB.body), stable(TRACE1.body)), 'two Admins read the identical stable trace (200)')
  const foreignOnHome = await traceOf(ASSESS1.assessmentId, O.who)
  const missingAsForeign = await traceOf(MISSING, O.who)
  const homeOnForeign = await traceOf(ASSESS_F.assessmentId)
  check(
    'T018',
    'Other tenant 404 equals missing',
    foreignOnHome.status === 404 && same({ ...foreignOnHome.body?.error, requestId: null }, { ...missingAsForeign.body?.error, requestId: null }) && homeOnForeign.status === 404,
    "the other organization's Admin gets exactly the missing-id envelope for this tenant's assessment, and this tenant's Admin 404 for theirs",
  )
  const missing = await traceOf(MISSING)
  check('T019', 'Missing assessment 404', missing.status === 404 && errorCode(missing.body) === 'NOT_FOUND' && !rawError(missing.body), 'a non-existent assessment: 404 NOT_FOUND')
  const spoofed = [
    await api('GET', `${tracePath(ASSESS1.assessmentId)}?organizationId=${otherOrg}&actorUserId=${O.id}`, undefined, (init = {}) => asAdmin({ ...init, headers: { 'X-Organization-Id': otherOrg, 'X-User-Id': O.id } })),
    await api('GET', `${tracePath(ASSESS1.assessmentId)}?organizationId=${org}`, undefined, (init = {}) => O.who({ ...init, headers: { 'X-Organization-Id': org } })),
  ]
  check(
    'T020',
    'No actor/tenant spoofing via request',
    spoofed[0].status === 200 && same(stable(spoofed[0].body), stable(TRACE1.body)) && spoofed[1].status === 404 && !deepKeys(TRACE1.body).has('recordedByUserId') && !deepKeys(TRACE1.body).has('actorUserId'),
    "an organization or actor in the query or a header changes nothing: this tenant still reads its own trace, the other tenant still gets 404; the trace carries no actor",
  )
  const refusalsLeftNothing = await unchanged(countsAtStart)

  // ---------------------------------------------------------------- complete case trace (T021–T030)
  section('The worked complete case: identity, copied digest, recorded outcome, one exact item per stored entry, no row changed')
  const upstreamBefore = { sources: await sourceHash(), classifications: await classificationHash(), readiness: await readinessHash(), cases: await allCasesHash(), assessments: await allAssessmentsHash() }
  const items1 = (TRACE1.body?.traceItems ?? []) as any[]
  check(
    'T021',
    'Complete case: external-absent trace',
    TRACE1.status === 200 && same(Object.keys(TRACE1.body ?? {}), DTO_KEYS) && TRACE1.body.traceCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && items1.length === 2 && CASE1.assemblyCode === 'INVENTORY_COMPLETE',
    '200: the complete case of two NOT_READY_FOR_ADJUDICATION sources traces EXTERNAL_FINANCIAL_EVIDENCE_ABSENT with two items; the DTO carries exactly its fields',
  )
  check('T022', 'Assessment and case identity exact', TRACE1.body?.assessmentId === ASSESS1.assessmentId && TRACE1.body?.caseId === CASE1.caseId && ASSESS1.caseId === CASE1.caseId, 'the trace names exactly ASSESS1 and its case CASE1')
  const snapshot1 = await prisma.evidenceCaseSnapshot.findUniqueOrThrow({ where: { id: CASE1.caseId }, include: { entries: { orderBy: { ordinal: 'asc' } } } })
  check('T023', 'Case SHA-256 copied unchanged', TRACE1.body?.caseManifestSha256 === snapshot1.manifestSha256 && TRACE1.body?.caseManifestSha256 === ASSESS1.caseManifestSha256, `the stored case digest ${snapshot1.manifestSha256.slice(0, 12)}… is copied, never recomputed; it equals the assessment's copy`)
  const row1 = await prisma.evidencePrereqResult.findUniqueOrThrow({ where: { id: ASSESS1.assessmentId } })
  check('T024', 'Trace outcome = recorded code and basis', TRACE1.body?.assessmentCode === row1.assessmentCode && TRACE1.body?.basisCode === row1.basisCode && TRACE1.body?.traceCode === row1.assessmentCode, `traceCode, assessmentCode and basisCode are exactly the recorded ${row1.assessmentCode} / ${row1.basisCode}`)
  check('T025', 'One output item per stored A7.4 item', items1.length === snapshot1.entries.length && TRACE1.body?.itemCount === snapshot1.itemCount && TRACE1.body?.sourceCount === snapshot1.sourceCount, `${items1.length} items for ${snapshot1.entries.length} stored entries; counts copied`)
  check('T026', 'Ordinals exactly A7.4 order 1..N', same(items1.map((i) => i.ordinal), snapshot1.entries.map((e) => e.ordinal)) && same(items1.map((i) => i.ordinal), [1, 2]) && same(items1.map((i) => i.sourceEvidenceId), [K1.E, K2.E]), 'ordinals 1..2 in the stored order: E1 then E2')
  check(
    'T027',
    'Source, classification, readiness exact',
    same(items1.map((i) => [i.sourceEvidenceId, i.classificationId, i.readinessId, i.sourceReasonCode]), snapshot1.entries.map((e) => [e.sourceEvidenceId, e.classificationId, e.readinessId, e.itemReasonCode])) && same(items1.map((i) => i.readinessId), [K1.R, K2.R]),
    'every item names exactly the stored source, classification, readiness and reason of its entry (E1/C1/R1, E2/C2/R2)',
  )
  check('T028', 'One explanation code per stored item', items1.every((i) => same(Object.keys(i), ITEM_KEYS) && EXPLANATIONS.includes(i.explanationCode)), 'every item carries exactly the TraceItemV1 fields and one controlled explanation')
  const storedGates = await prisma.evidenceGateResult.findMany({ where: { id: { in: [K1.R, K2.R] } } })
  check(
    'T029',
    'Explanations agree with readiness',
    items1.every((i) => {
      const g = storedGates.find((s) => s.id === i.readinessId)
      return g !== undefined && i.readinessCode === g.readinessCode && i.readinessReasonCode === g.reasonCode && i.explanationCode === 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT'
    }),
    'each item carries the stored readiness and reason of its A7.3 row, and NOT_READY_FOR_ADJUDICATION explains EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT',
  )
  const reads = [await traceOf(ASSESS1.assessmentId), await traceOf(ASSESS1.assessmentId, asViewer)]
  check(
    'T030',
    'A7.5, A7.4 and A7.3 rows unchanged',
    reads.every((r) => r.status === 200) && (await allAssessmentsHash()) === upstreamBefore.assessments && (await allCasesHash()) === upstreamBefore.cases && (await readinessHash()) === upstreamBefore.readiness && (await classificationHash()) === upstreamBefore.classifications && (await sourceHash()) === upstreamBefore.sources,
    'after repeated traces every byte of every assessment and case and of this run\'s readiness results, classifications and sources is identical',
  )

  // ---------------------------------------------------------------- controlled outcomes (T031–T040)
  section('Empty and incomplete cases through the real routes; REVIEW, UNSUPPORTED and unknown codes planted (always rolled back); correction independence')
  const SE = fresh()
  const emptyCase = await caseOf(SE)
  const emptyAssessment = await assessmentOf(emptyCase.caseId)
  const emptyTrace = await traceOf(emptyAssessment.assessmentId)
  check('T031', 'Empty case: zero items, NO_SOURCE_BASIS', emptyTrace.status === 200 && emptyTrace.body.traceCode === 'NO_SOURCE_BASIS' && emptyTrace.body.basisCode === 'NO_REGISTERED_SOURCES' && emptyTrace.body.traceItems.length === 0 && emptyTrace.body.itemCount === 0, 'an empty case traces NO_SOURCE_BASIS / NO_REGISTERED_SOURCES with zero items — no inventory, never a zero balance')
  const SI = fresh()
  const incSourceOnly = await registerSource(SI, 'INC-SOURCE-ONLY')
  const incClassified = await registerSource(SI, 'INC-CLASSIFIED')
  const incClassification = await classifySource(incClassified)
  const incLinked = await linkedSource(SI, 'INC-LINKED')
  const incCase = await caseOf(SI)
  const incAssessment = await assessmentOf(incCase.caseId)
  const incTrace = await traceOf(incAssessment.assessmentId)
  const itemOf = (trace: any, sourceId: string) => (trace.body?.traceItems ?? []).find((i: any) => i.sourceEvidenceId === sourceId)
  check(
    'T032',
    'SOURCE_ONLY yields SOURCE_UNCLASSIFIED',
    incTrace.status === 200 && incTrace.body.traceCode === 'INCOMPLETE_SOURCE_CHAIN' && itemOf(incTrace, incSourceOnly)?.explanationCode === 'SOURCE_UNCLASSIFIED' && itemOf(incTrace, incSourceOnly)?.classificationId === null && itemOf(incTrace, incSourceOnly)?.readinessId === null && itemOf(incTrace, incSourceOnly)?.readinessCode === null,
    'a source without classification is SOURCE_UNCLASSIFIED with every missing link null; the case traces INCOMPLETE_SOURCE_CHAIN',
  )
  check(
    'T033',
    'CLASSIFIED_NO_READINESS explained',
    itemOf(incTrace, incClassified)?.explanationCode === 'CLASSIFICATION_NO_READINESS' && itemOf(incTrace, incClassified)?.classificationId === incClassification && itemOf(incTrace, incClassified)?.readinessId === null && itemOf(incTrace, incClassified)?.readinessReasonCode === null,
    'a classification without readiness is CLASSIFICATION_NO_READINESS, naming the classification and leaving the readiness null',
  )
  check('T034', 'LINKED NOT_READY: external evidence absent', itemOf(incTrace, incLinked.E)?.explanationCode === 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' && itemOf(incTrace, incLinked.E)?.readinessId === incLinked.R && items1.every((i) => i.explanationCode === 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT'), 'every linked NOT_READY_FOR_ADJUDICATION item is EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT')
  const review = await planted({ gates: [{ of: 0 }, { of: 1, ...REVIEW }], entries: (g) => [linkedRow(0, g), linkedRow(1, g)], assessment: { code: 'REVIEW_REQUIRED', guardOn: true } })
  check(
    'T035',
    'REVIEW test-only trace agrees',
    tracedAs(review, 'REVIEW_REQUIRED') && review.result?.ok === true && same(review.result.value.traceItems.map((i: any) => i.explanationCode), ['EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'CLASSIFICATION_REVIEW_REQUIRED']),
    'a planted complete case holding a SOURCE_REQUIRES_REVIEW readiness, assessed REVIEW_REQUIRED with the A7.5 guard on, traces REVIEW_REQUIRED and explains the item as CLASSIFICATION_REVIEW_REQUIRED (rolled back)',
  )
  const unsupported = await planted({ gates: [{ of: 0 }, { of: 1, ...UNSUPPORTED }], entries: (g) => [linkedRow(0, g), linkedRow(1, g)], assessment: { code: 'UNSUPPORTED_SOURCE_BASIS', guardOn: true } })
  check(
    'T036',
    'UNSUPPORTED test-only trace agrees',
    tracedAs(unsupported, 'UNSUPPORTED_SOURCE_BASIS') && unsupported.result?.ok === true && unsupported.result.value.traceItems[1].explanationCode === 'CLASSIFICATION_UNSUPPORTED',
    'a planted complete case holding a SOURCE_UNSUPPORTED readiness, assessed UNSUPPORTED_SOURCE_BASIS with the A7.5 guard on, traces UNSUPPORTED_SOURCE_BASIS (rolled back)',
  )
  const mixed = await planted({ gates: [{ of: 0, ...UNSUPPORTED }, { of: 1, ...REVIEW }, { of: 2 }], entries: (g) => [linkedRow(0, g), linkedRow(1, g), linkedRow(2, g)], assessment: { code: 'REVIEW_REQUIRED', guardOn: true } })
  const mixedForged = await planted({ gates: [{ of: 0, ...UNSUPPORTED }, { of: 1, ...REVIEW }, { of: 2 }], entries: (g) => [linkedRow(0, g), linkedRow(1, g), linkedRow(2, g)], assessment: { code: 'UNSUPPORTED_SOURCE_BASIS' } })
  check(
    'T037',
    'Mixed review/unsupported: A7.5 priority',
    tracedAs(mixed, 'REVIEW_REQUIRED') && refusedConflict(mixedForged),
    `review outranks unsupported exactly as in A7.5: the REVIEW_REQUIRED assessment traces; an UNSUPPORTED_SOURCE_BASIS record of the same case is refused (${detailOf(mixedForged)})`,
  )
  const unknownCode = await planted({
    relax: [`ALTER TABLE ${GATE} DROP CONSTRAINT evidence_gate_results_readiness_chk`, `ALTER TABLE ${GATE} DROP CONSTRAINT evidence_gate_results_pairing_chk`],
    gates: [{ of: 0 }, { of: 1, readinessCode: 'READY_FOR_ADJUDICATION' }],
    entries: (g) => [linkedRow(0, g), linkedRow(1, g)],
  })
  check('T038', 'Unknown readiness code refuses 409', refusedConflict(unknownCode) && /approved readiness\/reason pair/.test(detailOf(unknownCode)), `an invented READY_FOR_ADJUDICATION readiness (planted with the A7.3 CHECKs dropped, rolled back) is refused 409, never mapped: ${detailOf(unknownCode)}`)
  const unknownReason = await planted({
    relax: [`ALTER TABLE ${GATE} DROP CONSTRAINT evidence_gate_results_reason_chk`, `ALTER TABLE ${GATE} DROP CONSTRAINT evidence_gate_results_pairing_chk`],
    gates: [{ of: 0 }, { of: 1, reasonCode: 'PAYER_CONFIRMED' }],
    entries: (g) => [linkedRow(0, g), linkedRow(1, g)],
  })
  check('T039', 'Unknown controlled reason refuses 409', refusedConflict(unknownReason) && /approved readiness\/reason pair/.test(detailOf(unknownReason)), `an invented PAYER_CONFIRMED reason is refused 409: ${detailOf(unknownReason)}`)
  const CASE_S2 = await caseOf(S2)
  const ASSESS_S2 = await assessmentOf(CASE_S2.caseId)
  const traceS2 = await traceOf(ASSESS_S2.assessmentId)
  const trace1Again = await traceOf(ASSESS1.assessmentId)
  check(
    'T040',
    'A6.9 corrected submission independent',
    traceS2.status === 200 && traceS2.body.caseId === CASE_S2.caseId && same(traceS2.body.traceItems.map((i: any) => i.sourceEvidenceId), [KS2.E]) && same(stable(trace1Again.body), stable(TRACE1.body)),
    "the corrected freeze S2 (an A6.9 link from S1) has its own case, assessment and trace naming only its own source; ASSESS1's trace is unchanged",
  )

  // ---------------------------------------------------------------- read and replay integrity (T041–T050)
  section('Stable reads, other users, evaluatedAt only, later evidence, no latest, dispositions, future contract, duplicate and missing readiness')
  const twice = [await traceOf(ASSESS1.assessmentId), await traceOf(ASSESS1.assessmentId)]
  check('T041', 'Same GET twice: identical stable fields', twice.every((r) => r.status === 200) && same(stable(twice[0].body), stable(twice[1].body)) && same(stable(twice[0].body), stable(TRACE1.body)), 'two consecutive reads return identical stable fields, equal to the first trace')
  check('T042', 'Other permitted user: identical facts', [viewerTrace, adminB].every((r) => same(stable(r.body), stable(TRACE1.body))), 'the Viewer and a second Admin see exactly the same facts')
  const times = [TRACE1.body.evaluatedAt, twice[0].body.evaluatedAt, twice[1].body.evaluatedAt]
  check(
    'T043',
    'Only evaluatedAt may differ',
    same(Object.keys(twice[0].body).filter((k) => JSON.stringify(twice[0].body[k]) !== JSON.stringify(TRACE1.body[k])).filter((k) => k !== 'evaluatedAt'), []) && times.every((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t) && Date.parse(times[0]) <= Date.parse(times[2]),
    `between reads only evaluatedAt changes (${times[0]} … ${times[2]}), a canonical UTC database instant`,
  )
  const K3 = await linkedSource(S1, 'E3-LATER')
  const afterLater = await traceOf(ASSESS1.assessmentId)
  check('T044', 'Later E3: trace remains historical', afterLater.status === 200 && same(stable(afterLater.body), stable(TRACE1.body)) && !afterLater.body.traceItems.some((i: any) => i.sourceEvidenceId === K3.E), 'after E3 is registered, classified and gated on S1, the trace of ASSESS1 is identical and does not list E3')
  const latest = [await get(`/api/claim-submissions/${S1}/basis-trace`), await get(`/api/claims/${W.claimId}/basis-trace`), await get(`/api/revenue-evidence-cases/${CASE1.caseId}/basis-trace`), await traceOf(CASE1.caseId)]
  check(
    'T045',
    'No automatic latest correction selection',
    latest.every((r) => r.status === 404) && afterLater.body.caseId === CASE1.caseId && ![...deepKeys(afterLater.body)].some((k) => /latest|current|successor|corrected|newest/i.test(k)),
    'a trace names one exact assessment from the path: per-submission, per-Claim and per-case scans are 404, a case id is not an assessment, and nothing points to the corrected freeze S2',
  )
  const Re = await home.series('release eligible', 1)
  const re = await assessedCase('RELEASED', Re.freezes[0])
  await post(`/api/claim-submissions/${Re.freezes[0]}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null })
  const reLifecycle = await lifecycleHash(Re.claimId)
  const reTrace = await traceOf(re.assessment.assessmentId)
  check(
    'T046',
    'RELEASE_ELIGIBLE is not payer release',
    reTrace.status === 200 && reTrace.body.traceCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && (await get(`/api/claim-submissions/${Re.freezes[0]}/lifecycle`)).body?.state === 'RELEASE_ELIGIBLE' && (await lifecycleHash(Re.claimId)) === reLifecycle,
    'the trace of a RELEASE_ELIGIBLE freeze still explains EXTERNAL_FINANCIAL_EVIDENCE_ABSENT — internal release is never payer release — and the lifecycle is byte-identical',
  )
  const Wd = await home.series('withdrawn', 1)
  const wd = await assessedCase('WITHDRAWN', Wd.freezes[0])
  const beforeWithdrawal = await traceOf(wd.assessment.assessmentId)
  await post(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle-events`, { eventCode: 'WITHDRAW_INTERNAL', reasonCode: 'INTERNAL_OTHER' })
  const afterWithdrawal = await traceOf(wd.assessment.assessmentId)
  check(
    'T047',
    'WITHDRAWN_INTERNAL does not rewrite',
    beforeWithdrawal.status === 200 && (await get(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle`)).body?.state === 'WITHDRAWN_INTERNAL' && same(stable(afterWithdrawal.body), stable(beforeWithdrawal.body)),
    'an internal withdrawal after the assessment leaves its trace identical; the disposition is neither read nor changed',
  )
  const futureContract = await planted({ relax: [`ALTER TABLE ${PREREQ} DROP CONSTRAINT evidence_prereq_results_contract_chk`], gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g)], assessment: { contract: 'A7-CLOSURE-PREREQ-2' } })
  check('T048', 'A7.5 future contract refused', refusedConflict(futureContract) && /A7-CLOSURE-PREREQ-1/.test(detailOf(futureContract)), `an assessment under A7-CLOSURE-PREREQ-2 (CHECK dropped, rolled back) is refused 409: ${detailOf(futureContract)}`)
  const duplicateReadiness = await planted({ relax: ['DROP INDEX evidence_gate_results_identity_key'], gates: [{ of: 0 }, { of: 0 }], entries: (g) => [linkedRow(0, g)] })
  check('T049', 'Duplicate readiness results refused', refusedConflict(duplicateReadiness) && /more than one readiness/.test(detailOf(duplicateReadiness)), `two stored results for one linked classification (identity index dropped, rolled back) are refused 409: ${detailOf(duplicateReadiness)}`)
  const missingReadiness = await planted({ gates: [], entries: () => [{ ordinal: 1, source: FS[0].E, classification: FS[0].C, readiness: randomUuid(), reason: 'LINKED' }] })
  check('T050', 'Missing readiness ID fails closed', refusedConflict(missingReadiness) && /missing; it is never assumed/.test(detailOf(missingReadiness)), `an entry naming a readiness result that does not exist is refused 409: ${detailOf(missingReadiness)}`)

  // ---------------------------------------------------------------- broken provenance (T051–T060)
  section('Broken provenance (planted, always rolled back): classification, source, case, digest, codes, contracts, ordinals, duplicate source')
  const wrongClassification = await planted({ gates: [{ of: 0 }, { of: 1 }, { of: 2 }], entries: (g) => [{ ...linkedRow(0, g), classification: FS[1].C, readiness: g[1] }, linkedRow(2, g, 2)] })
  check('T051', 'Wrong classification in linked item', refusedConflict(wrongClassification) && /another source/.test(detailOf(wrongClassification)), `an entry of source F1 naming F2's classification and readiness is refused 409: ${detailOf(wrongClassification)}`)
  const foreignSource = await planted({ gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g), { ordinal: 2, source: KS2.E, classification: null, readiness: null, reason: 'SOURCE_ONLY' }], assessment: { code: 'INCOMPLETE_SOURCE_CHAIN' } })
  check('T052', 'Foreign source in case entry refused', refusedConflict(foreignSource) && /not a registration/.test(detailOf(foreignSource)), `an entry naming a source of the correction freeze S2 inside a case of SF is refused 409: ${detailOf(foreignSource)}`)
  const wrongCase = await planted({ relax: ['DROP INDEX evidence_prereq_results_identity_key'], gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g)], assessment: { caseId: CASE1.caseId } })
  check('T053', 'Wrong case ID in assessment refused', refusedConflict(wrongCase) && /digest/.test(detailOf(wrongCase)), `an assessment pointing at CASE1 while carrying the planted case's digest is refused 409: ${detailOf(wrongCase)}`)
  const wrongDigest = await planted({ gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g)], assessment: { digest: 'f'.repeat(64) } })
  check('T054', 'Case digest disagreement refused', refusedConflict(wrongDigest) && /digest/.test(detailOf(wrongDigest)), `an assessment whose copied digest is not the case's is refused 409: ${detailOf(wrongDigest)}`)
  const wrongCode = await planted({ gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g)], assessment: { code: 'INCOMPLETE_SOURCE_CHAIN' } })
  check('T055', 'Mismatched assessment code refused', refusedConflict(wrongCode) && /do not explain the recorded outcome/.test(detailOf(wrongCode)), `a complete case recorded as INCOMPLETE_SOURCE_CHAIN is refused 409: ${detailOf(wrongCode)}`)
  const wrongBasis = await planted({ relax: [`ALTER TABLE ${PREREQ} DROP CONSTRAINT evidence_prereq_results_pairing_chk`], gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g)], assessment: { basis: 'NO_REGISTERED_SOURCES' } })
  check('T056', 'Mismatched basis code refused', refusedConflict(wrongBasis) && /basis/.test(detailOf(wrongBasis)), `EXTERNAL_FINANCIAL_EVIDENCE_ABSENT recorded with NO_REGISTERED_SOURCES (pairing CHECK dropped) is refused 409: ${detailOf(wrongBasis)}`)
  const wrongCaseContract = await planted({ relax: [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_contract_chk`], gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g)], header: { contract: 'A7-REVENUE-CASE-2' } })
  check('T057', 'Wrong A7.4 contract refused', refusedConflict(wrongCaseContract) && /A7-REVENUE-CASE-1/.test(detailOf(wrongCaseContract)), `a case under A7-REVENUE-CASE-2 (CHECK dropped) is refused 409: ${detailOf(wrongCaseContract)}`)
  const wrongReadinessContract = await planted({ relax: [`ALTER TABLE ${GATE} DROP CONSTRAINT evidence_gate_results_contract_chk`], gates: [{ of: 0, contract: 'A7-ADJ-READINESS-2' }], entries: (g) => [linkedRow(0, g)] })
  check('T058', 'Wrong A7.3 contract refused', refusedConflict(wrongReadinessContract) && /contract version/.test(detailOf(wrongReadinessContract)), `a readiness result under A7-ADJ-READINESS-2 (CHECK dropped) is refused 409: ${detailOf(wrongReadinessContract)}`)
  const gapOrdinal = await planted({ gates: [{ of: 0 }, { of: 1 }], entries: (g) => [linkedRow(0, g, 1), linkedRow(1, g, 3)] })
  const repeatedOrdinal = await planted({ relax: ['DROP INDEX evidence_case_entries_ordinal_key'], gates: [{ of: 0 }, { of: 1 }], entries: (g) => [linkedRow(0, g, 1), linkedRow(1, g, 1)] })
  check('T059', 'Noncontiguous or repeated ordinal', [gapOrdinal, repeatedOrdinal].every(refusedConflict) && [gapOrdinal, repeatedOrdinal].every((p) => /1\.\.N/.test(detailOf(p))), `ordinals 1,3 and a repeated 1 (ordinal index dropped) are refused 409: ${detailOf(gapOrdinal)}`)
  const duplicateSource = await planted({ relax: ['DROP INDEX evidence_case_entries_source_key'], gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g, 1), { ...linkedRow(0, g, 2) }] })
  check('T060', 'Duplicate source entry refused', refusedConflict(duplicateSource) && /repeated/.test(detailOf(duplicateSource)), `two entries for one source (source index dropped) are refused 409: ${detailOf(duplicateSource)}`)

  // ---------------------------------------------------------------- structural contradictions (T061–T070)
  section('Structural contradictions (planted, always rolled back): counts, assembly codes, link shapes, readiness ownership, repeats, uncontrolled pairs')
  const wrongSourceCount = await planted({ relax: [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_counts_chk`], gates: [{ of: 0 }, { of: 1 }], entries: (g) => [linkedRow(0, g), linkedRow(1, g)], header: { sourceCount: 3 } })
  check('T061', 'Incorrect header sourceCount refused', refusedConflict(wrongSourceCount) && /counts disagree/.test(detailOf(wrongSourceCount)), `sourceCount 3 over two entries is refused 409: ${detailOf(wrongSourceCount)}`)
  const wrongClassified = await planted({ gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g), classifiedRow(1)], header: { classifiedCount: 1 }, assessment: { code: 'INCOMPLETE_SOURCE_CHAIN' } })
  check('T062', 'Incorrect classifiedCount refused', refusedConflict(wrongClassified) && /counts disagree/.test(detailOf(wrongClassified)), `classifiedCount 1 over two classified entries is refused 409: ${detailOf(wrongClassified)}`)
  const wrongReadinessCount = await planted({ gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g), classifiedRow(1)], header: { readinessCount: 0 }, assessment: { code: 'INCOMPLETE_SOURCE_CHAIN' } })
  check('T063', 'Incorrect readinessCount refused', refusedConflict(wrongReadinessCount) && /counts disagree/.test(detailOf(wrongReadinessCount)), `readinessCount 0 over one linked entry is refused 409: ${detailOf(wrongReadinessCount)}`)
  const noSourcesWithItems = await planted({ gates: [{ of: 0 }], entries: (g) => [linkedRow(0, g)], header: { code: 'NO_REVENUE_SOURCES', sourceCount: 0, classifiedCount: 0, readinessCount: 0, itemCount: 0 }, assessment: { code: 'NO_SOURCE_BASIS' } })
  check('T064', 'NO_REVENUE_SOURCES with items refused', refusedConflict(noSourcesWithItems), `a NO_REVENUE_SOURCES header over a stored entry is refused 409: ${detailOf(noSourcesWithItems)}`)
  const completeMissingReadiness = await planted({ entries: () => [classifiedRow(0)], header: { code: 'INVENTORY_COMPLETE', readinessCount: 1 } })
  check('T065', 'COMPLETE with missing readiness refused', refusedConflict(completeMissingReadiness), `an INVENTORY_COMPLETE header over a classification without readiness is refused 409: ${detailOf(completeMissingReadiness)}`)
  const incompleteAllLinked = await planted({ relax: [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_code_counts_chk`], gates: [{ of: 0 }, { of: 1 }], entries: (g) => [linkedRow(0, g), linkedRow(1, g)], header: { code: 'INVENTORY_INCOMPLETE' }, assessment: { code: 'INCOMPLETE_SOURCE_CHAIN' } })
  check('T066', 'INCOMPLETE with all linked refused', refusedConflict(incompleteAllLinked) && /assembly code/.test(detailOf(incompleteAllLinked)), `an INVENTORY_INCOMPLETE header over two linked entries (code CHECK dropped) is refused 409: ${detailOf(incompleteAllLinked)}`)
  const readinessNoClassification = await planted({ relax: [`ALTER TABLE ${ENTRY} DROP CONSTRAINT evidence_case_entries_shape_chk`], gates: [{ of: 0 }], entries: (g) => [{ ordinal: 1, source: FS[0].E, classification: null, readiness: g[0], reason: 'SOURCE_ONLY' }], header: { code: 'INVENTORY_INCOMPLETE', readinessCount: 0 }, assessment: { code: 'INCOMPLETE_SOURCE_CHAIN' } })
  check('T067', 'Readiness without classification refused', refusedConflict(readinessNoClassification) && /reason disagrees with its links/.test(detailOf(readinessNoClassification)), `a SOURCE_ONLY entry naming a readiness (shape CHECK dropped) is refused 409: ${detailOf(readinessNoClassification)}`)
  const readinessOtherSource = await planted({ gates: [{ of: 0, source: FS[1].E }], entries: (g) => [linkedRow(0, g)] })
  check('T068', 'Readiness source mismatch refused', refusedConflict(readinessOtherSource) && /another source/.test(detailOf(readinessOtherSource)), `F1's classification with a readiness recorded for source F2 is refused 409: ${detailOf(readinessOtherSource)}`)
  const repeatedReadiness = await planted({ gates: [{ of: 0 }, { of: 1 }], entries: (g) => [linkedRow(0, g), { ...linkedRow(1, g), readiness: g[0] }] })
  check('T069', 'Repeated readiness ID refused', refusedConflict(repeatedReadiness) && /same readiness/.test(detailOf(repeatedReadiness)), `two linked entries naming one readiness result are refused 409: ${detailOf(repeatedReadiness)}`)
  const uncontrolledPair = await planted({ relax: [`ALTER TABLE ${GATE} DROP CONSTRAINT evidence_gate_results_pairing_chk`], gates: [{ of: 0, readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }], entries: (g) => [linkedRow(0, g)] })
  const plantedLeftNothing = plantedRuns.total >= 30 && plantedRuns.dirty === 0
  check(
    'T070',
    'Uncontrolled pair refused, not guessed',
    refusedConflict(uncontrolledPair) && /approved readiness\/reason pair/.test(detailOf(uncontrolledPair)) && plantedLeftNothing,
    `NOT_READY_FOR_ADJUDICATION with CLASSIFICATION_UNSUPPORTED (pairing CHECK dropped) is refused 409, never mapped to the nearest explanation; each of the ${plantedRuns.total} planted cases left all rows, CHECKs and indexes byte-identical (${plantedRuns.dirty} did not): ${detailOf(uncontrolledPair)}`,
  )

  // ---------------------------------------------------------------- snapshot and concurrency (T071–T080)
  section('One read-only snapshot, the caller DbClient, no Claim lock, writers of A7.1–A7.5 held uncommitted, no write or audit')
  const serviceCode = committedCode(`${MODULE_DIR}/closure-basis-trace.service.ts`)
  const ofBody = serviceCode.slice(serviceCode.indexOf('export async function getClosureBasisTraceOf'), serviceCode.indexOf('export async function getClosureBasisTrace('))
  // A harness-held REPEATABLE READ snapshot: a source registered on S1 by another transaction after the snapshot began
  // is invisible to every owner read on it, and the trace on it stays identical.
  const snapshotProof = await withReadSnapshot(undefined, async (tx) => {
    const first = await getClosureBasisTraceOf(ASSESS1.assessmentId, tx)
    const sourcesBefore = await getRevenueSourceEvidenceOf(S1, tx)
    const registered = await registerRevenueSourceEvidence(S1, { sourceKind: SYNTHETIC, sourceReference: ref('DURING-SNAPSHOT') }, creatorId)
    const second = await getClosureBasisTraceOf(ASSESS1.assessmentId, tx)
    const sourcesAfter = await getRevenueSourceEvidenceOf(S1, tx)
    return { first, second, registered: registered.ok, before: sourcesBefore.ok ? sourcesBefore.value.items.length : -1, after: sourcesAfter.ok ? sourcesAfter.value.items.length : -2 }
  })
  check(
    'T071',
    'One committed DB snapshot for all reads',
    /return withReadSnapshot\(undefined, \(tx\) => getClosureBasisTraceOf\(assessmentId, tx\)\)/.test(serviceCode) && snapshotProof.registered && snapshotProof.before === snapshotProof.after && snapshotProof.first.ok && snapshotProof.second.ok && same(stable(snapshotProof.first.value), stable(snapshotProof.second.value)),
    `the public read is one REPEATABLE READ, READ ONLY snapshot; on a held snapshot a source committed meanwhile is invisible to the owner reads (${snapshotProof.before} registrations before and after) and the trace is identical`,
  )
  check(
    'T072',
    'Owner reads on the same caller DbClient',
    /findAssessmentById\(assessmentId\.toLowerCase\(\), tx\)/.test(ofBody) && /findCaseForPrerequisite\(assessment\.evidenceCaseId, tx\)/.test(ofBody) && /findCaseById\(assessment\.evidenceCaseId, tx\)/.test(ofBody) &&
      /getRevenueSourceEvidenceOf\(stored\.claimSubmissionId, tx\)/.test(ofBody) && /getReadinessOf\(classificationId, tx\)/.test(ofBody) && /readTransactionTimestamp\(tx\)/.test(ofBody) && !/prisma\.|withReadSnapshot/.test(ofBody),
    'the A7.5 assessment and chain, the A7.4 case, the A7.1 registrations, every A7.3 readiness and the evaluation instant are all read on the one caller client',
  )
  const production = committedProductionCodeOf([MODULE_DIR])
  const holdLock = holdAt('casePrerequisite.claim_locked')
  const lockHolder = assessClosurePrerequisites(CASE1.caseId, {}, creatorId)
  await Promise.race([holdLock.arrived, lockHolder])
  const duringLock = traceOf(ASSESS1.assessmentId)
  const lockFree = await settledWithin(duringLock, 3000)
  const duringLockBody = (await duringLock).body
  holdLock.release()
  const lockReplay = await lockHolder
  clearConcurrencyProbes()
  check(
    'T073',
    'No Claim write lock for a read',
    lockFree && same(stable(duringLockBody), stable(TRACE1.body)) && lockReplay.ok && lockReplay.value.replayed && !/lockRowForUpdate|FOR UPDATE|FOR SHARE|NOWAIT|row-lock/.test(production.code),
    "while an A7.5 request holds CASE1's Claim row lock, the trace answers at once with the identical facts; the A7.6 code requests no row lock",
  )
  const raceRead = async (probe: string, writer: () => Promise<{ ok: boolean }>, assessmentId = ASSESS1.assessmentId) => {
    const before = await traceOf(assessmentId)
    const hold = holdAt(probe)
    const w = writer()
    await Promise.race([hold.arrived, w])
    const during = traceOf(assessmentId)
    const prompt = await settledWithin(during, 3000)
    const duringBody = (await during).body
    hold.release()
    const written = await w
    clearConcurrencyProbes()
    const after = await traceOf(assessmentId)
    return { prompt, ok: written.ok, identical: same(stable(duringBody), stable(before.body)) && same(stable(after.body), stable(before.body)) }
  }
  const r74 = await raceRead('revenueEvidence.inserted', () => registerRevenueSourceEvidence(S1, { sourceKind: SYNTHETIC, sourceReference: ref('A71-RACE') }, creatorId))
  check('T074', 'Concurrent A7.1 cannot mix snapshot', r74.prompt && r74.ok && r74.identical, 'with an A7.1 registration on S1 inserted but uncommitted, the trace answers at once with committed facts only; after it commits the trace is still identical')
  const s75 = await registerSource(S1, 'A72-RACE')
  const r75 = await raceRead('evidenceClassification.inserted', () => classifySourceEvidence(s75, {}, creatorId))
  check('T075', 'Concurrent A7.2 cannot mix snapshot', r75.prompt && r75.ok && r75.identical, 'with an A7.2 classification on S1 uncommitted, the trace answers at once and stays identical after it commits')
  const c76 = await classifySource(await registerSource(S1, 'A73-RACE'))
  const r76 = await raceRead('evidenceGate.inserted', () => recordAdjudicationReadiness(c76, {}, creatorId))
  check('T076', 'Concurrent A7.3 cannot mix snapshot', r76.prompt && r76.ok && r76.identical, 'with an A7.3 readiness on S1 uncommitted, the trace answers at once and stays identical after it commits')
  const S77 = fresh()
  await linkedSource(S77, 'A74-RACE')
  const r77 = await raceRead('evidenceCase.entries_inserted', () => assembleRevenueEvidenceCase(S77, {}, creatorId))
  check('T077', 'Concurrent A7.4 cannot mix snapshot', r77.prompt && r77.ok && r77.identical, 'with an A7.4 case assembly (header and entries written) uncommitted, the trace answers at once and stays identical after it commits')
  const S78 = fresh()
  await linkedSource(S78, 'A75-RACE')
  const case78 = await caseOf(S78)
  const r78 = await raceRead('casePrerequisite.inserted', () => assessClosurePrerequisites(case78.caseId, {}, creatorId))
  check('T078', 'Concurrent A7.5 cannot mix snapshot', r78.prompt && r78.ok && r78.identical, 'with a new A7.5 assessment uncommitted, the trace answers at once and stays identical after it commits')
  const S79 = fresh()
  await linkedSource(S79, 'UNCOMMITTED')
  const hold79 = holdAt('evidenceCase.audited')
  const pending79 = assembleRevenueEvidenceCase(S79, {}, creatorId)
  await Promise.race([hold79.arrived, pending79])
  const visibleCases = await prisma.evidenceCaseSnapshot.count({ where: { claimSubmissionId: S79 } })
  const during79 = traceOf(ASSESS1.assessmentId)
  const prompt79 = await settledWithin(during79, 3000)
  const during79Body = (await during79).body
  hold79.release()
  const done79 = await pending79
  clearConcurrencyProbes()
  check('T079', 'Uncommitted tx: committed facts only', visibleCases === 0 && prompt79 && same(stable(during79Body), stable(TRACE1.body)) && done79.ok, 'while a case, its entries and audit are uncommitted no read can see them (0 visible), and the trace answers at once with committed facts')
  const readOnlyProof = await attemptAdversarial(() => withReadSnapshot(undefined, async (tx) => tx.$executeRawUnsafe(`UPDATE ${PREREQ} SET assessment_code = assessment_code WHERE id = $1::uuid`, ASSESS1.assessmentId)))
  const noXid = await prisma.$transaction(async (tx) => {
    await getClosureBasisTraceOf(ASSESS1.assessmentId, tx)
    return (await tx.$queryRaw<{ x: string | null }[]>`SELECT txid_current_if_assigned()::text AS x`)[0].x
  })
  check(
    'T080',
    'No transaction-level write or audit',
    /read-only transaction/.test(readOnlyProof) && noXid === null && !/\.create\(|\.update\(|\.delete\(|\.upsert\(|INSERT |UPDATE |DELETE |recordAuditEvent|\$executeRaw/i.test(production.code),
    'the snapshot refuses any write (READ ONLY); a full trace never assigns a transaction id (no write of any kind); the A7.6 code holds no insert, update, delete, raw execute or audit call',
  )

  // ---------------------------------------------------------------- privacy and no writes (T081–T090)
  section('Privacy: exact schema, no PHI, codes, money, bytes, fingerprints or secrets, no audit on success or refusal, safe errors, tenant isolation')
  const traces = [TRACE1.body, emptyTrace.body, incTrace.body, traceS2.body, reTrace.body]
  const exposed = JSON.stringify(traces)
  const exposedKeys = [...deepKeys(JSON.parse(exposed))]
  check('T081', 'DTO exact schema, no unknown values', traces.every((t: any) => same(Object.keys(t), DTO_KEYS) && t.traceItems.every((i: any) => same(Object.keys(i), ITEM_KEYS))), 'every trace carries exactly its 11 fields and every item exactly its 8 TraceItemV1 fields')
  check('T082', 'No PHI or member value', !exposed.includes(`${runId}-home-P`) && !exposed.includes('1990-01-01') && !exposedKeys.some((k) => /patient|member|name|birth|email|phone|address|gender/i.test(k)), 'no patient, member or contact value or key')
  check('T083', 'No diagnosis/procedure values', !exposedKeys.some((k) => /diagnos|procedure|activity|encounter|clinician|facility/i.test(k)) && !exposed.includes(key('home-DXA')) && !exposed.includes(key('home-PA')), 'no diagnosis, procedure, activity, encounter, clinician or facility key or value')
  check('T084', 'No amount, payer, currency, balance', !/125\.25|12\.125|200\.01|AED/.test(exposed) && !exposedKeys.some((k) => /amount|balance|currency|paid|price|fee|payer|payment|denial|adjudicat|status|verdict/i.test(k)) && !/"(PAID|DENIED|SETTLED|CLOSED|READY_FOR_CLOSURE)"/.test(exposed), 'no amount, currency, balance, fee, payer, payment, denial, status or verdict key or value')
  check('T085', 'No frozen payload or evidence bytes', !exposedKeys.some((k) => /bytes|payload|seal|manifestText|sourceReference|raw|content/i.test(k)) && !exposed.includes(ref('E1')), 'no frozen payload, manifest bytes, seal or source reference leaves the server')
  const fingerprints = (await prisma.sourceEvidenceClassification.findMany({ where: { id: { in: [K1.C, K2.C] } }, select: { sourceFingerprintSha256: true } })).map((r) => r.sourceFingerprintSha256)
  const sourceDigests = (await prisma.revenueSourceEvidence.findMany({ where: { id: { in: [K1.E, K2.E] } }, select: { sourceDigestSha256: true } })).map((r) => r.sourceDigestSha256).filter((d): d is string => d !== null)
  check('T086', 'No raw source fingerprint or secret', !exposedKeys.some((k) => /fingerprint|secret|token|password|cookie/i.test(k)) && fingerprints.every((f) => !exposed.includes(f)) && sourceDigests.every((d) => !exposed.includes(d)), 'no per-source fingerprint or digest, secret, token or cookie: the only digest is the case manifest digest')
  const auditsBefore = await prisma.auditEvent.count()
  for (const who of [asAdmin, asViewer, B.who]) await traceOf(ASSESS1.assessmentId, who)
  const auditsAfterReads = await prisma.auditEvent.count()
  check('T087', 'No audit on GET', auditsAfterReads === auditsBefore && refusalsLeftNothing, 'successful traces by three users wrote no audit (and no other row)')
  for (const res of [await traceOf(MISSING), await traceOf('not-a-uuid'), await traceOf(ASSESS1.assessmentId, anonymous), await traceOf(ASSESS1.assessmentId, O.who)]) void res
  check('T088', 'No audit on refused GET', (await prisma.auditEvent.count()) === auditsAfterReads, 'missing, malformed, anonymous and foreign reads wrote no audit')
  const errorBodies = [...malformed, ...injected, anon, foreignOnHome, homeOnForeign, missing, ...absent, ...latest, spoofed[1]]
  const plantedRefusals = [unknownCode, wrongCase, wrongDigest, duplicateSource]
  check(
    'T089',
    'Safe errors omit SQL/stack details',
    errorBodies.every((res) => !rawError(res.body) && (res.status === 401 || res.status === 404 || typeof res.body?.error?.code === 'string')) && plantedRefusals.every((p) => p.result?.ok === false && !rawError({ error: p.result })) &&
      /code === 'NOT_FOUND' \? 404 : code === 'VALIDATION_ERROR' \? 400 : 409/.test(routeCode),
    `all ${errorBodies.length} HTTP refusals and the planted 409 messages carry only a public code and a safe message — no SQL, stack, guard or table name; 409 is the mapped status of CLOSURE_BASIS_PROVENANCE_CONFLICT`,
  )
  check('T090', 'Cross-tenant single read 404', foreignOnHome.status === 404 && homeOnForeign.status === 404 && !JSON.stringify([foreignOnHome.body, homeOnForeign.body]).includes(CASE1.caseId) && !JSON.stringify(foreignOnHome.body).includes(org), "neither tenant can read the other's trace (404, the missing envelope), and no case id or organization leaks")

  // ---------------------------------------------------------------- determinism and truthful boundaries (T091–T100)
  section('Fifty identical reductions, time zone and locale invariance, zero writes, no balance, closure, adjudication or auto-clearing, no pointer')
  const factsOf = async (assessmentId: string): Promise<TraceFacts> =>
    withReadSnapshot(undefined, async (tx) => {
      const a = await prisma.evidencePrereqResult.findUniqueOrThrow({ where: { id: assessmentId } })
      const s = await prisma.evidenceCaseSnapshot.findUniqueOrThrow({ where: { id: a.evidenceCaseId }, include: { entries: { orderBy: { ordinal: 'asc' } } } })
      const g = await prisma.evidenceGateResult.findMany({ where: { classificationId: { in: s.entries.filter((e) => e.itemReasonCode === 'LINKED').map((e) => e.classificationId as string) } } })
      const regs = await getRevenueSourceEvidenceOf(s.claimSubmissionId, tx)
      return {
        assessment: { assessmentId: a.id, caseId: a.evidenceCaseId, organizationId: a.organizationId, contractVersion: a.contractVersion, assessmentCode: a.assessmentCode, basisCode: a.basisCode, caseManifestSha256: a.caseManifestSha256 },
        header: { ...s, caseId: s.id },
        entries: s.entries,
        readiness: g.map((r) => ({ readinessId: r.id, classificationId: r.classificationId, sourceEvidenceId: r.sourceEvidenceId, contractVersion: r.contractVersion, readinessCode: r.readinessCode, reasonCode: r.reasonCode })),
        submissionSourceIds: regs.ok ? regs.value.items.map((i) => i.revenueSourceEvidenceId) : [],
      }
    })
  const facts1 = await factsOf(ASSESS1.assessmentId)
  const repeated = Array.from({ length: 50 }, () => JSON.stringify(traceClosureBasis(facts1)))
  const pure1 = JSON.parse(repeated[0])
  check('T091', 'Fifty pure reductions identical', new Set(repeated).size === 1 && pure1.ok && same(pure1.value.traceItems, TRACE1.body.traceItems) && pure1.value.traceCode === TRACE1.body.traceCode, 'fifty reductions of the independently read facts give identical bytes, equal to the HTTP trace')
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import { traceClosureBasis } from './src/modules/closure-basis-trace/closure-basis-trace.reducer.ts'; const r = traceClosureBasis(JSON.parse(process.env.A76_INPUT)); console.log(JSON.stringify([r, Intl.DateTimeFormat().resolvedOptions().timeZone, Intl.DateTimeFormat().resolvedOptions().locale]))"],
    { encoding: 'utf8', cwd: process.cwd(), env: childEnv({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', A76_INPUT: JSON.stringify(facts1) }) },
  )
  const probed = (() => {
    try {
      return JSON.parse((probe.stdout ?? '').trim().split(/\r?\n/).pop() ?? '')
    } catch {
      return null
    }
  })()
  const zonedTrace = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Kiritimati'")
    await tx.$executeRawUnsafe("SET LOCAL lc_messages = 'C'")
    return getClosureBasisTraceOf(ASSESS1.assessmentId, tx)
  })
  check(
    'T092',
    'Time zone change does not affect codes',
    probed !== null && probed[1] === 'Pacific/Kiritimati' && same(probed[0], pure1) && zonedTrace.ok && same(stable(zonedTrace.value), stable(TRACE1.body)) && zonedTrace.value.evaluatedAt.endsWith('Z'),
    'a separate process in Pacific/Kiritimati (UTC+14) reduces identically, and a database session in that zone traces the identical facts with a UTC instant',
  )
  const lowerings = (production.code.match(/\.toLowerCase\(\)/g) ?? []).length
  const idLowerings = (production.code.match(/assessmentId\)?\.toLowerCase\(\)/g) ?? []).length
  check(
    'T093',
    'Locale change does not affect order/codes',
    probed !== null && same(probed[0], pure1) && !/toLocale|Intl\.|localeCompare|toUpperCase|\.sort\(/.test(production.code) && lowerings === idLowerings,
    `with a ${probed?.[2] ?? '?'} process locale and C database messages the order and codes are the same; A7.6 never sorts, compares by locale or changes case except lower-casing the path id (${idLowerings})`,
  )
  const countsBefore94 = await counts()
  for (const id of [ASSESS1.assessmentId, emptyAssessment.assessmentId, incAssessment.assessmentId, ASSESS_S2.assessmentId]) await traceOf(id)
  check('T094', 'Read-only execution: zero writes', (await unchanged(countsBefore94)) && noXid === null, 'traces of four assessments changed no row in any of the 14 tables, and a trace never assigns a transaction id')
  const ledgerTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(receivable|ledger|balance|posting|journal|allocation|settle|payment|cash|receipt|copay|patient_share)'`).map((row) => row.t)
  check('T095', 'No-source is not a zero balance', emptyTrace.body.traceCode === 'NO_SOURCE_BASIS' && emptyTrace.body.traceItems.length === 0 && ledgerTables.length === 0 && !deepKeys(emptyTrace.body).has('balance'), 'NO_SOURCE_BASIS explains only that no source exists: no balance, ledger or payment exists to be zero')
  check('T096', 'Incomplete is not closure ready', incTrace.body.traceCode === 'INCOMPLETE_SOURCE_CHAIN' && !/READY_FOR_CLOSURE|CLOSURE_READY|CLOSED/.test(JSON.stringify(incTrace.body)) && !/READY_FOR_CLOSURE|CLOSURE_READY/.test(production.code), 'an incomplete chain is explained as missing links; no closure-ready or closed code exists in A7.6')
  const adjudicationTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(adjudicat|remittance|denial|allowed)'`).map((row) => row.t)
  check('T097', 'External absent never means adjudicated', TRACE1.body.traceCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && items1.every((i) => i.readinessCode === 'NOT_READY_FOR_ADJUDICATION') && adjudicationTables.length === 0, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT rests on NOT_READY_FOR_ADJUDICATION readiness only; no adjudication, remittance or denial table exists')
  const autoClear = [
    traceClosureBasis({ ...facts1, readiness: facts1.readiness.map((r, i) => (i === 0 ? { ...r, ...REVIEW } : r)) }),
    traceClosureBasis({ ...facts1, readiness: facts1.readiness.map((r, i) => (i === 0 ? { ...r, ...UNSUPPORTED } : r)) }),
  ]
  check(
    'T098',
    'Unsupported and review never auto-cleared',
    autoClear.every((r) => !r.ok) && tracedAs(review, 'REVIEW_REQUIRED') && tracedAs(unsupported, 'UNSUPPORTED_SOURCE_BASIS'),
    'a review or unsupported readiness under an EXTERNAL_FINANCIAL_EVIDENCE_ABSENT record is a conflict, never cleared to the recorded outcome; REVIEW and UNSUPPORTED cases trace as themselves (T035, T036)',
  )
  check('T099', 'No latest/current pointer returned', !exposedKeys.some((k) => /latest|current|pointer|successor|newest|status|state/i.test(k)) && latest.every((r) => r.status === 404), 'no trace carries a latest, current, successor, status or state field, and no scan route exists')
  const futurePure = traceClosureBasis({ ...facts1, assessment: { ...facts1.assessment, contractVersion: 'A7-CLOSURE-PREREQ-2' } })
  const futureCase = traceClosureBasis({ ...facts1, header: { ...facts1.header, contractVersion: 'A7-REVENUE-CASE-2' } })
  const futureReadiness = traceClosureBasis({ ...facts1, readiness: facts1.readiness.map((r) => ({ ...r, contractVersion: 'A7-ADJ-READINESS-2' })) })
  check('T100', 'Unknown future contract fails closed', [futurePure, futureCase, futureReadiness].every((r) => !r.ok) && refusedConflict(futureContract), 'a future A7.5, A7.4 or A7.3 contract is refused by the reducer and, planted, by the service (T048) — never read as the current one')

  // ---------------------------------------------------------------- zero downstream mutation (T101–T110)
  section('No A6 or A7.1–A7.5 row changed by tracing; no A7.7–A9, financial, network, worker, queue, ledger or posting functionality')
  const before101 = {
    freezeW: await freezeHash(W.claimId), freezeP: await freezeHash(P.claimId), lifecycle: await lifecycleHash(Re.claimId), lifecycleWd: await lifecycleHash(Wd.claimId), correction: await correctionHash(W.claimId),
    sources: await sourceHash(), classifications: await classificationHash(), readiness: await readinessHash(), cases: await allCasesHash(), assessments: await allAssessmentsHash(),
  }
  for (const id of [ASSESS1.assessmentId, ASSESS_S2.assessmentId, emptyAssessment.assessmentId, incAssessment.assessmentId, re.assessment.assessmentId, wd.assessment.assessmentId]) await traceOf(id)
  check('T101', 'A6.7 frozen bytes unchanged', (await freezeHash(W.claimId)) === before101.freezeW && (await freezeHash(P.claimId)) === before101.freezeP, 'every byte of the freezes and their sealed manifests is identical after six traces')
  check('T102', 'A6.8 lifecycle rows unchanged', (await lifecycleHash(Re.claimId)) === before101.lifecycle && (await lifecycleHash(Wd.claimId)) === before101.lifecycleWd, 'the RELEASE_ELIGIBLE and WITHDRAWN_INTERNAL lifecycles are byte-identical')
  check('T103', 'A6.9 correction links unchanged', (await correctionHash(W.claimId)) === before101.correction, 'the worked correction link is byte-identical')
  check('T104', 'A7.1 source records unchanged', (await sourceHash()) === before101.sources, "every byte of this run's A7.1 sources is identical")
  check('T105', 'A7.2 classifications unchanged', (await classificationHash()) === before101.classifications, "every byte of this run's A7.2 classifications is identical")
  check('T106', 'A7.3 readiness rows unchanged', (await readinessHash()) === before101.readiness, "every byte of this run's A7.3 readiness results is identical")
  check('T107', 'A7.4 case snapshot/entries unchanged', (await allCasesHash()) === before101.cases, 'every byte of every A7.4 case header and entry is identical')
  check('T108', 'A7.5 assessment rows unchanged', (await allAssessmentsHash()) === before101.assessments, 'every byte of every A7.5 assessment is identical')
  const laterRoutes = [
    await post(`${tracePath(ASSESS1.assessmentId)}/close`, {}),
    await post(`/api/closure-prerequisite-assessments/${ASSESS1.assessmentId}/exceptions`, {}),
    await post(`/api/closure-prerequisite-assessments/${ASSESS1.assessmentId}/reconciliations`, {}),
    await post(`/api/claim-submissions/${S1}/remittances`, {}),
    await post(`/api/claim-submissions/${S1}/payments`, {}),
  ]
  const laterTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(adjudicat|denial|allowed|remittance|settle|import|inbound|outbox|queue|transmission|acknowledg|closure|reconcil|exception|trace)'`).map((row) => row.t)
  const moneyIdentifier = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|toFixed\(|[Ss]ettle|[Aa]llocat|[Aa]djust|[Rr]eceivable|[Bb]alance|[Ll]edger|[Pp]ayment|[Rr]emittance/
  const moneyCode = production.code.replace(/EXTERNAL_REMITTANCE_NOT_ESTABLISHED/g, '')
  check(
    'T109',
    'No A7.7/A8/A9/financial functionality',
    laterRoutes.every((res) => res.status === 404) && laterTables.length === 0 && !moneyIdentifier.test(moneyCode) && ledgerTables.length === 0,
    'no close, exception, reconciliation, remittance or payment route; no such table (nor a trace table); A7.6 computes no money',
  )
  const awaitedPause = /new Promise\(\(resolve\) => setTimeout\(resolve, [^\n]*/g
  const backgroundWork = production.code.replace(awaitedPause, '')
  const jobsChanged = changedPaths.filter((file) => /^backend\/src\/jobs\//.test(file))
  check(
    'T110',
    'No network, worker, queue, ledger, posting',
    !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|<\?xml|\bx12\b|\bhl7\b|\bfhir\b|dhpo|eclaimlink|enqueue|posting/i.test(production.code) && !/setInterval|setTimeout|setImmediate|worker_threads|\bnew Worker\(|cron|schedule\(/i.test(backgroundWork) && jobsChanged.length === 0 && production.files.length === 5,
    'the five A7.6 backend files hold no network client, XML/X12/HL7/FHIR, queue, job, worker, timer, ledger or posting',
  )

  const workedFacts = async () => stable((await traceOf(ASSESS1.assessmentId)).body)
  const worked = await workedFacts()

  // ---------------------------------------------------------------- nested regressions (T111–T120)
  section('Regressions — A7.5 invoked, nesting A7.4 -> A7.3 -> A7.2 -> A7.1 -> A6.10 -> … -> A6.1 -> A5.10 -> A1')
  await apiReady('the A7.5 and backward regression chain')
  const chain = run('npm run test:a7:case-prerequisite')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.5')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.5] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.5 asserts facts about its own branch (name, tracking, migration, production diff), its nested N/A proofs against
  // its own branch, and its own upstream. On A7.6 those statements are obsolete by design; every other A7.5 check is
  // substantive. T120 below proves each cause independently, never from the id.
  const a75NonApplicable: Record<string, string> = {
    T001: "A7.5 'Correct A7.4 merge prerequisite' requires the A7.5 feature branch (and reads any other A7 suite as later code); A7.6 is branched from the main that contains the A7.5 merge",
    T002: "A7.5 'Clean HEAD and origin parity' requires tracking origin/feature/a7-5-…, deleted when it merged; the clean tree and exact origin parity of THIS branch are proved by T002 here",
    T004: "A7.5 'One additive migration only' expects its own migration as the branch's only addition; A7.6 adds no migration at all (T004 here)",
    T010: "A7.5 'Exact changed-file scope, no later domain' lists the paths A7.5 was allowed to change; A7.6 legitimately changes its own (T010 here)",
    T120: "A7.5 'All nested substantive checks PASS' proves A7.4's branch-only causes against the A7.5 branch (its name, migration, diff and upstream); on A7.6 those proofs are re-done here (T120)",
    T130: "A7.5 'Exact HEAD, two full runs, clean parity' requires the upstream to be the A7.5 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a75NonApplicable))
  const summary = chain.output.match(/\[A7\.5\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.5\] RUN ABORTED|\[A7\.5\] uncaught error|\[A7\.5\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a75Substantive = rows.filter((row) => !(row.id in a75NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a75Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T111',
    'A7.5 substantive regression (nested)',
    ran && reconciled && undocumented.length === 0 && a75Substantive.length === 0 && a75Passing >= 124 && ['T006', 'T009', 'T060', 'T096', 'T108'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A7.5 suite did not complete'
      : !reconciled
        ? `A7.5 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.5 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.5\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.5] automated summary: ', 'A7.5 ')}; all ${a75Passing} substantive checks PASS (T008 and T108 with the A7.6 route mounted) and every failure is documented`,
  )
  for (const id of Object.keys(a75NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A7.5 ${titleOf(row.line)}`, a75NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T112', 'A7.4 substantive regression (chain)', verdictOf('T111') === 'PASS', `A7.5 T111 (A7.4 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A7.3 substantive regression (chain)', verdictOf('T112') === 'PASS', `A7.5 T112 (A7.3) ${verdictOf('T112')}`)
  check('T114', 'A7.2 substantive regression (chain)', verdictOf('T113') === 'PASS', `A7.5 T113 (A7.2) ${verdictOf('T113')}`)
  check('T115', 'A7.1 substantive regression (chain)', verdictOf('T114') === 'PASS', `A7.5 T114 (A7.1) ${verdictOf('T114')}`)
  check('T116', 'A6.10 cumulative regression', verdictOf('T115') === 'PASS', `A7.5 T115 (A6.10) ${verdictOf('T115')}`)
  check('T117', 'A6.1–A6.9 regression', verdictOf('T116') === 'PASS', `A7.5 T116 (A6.9 … A6.1) ${verdictOf('T116')}`)
  check('T118', 'A5.1–A5.10 regression', verdictOf('T117') === 'PASS', `A7.5 T117 (A5.10 → A5.1) ${verdictOf('T117')}`)
  check('T119', 'A1–A4 substantive regressions', verdictOf('T118') === 'PASS' && verdictOf('T119') === 'PASS', `A7.5 T118 (A1–A4) ${verdictOf('T118')} and T119 (only justified nested N/A) ${verdictOf('T119')}`)
  // Each documented A7.5 failure must fail for its branch-only reason, proved independently on this branch.
  const allowed = ['backend/package.json', 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'frontend/src/developer/checkRegistry.tsx']
  const ownDirs = [MODULE_DIR, FE_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const a75Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA74 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const causes: Record<string, boolean> = {
    T001: branch === a76Branch && a75Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a75Merge} HEAD`),
    T002: /working tree clean/.test(lineOfRow('T002')) && dirty.length === 0 && tracking.includes(`origin/${a76Branch}`) && !/ahead|behind/.test(tracking),
    T004: migrationStatus.length === 0 && /migration changes: $/.test(lineOfRow('T004').trimEnd() + ' '),
    T010: a75Unexpected.length > 0 && a75Unexpected.every((path, index) => changedPaths.includes(path) || (index === a75Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A7.5 re-proves A7.4's branch-only causes against the A7.5 branch; on A7.6 only those tied to the branch (its
    // name, tracking, migration, diff and upstream) can be unproven — re-proved here against this branch.
    T120: unprovenA74.length > 0 && unprovenA74.every((id) => ['T001', 'T002', 'T004', 'T010', 'T120', 'T130'].includes(id)) && migrationStatus.length === 0 && outOfScope.length === 0 && tracking.includes(`origin/${a76Branch}`),
    T130: tracking.includes(`origin/${a76Branch}`) && !/origin\/feature\/a7-5/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A7\.5\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T120',
    'Historical N/A independently justified',
    ran && a75Substantive.length === 0 && failing.every((id) => id in a75NonApplicable) && unproven.length === 0 && naLines.length === 6 && naLines.every((line) => line.length > 80) && ownerChanged.length === 0,
    unproven.length === 0
      ? `each documented A7.5 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved independently here; A7.5 itself justifies its six A7.4 items (${naLines.length} lines)`
      : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- build and exact-head acceptance (T121–T130)
  section('Units, typecheck, frontend, unchanged migration checksums, outage and recovery, no 5xx, synthetic fixtures, golden example, exact head')
  const allUnit = run('npm run test:unit')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  check('T121', 'Backend unit suite PASS', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 11/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 11 A7.6 reducer and path tests with their negative controls`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Backend typecheck PASS', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint PASS', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build PASS', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const appliedChecksum = (await prisma.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM _prisma_migrations WHERE migration_name = ${A75_MIGRATION_NAME} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.checksum
  const blob = spawnSync('git', ['show', `HEAD:${A75_MIGRATION}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const appliedTotal = Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].n)
  check(
    'T125',
    'Migration checksums + from-empty replay',
    status.ok && replay.ok && (appliedChecksum === sha256Of(readFileSync(`../${A75_MIGRATION}`)) || appliedChecksum === sha256Of(blob)) && appliedTotal === headMigrationDirs.length,
    `no migration added: ${appliedTotal} applied = ${headMigrationDirs.length} committed; the newest (A7.5) still carries its committed checksum (${(appliedChecksum ?? '').slice(0, 12)}…); scratch replay ALL CHECKS PASS (T006)`,
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
  check('T126', 'Health 200, ready 503 outage, recovery', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')
  await waitFor(databaseUp, 60_000)
  check('T127', 'Zero unexpected HTTP 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runAssessments = await prisma.$queryRawUnsafe<{ org: string; sub: string }[]>(`SELECT a.organization_id::text AS org, h.claim_submission_id::text AS sub FROM ${PREREQ} a JOIN ${HEADER} h ON h.id = a.evidence_case_id WHERE a.created_at >= $1::timestamptz`, runStartedAt.toISOString())
  const runSubmissions = new Set([...W.freezes, ...P.freezes, ...F.freezes, ...Re.freezes, ...Wd.freezes])
  const syntheticKinds = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${ENTRY} e JOIN ${HEADER} h ON h.id = e.assembly_id JOIN revenue_source_evidence r ON r.id = e.source_evidence_id WHERE h.created_at >= $1::timestamptz AND r.source_kind <> 'INTERNAL_SYNTHETIC'`, runStartedAt.toISOString()))[0].n)
  check(
    'T128',
    'Only synthetic organizations and IDs',
    runAssessments.length > 0 && runAssessments.every((a) => runSubmissions.has(a.sub) && [org, otherOrg].includes(a.org)) && syntheticKinds === 0 && !/['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/.test(production.code),
    `${runAssessments.length} assessments traced by this run all belong to its synthetic submissions in the two synthetic organizations; every cased source is INTERNAL_SYNTHETIC; no id is hard-coded in A7.6`,
  )
  const afterRestart = await workedFacts()
  console.log(`[${TAG}]      worked example: S1 ${S1} -> CASE1 ${CASE1.caseId} -> ASSESS1 ${ASSESS1.assessmentId} ${ASSESS1.assessmentCode} / ${ASSESS1.basisCode}; GET basis-trace -> ${TRACE1.body.traceCode}, items 1 (E1/C1/R1) and 2 (E2/C2/R2) both EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT, digest ${TRACE1.body.caseManifestSha256.slice(0, 12)}… copied`)
  console.log(`[${TAG}]      worked example: later E3 on S1 -> identical trace; corrected S2 -> its own case, assessment and trace; empty -> ${emptyTrace.body.traceCode}; incomplete -> ${incTrace.body.traceCode}; no row written by any trace; nothing paid, closed or adjudicated`)
  check(
    'T129',
    'Golden worked case after DB restart',
    TRACE1.status === 200 && same(afterRestart, worked) && same(afterRestart, stable(TRACE1.body)) && (afterRestart as any).traceCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT',
    'the §8 scenario is reproduced, and after the nested chain and a database restart the worked trace reads back identically (all but evaluatedAt)',
  )

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|reconcil|exception|integration\/a(8|9)|dhpo|eclaimlink|prisma\//i.test(file))
  check(
    'T010',
    'Only allowlisted A7.6 files changed',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A7.6 module, harness and check page, one error code, the route mount, the scripts and the registry entry; no migration, schema, permission, audit or owner change; no A7.7+/A8/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  check(
    'T130',
    'Exact head, scope and two complete runs',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a76Branch}`) && !/ahead|behind/.test(tracking) && same(afterRestart, worked) && outOfScope.length === 0,
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; scope exact (T010); after the database restart the worked trace reads back identically`,
  )

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] CLOSURE BASIS TRACE ACCEPTANCE COMPLETE` : `[${TAG}] A7.6 FINAL FAIL`)
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
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[${TAG}] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
