import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
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
import { recordCorrectionLink } from '../../modules/claim-correction/claim-correction.service.ts'
import { registerRevenueSourceEvidence } from '../../modules/revenue-evidence/revenue-evidence.service.ts'
import { classifySourceEvidence } from '../../modules/evidence-classification/evidence-classification.service.ts'
import { recordAdjudicationReadiness } from '../../modules/evidence-gate/evidence-gate.service.ts'
import { assembleRevenueEvidenceCase } from '../../modules/evidence-case/evidence-case.service.ts'
import { assessClosurePrerequisites } from '../../modules/case-prerequisite/case-prerequisite.service.ts'
import { assessmentCodes, basisCodes } from '../../modules/case-prerequisite/case-prerequisite.types.ts'
import { getRevenueTimeline } from '../../modules/revenue-timeline/revenue-timeline.service.ts'
import { deriveRevenueDelta } from '../../modules/revenue-delta/revenue-delta.reducer.ts'
import { getRevenueDeltaOf } from '../../modules/revenue-delta/revenue-delta.service.ts'
import type { TimelineFacts } from '../../modules/revenue-delta/revenue-delta.types.ts'

// A7.8 — focused acceptance for Correction-Chain Revenue Evidence Delta (T001–T130).
//
// Every Claim, freeze and correction link is built through its owners, exactly as the A6.7–A7.7 suites build them
// (tariff world and rates, the A5.7 recorder, readiness, the Claim, lines, diagnoses and pointers, pricing, draft
// assessments, APPROVE/REVOKE by a separate synthetic Admin, every freeze through the A6.7 route and every correction
// link through the A6.9 route); every source is registered through the A7.1 route, classified through A7.2, gated
// through A7.3, cased through A7.4 and assessed through A7.5. The other organization builds its own world with its
// own two Admins. Deltas are read through the A7.8 route (or, on a harness-held snapshot, through its
// transaction-aware service). CORRUPT histories no owner can record (broken chains, forks, joins, cycles, extra,
// missing or foreign freezes, foreign, duplicate, future or malformed cases and assessments, reversed instants) are
// planted only in a transaction that is ALWAYS rolled back — owner guards off, and where a CHECK or UNIQUE index would
// refuse the forgery, that one constraint dropped inside the same transaction — and judged there by the production
// service on that transaction. Facts the A7.7 owner itself composes (its contract, ordinals, predecessors) cannot be
// planted in a table: they are forged on the REAL timeline and judged by the production reducer. Synthetic users are
// provisioned per run through Better Auth's own server-side creation with a random password that is never printed.

const TAG = 'A7.8'
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

const runId = `A78-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
const a77Branch = 'feature/a7-7-revenue-evidence-timeline'
const UPSTREAM_BRANCHES = ['feature/a6-10-a6-integration-acceptance', 'feature/a7-1-revenue-source-evidence', 'feature/a7-2-evidence-classification', 'feature/a7-3-adjudication-evidence-readiness', 'feature/a7-4-revenue-evidence-case-assembly', 'feature/a7-5-case-closure-prerequisite-assessment', 'feature/a7-6-closure-basis-trace', a77Branch]
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/revenue-delta'
const FE_DIR = 'frontend/src/modules/revenue-delta'
const HARNESS_DIR = 'backend/src/integration/a7-revenue-delta'
const A77_ROUTE = 'backend/src/modules/revenue-timeline/revenue-timeline.route.ts'
const A75_MIGRATION_NAME = '20261025090000_a7_5_case_prerequisite'
const A75_MIGRATION = `backend/prisma/migrations/${A75_MIGRATION_NAME}/migration.sql`
const UNIT_TESTS = [`${MODULE_DIR}/revenue-delta.reducer.test.ts`, `${MODULE_DIR}/revenue-delta.validation.test.ts`]
const PREREQ = 'evidence_prereq_results'
const HEADER = 'evidence_case_snapshots'
const ENTRY = 'evidence_case_entries'
const LINKS = 'claim_correction_links'
const FREEZES = 'claim_freezes'
const CONTRACT = 'A7-REVENUE-DELTA-1'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const DTO_KEYS = ['contractVersion', 'claimId', 'evaluatedAt', 'baselineCode', 'comparisonCount', 'comparisons']
const COMPARISON_KEYS = [
  'ordinal', 'predecessorSubmissionId', 'correctedSubmissionId', 'correctionLinkId', 'predecessorFrozenAt', 'correctedFrozenAt', 'predecessorCaseId', 'correctedCaseId', 'predecessorAssessmentId', 'correctedAssessmentId', 'evidenceDeltaCode',
  'sourceCountBefore', 'sourceCountAfter', 'classifiedCountBefore', 'classifiedCountAfter', 'readinessCountBefore', 'readinessCountAfter', 'prerequisiteBefore', 'prerequisiteAfter', 'predecessorCaseManifestSha256', 'correctedCaseManifestSha256',
]
const DELTA_CODES = ['BOTH_ABSENT', 'NEW_CASE_RECORDED', 'CASE_NO_LONGER_RECORDED', 'RECORDED_SUMMARY_UNCHANGED', 'RECORDED_SUMMARY_CHANGED']
// The owners A7.8 consumes or must leave untouched: the A5/A6 modules and A7.1–A7.7 (backend, pages and suites).
const OWNER_DIRS = [
  ...[
    'claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction',
    'pre-claim-validation', 'pre-claim-readiness', 'validation-run', 'revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'closure-basis-trace', 'revenue-timeline', 'encounter-billing-context',
  ].map((name) => `backend/src/modules/${name}`),
  'backend/src/shared/database',
  'backend/src/shared/authorization',
  'backend/prisma',
  ...['revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'closure-basis-trace', 'revenue-timeline'].map((name) => `frontend/src/modules/${name}`),
  ...['a7-revenue-source-evidence', 'a7-evidence-classification', 'a7-evidence-gate', 'a7-evidence-case', 'a7-case-prerequisite', 'a7-closure-basis-trace', 'a7-revenue-timeline'].map((name) => `backend/src/integration/${name}`),
]
// Every table a delta could conceivably touch, read in this fixed key order (a UNION ALL may come back in Parallel
// Append order). A delta must leave every one of them exactly as it found it.
const COUNT_TABLES = [PREREQ, HEADER, ENTRY, 'evidence_gate_results', 'source_evidence_classifications', 'revenue_source_evidence', 'audit_events', 'claims', 'claim_lines', 'claim_pricing_runs', 'claim_review_events', FREEZES, 'claim_freeze_evidence_manifests', 'claim_freeze_lifecycle_events', LINKS]

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
// A delta without its evaluation instant: the only field that may differ between two reads of the same history.
const stable = (body: any) => {
  if (!body || typeof body !== 'object') return body
  const { evaluatedAt: _evaluatedAt, ...rest } = body
  return rest
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  const headAtStart = git('rev-parse HEAD')
  console.log(`[${TAG}] A7.8 correction-chain revenue evidence delta — run ${runId}`)
  console.log(`[${TAG}] HEAD ${headAtStart} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- preflight (T001–T009; T010 at the end)
  section('Preflight: accepted A7.7, ancestry, no schema or migration, Prisma, replay, the A7.7 read permission, one GET route, owners untouched')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a77Merge = mergeOf(a77Branch)
  const upstreamMerges = UPSTREAM_BRANCHES.map((name) => ({ name, sha: mergeOf(name) }))
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|settlement|receivable|claim-transport|claim-outbox|payer-response|integration\/a(8|9)|integration\/a7-(?!revenue-source-evidence|evidence-classification|evidence-gate|evidence-case|case-prerequisite|closure-basis-trace|revenue-timeline|revenue-delta)|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Correct accepted A7.7 merge ancestry',
    branch === a78Branch && a77Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a77Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A7.7 merged as ${a77Merge.slice(0, 7) || 'NOT FOUND'} and is an ancestor; contains latest main ${git('rev-parse --short origin/main')}, not stacked on an unmerged branch; no A7.9+/A8/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean branch, origin parity at HEAD', dirty.length === 0 && tracking.includes(`origin/${a78Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  const constantOf = (path: string, name: string) => (committedText(path).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/revenue-evidence/revenue-evidence.types.ts', 'REVENUE_SOURCE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-classification/evidence-classification.types.ts', 'CLASSIFICATION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-gate/evidence-gate.types.ts', 'READINESS_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-case/evidence-case.types.ts', 'CASE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/case-prerequisite/case-prerequisite.types.ts', 'PREREQ_CONTRACT_VERSION'),
    constantOf('backend/src/modules/closure-basis-trace/closure-basis-trace.types.ts', 'TRACE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/revenue-timeline/revenue-timeline.types.ts', 'TIMELINE_CONTRACT_VERSION'),
  ]
  const expectedContracts = ['A7-REVENUE-SOURCE-1', 'A7-EVIDENCE-CLASS-1', 'A7-ADJ-READINESS-1', 'A7-REVENUE-CASE-1', 'A7-CLOSURE-PREREQ-1', 'A7-CLOSURE-TRACE-1', 'A7-REVENUE-TIMELINE-1']
  const timelineExport = /export async function getRevenueTimelineOf\(claimId: string, tx: DbClient\)/.test(committedCode('backend/src/modules/revenue-timeline/revenue-timeline.service.ts'))
  check(
    'T003',
    'A6.10 and A7.1–A7.7 contract ancestry',
    upstreamMerges.every((m) => m.sha.length === 40 && gitOk(`merge-base --is-ancestor ${m.sha} HEAD`)) && same(contracts, expectedContracts) && timelineExport,
    `A6.10 and A7.1–A7.7 merges (${upstreamMerges.map((m) => m.sha.slice(0, 7)).join(', ')}) are ancestors; contracts ${contracts.join(', ')}; the A7.7 owner exports getRevenueTimelineOf(claimId, tx)`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const prismaStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  const baseMigrationDirs = migrationDirsAt('origin/main')
  // A7.8's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge
  // added. A later package's changes are that package's to prove, so the scope checks below (no migration, replay
  // base, permission catalogue, owner code) always judge THIS package.
  const ownMerge = branch === a78Branch ? '' : mergeOf(a78Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = ownMerge ? migrationDirsAt(ownMerge) : headMigrationDirs
  const ownBaseMigrationDirs = ownMerge ? migrationDirsAt(`${ownMerge}^1`) : baseMigrationDirs
  check('T004', 'No new migration or schema change', ownPrismaStatus.length === 0 && same(ownHeadMigrationDirs, ownBaseMigrationDirs), ownPrismaStatus.length === 0 ? `nothing under backend/prisma changed: schema and all ${headMigrationDirs.length} migrations identical to its base` : `prisma changes: ${ownPrismaStatus.join(' | ')}`)
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma validate, generate and status', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'the unchanged schema validates and generates; the working database is up to date (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check('T006', 'From-empty replay equals committed', replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && ownHeadMigrationDirs.length === ownBaseMigrationDirs.length, `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD, none added in its own scope`)
  const routeCode = committedCode(`${MODULE_DIR}/revenue-delta.route.ts`)
  const permissionsOf = (code: string) => [...code.matchAll(/requireMemberPermission\(organizationIdFromClaim, '([^']+)'\)/g)].map((m) => m[1])
  const a77Permissions = permissionsOf(committedCode(A77_ROUTE))
  const authzDiff = gitArgs(['diff', ownRange, '--', ':/backend/src/shared/authorization', ':/backend/src/scripts/bootstrap-authz-dev.ts'])
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  check(
    'T007',
    'A7.7 read permission reused exactly',
    a77Permissions.length === 5 && same(permissionsOf(routeCode), a77Permissions) && authzDiff === '' && !allCodes.some((code) => /delta|timeline/i.test(code)),
    `the route requires exactly the A7.7 timeline's reads (${a77Permissions.join(', ')}); the catalogue and its bootstrap are unchanged; no delta permission exists`,
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
  // A GET that carries a body: fetch refuses to send one, so it goes through node:http directly.
  const getWithBody = (path: string, body: string, cookie: string) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const target = new URL(path, baseUrl)
      const req = httpRequest({ method: 'GET', hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie } }, (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 500) serverErrors += 1
          let parsed: unknown = text
          try {
            parsed = JSON.parse(text)
          } catch {
            // keep the raw text
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      })
      req.on('error', reject)
      req.end(body)
    })
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  // Raw database text in a response body: SQL keywords, a stack frame or a physical table or guard name.
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /claim_correction_link|claim_freeze|evidence_prereq|evidence_case_|evidence_gate_result/.test(text)
  }

  // Synthetic users: Better Auth's own server-side user and credential creation, then a membership with the ORG_ADMIN
  // role. The password is random per run and never printed.
  const authContext = await auth.$context
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' }, select: { id: true } })
  const provisionMember = async (label: string, organizationId = org) => {
    const email = `${runId.toLowerCase()}-${label}@reviewers.sbn.test`
    const secretValue = randomBytes(24).toString('base64url')
    const user = await authContext.internalAdapter.createUser({ email, name: `Synthetic member ${label}`, emailVerified: false }, { method: 'email-password' })
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', issuer: 'local:credential', accountId: user.id, password: await authContext.password.hash(secretValue) })
    const membership = await prisma.organizationMembership.create({ data: { organizationId, userId: user.id } })
    await prisma.membershipRole.create({ data: { membershipId: membership.id, roleId: adminRole.id } })
    const signed = await signIn(email, secretValue)
    if (signed.status !== 200) throw new Error(`fixture member ${label} could not sign in (${signed.status})`)
    return { id: user.id as string, who: as(signed.cookie), cookie: signed.cookie }
  }
  // B approves (separation of duties for A6.5) and reads as a second Admin; O and O2 are the two Admins of the OTHER
  // organization.
  const B = await provisionMember('b')
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)

  const deltaPath = (claimId: string) => `/api/claims/${claimId}/revenue-evidence-delta`
  const deltaOf = (claimId: string, who: Who = asAdmin) => get(deltaPath(claimId), who)
  const wiring = await deltaOf(MISSING)
  const absent = [
    await api('POST', deltaPath(MISSING), {}),
    await api('PUT', deltaPath(MISSING), {}),
    await api('PATCH', deltaPath(MISSING), {}),
    await api('DELETE', deltaPath(MISSING)),
    await api('GET', `${deltaPath(MISSING)}/latest`),
    await api('GET', `${deltaPath(MISSING)}/current`),
    await api('GET', '/api/revenue-evidence-deltas'),
    await api('GET', `/api/claim-submissions/${MISSING}/revenue-evidence-delta`),
  ]
  const unauthenticated = await deltaOf(MISSING, anonymous)
  check(
    'T008',
    'One GET route; mutation/latest absent',
    wiring.status === 404 && errorCode(wiring.body) === 'NOT_FOUND' && absent.every((res) => res.status === 404) && unauthenticated.status === 401 &&
      (routeCode.match(/deltaRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 1 && /deltaRouter\.get\(\s*'\/:claimId\/revenue-evidence-delta'/.test(routeCode),
    `GET answers a missing Claim with a privacy-safe 404; POST/PUT/PATCH/DELETE, latest, current, a collection and a per-submission route are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.status}`,
  )
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file))
  const ownOwnerChanged = ownChangedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file))
  check(
    'T009',
    'No upstream module or migration edits',
    ownOwnerChanged.length === 0 && ownPrismaStatus.length === 0 && same(contracts, expectedContracts),
    ownOwnerChanged.length === 0 ? 'no A5/A6/A7.1–A7.7 module, page or suite, shared database or authorization code, schema or migration changed; every upstream contract is unchanged' : `changed: ${ownOwnerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: Claims with 0, 1, 2, 3 and 4 linked freezes, evidence, cases and assessments of two organizations')
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
    // A Claim with `count` lawfully frozen submissions (0 leaves it unfrozen): each later one after revoking the
    // current approval, on a NEW draft assessment with its own new approval. `extend` freezes one more.
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
      const extend = async () => {
        if (assessment && approvalId) await revoke(claim.id, assessment, approvalId)
        assessment = await assessDraft(claim.id, pricing.body.id)
        approvalId = await approve(claim.id, assessment)
        const submission = await freezeNow(claim.id, assessment, approvalId)
        freezes.push(submission)
        return submission
      }
      for (let i = 0; i < count; i += 1) await extend()
      return { claimId: claim.id as string, freezes, lineIds, extend }
    }
    return { series }
  }
  const home = await tenantWorld('home', org, asAdmin, creatorId, B.who)
  const away = await tenantWorld('away', otherOrg, O.who, O.id, O2.who)
  const ref = (suffix: string) => `SYN-${runId.replace(/^A78-/, '')}-${suffix}`.toUpperCase()
  const registerSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref(suffix) }, who)
    if (res.status !== 201) throw new Error(`fixture source ${suffix} could not be registered through A7.1: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.revenueSourceEvidenceId as string
  }
  const linkedSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const E = await registerSource(submissionId, suffix, who)
    const C = (await post(`/api/revenue-source-evidence/${E}/classifications`, {}, who)).body.classificationId as string
    const R = (await post(`/api/revenue-evidence-classifications/${C}/adjudication-readiness`, {}, who)).body.readinessId as string
    if (!C || !R) throw new Error(`fixture ${suffix}: classification or readiness refused`)
    return { E, C, R }
  }
  const caseOf = async (submissionId: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-evidence-cases`, {}, who)
    if (res.status !== 201) throw new Error(`fixture case could not be assembled through A7.4: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { caseId: string; assemblyCode: string; manifestSha256: string; itemCount: number; sourceCount: number; classifiedCount: number; readinessCount: number }
  }
  const assessmentOf = async (caseId: string, who: Who = asAdmin) => {
    const res = await post(`/api/revenue-evidence-cases/${caseId}/closure-prerequisite-assessments`, {}, who)
    if (res.status !== 201) throw new Error(`fixture assessment could not be recorded through A7.5: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { assessmentId: string; caseId: string; assessmentCode: string; basisCode: string; caseManifestSha256: string }
  }
  const linkOf = async (claimId: string, prior: string, corrected: string, who: Who = asAdmin) => {
    const res = await post(`/api/claims/${claimId}/correction-links`, { priorSubmissionId: prior, correctedSubmissionId: corrected, reasonCode: 'CORRECTED_CODING' }, who)
    if (res.status !== 201) throw new Error(`fixture: the A6.9 link was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.correctionLinkId as string
  }
  const chainOf = async (claimId: string, freezes: string[], who: Who = asAdmin) => {
    const links: string[] = []
    for (let i = 1; i < freezes.length; i += 1) links.push(await linkOf(claimId, freezes[i - 1], freezes[i], who))
    return links
  }
  // §8 — Claim K: D1 → D2 → D3; D1 without a case; D2 with a two-source case and its A7.5 assessment; D3 with a
  // separately recorded three-source case (unassessed).
  const W = await home.series('worked', 3)
  const [D1, D2, D3] = W.freezes
  const WL = await chainOf(W.claimId, W.freezes)
  await linkedSource(D2, 'D2-E1')
  await linkedSource(D2, 'D2-E2')
  const CASE2 = await caseOf(D2)
  const ASSESS2 = await assessmentOf(CASE2.caseId)
  for (const suffix of ['D3-E1', 'D3-E2', 'D3-E3']) await linkedSource(D3, suffix)
  const CASE3 = await caseOf(D3)
  // A Claim never frozen; a one-freeze Claim; B: two linked freezes without cases; G: a case only on the predecessor;
  // Q: four linked freezes (q2 with a case and assessment, q3 with a case and assessment, q1 and q4 bare) for plants.
  const Z = await home.series('unfrozen', 0)
  const One = await home.series('single', 1)
  const Bc = await home.series('both absent', 2)
  const BL = await chainOf(Bc.claimId, Bc.freezes)
  const G = await home.series('no longer', 2)
  await chainOf(G.claimId, G.freezes)
  await linkedSource(G.freezes[0], 'G1-E1')
  const GCASE = await caseOf(G.freezes[0])
  const Q = await home.series('four', 4)
  const QL = await chainOf(Q.claimId, Q.freezes)
  await linkedSource(Q.freezes[1], 'Q2-E1')
  const Qcase2 = await caseOf(Q.freezes[1])
  await assessmentOf(Qcase2.caseId)
  await linkedSource(Q.freezes[2], 'Q3-E1')
  const Qcase3 = await caseOf(Q.freezes[2])
  await assessmentOf(Qcase3.caseId)
  // The other organization: two linked freezes, a case and an assessment of its own.
  const F = await away.series('foreign', 2)
  const FL = await chainOf(F.claimId, F.freezes, O.who)
  await linkedSource(F.freezes[1], 'FOREIGN', O.who)
  const FCASE = await caseOf(F.freezes[1], O.who)
  const FASSESS = await assessmentOf(FCASE.caseId, O.who)
  console.log(`[${TAG}]      fixtures ready: two synthetic AE-DU/DHA worlds; Claims with 0, 1, 2 (three kinds), 3 and 4 linked freezes and a foreign 2-freeze Claim; evidence, cases and assessments through the A7.1–A7.5 owner routes`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const runToken = runId.replace(/^A78-/, '')
  const freezeHash = (claimId: string) => hashOf(`SELECT f.*, m.id AS manifest_id, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') AS manifest FROM ${FREEZES} f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = $1::uuid`, claimId)
  const lifecycleHash = (claimId: string) => hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN ${FREEZES} f ON f.id = e.claim_submission_id WHERE f.claim_id = $1::uuid`, claimId)
  const correctionHash = (claimId: string) => hashOf(`SELECT l.* FROM ${LINKS} l WHERE l.claim_id = $1::uuid`, claimId)
  const sourceHash = () => hashOf(`SELECT r.* FROM revenue_source_evidence r WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const classificationHash = () => hashOf(`SELECT c.* FROM source_evidence_classifications c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const readinessHash = () => hashOf(`SELECT g.* FROM evidence_gate_results g JOIN revenue_source_evidence r ON r.id = g.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const allCasesHash = () => hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM ${HEADER} h UNION ALL SELECT e.id, row_to_json(e)::text FROM ${ENTRY} e) x`)
  const allAssessmentsHash = () => hashOf(`SELECT a.* FROM ${PREREQ} a`)
  const relaxable = [LINKS, FREEZES, HEADER, ENTRY, PREREQ].map((t) => `'${t}'::regclass`).join(', ')
  const constraintsHash = () => hashOf(`SELECT c.oid::text AS id, c.conrelid::regclass::text AS t, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid IN (${relaxable}) UNION ALL SELECT i.indexrelid::text, i.indrelid::regclass::text, i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid IN (${relaxable})`)
  const NOT_REFUSED = 'ROLLED_BACK'

  // A planted (corrupt) history: the relaxations and forged rows go in with row triggers off, then the production A7.8
  // service derives that Claim's delta on THIS transaction, which is then ALWAYS rolled back. Every plant is measured
  // on its own: all tables and every CHECK and index of the five relaxable tables must read back exactly.
  const plantedRuns = { total: 0, dirty: 0 }
  type Planted = { result?: Awaited<ReturnType<typeof getRevenueDeltaOf>>; message: string }
  const planted = async (claimId: string, relax: string[], mutate: (tx: DbClient) => Promise<void>): Promise<Planted> => {
    const countsBefore = await counts()
    const constraintsBefore = await constraintsHash()
    const out: { result?: Awaited<ReturnType<typeof getRevenueDeltaOf>> } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          for (const ddl of relax) await tx.$executeRawUnsafe(ddl)
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
          await mutate(tx)
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
          out.result = await getRevenueDeltaOf(claimId, tx)
          throw new Error(NOT_REFUSED)
        },
        { timeout: 60_000 },
      ),
    )
    plantedRuns.total += 1
    if (!(await unchanged(countsBefore)) || (await constraintsHash()) !== constraintsBefore) plantedRuns.dirty += 1
    return { ...out, message }
  }
  const insertLink = (tx: DbClient, claimId: string, prior: string, corrected: string) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${LINKS} (id, claim_id, prior_submission_id, corrected_submission_id, reason_code, recorded_by_user_id, contract_version) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'CORRECTED_CODING', $4::uuid, 'A6-CORRECTION-1')`,
      claimId, prior, corrected, creatorId,
    )
  const deleteLink = (tx: DbClient, linkId: string) => tx.$executeRawUnsafe(`DELETE FROM ${LINKS} WHERE id = $1::uuid`, linkId)
  const insertCase = async (tx: DbClient, submissionId: string, o: { organization?: string; contract?: string; digest?: string } = {}) =>
    (await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ${HEADER} (id, organization_id, claim_submission_id, contract_version, assembly_code, source_count, classified_count, readiness_count, item_count, manifest_sha256, recorded_by_user_id)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'NO_REVENUE_SOURCES', 0, 0, 0, 0, $4, $5::uuid) RETURNING id::text AS id`,
      o.organization ?? org, submissionId, o.contract ?? 'A7-REVENUE-CASE-1', o.digest ?? createHash('sha256').update(randomBytes(8)).digest('hex'), creatorId,
    ))[0].id
  const insertAssessment = (tx: DbClient, caseId: string, digest: string, o: { contract?: string } = {}) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${PREREQ} (id, organization_id, evidence_case_id, contract_version, assessment_code, basis_code, case_manifest_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', $4, $5::uuid)`,
      org, caseId, o.contract ?? 'A7-CLOSURE-PREREQ-1', digest, creatorId,
    )
  const refused = (p: Planted) => p.message.includes(NOT_REFUSED) && p.result?.ok === false && p.result.code === 'REVENUE_DELTA_PROVENANCE_CONFLICT' && !('value' in (p.result as object))
  const detailOf = (p: Planted) => (p.result?.ok === false ? String(p.result.message).replace(/; nothing was (composed|compared)$/, '') : p.result?.ok ? `derived ${p.result.value.comparisonCount} comparisons` : `not planted: ${p.message.slice(0, 140)}`)
  const timelineFactsOf = async (claimId: string): Promise<TimelineFacts> => {
    const timeline = await getRevenueTimeline(claimId)
    if (!timeline.ok) throw new Error(`fixture: the timeline of ${claimId} could not be read (${timeline.message})`)
    return timeline.value
  }
  const reducerCode = (input: TimelineFacts) => {
    const result = deriveRevenueDelta(input)
    return result.ok ? `derived ${result.value.comparisons.length}` : result.detail
  }

  // ---------------------------------------------------------------- strict access (T011–T020)
  section('Strict access: contract and keys, malformed, SQL- and traversal-shaped ids, session, roles, tenants, missing Claim, no spoofing')
  const countsAtStart = await counts()
  const DW = await deltaOf(W.claimId)
  check(
    'T011',
    'Exact delta contract and DTO keys',
    DW.status === 200 && DW.body?.contractVersion === CONTRACT && same(Object.keys(DW.body), DTO_KEYS) && DW.body.comparisons.every((c: any) => same(Object.keys(c), COMPARISON_KEYS)) && constantOf(`${MODULE_DIR}/revenue-delta.types.ts`, 'DELTA_CONTRACT_VERSION') === CONTRACT,
    `A7-REVENUE-DELTA-1 in code and on the DTO; exactly ${DTO_KEYS.length} top-level keys and the ${COMPARISON_KEYS.length} ComparisonV1 keys`,
  )
  const malformed = [await deltaOf('not-a-uuid'), await deltaOf(MISSING.slice(0, 35)), await deltaOf(MISSING.replace(/-/g, '')), await deltaOf(`${MISSING}0`)]
  check('T012', 'Malformed Claim UUID 400', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR'), `malformed ids: ${malformed.map((r) => r.status).join('/')}`)
  const sqlShaped = [await deltaOf(encodeURIComponent("1' OR '1'='1")), await deltaOf(encodeURIComponent(`${W.claimId}' OR '1'='1`)), await deltaOf(encodeURIComponent(`${W.claimId};DROP TABLE claims`))]
  check('T013', 'SQL-shaped Claim identifier refused', sqlShaped.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `SQL-shaped path ids are refused before any lookup with a safe body: ${sqlShaped.map((r) => r.status).join('/')}`)
  const traversal = [await deltaOf(encodeURIComponent('../../claims')), await deltaOf(encodeURIComponent(`${W.claimId}/../${MISSING}`)), await deltaOf('..%2F..%2Fadmin')]
  check('T014', 'Traversal-shaped identifier refused', traversal.every((res) => res.status === 400 && !rawError(res.body)), `traversal-shaped path ids are refused: ${traversal.map((r) => r.status).join('/')}`)
  const anon = await deltaOf(W.claimId, anonymous)
  check('T015', 'No session gives 401', anon.status === 401 && unauthenticated.status === 401, 'no session: 401 for an existing and a missing Claim')
  check('T016', 'Admin reads authorized Claim', DW.status === 200 && DW.body.claimId === W.claimId && DW.body.comparisonCount === 2, 'an Admin of the organization reads the three-freeze Claim (200, two comparisons)')
  const viewerDW = await deltaOf(W.claimId, asViewer)
  check('T017', 'Viewer reads same stable data', viewerDW.status === 200 && same(stable(viewerDW.body), stable(DW.body)), 'a Viewer reads exactly the same stable delta')
  const foreignOnHome = await deltaOf(W.claimId, O.who)
  const missingAsForeign = await deltaOf(MISSING, O.who)
  const homeOnForeign = await deltaOf(F.claimId)
  check('T018', 'Foreign tenant equals missing 404', foreignOnHome.status === 404 && same({ ...foreignOnHome.body?.error, requestId: null }, { ...missingAsForeign.body?.error, requestId: null }) && homeOnForeign.status === 404, "the other organization's Admin gets exactly the missing-id envelope for this tenant's Claim, and this tenant's Admin 404 for theirs")
  const missingClaim = await deltaOf(MISSING)
  check('T019', 'Missing Claim returns 404', missingClaim.status === 404 && errorCode(missingClaim.body) === 'NOT_FOUND' && !rawError(missingClaim.body), 'a non-existent Claim: 404 NOT_FOUND')
  const spoofs = [
    await api('GET', `${deltaPath(W.claimId)}?organizationId=${otherOrg}&actorUserId=${O.id}`),
    await api('GET', `${deltaPath(W.claimId)}?latest=true&current=true`),
    await api('GET', `${deltaPath(W.claimId)}?payer=X&amount=1&override=1&sourceEvidenceIds=${MISSING}`),
    await getWithBody(deltaPath(W.claimId), JSON.stringify({ comparisons: [], actorUserId: O.id }), admin.cookie),
  ]
  const spoofedForeign = await api('GET', `${deltaPath(W.claimId)}?organizationId=${org}`, undefined, (init = {}) => O.who({ ...init, headers: { 'X-Organization-Id': org } }))
  check(
    'T020',
    'No actor or tenant spoofing',
    spoofs.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR') && spoofedForeign.status === 404 && (await unchanged(countsAtStart)),
    'an organization, actor, latest/current flag, payer, amount, override or source list in the query, and any body, are refused (400); a foreign Admin claiming this tenant still gets 404; nothing was written',
  )

  // ---------------------------------------------------------------- baselines and order (T021–T030)
  section('Baselines and order: 0, 1, 2 and 4 freezes, root-to-tail pairs, exact ids, the database evaluation instant')
  const DZ = await deltaOf(Z.claimId)
  check('T021', 'Zero freezes: NO_FROZEN_SUBMISSION', DZ.status === 200 && DZ.body.baselineCode === 'NO_FROZEN_SUBMISSION' && (await prisma.claimFreeze.count({ where: { claimId: Z.claimId } })) === 0, 'an unfrozen Claim reads NO_FROZEN_SUBMISSION')
  check('T022', 'Zero freezes: zero comparisons', DZ.body.comparisonCount === 0 && same(DZ.body.comparisons, []), 'and carries no comparison')
  const D1f = await deltaOf(One.claimId)
  check('T023', 'One freeze: SINGLE_FREEZE', D1f.status === 200 && D1f.body.baselineCode === 'SINGLE_FREEZE', 'a one-freeze Claim reads SINGLE_FREEZE')
  check('T024', 'One freeze: zero comparisons', D1f.body.comparisonCount === 0 && same(D1f.body.comparisons, []), 'and carries no comparison (a single freeze has nothing to compare)')
  const DB2 = await deltaOf(Bc.claimId)
  check('T025', 'Two linked freezes: one pair', DB2.status === 200 && DB2.body.baselineCode === 'COMPARABLE_HISTORY' && DB2.body.comparisonCount === 1 && DB2.body.comparisons[0].predecessorSubmissionId === Bc.freezes[0] && DB2.body.comparisons[0].correctedSubmissionId === Bc.freezes[1], 'two linked freezes give exactly one pair (S1/S2)')
  const DQ = await deltaOf(Q.claimId)
  check('T026', 'Three links: three comparisons', DQ.status === 200 && DQ.body.comparisonCount === 3 && DQ.body.comparisons.length === 3, 'four freezes joined by three links give three comparisons')
  const TQ = await timelineFactsOf(Q.claimId)
  check(
    'T027',
    'Comparisons root-to-tail order',
    same(DQ.body.comparisons.map((c: any) => [c.predecessorSubmissionId, c.correctedSubmissionId]), [[Q.freezes[0], Q.freezes[1]], [Q.freezes[1], Q.freezes[2]], [Q.freezes[2], Q.freezes[3]]]) && same(DQ.body.comparisons.map((c: any) => c.correctedSubmissionId), TQ.submissions.slice(1).map((e) => e.claimSubmissionId)),
    'q1/q2, q2/q3, q3/q4 — exactly the A7.7 timeline order',
  )
  check('T028', 'Every ordinal contiguous 1..N', [DW.body, DB2.body, DQ.body].every((b: any) => same(b.comparisons.map((c: any) => c.ordinal), b.comparisons.map((_: unknown, i: number) => i + 1))), 'comparison ordinals are exactly 1..N on every delta')
  const dbLinks = await prisma.claimCorrectionLink.findMany({ where: { claimId: Q.claimId } })
  check(
    'T029',
    'Predecessor, corrected, link IDs exact',
    DQ.body.comparisons.every((c: any, i: number) => c.correctionLinkId === QL[i] && dbLinks.some((l) => l.id === c.correctionLinkId && l.priorSubmissionId === c.predecessorSubmissionId && l.correctedSubmissionId === c.correctedSubmissionId)),
    'each pair names exactly the stored link from its predecessor to its corrected freeze',
  )
  const dbBefore = (await prisma.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`)[0].t
  const timed = await deltaOf(W.claimId)
  const dbAfter = (await prisma.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`)[0].t
  const evaluated = Date.parse(timed.body.evaluatedAt)
  check('T030', 'Database evaluation time UTC and exact', /Z$/.test(timed.body.evaluatedAt) && new Date(evaluated).toISOString() === timed.body.evaluatedAt && evaluated >= dbBefore.getTime() && evaluated <= dbAfter.getTime(), `evaluatedAt ${timed.body.evaluatedAt} is a canonical UTC instant taken by the database between ${dbBefore.toISOString()} and ${dbAfter.toISOString()}`)

  // ---------------------------------------------------------------- delta codes (T031–T040)
  section('Delta codes: both absent, new case, no longer recorded, unchanged (planted, rolled back), each changed field, evaluatedAt ignored')
  const bPair = DB2.body.comparisons[0]
  check('T031', 'Both cases absent: BOTH_ABSENT', bPair.evidenceDeltaCode === 'BOTH_ABSENT', 'two linked freezes without cases compare BOTH_ABSENT')
  const [w1, w2] = DW.body.comparisons
  check('T032', 'Only corrected case: NEW_CASE_RECORDED', w1.evidenceDeltaCode === 'NEW_CASE_RECORDED' && w1.predecessorCaseId === null && w1.correctedCaseId === CASE2.caseId, 'D1 (no case) → D2 (CASE2) is NEW_CASE_RECORDED')
  const DG = await deltaOf(G.claimId)
  check('T033', 'Only predecessor case: NO_LONGER_RECORDED', DG.status === 200 && DG.body.comparisons[0].evidenceDeltaCode === 'CASE_NO_LONGER_RECORDED' && DG.body.comparisons[0].predecessorCaseId === GCASE.caseId && DG.body.comparisons[0].correctedCaseId === null, 'a case only on the predecessor is CASE_NO_LONGER_RECORDED')
  const twinDigest = createHash('sha256').update(`${runId}-twin`).digest('hex')
  const unchangedPlant = await planted(Bc.claimId, [], async (tx) => {
    await insertCase(tx, Bc.freezes[0], { digest: twinDigest })
    await insertCase(tx, Bc.freezes[1], { digest: twinDigest })
  })
  const unchangedValue = unchangedPlant.result?.ok ? unchangedPlant.result.value.comparisons[0] : null
  check(
    'T034',
    'Equal stored summaries: UNCHANGED',
    unchangedPlant.message.includes(NOT_REFUSED) && unchangedValue?.evidenceDeltaCode === 'RECORDED_SUMMARY_UNCHANGED' && unchangedValue.predecessorCaseManifestSha256 === unchangedValue.correctedCaseManifestSha256,
    'two cases with identical stored summaries — reachable only planted (rolled back), since every real case digest binds its own freeze — compare RECORDED_SUMMARY_UNCHANGED through the production service',
  )
  const TW = await timelineFactsOf(W.claimId)
  const twin = (change: Record<string, unknown>) => {
    const base = TW.submissions[1].caseSummaries[0]
    const entries = TW.submissions.map((e, i) => (i === 2 ? { ...e, caseSummaries: [{ ...base, caseId: e.caseSummaries[0].caseId, ...change }], prerequisiteSummaries: [] } : e))
    const result = deriveRevenueDelta({ ...TW, submissions: entries })
    return result.ok ? result.value.comparisons[1].evidenceDeltaCode : 'CONFLICT'
  }
  check('T035', 'Changed manifest digest: CHANGED', w2.evidenceDeltaCode === 'RECORDED_SUMMARY_CHANGED' && w2.predecessorCaseManifestSha256 !== w2.correctedCaseManifestSha256 && twin({}) === 'RECORDED_SUMMARY_UNCHANGED' && twin({ manifestSha256: twinDigest }) === 'RECORDED_SUMMARY_CHANGED', 'D2/D3 differ in digest (CHANGED); on the real timeline a twin of CASE2 is UNCHANGED and the same twin with only another digest is CHANGED')
  check('T036', 'Changed count: CHANGED', w2.sourceCountBefore === 2 && w2.sourceCountAfter === 3 && twin({ sourceCount: 9 }) === 'RECORDED_SUMMARY_CHANGED' && twin({ itemCount: 9 }) === 'RECORDED_SUMMARY_CHANGED', 'D2→D3 carries 2→3 sources; a twin changing only sourceCount, or only itemCount, is CHANGED')
  check('T037', 'Changed assembly code: CHANGED', twin({ assemblyCode: 'INVENTORY_INCOMPLETE' }) === 'RECORDED_SUMMARY_CHANGED', 'a twin changing only the assembly code is CHANGED')
  check('T038', 'Changed classified count: CHANGED', twin({ classifiedCount: 1 }) === 'RECORDED_SUMMARY_CHANGED' && w2.classifiedCountBefore === 2 && w2.classifiedCountAfter === 3, 'a twin changing only classifiedCount is CHANGED; D2→D3 carries 2→3 classified')
  check('T039', 'Changed readiness count: CHANGED', twin({ readinessCount: 1 }) === 'RECORDED_SUMMARY_CHANGED' && w2.readinessCountBefore === 2 && w2.readinessCountAfter === 3, 'a twin changing only readinessCount is CHANGED; D2→D3 carries 2→3 linked')
  const again = await deltaOf(W.claimId)
  const reducerTwice = [deriveRevenueDelta(TW), deriveRevenueDelta({ ...TW })]
  check('T040', 'Only evaluatedAt differences ignored', same(stable(again.body), stable(DW.body)) && again.body.evaluatedAt !== undefined && same(reducerTwice[0], reducerTwice[1]) && !/evaluatedAt/.test(committedCode(`${MODULE_DIR}/revenue-delta.reducer.ts`)), 'two reads differ at most in evaluatedAt; the reducer never reads it')

  // ---------------------------------------------------------------- absence and truthful boundaries (T041–T050)
  section('Absence as null, assessment copied, nothing synthesized, no trace, no payer reason, no disposition, no zero balance')
  check('T041', 'Absent case: null IDs and counts', [bPair.predecessorCaseId, bPair.correctedCaseId, bPair.sourceCountBefore, bPair.sourceCountAfter, bPair.classifiedCountBefore, bPair.readinessCountAfter, bPair.predecessorCaseManifestSha256, bPair.correctedCaseManifestSha256].every((v) => v === null) && w1.predecessorCaseId === null && w1.sourceCountBefore === null, 'every case id, count and digest of an absent case is null — never 0 or ""')
  check('T042', 'Absent assessment: null', w2.prerequisiteAfter === null && w2.correctedAssessmentId === null && bPair.prerequisiteBefore === null && bPair.prerequisiteAfter === null, "D3's case is unassessed: its assessment id and state are null")
  const assess2Row = await prisma.evidencePrereqResult.findUniqueOrThrow({ where: { id: ASSESS2.assessmentId } })
  check('T043', 'Assessment code copied exactly', w1.correctedAssessmentId === ASSESS2.assessmentId && w1.prerequisiteAfter?.assessmentCode === assess2Row.assessmentCode && w2.prerequisiteBefore?.assessmentCode === assess2Row.assessmentCode, `ASSESS2's recorded ${assess2Row.assessmentCode} is copied on both sides it appears`)
  check('T044', 'Assessment basis copied exactly', w1.prerequisiteAfter?.basisCode === assess2Row.basisCode && w2.prerequisiteBefore?.basisCode === assess2Row.basisCode && same(Object.keys(w1.prerequisiteAfter ?? {}), ['assessmentCode', 'basisCode']), `and its basis ${assess2Row.basisCode}; the state holds exactly code and basis`)
  const countsBefore45 = await counts()
  for (const c of [W, Bc, G, Q, Z, One]) await deltaOf(c.claimId)
  const after45 = await counts()
  check('T045', 'No case synthesized by delta', after45[HEADER] === countsBefore45[HEADER] && after45[ENTRY] === countsBefore45[ENTRY] && (await prisma.evidenceCaseSnapshot.count({ where: { claimSubmissionId: { in: Bc.freezes } } })) === 0, 'six deltas created no case or entry; the both-absent Claim still has no case')
  check('T046', 'No assessment synthesized by delta', after45[PREREQ] === countsBefore45[PREREQ] && (await prisma.evidencePrereqResult.count({ where: { evidenceCaseId: CASE3.caseId } })) === 0, "six deltas created no assessment; D3's case is still unassessed")
  const productionCode = committedProductionCodeOf([MODULE_DIR]).code
  check('T047', 'No A7.6 trace generated by delta', !/closure-basis-trace|traceClosureBasis|getClosureBasisTrace|explanation/.test(productionCode) && ![...deepKeys(DW.body)].some((k) => /trace|explanation/i.test(k)), 'A7.8 neither imports nor creates an A7.6 trace and returns no trace or explanation field')
  const linkRow = await prisma.claimCorrectionLink.findUniqueOrThrow({ where: { id: WL[0] } })
  check('T048', 'Correction reason not a payer reason', ![...deepKeys(DW.body)].some((k) => /reason/i.test(k)) && !JSON.stringify(DW.body).includes(linkRow.reasonCode), `the link's recorded reason (${linkRow.reasonCode}) is not carried, renamed or reinterpreted; no reason field exists`)
  const dgBefore = stable(DG.body)
  await post(`/api/claim-submissions/${G.freezes[1]}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null })
  const dgAfter = await deltaOf(G.claimId)
  check(
    'T049',
    'Internal disposition not financial outcome',
    (await get(`/api/claim-submissions/${G.freezes[1]}/lifecycle`)).body?.state === 'RELEASE_ELIGIBLE' && same(stable(dgAfter.body), dgBefore) && ![...deepKeys(dgAfter.body)].some((k) => /disposition|lifecycle|release|state|status/i.test(k)) && !JSON.stringify(dgAfter.body).includes('RELEASE'),
    'after an internal AUTHORIZE_RELEASE on the corrected freeze, the delta is byte-identical and carries no disposition, release or status',
  )
  const ledgerTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(receivable|ledger|balance|posting|journal|allocation|settle|payment|cash|receipt|copay|patient_share)'`).map((row) => row.t)
  check('T050', 'No zero balance inferred from absence', bPair.sourceCountBefore === null && !/":0[,}]/.test(JSON.stringify(DB2.body.comparisons)) && ledgerTables.length === 0 && ![...deepKeys(DB2.body)].some((k) => /balance|amount|due|paid/i.test(k)), 'absence is null, never 0; no balance, amount or payment field or table exists')

  // ---------------------------------------------------------------- corrupt chains (T051–T060)
  section('Corrupt histories (planted on the four-freeze Claim, always rolled back): chains, forks, joins, cycles, extra, missing and foreign freezes, cases, assessments')
  const [q1, q2, q3, q4] = Q.freezes
  const broken = await planted(Q.claimId, [], (tx) => deleteLink(tx, QL[1]).then(() => undefined))
  check('T051', 'Broken correction chain 409', refused(broken) && /more than one chain/.test(detailOf(broken)), `q1→q2 and q3→q4 (q2→q3 removed) is refused 409: ${detailOf(broken)}`)
  const fork = await planted(Q.claimId, ['DROP INDEX claim_correction_links_prior_submission_id_key', 'DROP INDEX claim_correction_links_corrected_submission_id_key'], (tx) => insertLink(tx, Q.claimId, q1, q3).then(() => undefined))
  check('T052', 'Fork refused 409', refused(fork) && /fork|join/.test(detailOf(fork)), `q1 corrected by both q2 and q3 is refused 409: ${detailOf(fork)}`)
  const join = await planted(Q.claimId, ['DROP INDEX claim_correction_links_corrected_submission_id_key'], (tx) => insertLink(tx, Q.claimId, q4, q2).then(() => undefined))
  check('T053', 'Join refused 409', refused(join) && /join/.test(detailOf(join)), `q2 correcting both q1 and q4 is refused 409: ${detailOf(join)}`)
  const cycle = await planted(Q.claimId, [], (tx) => insertLink(tx, Q.claimId, q4, q1).then(() => undefined))
  check('T054', 'Cycle refused 409', refused(cycle) && /cycle/.test(detailOf(cycle)), `q1→q2→q3→q4→q1 is refused 409: ${detailOf(cycle)}`)
  const extra = await planted(Q.claimId, [], (tx) => deleteLink(tx, QL[2]).then(() => undefined))
  check('T055', 'Disconnected extra freeze refused 409', refused(extra) && /more than one root/.test(detailOf(extra)), `q4 left unlinked is refused 409: ${detailOf(extra)}`)
  const missingFreeze = await planted(Q.claimId, [], (tx) => insertLink(tx, Q.claimId, q4, MISSING).then(() => undefined))
  check('T056', 'Missing freeze refused 409', refused(missingFreeze) && /not this claim's/.test(detailOf(missingFreeze)), `a link to a freeze that does not exist is refused 409: ${detailOf(missingFreeze)}`)
  const crossClaim = await planted(Q.claimId, [], (tx) => insertLink(tx, Q.claimId, q4, One.freezes[0]).then(() => undefined))
  check('T057', 'Cross-Claim submission refused 409', refused(crossClaim) && /not this claim's/.test(detailOf(crossClaim)), `a link to another Claim's freeze is refused 409: ${detailOf(crossClaim)}`)
  const foreignCase = await planted(Q.claimId, [], (tx) => insertCase(tx, q1, { organization: otherOrg }).then(() => undefined))
  check('T058', 'Foreign case ownership refused 409', refused(foreignCase) && /another organization/.test(detailOf(foreignCase)), `a case of the other organization on q1 is refused 409: ${detailOf(foreignCase)}`)
  const duplicateCase = await planted(Q.claimId, ['DROP INDEX evidence_case_snapshots_identity_key'], (tx) => insertCase(tx, q2).then(() => undefined))
  check('T059', 'Duplicate v1 case refused 409', refused(duplicateCase) && /more than one case/.test(detailOf(duplicateCase)), `a second v1 case for q2 (identity index dropped) is refused 409, never resolved to the newest: ${detailOf(duplicateCase)}`)
  const duplicateAssessment = await planted(Q.claimId, ['DROP INDEX evidence_prereq_results_identity_key'], (tx) => insertAssessment(tx, Qcase2.caseId, Qcase2.manifestSha256).then(() => undefined))
  check('T060', 'Duplicate v1 prerequisite refused 409', refused(duplicateAssessment) && /more than one assessment/.test(detailOf(duplicateAssessment)), `a second v1 assessment of q2's case (identity index dropped) is refused 409: ${detailOf(duplicateAssessment)}`)

  // ---------------------------------------------------------------- contracts and structure (T061–T070)
  section('Future contracts, malformed digests, mismatches, missing links, chronology, ordinals and predecessors; no partial DTO')
  const futureTimeline = reducerCode({ ...TQ, contractVersion: 'A7-REVENUE-TIMELINE-2' })
  check('T061', 'Future A7.7 contract refused', /A7-REVENUE-TIMELINE-1/.test(futureTimeline), `the A7.7 owner composes its contract itself, so the future version is forged on the real timeline and refused by the production reducer: ${futureTimeline}`)
  const futureCase = await planted(Q.claimId, [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_contract_chk`], (tx) => insertCase(tx, q1, { contract: 'A7-REVENUE-CASE-2' }).then(() => undefined))
  check('T062', 'Future A7.4 contract refused', refused(futureCase) && /unsupported contract/.test(detailOf(futureCase)), `an A7-REVENUE-CASE-2 case (CHECK dropped) is refused 409: ${detailOf(futureCase)}`)
  const futureAssessment = await planted(Q.claimId, [`ALTER TABLE ${PREREQ} DROP CONSTRAINT evidence_prereq_results_contract_chk`, 'DROP INDEX evidence_prereq_results_identity_key'], (tx) => insertAssessment(tx, Qcase3.caseId, Qcase3.manifestSha256, { contract: 'A7-CLOSURE-PREREQ-2' }).then(() => undefined))
  check('T063', 'Future A7.5 contract refused', refused(futureAssessment) && /unsupported contract/.test(detailOf(futureAssessment)), `an A7-CLOSURE-PREREQ-2 assessment (CHECK dropped) is refused 409: ${detailOf(futureAssessment)}`)
  const badDigest = await planted(Q.claimId, [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_manifest_chk`], (tx) => insertCase(tx, q1, { digest: 'ABC' }).then(() => undefined))
  check('T064', 'Malformed stored case digest refused', refused(badDigest) && /digest/.test(detailOf(badDigest)), `a case whose stored digest is "ABC" (CHECK dropped) is refused 409: ${detailOf(badDigest)}`)
  const mismatch = await planted(Q.claimId, ['DROP INDEX evidence_prereq_results_identity_key'], (tx) => insertAssessment(tx, Qcase3.caseId, 'f'.repeat(64)).then(() => undefined))
  check('T065', 'Digest/assessment mismatch refused', refused(mismatch) && /digest|more than one assessment/.test(detailOf(mismatch)), `an assessment of q3's case carrying another digest is refused 409: ${detailOf(mismatch)}`)
  const missingLink = await planted(Bc.claimId, [], (tx) => deleteLink(tx, BL[0]).then(() => undefined))
  check('T066', 'Missing correction link refused', refused(missingLink) && /more than one root/.test(detailOf(missingLink)), `two freezes with their only link removed are refused 409: ${detailOf(missingLink)}`)
  const chronology = await planted(Q.claimId, [], (tx) => tx.$executeRawUnsafe(`UPDATE ${FREEZES} SET frozen_at = (SELECT frozen_at FROM ${FREEZES} WHERE id = $1::uuid) - interval '1 day' WHERE id = $2::uuid`, q1, q2).then(() => undefined))
  check('T067', 'Wrong chronology refused', refused(chronology) && /strictly after/.test(detailOf(chronology)), `q2 frozen a day before q1 is refused 409: ${detailOf(chronology)}`)
  const gap = reducerCode({ ...TQ, submissions: TQ.submissions.map((e, i) => (i === 2 ? { ...e, ordinal: 4 } : e)) })
  check('T068', 'Noncontiguous ordinal refused', /1\.\.N/.test(gap), `an ordinal gap forged on the real timeline is refused by the production reducer: ${gap}`)
  const predecessor = reducerCode({ ...TQ, submissions: TQ.submissions.map((e, i) => (i === 2 ? { ...e, priorSubmissionId: q4 } : e)) })
  check('T069', 'Mismatched predecessor refused', /predecessor is not the entry before it/.test(predecessor), `a predecessor forged on the real timeline is refused by the production reducer: ${predecessor}`)
  const allPlants = [broken, fork, join, cycle, extra, missingFreeze, crossClaim, foreignCase, duplicateCase, duplicateAssessment, futureCase, futureAssessment, badDigest, mismatch, missingLink, chronology]
  check(
    'T070',
    'No partial DTO on any refusal',
    allPlants.every(refused) && plantedRuns.total === allPlants.length + 1 && plantedRuns.dirty === 0,
    `each of the ${allPlants.length} refused histories returned only the controlled 409 code and a safe message — never comparisons; all ${plantedRuns.total} plants left every row, CHECK and index byte-identical (${plantedRuns.dirty} did not)`,
  )

  // ---------------------------------------------------------------- snapshot and concurrency (T071–T080)
  section('One REPEATABLE READ, READ ONLY snapshot on the caller client, no Claim lock, writers of A6.9 and A7.1–A7.5 held uncommitted')
  await linkedSource(G.freezes[1], 'G2-E1')
  const snapshotProof = await withReadSnapshot(undefined, async (tx) => {
    const isolation = (await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('transaction_isolation') AS v`)[0].v
    const first = await getRevenueDeltaOf(G.claimId, tx)
    const assembled = await assembleRevenueEvidenceCase(G.freezes[1], {}, creatorId)
    const second = await getRevenueDeltaOf(G.claimId, tx)
    return { isolation, first, second, assembled: assembled.ok }
  })
  const gAfter = await deltaOf(G.claimId)
  check(
    'T071',
    'One REPEATABLE READ snapshot',
    snapshotProof.isolation === 'repeatable read' && snapshotProof.assembled && snapshotProof.first.ok && snapshotProof.second.ok && same(stable(snapshotProof.first.value), stable(snapshotProof.second.value)) && gAfter.body.comparisons[0].evidenceDeltaCode === 'RECORDED_SUMMARY_CHANGED',
    'the read runs at REPEATABLE READ; a case committed on the corrected freeze meanwhile is invisible to the held snapshot (still CASE_NO_LONGER_RECORDED); a new snapshot sees it (now CHANGED)',
  )
  const readOnly = await withReadSnapshot(undefined, async (tx) => (await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('transaction_read_only') AS v`)[0].v)
  const writeRefused = await attemptAdversarial(() => withReadSnapshot(undefined, async (tx) => tx.$executeRawUnsafe(`UPDATE ${LINKS} SET reason_code = reason_code WHERE id = $1::uuid`, WL[0])))
  check('T072', 'Snapshot READ ONLY enforced', readOnly === 'on' && /read-only transaction/.test(writeRefused), 'transaction_read_only is on, and a write attempted inside the snapshot is refused by PostgreSQL')
  const serviceCode = committedCode(`${MODULE_DIR}/revenue-delta.service.ts`)
  const ofBody = serviceCode.slice(serviceCode.indexOf('export async function getRevenueDeltaOf'), serviceCode.indexOf('export async function getRevenueDelta('))
  check('T073', 'Same caller DbClient for owner reads', /getRevenueTimelineOf\(claimId, tx\)/.test(ofBody) && !/prisma\.|withReadSnapshot/.test(ofBody) && /return withReadSnapshot\(undefined, \(tx\) => getRevenueDeltaOf\(claimId, tx\)\)/.test(serviceCode), 'the A7.7 owner read runs on the one caller client of the one snapshot; nothing else is read')
  const holdLock = holdAt('casePrerequisite.claim_locked')
  const lockHolder = assessClosurePrerequisites(CASE2.caseId, {}, creatorId)
  await Promise.race([holdLock.arrived, lockHolder])
  const duringLockPromise = deltaOf(W.claimId)
  const lockFree = await settledWithin(duringLockPromise, 3000)
  const duringLock = await duringLockPromise
  holdLock.release()
  const lockReplay = await lockHolder
  clearConcurrencyProbes()
  check('T074', 'No Claim lock for GET', lockFree && duringLock.status === 200 && lockReplay.ok && lockReplay.value.replayed && !/lockRowForUpdate|FOR UPDATE|FOR SHARE|NOWAIT|row-lock/.test(productionCode), "while an A7.5 request holds the Claim's row lock, the delta answers at once; the A7.8 code requests no row lock")
  const raceRead = async (claimId: string, probe: string, writer: () => Promise<{ ok: boolean }>) => {
    const before = await deltaOf(claimId)
    const hold = holdAt(probe)
    const w = writer()
    await Promise.race([hold.arrived, w])
    const during = deltaOf(claimId)
    const prompt = await settledWithin(during, 3000)
    const duringBody = (await during).body
    hold.release()
    const written = await w
    clearConcurrencyProbes()
    const after = await deltaOf(claimId)
    return { prompt, ok: written.ok, before: before.body, during: duringBody, after: after.body }
  }
  const r75 = await raceRead(W.claimId, 'revenueEvidence.inserted', () => registerRevenueSourceEvidence(D2, { sourceKind: SYNTHETIC, sourceReference: ref('A71-RACE') }, creatorId))
  check('T075', 'A7.1 write cannot mix snapshot', r75.prompt && r75.ok && same(stable(r75.during), stable(r75.before)) && same(stable(r75.after), stable(r75.before)), 'with an A7.1 registration on D2 uncommitted, the delta answers at once with committed facts only; after it commits, the recorded summaries are unchanged')
  const s76 = await registerSource(D2, 'A72-RACE')
  const r76 = await raceRead(W.claimId, 'evidenceClassification.inserted', () => classifySourceEvidence(s76, {}, creatorId))
  check('T076', 'A7.2 write cannot mix snapshot', r76.prompt && r76.ok && same(stable(r76.during), stable(r76.before)) && same(stable(r76.after), stable(r76.before)), 'with an A7.2 classification on D2 uncommitted, the delta answers at once and stays identical')
  const c77 = (await post(`/api/revenue-source-evidence/${await registerSource(D2, 'A73-RACE')}/classifications`, {})).body.classificationId as string
  const r77 = await raceRead(W.claimId, 'evidenceGate.inserted', () => recordAdjudicationReadiness(c77, {}, creatorId))
  check('T077', 'A7.3 write cannot mix snapshot', r77.prompt && r77.ok && same(stable(r77.during), stable(r77.before)) && same(stable(r77.after), stable(r77.before)), 'with an A7.3 readiness on D2 uncommitted, the delta answers at once and stays identical')
  await linkedSource(Bc.freezes[0], 'B1-E1')
  const r78 = await raceRead(Bc.claimId, 'evidenceCase.entries_inserted', () => assembleRevenueEvidenceCase(Bc.freezes[0], {}, creatorId))
  check(
    'T078',
    'A7.4 assembly cannot mix snapshot',
    r78.prompt && r78.ok && r78.during.comparisons[0].evidenceDeltaCode === 'BOTH_ABSENT' && r78.after.comparisons[0].evidenceDeltaCode === 'CASE_NO_LONGER_RECORDED',
    'while the B1 case header and entries were written but uncommitted the delta still read BOTH_ABSENT; after commit, CASE_NO_LONGER_RECORDED — never a half-written case',
  )
  const b1Case = r78.after.comparisons[0].predecessorCaseId as string
  const r79 = await raceRead(Bc.claimId, 'casePrerequisite.inserted', () => assessClosurePrerequisites(b1Case, {}, creatorId))
  check('T079', 'A7.5 assessment cannot mix snapshot', r79.prompt && r79.ok && r79.during.comparisons[0].prerequisiteBefore === null && r79.after.comparisons[0].prerequisiteBefore?.assessmentCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'while the B1 assessment was uncommitted the delta showed none; after commit, exactly the recorded assessment')
  const beforeGrow = await deltaOf(W.claimId)
  const D4 = await W.extend()
  const unlinked = await deltaOf(W.claimId)
  const holdLink = holdAt('claimCorrection.inserted')
  const linking = recordCorrectionLink(W.claimId, { priorSubmissionId: D3, correctedSubmissionId: D4, reasonCode: 'CORRECTED_CODING' }, creatorId)
  await Promise.race([holdLink.arrived, linking])
  const duringLinkPromise = deltaOf(W.claimId)
  const linkPrompt = await settledWithin(duringLinkPromise, 3000)
  const duringLink = await duringLinkPromise
  holdLink.release()
  const linked = await linking
  clearConcurrencyProbes()
  const afterGrow = await deltaOf(W.claimId)
  check(
    'T080',
    'Concurrent link cannot mix snapshot',
    unlinked.status === 409 && linkPrompt && duringLink.status === 409 && errorCode(duringLink.body) === 'REVENUE_DELTA_PROVENANCE_CONFLICT' && linked.ok && afterGrow.status === 200 && afterGrow.body.comparisonCount === 3,
    'with D4 frozen but its D3→D4 link uncommitted, the delta answered at once from the committed history (an unlinked freeze: 409, never a half-linked pair); after the link commits, three comparisons',
  )

  // ---------------------------------------------------------------- determinism and history (T081–T090)
  section('Stable bytes, other users, evaluatedAt only, time zone and locale, one hundred reductions, history after sources, assessments, growth and a restart')
  const twice = [await deltaOf(W.claimId), await deltaOf(W.claimId)]
  check('T081', 'Same GET twice: stable bytes identical', same(stable(twice[0].body), stable(twice[1].body)) && same(stable(twice[0].body), stable(afterGrow.body)), 'two consecutive reads are byte-identical apart from evaluatedAt')
  const others = [await deltaOf(W.claimId, asViewer), await deltaOf(W.claimId, B.who)]
  check('T082', 'Other permitted user: same facts', others.every((r) => r.status === 200 && same(stable(r.body), stable(twice[0].body))), 'the Viewer and a second Admin see exactly the same stable facts')
  check('T083', 'Only evaluatedAt may vary', Object.keys(twice[0].body).filter((k) => JSON.stringify(twice[0].body[k]) !== JSON.stringify(twice[1].body[k])).every((k) => k === 'evaluatedAt'), 'between reads no field but evaluatedAt changes')
  const probe = spawnSync(
    process.execPath,
    ['--env-file=.env', '--input-type=module', '-e', `import { prisma } from './src/shared/database/prisma.ts'; import { getRevenueDelta } from './src/modules/revenue-delta/revenue-delta.service.ts'; const r = await getRevenueDelta('${W.claimId}'); const { evaluatedAt, ...rest } = r.ok ? r.value : {}; console.log(JSON.stringify([rest, Intl.DateTimeFormat().resolvedOptions().timeZone, Intl.DateTimeFormat().resolvedOptions().locale])); await prisma.$disconnect()`],
    { encoding: 'utf8', cwd: process.cwd(), env: childEnv({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }) },
  )
  const probed = (() => {
    try {
      return JSON.parse((probe.stdout ?? '').trim().split(/\r?\n/).pop() ?? '')
    } catch {
      return null
    }
  })()
  const zoned = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Kiritimati'")
    await tx.$executeRawUnsafe("SET LOCAL lc_messages = 'C'")
    return getRevenueDeltaOf(W.claimId, tx)
  })
  check('T084', 'Time zone invariance', probed !== null && probed[1] === 'Pacific/Kiritimati' && same(probed[0], stable(twice[0].body)) && zoned.ok && same(stable(zoned.value), stable(twice[0].body)), 'a separate process in Pacific/Kiritimati and a database session in that zone derive the identical delta')
  const lowerings = (productionCode.match(/\.toLowerCase\(\)/g) ?? []).length
  const idLowerings = (productionCode.match(/claimId\)?\.toLowerCase\(\)/g) ?? []).length
  check('T085', 'Locale invariance of order and codes', probed !== null && same(probed[0], stable(twice[0].body)) && !/toLocale|Intl\.|localeCompare|toUpperCase|\.sort\(/.test(productionCode) && lowerings === idLowerings, `with a ${probed?.[2] ?? '?'} process locale the order and codes are the same; A7.8 never sorts, compares by locale or changes case except the path id (${idLowerings})`)
  const TWnow = await timelineFactsOf(W.claimId)
  const hundred = new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveRevenueDelta(TWnow))))
  check('T086', 'One hundred pure reductions deterministic', hundred.size === 1 && same(JSON.parse([...hundred][0]).value.comparisons, twice[0].body.comparisons), 'one hundred reductions of the same timeline are byte-identical and equal the HTTP comparisons')
  await linkedSource(D2, 'D2-LATER')
  const afterSources = await deltaOf(W.claimId)
  check('T087', 'History remains after later sources', same(stable(afterSources.body), stable(twice[0].body)), 'a source registered, classified and gated on D2 later leaves every comparison byte-identical (its case is history)')
  const assess3 = await assessmentOf(CASE3.caseId)
  const afterAssessment = await deltaOf(W.claimId)
  const [p1, p2] = afterAssessment.body.comparisons
  check(
    'T088',
    'History remains after new assessment',
    same(p1, twice[0].body.comparisons[0]) && p2.evidenceDeltaCode === twice[0].body.comparisons[1].evidenceDeltaCode && p2.correctedCaseManifestSha256 === twice[0].body.comparisons[1].correctedCaseManifestSha256 && p2.correctedAssessmentId === assess3.assessmentId && twice[0].body.comparisons[1].correctedAssessmentId === null,
    "after D3's case is assessed, D1/D2 is byte-identical and D2/D3 keeps its code and digests, now showing the new assessment on the corrected side",
  )
  check('T089', 'Old comparisons remain after chain grows', beforeGrow.status === 200 && same(afterGrow.body.comparisons.slice(0, 2), beforeGrow.body.comparisons) && afterGrow.body.comparisons[2].correctedSubmissionId === D4, 'after D4 is frozen and linked, D1/D2 and D2/D3 are byte-identical and D3/D4 is appended')
  const beforeRestart = stable((await deltaOf(W.claimId)).body)
  const restartedOnce = spawnSync('docker', ['restart', dbContainer], { encoding: 'utf8' }).status === 0
  await waitFor(databaseUp, 90_000)
  await apiReady('reading after the database restart')
  const afterRestart = stable((await deltaOf(W.claimId)).body)
  check('T090', 'Database restart preserves stable DTO', restartedOnce && same(afterRestart, beforeRestart), 'after the database container restarts, the delta reads back byte-identically (all but evaluatedAt)')

  // ---------------------------------------------------------------- privacy and no writes (T091–T100)
  section('Privacy: no PHI, clinical, money, payer, payload, source or transport detail; no audit on success or refusal; no browser persistence or logging')
  const deltas = [afterAssessment.body, DB2.body, DG.body, DQ.body, DZ.body, D1f.body, gAfter.body]
  const exposed = JSON.stringify(deltas)
  const exposedKeys = [...deepKeys(JSON.parse(exposed))]
  check('T091', 'No PHI in DTO', !exposed.includes(`${runId}-home-P`) && !exposed.includes('1990-01-01') && !exposedKeys.some((k) => /patient|member|name|birth|email|phone|address|gender|user|actor|recordedBy/i.test(k)), 'no patient, member, user or actor value or key')
  check('T092', 'No diagnosis/procedure details', !exposedKeys.some((k) => /diagnos|procedure|activity|encounter|clinician|facility|^(claim)?lines?(Id)?$/i.test(k)) && !exposed.includes(key('home-DXA')) && !exposed.includes(key('home-PA')), 'no diagnosis, procedure, activity, encounter, clinician, facility or line key or value')
  check('T093', 'No amount, currency or balance', !/125\.25|12\.125|200\.01|AED/.test(exposed) && !exposedKeys.some((k) => /amount|balance|currency|price|fee|total|money/i.test(k)), 'no amount, currency, balance, price or total')
  check('T094', 'No payer, denial or remittance status', !exposedKeys.some((k) => /payer|payment|denial|adjudicat|remittance|status|verdict|settle/i.test(k)) && !/"(PAID|DENIED|SETTLED|ADJUDICATED|CLOSED)"/.test(exposed), 'no payer, payment, denial, adjudication, remittance or status key, and no paid/denied/settled value (the A7.5 basis code is the only controlled mention of remittance, and only as absent)')
  check('T095', 'No raw canonical payload bytes', !exposedKeys.some((k) => /bytes|payload|seal|canonical|manifestText|raw/i.test(k)), 'no frozen payload, manifest bytes or seal')
  const fingerprints = (await prisma.sourceEvidenceClassification.findMany({ where: { sourceEvidence: { claimSubmissionId: D2 } }, select: { sourceFingerprintSha256: true } })).map((r) => r.sourceFingerprintSha256)
  check('T096', 'No source payload or secrets', !exposedKeys.some((k) => /source(Reference|Evidence|Digest)|fingerprint|secret|token|password|cookie/i.test(k)) && !exposed.includes(ref('D2-E1')) && fingerprints.every((f) => !exposed.includes(f)), 'no source reference, source id, source digest or fingerprint, secret, token or cookie')
  check('T097', 'No transport identifiers', !exposedKeys.some((k) => /transmission|outbox|dhpo|eclaim|external|batch|message|acknowledg/i.test(k)), 'no transmission, outbox, batch, message, acknowledgement or external reference field')
  const auditsBefore = await prisma.auditEvent.count()
  for (const who of [asAdmin, asViewer, B.who]) await deltaOf(W.claimId, who)
  const auditsAfterSuccess = await prisma.auditEvent.count()
  check('T098', 'No audit event on success', auditsAfterSuccess === auditsBefore, 'successful deltas by three users wrote no audit')
  for (const r of [await deltaOf(MISSING), await deltaOf('not-a-uuid'), await deltaOf(W.claimId, anonymous), await deltaOf(W.claimId, O.who), await api('GET', `${deltaPath(W.claimId)}?latest=1`)]) void r
  check('T099', 'No audit event on refusal', (await prisma.auditEvent.count()) === auditsAfterSuccess, 'missing, malformed, anonymous, foreign and selector reads wrote no audit')
  const frontend = committedCode(`${FE_DIR}/RevenueDeltaCheck.tsx`)
  const registry = committedCode('frontend/src/developer/checkRegistry.tsx')
  check('T100', 'No browser persistence or logging', frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|setInterval|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend) && /key: 'revenue-delta'/.test(registry) && !/fetch\([^)]*,\s*\{/.test(frontend) && !/console\.|logger\.|process\.env/.test(productionCode), 'the registered check page makes one plain GET with no options, polls nothing and keeps nothing in browser storage; neither it nor the backend logs')

  // ---------------------------------------------------------------- zero downstream mutation (T101–T110)
  section('No A6 or A7.1–A7.5 row changed by reading, A7.6 traces still read-only, no A8/A9/ledger/payment/closure functionality')
  const traceBefore = await get(`/api/closure-prerequisite-assessments/${ASSESS2.assessmentId}/basis-trace`)
  const before101 = {
    freezes: await Promise.all([W, Bc, G, Q, One, Z, F].map((c) => freezeHash(c.claimId))), lifecycles: await Promise.all([W, G].map((c) => lifecycleHash(c.claimId))), corrections: await Promise.all([W, Bc, G, Q, F].map((c) => correctionHash(c.claimId))),
    sources: await sourceHash(), classifications: await classificationHash(), readiness: await readinessHash(), cases: await allCasesHash(), assessments: await allAssessmentsHash(),
  }
  for (const c of [W, Bc, G, Q, One, Z]) await deltaOf(c.claimId)
  await deltaOf(F.claimId, O.who)
  check('T101', 'A6.7 frozen rows unchanged', same(await Promise.all([W, Bc, G, Q, One, Z, F].map((c) => freezeHash(c.claimId))), before101.freezes), 'every byte of every freeze and sealed manifest of seven Claims is identical after reading their deltas')
  check('T102', 'A6.8 lifecycle rows unchanged', same(await Promise.all([W, G].map((c) => lifecycleHash(c.claimId))), before101.lifecycles), 'every lifecycle event is identical')
  check('T103', 'A6.9 correction links unchanged', same(await Promise.all([W, Bc, G, Q, F].map((c) => correctionHash(c.claimId))), before101.corrections), 'every correction link of five Claims is identical')
  check('T104', 'A7.1 sources unchanged', (await sourceHash()) === before101.sources, "every byte of this run's A7.1 sources is identical")
  check('T105', 'A7.2 classifications unchanged', (await classificationHash()) === before101.classifications, "every byte of this run's A7.2 classifications is identical")
  check('T106', 'A7.3 readiness unchanged', (await readinessHash()) === before101.readiness, "every byte of this run's A7.3 readiness results is identical")
  check('T107', 'A7.4 case and entries unchanged', (await allCasesHash()) === before101.cases, 'every byte of every A7.4 case header and entry is identical')
  check('T108', 'A7.5 assessment unchanged', (await allAssessmentsHash()) === before101.assessments, 'every byte of every A7.5 assessment is identical')
  const traceAfter = await get(`/api/closure-prerequisite-assessments/${ASSESS2.assessmentId}/basis-trace`)
  check('T109', 'A7.6 basis traces remain read-only', traceBefore.status === 200 && traceAfter.status === 200 && same(stable(traceAfter.body), stable(traceBefore.body)) && (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* 'trace'`).length === 0, "ASSESS2's A7.6 trace reads back identically around the deltas, and no trace is stored anywhere")
  const laterRoutes = [await post(`/api/claims/${W.claimId}/closures`, {}), await post(`/api/claims/${W.claimId}/payments`, {}), await post(`/api/claims/${W.claimId}/remittances`, {}), await post(`/api/claims/${W.claimId}/exceptions`, {}), await post(deltaPath(W.claimId), {})]
  const laterTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(adjudicat|denial|allowed|remittance|settle|import|inbound|outbox|queue|transmission|acknowledg|closure|reconcil|exception|delta|receivable|ledger|balance|payment)'`).map((row) => row.t)
  const moneyIdentifier = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|toFixed\(|[Ss]ettle|[Aa]llocat|[Aa]djust|[Rr]eceivable|[Bb]alance|[Ll]edger|[Pp]ayment|[Rr]emittance/
  check(
    'T110',
    'No A8/A9/ledger/payment/closure',
    laterRoutes.every((r) => r.status === 404) && laterTables.length === 0 && !moneyIdentifier.test(productionCode) && !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|enqueue|setInterval|worker_threads|cron/i.test(productionCode) && committedProductionCodeOf([MODULE_DIR]).files.length === 5,
    'no closure, payment, remittance or exception route; no such table (nor a delta table); the five A7.8 backend files hold no money, network, queue, job or worker code',
  )

  const goldenBefore = stable((await deltaOf(W.claimId)).body)

  // ---------------------------------------------------------------- nested regressions (T111–T120)
  section('Regressions — A7.7 invoked, nesting A7.6 -> A7.5 -> A7.4 -> A7.3 -> A7.2 -> A7.1 -> A6.10 -> … -> A6.1 -> A5.10 -> A1')
  await apiReady('the A7.7 and backward regression chain')
  // Rows written from here on belong to the nested suites' own fixtures (each proves its own); T128 judges this run's.
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const chain = run('npm run test:a7:revenue-timeline')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.7')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.7] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.7 asserts facts about its own branch (name, tracking, pushed HEAD, production diff), its nested N/A proofs
  // against its own branch, and a self-summary that holds only when none of those fail. On A7.8 those statements are
  // obsolete by design; every other A7.7 check is substantive. T120 below proves each cause independently.
  const a77NonApplicable: Record<string, string> = {
    T001: "A7.7 'Correct A7.6 merge and branch ancestry' requires the A7.7 feature branch (and reads any other A7 suite as later code); A7.8 is branched from the main that contains the A7.7 merge",
    T002: "A7.7 'Clean synchronized HEAD, origin parity' requires tracking origin/feature/a7-7-…, deleted when it merged; the clean tree and exact parity of THIS branch are proved by T002 here",
    T010: "A7.7 'Only A7.7 allowed file paths changed' lists the paths A7.7 was allowed to change; A7.8 legitimately changes its own (T010 here)",
    T110: "A7.7 'Only documented obsolete branch guards N/A' proves A7.6's branch-only causes against the A7.7 branch (its name, tracking and diff); on A7.8 those proofs are re-done here (T120)",
    T122: "A7.7 'Run uses the exact pushed HEAD' compares HEAD with origin/feature/a7-7-…, deleted when it merged; the pushed exact HEAD of THIS branch is proved by T130 here",
    T125: "A7.7 'Exact HEAD, origin clean, no unauthorized change' requires tracking origin/feature/a7-7-… and A7.7's own allowlist; THIS branch's are proved by T002, T010 and T130 here",
    T130: "A7.7 'Written acceptance summary 130/130' holds only when no earlier A7.7 check failed; on A7.8 exactly the branch-only items above fail, so it fails by construction (proved by count in T120)",
  }
  const undocumented = failing.filter((id) => !(id in a77NonApplicable))
  const summary = chain.output.match(/\[A7\.7\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.7\] RUN ABORTED|\[A7\.7\] uncaught error|\[A7\.7\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a77Substantive = rows.filter((row) => !(row.id in a77NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a77Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T111',
    'A7.7 nested substantive regression',
    ran && reconciled && undocumented.length === 0 && a77Substantive.length === 0 && a77Passing >= 123 && ['T004', 'T007', 'T009', 'T041', 'T061', 'T070', 'T084', 'T123', 'T127', 'T128'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A7.7 suite did not complete'
      : !reconciled
        ? `A7.7 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.7 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.7\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.7] automated summary: ', 'A7.7 ')}; all ${a77Passing} substantive checks PASS and every failure is documented`,
  )
  for (const id of Object.keys(a77NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A7.7 ${titleOf(row.line)}`, a77NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T112', 'A7.6 substantive regression', verdictOf('T101') === 'PASS', `A7.7 T101 (A7.6 with its own justified N/A) ${verdictOf('T101')}`)
  check('T113', 'A7.5 substantive regression', verdictOf('T102') === 'PASS', `A7.7 T102 (A7.5) ${verdictOf('T102')}`)
  check('T114', 'A7.4 substantive regression', verdictOf('T103') === 'PASS', `A7.7 T103 (A7.4) ${verdictOf('T103')}`)
  check('T115', 'A7.3 substantive regression', verdictOf('T104') === 'PASS', `A7.7 T104 (A7.3) ${verdictOf('T104')}`)
  check('T116', 'A7.2 substantive regression', verdictOf('T105') === 'PASS', `A7.7 T105 (A7.2) ${verdictOf('T105')}`)
  check('T117', 'A7.1 substantive regression', verdictOf('T106') === 'PASS', `A7.7 T106 (A7.1) ${verdictOf('T106')}`)
  check('T118', 'A6.10 and A6.1–A6.9 regressions', verdictOf('T107') === 'PASS' && verdictOf('T108') === 'PASS', `A7.7 T107 (A6.10) ${verdictOf('T107')} and T108 (A6.9 … A6.1) ${verdictOf('T108')}`)
  check('T119', 'A5 and A1–A4 regressions', verdictOf('T109') === 'PASS', `A7.7 T109 (A5 and A1–A4) ${verdictOf('T109')}`)
  // Each documented A7.7 failure must fail for its branch-only reason, proved independently on this branch.
  const allowed = ['backend/package.json', 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'frontend/src/developer/checkRegistry.tsx']
  const ownDirs = [MODULE_DIR, FE_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const a77Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA76 = (lineOfRow('T110').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const originA77 = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a77Branch}`])
  const originA78 = gitArgs(['rev-parse', `origin/${a78Branch}`])
  const a77SelfCount = Number((lineOfRow('T130').match(/(\d+)\/129 checks before this one PASS/) ?? [])[1] ?? -1)
  const causes: Record<string, boolean> = {
    T001: branch === a78Branch && a77Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a77Merge} HEAD`),
    T002: /working tree clean/.test(lineOfRow('T002')) && dirty.length === 0 && tracking.includes(`origin/${a78Branch}`) && !/ahead|behind/.test(tracking),
    T010: a77Unexpected.length > 0 && a77Unexpected.every((path, index) => changedPaths.includes(path) || (index === a77Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A7.7 re-proves A7.6's branch-only causes against the A7.7 branch; on A7.8 only those tied to the branch can be
    // unproven — re-proved here against this branch.
    T110: unprovenA76.length > 0 && unprovenA76.every((id) => ['T001', 'T002', 'T010', 'T120', 'T130'].includes(id)) && prismaStatus.length === 0 && outOfScope.length === 0 && tracking.includes(`origin/${a78Branch}`),
    T122: originA77 === '' && originA78 === headAtStart && headAtStart.length === 40,
    T125: tracking.includes(`origin/${a78Branch}`) && !/origin\/feature\/a7-7/.test(tracking) && outOfScope.length === 0,
    T130: a77SelfCount === 129 - (failing.length - 1) && failing.every((id) => id in a77NonApplicable),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A7\.7\] T101\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T120',
    'Historical N/A independently justified',
    ran && failing.every((id) => id in a77NonApplicable) && unproven.length === 0 && naLines.length === 5 && naLines.every((line) => line.length > 80) && ownerChanged.length === 0,
    unproven.length === 0
      ? `each documented A7.7 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved independently here; A7.7 itself justifies its five A7.6 items (${naLines.length} lines)`
      : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- build and acceptance evidence (T121–T130)
  section('Units, typecheck, frontend, checksums and replay, outage and recovery, no 5xx, synthetic fixtures, golden example, exact head')
  const allUnit = run('npm run test:unit')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  check('T121', 'Backend unit test suite PASS', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 11/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 11 A7.8 reducer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Backend typecheck PASS', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint PASS', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build PASS', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const appliedChecksum = (await prisma.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM _prisma_migrations WHERE migration_name = ${A75_MIGRATION_NAME} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.checksum
  const blob = spawnSync('git', ['show', `HEAD:${A75_MIGRATION}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const appliedTotal = Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].n)
  check('T125', 'Prisma checksum and scratch replay', status.ok && replay.ok && appliedTotal === headMigrationDirs.length && (appliedChecksum === sha256Of(readFileSync(`../${A75_MIGRATION}`)) || appliedChecksum === sha256Of(blob)), `no migration added: ${appliedTotal} applied = ${headMigrationDirs.length} committed; the newest still carries its committed checksum (${(appliedChecksum ?? '').slice(0, 12)}…); scratch replay ALL CHECKS PASS (T006)`)
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
  await waitFor(databaseUp, 60_000)
  check('T126', 'DB outage: health 200, ready 503, recovery', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  check('T127', 'Zero unexpected HTTP 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runFreezes = await prisma.$queryRawUnsafe<{ org: string }[]>(
    `SELECT p.organization_id::text AS org FROM ${FREEZES} f JOIN claims k ON k.id = f.claim_id JOIN encounters e ON e.id = k.encounter_id JOIN patients p ON p.id = e.patient_id WHERE f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  const runSources = await prisma.$queryRawUnsafe<{ kind: string; reference: string }[]>(`SELECT source_kind AS kind, source_reference AS reference FROM revenue_source_evidence WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, runStartedAt.toISOString(), chainStartedAt.toISOString())
  check(
    'T128',
    'Only synthetic development records',
    runFreezes.length > 0 && runFreezes.every((f) => [org, otherOrg].includes(f.org)) && runSources.length > 0 && runSources.every((s) => s.kind === SYNTHETIC && s.reference.includes(runToken)) && !/['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/.test(productionCode),
    `the ${runFreezes.length} freezes and ${runSources.length} sources this run recorded (before the nested chain) belong to the two synthetic organizations, every source INTERNAL_SYNTHETIC and keyed by ${runId}; no id is hard-coded in A7.8`,
  )
  const goldenAfter = stable((await deltaOf(W.claimId)).body)
  console.log(`[${TAG}]      worked example: Claim K ${W.claimId}: D1 (no case) -> D2 (CASE2, 2 sources, ${ASSESS2.assessmentCode}) -> D3 (CASE3, 3 sources) gives ${w1.evidenceDeltaCode} then ${w2.evidenceDeltaCode}; D4 appended later through A6.9 without changing either`)
  console.log(`[${TAG}]      worked example: no code means money changed, a payer adjudicated, a payment posted or the Claim closed; corrupt histories planted and rolled back -> 409 with no partial delta`)
  check('T129', 'Golden example after chain and restart', same(goldenAfter, goldenBefore) && w1.evidenceDeltaCode === 'NEW_CASE_RECORDED' && w2.evidenceDeltaCode === 'RECORDED_SUMMARY_CHANGED' && (goldenAfter as any).comparisonCount === 3, 'the §8 scenario (NEW_CASE_RECORDED, then RECORDED_SUMMARY_CHANGED) is reproduced, and after the nested chain and a database restart Claim K reads back identically (all but evaluatedAt)')

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|reconcil|exception|integration\/a(8|9)|dhpo|eclaimlink|prisma\//i.test(file))
  check(
    'T010',
    'Diff allowlist, no later domain code',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A7.8 module, harness and check page, one error code, the route mount, the scripts and the registry entry; no migration, schema, permission, audit or owner change; no A8/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headNow = git('rev-parse HEAD')
  check(
    'T130',
    'Exact HEAD, scope, parity, two full runs',
    headNow === headAtStart && headNow === originA78 && headNow.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a78Branch}`) && !/ahead|behind/.test(tracking) && outOfScope.length === 0 && same(goldenAfter, goldenBefore),
    `all evidence corresponds to ${headNow} (= origin/${a78Branch}); ${tracking}; fresh runId ${runId}; scope exact (T010); the two submitted runs must both state this HEAD`,
  )

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] REVENUE EVIDENCE DELTA ACCEPTANCE COMPLETE` : `[${TAG}] A7.8 FINAL FAIL`)
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
