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
import { getRevenueTimelineOf } from '../../modules/revenue-timeline/revenue-timeline.service.ts'
import { getRevenueDeltaOf } from '../../modules/revenue-delta/revenue-delta.service.ts'
import { deriveRevenueContinuity } from '../../modules/revenue-continuity/revenue-continuity.reducer.ts'
import { getRevenueContinuityOf } from '../../modules/revenue-continuity/revenue-continuity.service.ts'
import type { DeltaFacts, TimelineFacts } from '../../modules/revenue-continuity/revenue-continuity.types.ts'

// A7.9 — focused acceptance for Revenue Evidence Continuity & Provenance Gate (T001–T130).
//
// Every Claim, freeze and correction link is built through its owners, exactly as the A6.7–A7.8 suites build them
// (tariff world and rates, the A5.7 recorder, readiness, the Claim, lines, diagnoses and pointers, pricing, draft
// assessments, APPROVE/REVOKE by a separate synthetic Admin, every freeze through the A6.7 route and every correction
// link through the A6.9 route); every source is registered through the A7.1 route, classified through A7.2, gated
// through A7.3, cased through A7.4 and assessed through A7.5. The other organization builds its own world with its
// own two Admins. Continuity results are read through the A7.9 route (or, on a harness-held snapshot, through its
// transaction-aware service). Histories no owner can record — corrupt ones (broken chains, forks, cycles, extra,
// missing or foreign freezes, foreign, duplicate, future or malformed cases and assessments, uncontrolled bases) and
// truthful ones the synthetic-only A7.1 route cannot reach (REVIEW_REQUIRED and UNSUPPORTED_SOURCE_BASIS assessments,
// twin case summaries) — are planted only in a transaction that is ALWAYS rolled back, owner guards off and, where a
// CHECK or UNIQUE index would refuse the row, that one constraint dropped inside the same transaction; they are judged
// there by the production service on that transaction. Disagreements BETWEEN the A7.7 and A7.8 owners cannot be
// planted in a table (A7.8 derives its delta from the A7.7 timeline on the same snapshot): they are forged on the REAL
// owner results and judged by the production reducer. Synthetic users are provisioned per run through Better Auth's
// own server-side creation with a random password that is never printed.

const TAG = 'A7.9'
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

const runId = `A79-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
const a77Branch = 'feature/a7-7-revenue-evidence-timeline'
const UPSTREAM_BRANCHES = ['feature/a6-10-a6-integration-acceptance', 'feature/a7-1-revenue-source-evidence', 'feature/a7-2-evidence-classification', 'feature/a7-3-adjudication-evidence-readiness', 'feature/a7-4-revenue-evidence-case-assembly', 'feature/a7-5-case-closure-prerequisite-assessment', 'feature/a7-6-closure-basis-trace', a77Branch, a78Branch]
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/revenue-continuity'
const FE_DIR = 'frontend/src/modules/revenue-continuity'
const HARNESS_DIR = 'backend/src/integration/a7-revenue-continuity'
const A77_ROUTE = 'backend/src/modules/revenue-timeline/revenue-timeline.route.ts'
const A78_ROUTE = 'backend/src/modules/revenue-delta/revenue-delta.route.ts'
const A75_MIGRATION_NAME = '20261025090000_a7_5_case_prerequisite'
const A75_MIGRATION = `backend/prisma/migrations/${A75_MIGRATION_NAME}/migration.sql`
const UNIT_TESTS = [`${MODULE_DIR}/revenue-continuity.reducer.test.ts`, `${MODULE_DIR}/revenue-continuity.validation.test.ts`]
const PREREQ = 'evidence_prereq_results'
const HEADER = 'evidence_case_snapshots'
const ENTRY = 'evidence_case_entries'
const LINKS = 'claim_correction_links'
const FREEZES = 'claim_freezes'
const CONTRACT = 'A7-REVENUE-CONTINUITY-1'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const DTO_KEYS = ['contractVersion', 'claimId', 'evaluatedAt', 'continuityCode', 'submissionCount', 'comparisonCount', 'gaps', 'sourceTimelineContractVersion', 'sourceDeltaContractVersion']
const GAP_KEYS = ['ordinal', 'claimSubmissionId', 'caseId', 'assessmentId', 'gapCode', 'basisCode']
const CONTINUITY_CODES = ['NO_FROZEN_SUBMISSION', 'SINGLE_FREEZE_NO_COMPARISON', 'HISTORICAL_EVIDENCE_UNRECORDED', 'HISTORICAL_EVIDENCE_UNASSESSED', 'HISTORY_RECORDED_NO_EXTERNAL_FINANCIAL_PROOF']
// The owners A7.9 consumes or must leave untouched: the A5/A6 modules and A7.1–A7.8 (backend, pages and suites).
const OWNER_DIRS = [
  ...[
    'claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction',
    'pre-claim-validation', 'pre-claim-readiness', 'validation-run', 'revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'closure-basis-trace', 'revenue-timeline', 'revenue-delta',
    'encounter-billing-context',
  ].map((name) => `backend/src/modules/${name}`),
  'backend/src/shared/database',
  'backend/src/shared/authorization',
  'backend/prisma',
  ...['revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'closure-basis-trace', 'revenue-timeline', 'revenue-delta'].map((name) => `frontend/src/modules/${name}`),
  ...['a7-revenue-source-evidence', 'a7-evidence-classification', 'a7-evidence-gate', 'a7-evidence-case', 'a7-case-prerequisite', 'a7-closure-basis-trace', 'a7-revenue-timeline', 'a7-revenue-delta'].map((name) => `backend/src/integration/${name}`),
]
// Every table a continuity read could conceivably touch, read in this fixed key order (a UNION ALL may come back in
// Parallel Append order). A read must leave every one of them exactly as it found it.
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
// Every [key, number] pair anywhere in a value.
const numericFields = (value: unknown, found: [string, number][] = []): [string, number][] => {
  if (Array.isArray(value)) for (const item of value) numericFields(item, found)
  else if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'number') found.push([key, child])
      else numericFields(child, found)
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
// A result without its evaluation instant: the only field that may differ between two reads of the same history.
const stable = (body: any) => {
  if (!body || typeof body !== 'object') return body
  const { evaluatedAt: _evaluatedAt, ...rest } = body
  return rest
}
const codesOf = (body: any) => (body?.gaps ?? []).map((gap: any) => gap.gapCode)

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  const headAtStart = git('rev-parse HEAD')
  console.log(`[${TAG}] A7.9 revenue evidence continuity — run ${runId}`)
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
  section('Preflight: accepted A7.8, ancestry, no schema or migration, Prisma, replay, the A7.7/A7.8 read grant, one GET route, owners untouched')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a78Merge = mergeOf(a78Branch)
  const upstreamMerges = UPSTREAM_BRANCHES.map((name) => ({ name, sha: mergeOf(name) }))
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|settlement|receivable|claim-transport|claim-outbox|payer-response|integration\/a(8|9)|integration\/a7-(?!revenue-source-evidence|evidence-classification|evidence-gate|evidence-case|case-prerequisite|closure-basis-trace|revenue-timeline|revenue-delta|revenue-continuity)|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'A7.8 FINAL PASS merge is an ancestor',
    branch === a79Branch && a78Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a78Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A7.8 merged as ${a78Merge.slice(0, 7) || 'NOT FOUND'} and is an ancestor; contains latest main ${git('rev-parse --short origin/main')}, not stacked on an unmerged branch; no A7.10+/A8/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean HEAD and origin parity', dirty.length === 0 && tracking.includes(`origin/${a79Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  const constantOf = (path: string, name: string) => (committedText(path).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/revenue-evidence/revenue-evidence.types.ts', 'REVENUE_SOURCE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-classification/evidence-classification.types.ts', 'CLASSIFICATION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-gate/evidence-gate.types.ts', 'READINESS_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-case/evidence-case.types.ts', 'CASE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/case-prerequisite/case-prerequisite.types.ts', 'PREREQ_CONTRACT_VERSION'),
    constantOf('backend/src/modules/closure-basis-trace/closure-basis-trace.types.ts', 'TRACE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/revenue-timeline/revenue-timeline.types.ts', 'TIMELINE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/revenue-delta/revenue-delta.types.ts', 'DELTA_CONTRACT_VERSION'),
  ]
  const expectedContracts = ['A7-REVENUE-SOURCE-1', 'A7-EVIDENCE-CLASS-1', 'A7-ADJ-READINESS-1', 'A7-REVENUE-CASE-1', 'A7-CLOSURE-PREREQ-1', 'A7-CLOSURE-TRACE-1', 'A7-REVENUE-TIMELINE-1', 'A7-REVENUE-DELTA-1']
  const ownerExports =
    /export async function getRevenueTimelineOf\(claimId: string, tx: DbClient\)/.test(committedCode('backend/src/modules/revenue-timeline/revenue-timeline.service.ts')) &&
    /export async function getRevenueDeltaOf\(claimId: string, tx: DbClient\)/.test(committedCode('backend/src/modules/revenue-delta/revenue-delta.service.ts'))
  check(
    'T003',
    'A6.10 and A7.1–A7.8 ancestors',
    upstreamMerges.every((m) => m.sha.length === 40 && gitOk(`merge-base --is-ancestor ${m.sha} HEAD`)) && same(contracts, expectedContracts) && ownerExports,
    `A6.10 and A7.1–A7.8 merges (${upstreamMerges.map((m) => m.sha.slice(0, 7)).join(', ')}) are ancestors; contracts ${contracts.join(', ')}; the A7.7 and A7.8 owners export getRevenueTimelineOf(claimId, tx) and getRevenueDeltaOf(claimId, tx)`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const prismaStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  const baseMigrationDirs = migrationDirsAt('origin/main')
  // A7.9's own scope: on its own branch, its diff against main; on any later branch, exactly what its own merge
  // added. A later package's changes are that package's to prove, so the scope checks below (no migration, replay
  // base, permission catalogue, owner code) always judge THIS package.
  const ownMerge = branch === a79Branch ? '' : mergeOf(a79Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownPrismaStatus = gitArgs(['diff', '--name-status', ownRange, '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const ownHeadMigrationDirs = ownMerge ? migrationDirsAt(ownMerge) : headMigrationDirs
  const ownBaseMigrationDirs = ownMerge ? migrationDirsAt(`${ownMerge}^1`) : baseMigrationDirs
  check('T004', 'Zero schema or migration change', ownPrismaStatus.length === 0 && same(ownHeadMigrationDirs, ownBaseMigrationDirs), ownPrismaStatus.length === 0 ? `nothing under backend/prisma changed: schema and all ${headMigrationDirs.length} migrations identical to its base` : `prisma changes: ${ownPrismaStatus.join(' | ')}`)
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma validate, generate and status', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'the unchanged schema validates and generates; the working database is up to date (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check('T006', 'Scratch replay equals HEAD migrations', replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && ownHeadMigrationDirs.length === ownBaseMigrationDirs.length, `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD, none added in its own scope`)
  const routeCode = committedCode(`${MODULE_DIR}/revenue-continuity.route.ts`)
  const permissionsOf = (code: string) => [...code.matchAll(/requireMemberPermission\(organizationIdFromClaim, '([^']+)'\)/g)].map((m) => m[1])
  const a77Permissions = permissionsOf(committedCode(A77_ROUTE))
  const a78Permissions = permissionsOf(committedCode(A78_ROUTE))
  const authzDiff = gitArgs(['diff', ownRange, '--', ':/backend/src/shared/authorization', ':/backend/src/scripts/bootstrap-authz-dev.ts'])
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  check(
    'T007',
    'Only the accepted read grant reused',
    a78Permissions.length === 5 && same(a77Permissions, a78Permissions) && same(permissionsOf(routeCode), a78Permissions) && authzDiff === '' && !allCodes.some((code) => /continuit|delta|timeline/i.test(code)),
    `the route requires exactly the A7.7 and A7.8 reads (${a78Permissions.join(', ')}); the catalogue and its bootstrap are unchanged; no continuity permission exists`,
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

  const continuityPath = (claimId: string) => `/api/claims/${claimId}/revenue-evidence-continuity`
  const continuityOf = (claimId: string, who: Who = asAdmin) => get(continuityPath(claimId), who)
  const wiring = await continuityOf(MISSING)
  const absent = [
    await api('POST', continuityPath(MISSING), {}),
    await api('PUT', continuityPath(MISSING), {}),
    await api('PATCH', continuityPath(MISSING), {}),
    await api('DELETE', continuityPath(MISSING)),
    await api('GET', `${continuityPath(MISSING)}/latest`),
    await api('GET', `${continuityPath(MISSING)}/current`),
    await api('GET', '/api/revenue-evidence-continuities'),
    await api('GET', `/api/claim-submissions/${MISSING}/revenue-evidence-continuity`),
  ]
  const unauthenticated = await continuityOf(MISSING, anonymous)
  check(
    'T008',
    'One GET, all mutation routes absent',
    wiring.status === 404 && errorCode(wiring.body) === 'NOT_FOUND' && absent.every((res) => res.status === 404) && unauthenticated.status === 401 &&
      (routeCode.match(/continuityRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 1 && /continuityRouter\.get\(\s*'\/:claimId\/revenue-evidence-continuity'/.test(routeCode),
    `GET answers a missing Claim with a privacy-safe 404; POST/PUT/PATCH/DELETE, latest, current, a collection and a per-submission route are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.status}`,
  )
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file))
  const ownOwnerChanged = ownChangedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file))
  check(
    'T009',
    'Upstream owner contracts unchanged',
    ownOwnerChanged.length === 0 && ownPrismaStatus.length === 0 && same(contracts, expectedContracts),
    ownOwnerChanged.length === 0 ? 'no A5/A6/A7.1–A7.8 module, page or suite, shared database or authorization code, schema or migration changed; every upstream contract is unchanged' : `changed: ${ownOwnerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: Claims with 0, 1, 2 (three kinds), 4 and 4 linked freezes, evidence, cases and assessments of two organizations')
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
  const ref = (suffix: string) => `SYN-${runId.replace(/^A79-/, '')}-${suffix}`.toUpperCase()
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
  // §8 — Claim C: S1 → S2 → S3 → S4; S1 without a case; S2 with a case but no assessment; S3 with a complete case
  // assessed EXTERNAL_FINANCIAL_EVIDENCE_ABSENT; S4 with a case whose source chain is incomplete (one source registered
  // but never classified), assessed INCOMPLETE_SOURCE_CHAIN.
  const C = await home.series('worked', 4)
  const [S1, S2, S3, S4] = C.freezes
  const CL = await chainOf(C.claimId, C.freezes)
  await linkedSource(S2, 'S2-E1')
  const CASE2 = await caseOf(S2)
  await linkedSource(S3, 'S3-E1')
  await linkedSource(S3, 'S3-E2')
  const CASE3 = await caseOf(S3)
  const ASSESS3 = await assessmentOf(CASE3.caseId)
  await linkedSource(S4, 'S4-E1')
  await registerSource(S4, 'S4-E2')
  const CASE4 = await caseOf(S4)
  const ASSESS4 = await assessmentOf(CASE4.caseId)
  // A Claim never frozen; a one-freeze Claim; Bc: two linked freezes without cases; U: an assessed case, then an
  // unassessed one; R: every freeze recorded (an empty case assessed NO_SOURCE_BASIS, then a complete case assessed
  // EXTERNAL_FINANCIAL_EVIDENCE_ABSENT); Q: four linked freezes (q2 and q3 cased and assessed) for plants.
  const Z = await home.series('unfrozen', 0)
  const One = await home.series('single', 1)
  const Bc = await home.series('both absent', 2)
  const BL = await chainOf(Bc.claimId, Bc.freezes)
  const U = await home.series('unassessed', 2)
  await chainOf(U.claimId, U.freezes)
  await linkedSource(U.freezes[0], 'U1-E1')
  const UCASE1 = await caseOf(U.freezes[0])
  const UASSESS1 = await assessmentOf(UCASE1.caseId)
  await linkedSource(U.freezes[1], 'U2-E1')
  const UCASE2 = await caseOf(U.freezes[1])
  const R = await home.series('recorded', 2)
  await chainOf(R.claimId, R.freezes)
  const RCASE1 = await caseOf(R.freezes[0])
  const RASSESS1 = await assessmentOf(RCASE1.caseId)
  await linkedSource(R.freezes[1], 'R2-E1')
  const RCASE2 = await caseOf(R.freezes[1])
  const RASSESS2 = await assessmentOf(RCASE2.caseId)
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
  await chainOf(F.claimId, F.freezes, O.who)
  await linkedSource(F.freezes[1], 'FOREIGN', O.who)
  const FCASE = await caseOf(F.freezes[1], O.who)
  await assessmentOf(FCASE.caseId, O.who)
  console.log(`[${TAG}]      fixtures ready: two synthetic AE-DU/DHA worlds; Claims with 0, 1, 2 (three kinds) and 4 (two kinds) linked freezes and a foreign 2-freeze Claim; evidence, cases and assessments through the A7.1–A7.5 owner routes`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const runToken = runId.replace(/^A79-/, '')
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

  // A planted history: the relaxations and rows go in with row triggers off, then the production A7.9 service (and, for
  // comparison, the A7.8 owner) derives that Claim's result on THIS transaction, which is then ALWAYS rolled back.
  // Every plant is measured on its own: all tables and every CHECK and index of the five relaxable tables must read
  // back exactly.
  const plantedRuns = { total: 0, dirty: 0 }
  type Planted = { result?: Awaited<ReturnType<typeof getRevenueContinuityOf>>; delta?: Awaited<ReturnType<typeof getRevenueDeltaOf>>; message: string }
  const planted = async (claimId: string, relax: string[], mutate: (tx: DbClient) => Promise<void>): Promise<Planted> => {
    const countsBefore = await counts()
    const constraintsBefore = await constraintsHash()
    const out: { result?: Awaited<ReturnType<typeof getRevenueContinuityOf>>; delta?: Awaited<ReturnType<typeof getRevenueDeltaOf>> } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          for (const ddl of relax) await tx.$executeRawUnsafe(ddl)
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
          await mutate(tx)
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
          out.result = await getRevenueContinuityOf(claimId, tx)
          out.delta = await getRevenueDeltaOf(claimId, tx)
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
  const insertAssessment = (tx: DbClient, caseId: string, digest: string, o: { contract?: string; code?: string; basis?: string } = {}) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${PREREQ} (id, organization_id, evidence_case_id, contract_version, assessment_code, basis_code, case_manifest_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)`,
      org, caseId, o.contract ?? 'A7-CLOSURE-PREREQ-1', o.code ?? 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', o.basis ?? 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', digest, creatorId,
    )
  const refused = (p: Planted) => p.message.includes(NOT_REFUSED) && p.result?.ok === false && p.result.code === 'REVENUE_CONTINUITY_PROVENANCE_CONFLICT' && !('value' in (p.result as object))
  const detailOf = (p: Planted) => (p.result?.ok === false ? String(p.result.message).replace(/; nothing was (composed|compared|reconciled)$/, '') : p.result?.ok ? `derived ${p.result.value.gaps.length} gaps` : `not planted: ${p.message.slice(0, 140)}`)
  // Both owners exactly as they answer on ONE snapshot, for forging inter-owner disagreements.
  const ownersOf = async (claimId: string) => {
    const read = await withReadSnapshot(undefined, async (tx) => ({ timeline: await getRevenueTimelineOf(claimId, tx), delta: await getRevenueDeltaOf(claimId, tx) }))
    if (!read.timeline.ok || !read.delta.ok) throw new Error(`fixture: the owners of ${claimId} could not be read`)
    return { timeline: read.timeline.value as TimelineFacts, delta: read.delta.value as DeltaFacts }
  }
  const pureRefusals: string[] = []
  const reducerCode = (timeline: TimelineFacts, delta: DeltaFacts) => {
    const result = deriveRevenueContinuity(timeline, delta)
    if (!result.ok) {
      pureRefusals.push(result.detail)
      return result.detail
    }
    return `derived ${result.value.gaps.length}`
  }

  // ---------------------------------------------------------------- strict access (T011–T020)
  section('Strict access: contract and keys, malformed, SQL- and traversal-shaped ids, session, roles, tenants, missing Claim, no spoofing')
  const countsAtStart = await counts()
  const DC = await continuityOf(C.claimId)
  check(
    'T011',
    'Exact A7.9 literal and DTO keys',
    DC.status === 200 && DC.body?.contractVersion === CONTRACT && same(Object.keys(DC.body), DTO_KEYS) && DC.body.gaps.every((g: any) => same(Object.keys(g), GAP_KEYS)) && constantOf(`${MODULE_DIR}/revenue-continuity.types.ts`, 'CONTINUITY_CONTRACT_VERSION') === CONTRACT &&
      DC.body.sourceTimelineContractVersion === 'A7-REVENUE-TIMELINE-1' && DC.body.sourceDeltaContractVersion === 'A7-REVENUE-DELTA-1',
    `A7-REVENUE-CONTINUITY-1 in code and on the DTO; exactly the ${DTO_KEYS.length} top-level keys and the ${GAP_KEYS.length} gap keys; source contracts A7-REVENUE-TIMELINE-1 and A7-REVENUE-DELTA-1`,
  )
  const malformed = [await continuityOf('not-a-uuid'), await continuityOf(MISSING.slice(0, 35)), await continuityOf(MISSING.replace(/-/g, '')), await continuityOf(`${MISSING}0`)]
  check('T012', 'Malformed UUID safe 400', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `malformed ids: ${malformed.map((r) => r.status).join('/')}`)
  const sqlShaped = [await continuityOf(encodeURIComponent("1' OR '1'='1")), await continuityOf(encodeURIComponent(`${C.claimId}' OR '1'='1`)), await continuityOf(encodeURIComponent(`${C.claimId};DROP TABLE claims`))]
  check('T013', 'SQL-shaped path 400', sqlShaped.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `SQL-shaped path ids are refused before any lookup with a safe body: ${sqlShaped.map((r) => r.status).join('/')}`)
  const traversal = [await continuityOf(encodeURIComponent('../../claims')), await continuityOf(encodeURIComponent(`${C.claimId}/../${MISSING}`)), await continuityOf('..%2F..%2Fadmin')]
  check('T014', 'Traversal path 400', traversal.every((res) => res.status === 400 && !rawError(res.body)), `traversal-shaped path ids are refused: ${traversal.map((r) => r.status).join('/')}`)
  const anon = await continuityOf(C.claimId, anonymous)
  check('T015', 'No session 401', anon.status === 401 && unauthenticated.status === 401, 'no session: 401 for an existing and a missing Claim')
  check('T016', 'Admin authorized 200', DC.status === 200 && DC.body.claimId === C.claimId && DC.body.submissionCount === 4, 'an Admin of the organization reads the four-freeze Claim (200)')
  const viewerDC = await continuityOf(C.claimId, asViewer)
  check('T017', 'Viewer authorized 200 identical', viewerDC.status === 200 && same(stable(viewerDC.body), stable(DC.body)), 'a Viewer reads exactly the same stable result')
  const foreignOnHome = await continuityOf(C.claimId, O.who)
  const missingAsForeign = await continuityOf(MISSING, O.who)
  const homeOnForeign = await continuityOf(F.claimId)
  check('T018', 'Foreign tenant equals missing 404', foreignOnHome.status === 404 && same({ ...foreignOnHome.body?.error, requestId: null }, { ...missingAsForeign.body?.error, requestId: null }) && homeOnForeign.status === 404, "the other organization's Admin gets exactly the missing-id envelope for this tenant's Claim, and this tenant's Admin 404 for theirs")
  const missingClaim = await continuityOf(MISSING)
  check('T019', 'Missing Claim 404', missingClaim.status === 404 && errorCode(missingClaim.body) === 'NOT_FOUND' && !rawError(missingClaim.body), 'a non-existent Claim: 404 NOT_FOUND')
  const spoofs = [
    await api('GET', `${continuityPath(C.claimId)}?organizationId=${otherOrg}&actorUserId=${O.id}`),
    await api('GET', `${continuityPath(C.claimId)}?latestOnly=true&date=2026-01-01`),
    await api('GET', `${continuityPath(C.claimId)}?payer=X&override=1&sourceEvidenceIds=${MISSING}`),
    await getWithBody(continuityPath(C.claimId), JSON.stringify({ gaps: [], actorUserId: O.id }), admin.cookie),
  ]
  const spoofedForeign = await api('GET', `${continuityPath(C.claimId)}?organizationId=${org}`, undefined, (init = {}) => O.who({ ...init, headers: { 'X-Organization-Id': org } }))
  check(
    'T020',
    'Headers/query cannot spoof actor/tenant',
    spoofs.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR') && spoofedForeign.status === 404 && (await unchanged(countsAtStart)),
    'an organization, actor, latestOnly, date, payer, override or source list in the query, and any body, are refused (400); a foreign Admin claiming this tenant by header and query still gets 404; nothing was written',
  )

  // ---------------------------------------------------------------- empty and chain shape (T021–T030)
  section('Empty and chain shape: 0, 1, 2 and 4 freezes, root-to-tail gaps, contiguous ordinals, exact ids, the database evaluation instant')
  const DZ = await continuityOf(Z.claimId)
  check('T021', 'Zero freezes code', DZ.status === 200 && DZ.body.continuityCode === 'NO_FROZEN_SUBMISSION' && (await prisma.claimFreeze.count({ where: { claimId: Z.claimId } })) === 0, 'an unfrozen Claim reads NO_FROZEN_SUBMISSION')
  check('T022', 'Zero gap/comparison counts', DZ.body.submissionCount === 0 && DZ.body.comparisonCount === 0 && same(DZ.body.gaps, []), 'zero submissions, zero comparisons, no gap')
  const DOne = await continuityOf(One.claimId)
  check('T023', 'One freeze singleton code', DOne.status === 200 && DOne.body.continuityCode === 'SINGLE_FREEZE_NO_COMPARISON' && DOne.body.submissionCount === 1, 'a one-freeze Claim reads SINGLE_FREEZE_NO_COMPARISON')
  const deltaOne = await get(`/api/claims/${One.claimId}/revenue-evidence-delta`)
  check('T024', 'Singleton no comparison', DOne.body.comparisonCount === 0 && deltaOne.body?.comparisonCount === 0 && DOne.body.gaps.length === 1, 'zero comparisons (A7.8 agrees); its one freeze still shows its gap')
  const DBc = await continuityOf(Bc.claimId)
  const deltaBc = await get(`/api/claims/${Bc.claimId}/revenue-evidence-delta`)
  check('T025', 'Two freezes one comparison', DBc.status === 200 && DBc.body.submissionCount === 2 && DBc.body.comparisonCount === 1 && deltaBc.body?.comparisonCount === 1, 'two linked freezes: two submissions, exactly one comparison (A7.8 agrees)')
  const DQ = await continuityOf(Q.claimId)
  check('T026', 'Four freezes three comparisons', DQ.status === 200 && DQ.body.submissionCount === 4 && DQ.body.comparisonCount === 3 && DQ.body.gaps.length === 4, 'four freezes joined by three links: three comparisons and four gaps')
  const ownersQ = await ownersOf(Q.claimId)
  check(
    'T027',
    'Root-tail stable order',
    same(DQ.body.gaps.map((g: any) => g.claimSubmissionId), Q.freezes) && same(DQ.body.gaps.map((g: any) => g.claimSubmissionId), ownersQ.timeline.submissions.map((e) => e.claimSubmissionId)) && same(DC.body.gaps.map((g: any) => g.claimSubmissionId), C.freezes),
    'gaps follow q1, q2, q3, q4 (and S1…S4) — exactly the A7.7 timeline order; nothing is sorted by id or time',
  )
  check('T028', 'Contiguous ordinals', [DC.body, DBc.body, DQ.body, DOne.body].every((b: any) => same(b.gaps.map((g: any) => g.ordinal), b.gaps.map((_: unknown, i: number) => i + 1))), 'gap ordinals are exactly 1..N on every result')
  const dbFreezesC = (await prisma.claimFreeze.findMany({ where: { claimId: C.claimId }, select: { id: true } })).map((r) => r.id).sort()
  const dbCaseOwners = await prisma.evidenceCaseSnapshot.findMany({ where: { id: { in: [CASE2.caseId, CASE3.caseId, CASE4.caseId] } }, select: { id: true, claimSubmissionId: true } })
  const dbAssessments = await prisma.evidencePrereqResult.findMany({ where: { id: { in: [ASSESS3.assessmentId, ASSESS4.assessmentId] } }, select: { id: true, evidenceCaseId: true } })
  const [g1, g2, g3, g4] = DC.body.gaps
  check(
    'T029',
    'Every Claim/freeze ID exact',
    DC.body.claimId === C.claimId && same([...DC.body.gaps.map((g: any) => g.claimSubmissionId)].sort(), dbFreezesC) &&
      [g2, g3, g4].every((g: any) => dbCaseOwners.some((row) => row.id === g.caseId && row.claimSubmissionId === g.claimSubmissionId)) &&
      [g3, g4].every((g: any) => dbAssessments.some((row) => row.id === g.assessmentId && row.evidenceCaseId === g.caseId)),
    "the Claim, its four freezes, each case and each assessment id is exactly the stored row of that freeze",
  )
  const dbBefore = (await prisma.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`)[0].t
  const timed = await continuityOf(C.claimId)
  const dbAfter = (await prisma.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`)[0].t
  const evaluated = Date.parse(timed.body.evaluatedAt)
  check('T030', 'Database evaluatedAt and UTC', /Z$/.test(timed.body.evaluatedAt) && new Date(evaluated).toISOString() === timed.body.evaluatedAt && evaluated >= dbBefore.getTime() && evaluated <= dbAfter.getTime(), `evaluatedAt ${timed.body.evaluatedAt} is a canonical UTC instant taken by the database between ${dbBefore.toISOString()} and ${dbAfter.toISOString()}`)

  // ---------------------------------------------------------------- controlled gaps (T031–T040)
  section('Controlled gaps and their fixed priority: unrecorded, unassessed, incomplete, review and unsupported (planted, rolled back), external absence')
  check('T031', 'Unrecorded case gap', g1.gapCode === 'CASE_NOT_RECORDED' && g1.claimSubmissionId === S1 && g1.caseId === null && (await prisma.evidenceCaseSnapshot.count({ where: { claimSubmissionId: S1 } })) === 0, 'S1 has no stored A7.4 case: CASE_NOT_RECORDED')
  const DU = await continuityOf(U.claimId)
  const [u1, u2] = DU.body.gaps
  check(
    'T032',
    'Unassessed case gap',
    g2.gapCode === 'PREREQUISITE_NOT_RECORDED' && g2.caseId === CASE2.caseId && u2.gapCode === 'PREREQUISITE_NOT_RECORDED' && u2.caseId === UCASE2.caseId && DU.body.continuityCode === 'HISTORICAL_EVIDENCE_UNASSESSED' && (await prisma.evidencePrereqResult.count({ where: { evidenceCaseId: UCASE2.caseId } })) === 0,
    "S2's and U2's stored cases have no A7.5 assessment: PREREQUISITE_NOT_RECORDED; U (every freeze cased) reads HISTORICAL_EVIDENCE_UNASSESSED",
  )
  check('T033', 'Source chain incomplete gap', CASE4.assemblyCode === 'INVENTORY_INCOMPLETE' && ASSESS4.assessmentCode === 'INCOMPLETE_SOURCE_CHAIN' && g4.gapCode === 'SOURCE_CHAIN_INCOMPLETE' && g4.basisCode === 'SOURCE_LINKS_INCOMPLETE' && g4.assessmentId === ASSESS4.assessmentId, "S4's source was registered but never classified: its recorded INCOMPLETE_SOURCE_CHAIN reads SOURCE_CHAIN_INCOMPLETE (SOURCE_LINKS_INCOMPLETE)")
  const reviewPlant = await planted(U.claimId, [], (tx) => insertAssessment(tx, UCASE2.caseId, UCASE2.manifestSha256, { code: 'REVIEW_REQUIRED', basis: 'EVIDENCE_REVIEW_REQUIRED' }).then(() => undefined))
  const reviewValue = reviewPlant.result?.ok ? reviewPlant.result.value : null
  check(
    'T034',
    'Review required gap',
    reviewPlant.message.includes(NOT_REFUSED) && reviewValue?.gaps[1].gapCode === 'REVIEW_REQUIRED' && reviewValue.gaps[1].basisCode === 'EVIDENCE_REVIEW_REQUIRED' && reviewValue.continuityCode === 'HISTORY_RECORDED_NO_EXTERNAL_FINANCIAL_PROOF',
    'a REVIEW_REQUIRED assessment (unreachable through the synthetic-only A7.1 route, so planted and rolled back) stays visible as REVIEW_REQUIRED (EVIDENCE_REVIEW_REQUIRED) through the production service — never cleared or upgraded',
  )
  const unsupportedPlant = await planted(U.claimId, [], (tx) => insertAssessment(tx, UCASE2.caseId, UCASE2.manifestSha256, { code: 'UNSUPPORTED_SOURCE_BASIS', basis: 'UNSUPPORTED_EVIDENCE' }).then(() => undefined))
  const unsupportedValue = unsupportedPlant.result?.ok ? unsupportedPlant.result.value : null
  check('T035', 'Unsupported source gap', unsupportedPlant.message.includes(NOT_REFUSED) && unsupportedValue?.gaps[1].gapCode === 'UNSUPPORTED_SOURCE' && unsupportedValue.gaps[1].basisCode === 'UNSUPPORTED_EVIDENCE', 'an UNSUPPORTED_SOURCE_BASIS assessment (planted, rolled back) stays visible as UNSUPPORTED_SOURCE (UNSUPPORTED_EVIDENCE)')
  check('T036', 'External financial absence gap', g3.gapCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && g3.basisCode === 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' && g3.assessmentId === ASSESS3.assessmentId && u1.gapCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && u1.assessmentId === UASSESS1.assessmentId, "S3's (and U1's) recorded EXTERNAL_FINANCIAL_EVIDENCE_ABSENT is reported as that gap with its basis — the absence of external proof, never a verdict")
  check('T037', 'NO_FROZEN prioritized', DZ.body.continuityCode === 'NO_FROZEN_SUBMISSION' && DZ.body.gaps.length === 0 && CONTINUITY_CODES.indexOf('NO_FROZEN_SUBMISSION') === 0, 'with zero freezes nothing else is judged: NO_FROZEN_SUBMISSION comes first')
  check('T038', 'SINGLE_FREEZE prioritized', DOne.body.continuityCode === 'SINGLE_FREEZE_NO_COMPARISON' && DOne.body.gaps[0].gapCode === 'CASE_NOT_RECORDED', 'the one freeze has no case, yet the Claim reads SINGLE_FREEZE_NO_COMPARISON, not UNRECORDED (its gap is still listed)')
  check('T039', 'Unrecorded prioritized over unassessed', DC.body.continuityCode === 'HISTORICAL_EVIDENCE_UNRECORDED' && codesOf(DC.body).includes('CASE_NOT_RECORDED') && codesOf(DC.body).includes('PREREQUISITE_NOT_RECORDED'), 'Claim C has both an unrecorded case (S1) and an unassessed case (S2): it reads HISTORICAL_EVIDENCE_UNRECORDED')
  const DR = await continuityOf(R.claimId)
  check(
    'T040',
    'All recorded: no external-proof claim',
    DR.status === 200 && DR.body.continuityCode === 'HISTORY_RECORDED_NO_EXTERNAL_FINANCIAL_PROOF' && same(codesOf(DR.body), ['NO_SOURCE_BASIS', 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT']) && DR.body.gaps[0].basisCode === RASSESS1.basisCode && RASSESS1.assessmentCode === 'NO_SOURCE_BASIS' && DR.body.gaps[1].assessmentId === RASSESS2.assessmentId,
    'every freeze of R is cased and assessed: HISTORY_RECORDED_NO_EXTERNAL_FINANCIAL_PROOF, and each freeze still shows its gap (an empty case keeps NO_SOURCE_BASIS / NO_REGISTERED_SOURCES visible)',
  )

  // ---------------------------------------------------------------- evidence meaning (T041–T050)
  section('Evidence meaning: absence as null, basis copied, no balance, no payer send, no payment or improvement read into a delta, no reason, closure or verdict')
  check('T041', 'Case missing is null', g1.caseId === null && g1.assessmentId === null && g1.basisCode === null && DOne.body.gaps[0].caseId === null && !JSON.stringify(DC.body).includes('00000000-0000-0000-0000-000000000000'), 'a freeze without a case has a null case id, assessment id and basis — never "", 0 or a made-up UUID')
  check('T042', 'Assessment missing is null', g2.assessmentId === null && g2.basisCode === null && g2.caseId === CASE2.caseId && u2.assessmentId === null, 'a case without an assessment keeps its case id; the assessment id and basis are null')
  const assessedGaps = [g3, g4, u1, ...DR.body.gaps]
  const assessedRows = await prisma.evidencePrereqResult.findMany({ where: { id: { in: assessedGaps.map((g: any) => g.assessmentId) } } })
  check('T043', 'Basis code copied exactly', assessedGaps.every((g: any) => assessedRows.some((row) => row.id === g.assessmentId && row.basisCode === g.basisCode && row.evidenceCaseId === g.caseId)) && assessedRows.length === assessedGaps.length, `each of the ${assessedGaps.length} assessed gaps carries exactly its stored A7.5 basis code`)
  const deltaC = await get(`/api/claims/${C.claimId}/revenue-evidence-delta`)
  const numbers = numericFields(DC.body)
  check(
    'T044',
    'Source count not converted to balance',
    numbers.every(([k]) => ['ordinal', 'submissionCount', 'comparisonCount'].includes(k)) && deltaC.body.comparisons.some((c: any) => c.sourceCountAfter > 0) && ![...deepKeys(DC.body)].some((k) => /balance|amount|due|paid|count(Before|After)|sourceCount/i.test(k)),
    `the only numbers are ordinals and the two counts (${numbers.length}); A7.8's recorded source counts are not carried, summed or turned into a balance`,
  )
  const drBefore = stable(DR.body)
  await post(`/api/claim-submissions/${R.freezes[1]}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null })
  const drAfter = await continuityOf(R.claimId)
  check(
    'T045',
    'Internal release not payer send',
    (await get(`/api/claim-submissions/${R.freezes[1]}/lifecycle`)).body?.state === 'RELEASE_ELIGIBLE' && same(stable(drAfter.body), drBefore) && ![...deepKeys(drAfter.body)].some((k) => /disposition|lifecycle|release|state|status|sent|transmi/i.test(k)) && !JSON.stringify(drAfter.body).includes('RELEASE'),
    'after an internal AUTHORIZE_RELEASE (RELEASE_ELIGIBLE) the result is byte-identical and carries no disposition, release, send or status',
  )
  const twinDigest = createHash('sha256').update(`${runId}-twin`).digest('hex')
  const twinPlant = await planted(Bc.claimId, [], async (tx) => {
    await insertCase(tx, Bc.freezes[0], { digest: twinDigest })
    await insertCase(tx, Bc.freezes[1], { digest: twinDigest })
  })
  const twinValue = twinPlant.result?.ok ? twinPlant.result.value : null
  check(
    'T046',
    'Delta unchanged not payment unchanged',
    twinPlant.delta?.ok === true && twinPlant.delta.value.comparisons[0].evidenceDeltaCode === 'RECORDED_SUMMARY_UNCHANGED' && same(twinValue?.gaps.map((g) => g.gapCode), ['PREREQUISITE_NOT_RECORDED', 'PREREQUISITE_NOT_RECORDED']) && ![...deepKeys(twinValue)].some((k) => k !== 'sourceDeltaContractVersion' && /delta|unchanged|payment|paid/i.test(k)),
    'with twin case summaries (planted, rolled back) A7.8 reads RECORDED_SUMMARY_UNCHANGED, yet A7.9 still reports both unassessed cases and nothing about payment',
  )
  const productionCode = committedProductionCodeOf([MODULE_DIR]).code
  check(
    'T047',
    'Delta changed not financial improvement',
    deltaC.body.comparisons.some((c: any) => c.evidenceDeltaCode === 'RECORDED_SUMMARY_CHANGED') && g4.gapCode === 'SOURCE_CHAIN_INCOMPLETE' && !/'(NEW_CASE_RECORDED|CASE_NO_LONGER_RECORDED|RECORDED_SUMMARY_CHANGED|RECORDED_SUMMARY_UNCHANGED|BOTH_ABSENT)'/.test(productionCode) && ![...deepKeys(DC.body)].some((k) => k !== 'sourceDeltaContractVersion' && /improve|better|delta|change/i.test(k)),
    "A7.8 reads S3→S4 RECORDED_SUMMARY_CHANGED, yet S4's gap is its own recorded incomplete chain; A7.9 maps no delta code to any gap or improvement",
  )
  const linkRow = await prisma.claimCorrectionLink.findUniqueOrThrow({ where: { id: CL[0] } })
  check('T048', 'Correction reason never payer reason', ![...deepKeys(DC.body)].some((k) => /reason/i.test(k)) && !JSON.stringify(DC.body).includes(linkRow.reasonCode), `the link's recorded reason (${linkRow.reasonCode}) is not carried, renamed or reinterpreted; no reason field exists`)
  const allResults = [DC.body, DZ.body, DOne.body, DBc.body, DQ.body, DU.body, DR.body, reviewValue, unsupportedValue, twinValue]
  const allText = JSON.stringify(allResults)
  // Every controlled value a result carries (continuity, gap and basis codes).
  const resultCodes = allResults.flatMap((r: any) => (r ? [r.continuityCode, ...r.gaps.flatMap((g: any) => [g.gapCode, g.basisCode])] : [])).filter((v): v is string => typeof v === 'string')
  check('T049', 'No closure-ready outcome', resultCodes.length > 20 && !resultCodes.some((c) => /READY|CLOS|SETTLE|RESOLVED|(^|_)COMPLETE$/.test(c)) && !CONTINUITY_CODES.some((c) => /READY|CLOS|COMPLETE/.test(c)) && !/READY|CLOS/.test(committedText(`${MODULE_DIR}/revenue-continuity.types.ts`).replace(/\/\/.*$/gm, '')), 'no continuity or gap code says ready, closed, complete or settled — even when every freeze is recorded')
  const ledgerTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(receivable|ledger|balance|posting|journal|allocation|settle|payment|cash|receipt|copay|patient_share)'`).map((row) => row.t)
  check('T050', 'No implicit payer verdict', !/"(PAID|DENIED|APPROVED|ADJUDICATED|REJECTED|REMITTED|PARTIALLY_PAID)"/.test(allText) && ![...deepKeys(allResults)].some((k) => /payer|verdict|adjudicat|denial|remittance|status/i.test(k)) && ledgerTables.length === 0, 'no paid, denied, approved, adjudicated or remitted value and no payer or verdict field (the A7.5 basis EXTERNAL_REMITTANCE_NOT_ESTABLISHED names only an absence); no ledger table')

  // ---------------------------------------------------------------- owner reconciliation (T051–T060)
  section('Owner reconciliation: the REAL A7.7 and A7.8 results forged by one fact and judged by the production reducer; missing and foreign freezes planted and rolled back')
  const ownersC = await ownersOf(C.claimId)
  const TC = ownersC.timeline
  const DCo = ownersC.delta
  const [c1, c2, c3] = DCo.comparisons
  const baseline = reducerCode(TC, DCo)
  const t051 = reducerCode({ ...TC, contractVersion: 'A7-REVENUE-DELTA-1' }, DCo)
  check('T051', 'Mismatched A7.7 contract 409', baseline === 'derived 4' && /A7-REVENUE-TIMELINE-1/.test(t051), `the real timeline labelled with another contract is refused: ${t051}`)
  const t052 = reducerCode(TC, { ...DCo, contractVersion: 'A7-REVENUE-TIMELINE-1' })
  check('T052', 'Mismatched A7.8 contract 409', /A7-REVENUE-DELTA-1/.test(t052), `the real delta labelled with another contract is refused: ${t052}`)
  const foreignDelta = (await ownersOf(F.claimId)).delta
  const t053 = reducerCode(TC, foreignDelta)
  check('T053', 'Foreign Claim in delta 409', /same canonical claim/.test(t053), `C's real timeline with the other organization's real delta is refused: ${t053}`)
  const t054 = reducerCode(TC, { ...DCo, comparisonCount: 2, comparisons: [c1, c2] })
  check('T054', 'Missing delta pair 409', /exactly one comparison per adjacent pair/.test(t054), `a delta without its S3/S4 pair is refused: ${t054}`)
  const t055 = reducerCode(TC, { ...DCo, comparisons: [c1, c2, { ...c2, ordinal: 3 }] })
  check('T055', 'Duplicate delta pair 409', /consecutive timeline entries/.test(t055), `a delta repeating S2/S3 in place of S3/S4 is refused: ${t055}`)
  const t056 = reducerCode(TC, { ...DCo, comparisons: [c1, { ...c2, predecessorSubmissionId: c2.correctedSubmissionId, correctedSubmissionId: c2.predecessorSubmissionId }, c3] })
  check('T056', 'Reversed pair 409', /consecutive timeline entries/.test(t056), `S3/S2 in place of S2/S3 is refused: ${t056}`)
  const t057a = reducerCode(TC, { ...DCo, comparisons: [c1, { ...c2, ordinal: 3 }, c3] })
  const t057b = reducerCode({ ...TC, submissions: TC.submissions.map((e, i) => (i === 2 ? { ...e, ordinal: 4 } : e)) }, DCo)
  check('T057', 'Ordinal gap 409', /ordinals/.test(t057a) && /ordinals/.test(t057b), `an ordinal gap in the delta (${t057a}) or in the timeline (${t057b}) is refused`)
  const t058a = reducerCode(TC, { ...DCo, comparisons: [c1, { ...c2, correctionLinkId: QL[0] }, c3] })
  const [q1, q2, q3, q4] = Q.freezes
  const crossClaim = await planted(Q.claimId, [], (tx) => insertLink(tx, Q.claimId, q4, One.freezes[0]).then(() => undefined))
  check('T058', 'Wrong correction link 409', /another correction link/.test(t058a) && refused(crossClaim), `a pair naming another Claim's real link is refused (${t058a}); a stored link to another Claim's freeze (planted) is refused 409: ${detailOf(crossClaim)}`)
  const missingFreeze = await planted(Q.claimId, [], (tx) => insertLink(tx, Q.claimId, q4, MISSING).then(() => undefined))
  const t059 = reducerCode({ ...TC, submissions: TC.submissions.filter((_, i) => i !== 3), historyCount: 3 }, DCo)
  check('T059', 'Missing freeze in timeline 409', refused(missingFreeze) && /not this claim's/.test(detailOf(missingFreeze)) && /exactly one comparison per adjacent pair|baseline/.test(t059), `a link to a freeze that does not exist (planted) is refused 409 (${detailOf(missingFreeze)}); a timeline missing S4 against the real delta is refused: ${t059}`)
  check(
    'T060',
    'No partial DTO after refusal',
    refused(crossClaim) && refused(missingFreeze) && pureRefusals.length === 10 && [t051, t052, t053, t054, t055, t056, t057a, t057b, t058a, t059].every((d) => !d.startsWith('derived')),
    `the ${pureRefusals.length} forged owner pairs returned only a refusal and the planted ones only the controlled 409 code and a safe message — never gaps or counts`,
  )

  // ---------------------------------------------------------------- corrupt facts (T061–T070)
  section('Corrupt facts (planted on the four-freeze Claim, always rolled back): contracts, digests, duplicates, foreign cases, extra freezes, chains, versions, bases')
  const futureCase = await planted(Q.claimId, [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_contract_chk`], (tx) => insertCase(tx, q1, { contract: 'A7-REVENUE-CASE-2' }).then(() => undefined))
  check('T061', 'Bad case contract 409', refused(futureCase) && /unsupported contract/.test(detailOf(futureCase)), `an A7-REVENUE-CASE-2 case (CHECK dropped) is refused 409: ${detailOf(futureCase)}`)
  const futureAssessment = await planted(Q.claimId, [`ALTER TABLE ${PREREQ} DROP CONSTRAINT evidence_prereq_results_contract_chk`, 'DROP INDEX evidence_prereq_results_identity_key'], (tx) => insertAssessment(tx, Qcase3.caseId, Qcase3.manifestSha256, { contract: 'A7-CLOSURE-PREREQ-2' }).then(() => undefined))
  check('T062', 'Bad prerequisite contract 409', refused(futureAssessment) && /unsupported contract/.test(detailOf(futureAssessment)), `an A7-CLOSURE-PREREQ-2 assessment (CHECK dropped) is refused 409: ${detailOf(futureAssessment)}`)
  const mismatch = await planted(Q.claimId, ['DROP INDEX evidence_prereq_results_identity_key'], (tx) => insertAssessment(tx, Qcase3.caseId, 'f'.repeat(64)).then(() => undefined))
  check('T063', 'Case/assessment digest mismatch 409', refused(mismatch) && /digest|more than one assessment/.test(detailOf(mismatch)), `an assessment of q3's case carrying another digest is refused 409: ${detailOf(mismatch)}`)
  const duplicateCase = await planted(Q.claimId, ['DROP INDEX evidence_case_snapshots_identity_key'], (tx) => insertCase(tx, q2).then(() => undefined))
  check('T064', 'Duplicate case 409', refused(duplicateCase) && /more than one case/.test(detailOf(duplicateCase)), `a second v1 case for q2 (identity index dropped) is refused 409, never resolved to the newest: ${detailOf(duplicateCase)}`)
  const duplicateAssessment = await planted(Q.claimId, ['DROP INDEX evidence_prereq_results_identity_key'], (tx) => insertAssessment(tx, Qcase2.caseId, Qcase2.manifestSha256).then(() => undefined))
  check('T065', 'Duplicate prerequisite 409', refused(duplicateAssessment) && /more than one assessment/.test(detailOf(duplicateAssessment)), `a second v1 assessment of q2's case (identity index dropped) is refused 409: ${detailOf(duplicateAssessment)}`)
  const foreignCase = await planted(Q.claimId, [], (tx) => insertCase(tx, q1, { organization: otherOrg }).then(() => undefined))
  check('T066', 'Foreign case 409', refused(foreignCase) && /another organization/.test(detailOf(foreignCase)), `a case of the other organization on q1 is refused 409: ${detailOf(foreignCase)}`)
  const extra = await planted(Q.claimId, [], (tx) => deleteLink(tx, QL[2]).then(() => undefined))
  check('T067', 'Unlinked extra freeze 409', refused(extra) && /more than one root/.test(detailOf(extra)), `q4 left unlinked is refused 409: ${detailOf(extra)}`)
  const cycle = await planted(Q.claimId, [], (tx) => insertLink(tx, Q.claimId, q4, q1).then(() => undefined))
  const fork = await planted(Q.claimId, ['DROP INDEX claim_correction_links_prior_submission_id_key', 'DROP INDEX claim_correction_links_corrected_submission_id_key'], (tx) => insertLink(tx, Q.claimId, q1, q3).then(() => undefined))
  const broken = await planted(Q.claimId, [], (tx) => deleteLink(tx, QL[1]).then(() => undefined))
  check('T068', 'Corrupt chain 409', [cycle, fork, broken].every(refused) && /cycle/.test(detailOf(cycle)) && /fork|join/.test(detailOf(fork)) && /more than one chain/.test(detailOf(broken)), `a cycle (${detailOf(cycle)}), a fork (${detailOf(fork)}) and a broken chain (${detailOf(broken)}) are each refused 409`)
  const t069a = reducerCode({ ...ownersQ.timeline, contractVersion: 'A7-REVENUE-TIMELINE-2' }, ownersQ.delta)
  const t069b = reducerCode(ownersQ.timeline, { ...ownersQ.delta, contractVersion: 'A7-REVENUE-DELTA-2' })
  check('T069', 'Future owner version 409', /A7-REVENUE-TIMELINE-1/.test(t069a) && /A7-REVENUE-DELTA-1/.test(t069b), `a future A7.7 version (${t069a}) and a future A7.8 version (${t069b}) on the real results are refused, never guessed`)
  const unknownBasis = await planted(
    Q.claimId,
    [`ALTER TABLE ${PREREQ} DROP CONSTRAINT evidence_prereq_results_basis_chk`, `ALTER TABLE ${PREREQ} DROP CONSTRAINT evidence_prereq_results_pairing_chk`],
    (tx) => tx.$executeRawUnsafe(`UPDATE ${PREREQ} SET basis_code = 'PAYER_DENIED' WHERE evidence_case_id = $1::uuid`, Qcase2.caseId).then(() => undefined),
  )
  const allPlants = [crossClaim, missingFreeze, futureCase, futureAssessment, mismatch, duplicateCase, duplicateAssessment, foreignCase, extra, cycle, fork, broken, unknownBasis]
  const truthfulPlants = 3
  check(
    'T070',
    'Unknown controlled basis 409',
    refused(unknownBasis) && /basis|outcome/i.test(detailOf(unknownBasis)) && allPlants.every(refused) && plantedRuns.total === allPlants.length + truthfulPlants && plantedRuns.dirty === 0,
    `an assessment whose basis is the uncontrolled PAYER_DENIED (CHECKs dropped) is refused 409: ${detailOf(unknownBasis)}; all ${plantedRuns.total} plants left every row, CHECK and index byte-identical (${plantedRuns.dirty} did not)`,
  )

  // ---------------------------------------------------------------- snapshot and concurrency (T071–T080)
  section('One REPEATABLE READ, READ ONLY snapshot on the caller client, no Claim lock, writers of A6.9 and A7.1–A7.5 held uncommitted')
  const snapshotProof = await withReadSnapshot(undefined, async (tx) => {
    const isolation = (await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('transaction_isolation') AS v`)[0].v
    const first = await getRevenueContinuityOf(U.claimId, tx)
    const assessed = await assessClosurePrerequisites(UCASE2.caseId, {}, creatorId)
    const second = await getRevenueContinuityOf(U.claimId, tx)
    return { isolation, first, second, assessed: assessed.ok }
  })
  const uAfter = await continuityOf(U.claimId)
  check(
    'T071',
    'One repeatable-read snapshot',
    snapshotProof.isolation === 'repeatable read' && snapshotProof.assessed && snapshotProof.first.ok && snapshotProof.second.ok && same(stable(snapshotProof.first.value), stable(snapshotProof.second.value)) && snapshotProof.second.value.continuityCode === 'HISTORICAL_EVIDENCE_UNASSESSED' &&
      uAfter.body.continuityCode === 'HISTORY_RECORDED_NO_EXTERNAL_FINANCIAL_PROOF',
    "the read runs at REPEATABLE READ; an assessment committed on U2's case meanwhile is invisible to the held snapshot (still UNASSESSED); a new snapshot sees it (now every freeze recorded)",
  )
  const readOnly = await withReadSnapshot(undefined, async (tx) => (await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('transaction_read_only') AS v`)[0].v)
  const writeRefused = await attemptAdversarial(() => withReadSnapshot(undefined, async (tx) => tx.$executeRawUnsafe(`UPDATE ${LINKS} SET reason_code = reason_code WHERE id = $1::uuid`, CL[0])))
  check('T072', 'Database READ ONLY enforced', readOnly === 'on' && /read-only transaction/.test(writeRefused), 'transaction_read_only is on, and a write attempted inside the snapshot is refused by PostgreSQL')
  const serviceCode = committedCode(`${MODULE_DIR}/revenue-continuity.service.ts`)
  const ofBody = serviceCode.slice(serviceCode.indexOf('export async function getRevenueContinuityOf'), serviceCode.indexOf('export async function getRevenueContinuity('))
  check(
    'T073',
    'One caller DbClient for owners',
    /getRevenueTimelineOf\(claimId, tx\)/.test(ofBody) && /getRevenueDeltaOf\(claimId, tx\)/.test(ofBody) && !/prisma\.|withReadSnapshot|\$queryRaw/.test(ofBody) && /return withReadSnapshot\(undefined, \(tx\) => getRevenueContinuityOf\(claimId, tx\)\)/.test(serviceCode) && /evaluatedAt !== timeline\.value\.evaluatedAt/.test(ofBody),
    'both owner reads run on the one caller client of the one snapshot (their shared evaluation instant is verified); no table is queried directly',
  )
  const holdLock = holdAt('casePrerequisite.claim_locked')
  const lockHolder = assessClosurePrerequisites(CASE3.caseId, {}, creatorId)
  await Promise.race([holdLock.arrived, lockHolder])
  const duringLockPromise = continuityOf(C.claimId)
  const lockFree = await settledWithin(duringLockPromise, 3000)
  const duringLock = await duringLockPromise
  holdLock.release()
  const lockReplay = await lockHolder
  clearConcurrencyProbes()
  check('T074', 'No Claim write lock', lockFree && duringLock.status === 200 && lockReplay.ok && lockReplay.value.replayed && !/lockRowForUpdate|FOR UPDATE|FOR SHARE|NOWAIT|row-lock/.test(productionCode), "while an A7.5 request holds the Claim's row lock, the read answers at once; the A7.9 code requests no row lock")
  const raceRead = async (claimId: string, probe: string, writer: () => Promise<{ ok: boolean }>) => {
    const before = await continuityOf(claimId)
    const hold = holdAt(probe)
    const w = writer()
    await Promise.race([hold.arrived, w])
    const during = continuityOf(claimId)
    const prompt = await settledWithin(during, 3000)
    const duringBody = (await during).body
    hold.release()
    const written = await w
    clearConcurrencyProbes()
    const after = await continuityOf(claimId)
    return { prompt, ok: written.ok, before: before.body, during: duringBody, after: after.body }
  }
  const r75 = await raceRead(C.claimId, 'revenueEvidence.inserted', () => registerRevenueSourceEvidence(S3, { sourceKind: SYNTHETIC, sourceReference: ref('A71-RACE') }, creatorId))
  check('T075', 'Held A7.1 write no mixed facts', r75.prompt && r75.ok && same(stable(r75.during), stable(r75.before)) && same(stable(r75.after), stable(r75.before)), 'with an A7.1 registration on S3 uncommitted, the read answers at once with committed facts only; after it commits, every gap is unchanged')
  const s76 = await registerSource(S3, 'A72-RACE')
  const r76 = await raceRead(C.claimId, 'evidenceClassification.inserted', () => classifySourceEvidence(s76, {}, creatorId))
  check('T076', 'Held A7.2 write no mixed facts', r76.prompt && r76.ok && same(stable(r76.during), stable(r76.before)) && same(stable(r76.after), stable(r76.before)), 'with an A7.2 classification on S3 uncommitted, the read answers at once and stays identical')
  const c77 = (await post(`/api/revenue-source-evidence/${await registerSource(S3, 'A73-RACE')}/classifications`, {})).body.classificationId as string
  const r77 = await raceRead(C.claimId, 'evidenceGate.inserted', () => recordAdjudicationReadiness(c77, {}, creatorId))
  check('T077', 'Held A7.3 write no mixed facts', r77.prompt && r77.ok && same(stable(r77.during), stable(r77.before)) && same(stable(r77.after), stable(r77.before)), 'with an A7.3 readiness on S3 uncommitted, the read answers at once and stays identical')
  await linkedSource(Bc.freezes[0], 'B1-E1')
  const r78 = await raceRead(Bc.claimId, 'evidenceCase.entries_inserted', () => assembleRevenueEvidenceCase(Bc.freezes[0], {}, creatorId))
  check(
    'T078',
    'Held A7.4 write no mixed facts',
    r78.prompt && r78.ok && r78.during.gaps[0].gapCode === 'CASE_NOT_RECORDED' && r78.after.gaps[0].gapCode === 'PREREQUISITE_NOT_RECORDED',
    'while the B1 case header and entries were written but uncommitted the read still showed CASE_NOT_RECORDED; after commit, PREREQUISITE_NOT_RECORDED — never a half-written case',
  )
  const b1Case = r78.after.gaps[0].caseId as string
  const r79 = await raceRead(Bc.claimId, 'casePrerequisite.inserted', () => assessClosurePrerequisites(b1Case, {}, creatorId))
  check('T079', 'Held A7.5 write no mixed facts', r79.prompt && r79.ok && r79.during.gaps[0].gapCode === 'PREREQUISITE_NOT_RECORDED' && r79.after.gaps[0].gapCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'while the B1 assessment was uncommitted the read showed none; after commit, exactly the recorded outcome')
  const beforeGrow = await continuityOf(C.claimId)
  const S5 = await C.extend()
  const unlinked = await continuityOf(C.claimId)
  const holdLink = holdAt('claimCorrection.inserted')
  const linking = recordCorrectionLink(C.claimId, { priorSubmissionId: S4, correctedSubmissionId: S5, reasonCode: 'CORRECTED_CODING' }, creatorId)
  await Promise.race([holdLink.arrived, linking])
  const duringLinkPromise = continuityOf(C.claimId)
  const linkPrompt = await settledWithin(duringLinkPromise, 3000)
  const duringLink = await duringLinkPromise
  holdLink.release()
  const linked = await linking
  clearConcurrencyProbes()
  const afterGrow = await continuityOf(C.claimId)
  check(
    'T080',
    'Held chain change no mixed facts',
    unlinked.status === 409 && linkPrompt && duringLink.status === 409 && errorCode(duringLink.body) === 'REVENUE_CONTINUITY_PROVENANCE_CONFLICT' && linked.ok && afterGrow.status === 200 && afterGrow.body.submissionCount === 5 && afterGrow.body.comparisonCount === 4,
    'with S5 frozen but its S4→S5 link uncommitted, the read answered at once from the committed history (an unlinked freeze: 409, never a half-linked pair); after the link commits, five freezes and four comparisons',
  )

  // ---------------------------------------------------------------- determinism and history (T081–T090)
  section('Stable bytes, other users, evaluatedAt only, time zone and locale, one hundred reductions, history after sources, assessments, growth and a restart')
  const twice = [await continuityOf(C.claimId), await continuityOf(C.claimId)]
  check('T081', 'Repeated GET stable fields identical', same(stable(twice[0].body), stable(twice[1].body)) && same(stable(twice[0].body), stable(afterGrow.body)), 'two consecutive reads are byte-identical apart from evaluatedAt')
  const others = [await continuityOf(C.claimId, asViewer), await continuityOf(C.claimId, B.who)]
  check('T082', 'Other authorized user same facts', others.every((r) => r.status === 200 && same(stable(r.body), stable(twice[0].body))), 'the Viewer and a second Admin see exactly the same stable facts')
  check('T083', 'Only evaluatedAt differs', Object.keys(twice[0].body).filter((k) => JSON.stringify(twice[0].body[k]) !== JSON.stringify(twice[1].body[k])).every((k) => k === 'evaluatedAt'), 'between reads no field but evaluatedAt changes')
  const probe = spawnSync(
    process.execPath,
    ['--env-file=.env', '--input-type=module', '-e', `import { prisma } from './src/shared/database/prisma.ts'; import { getRevenueContinuity } from './src/modules/revenue-continuity/revenue-continuity.service.ts'; const r = await getRevenueContinuity('${C.claimId}'); const { evaluatedAt, ...rest } = r.ok ? r.value : {}; console.log(JSON.stringify([rest, Intl.DateTimeFormat().resolvedOptions().timeZone, Intl.DateTimeFormat().resolvedOptions().locale])); await prisma.$disconnect()`],
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
    return getRevenueContinuityOf(C.claimId, tx)
  })
  check('T084', 'Timezone invariance', probed !== null && probed[1] === 'Pacific/Kiritimati' && same(probed[0], stable(twice[0].body)) && zoned.ok && same(stable(zoned.value), stable(twice[0].body)), 'a separate process in Pacific/Kiritimati and a database session in that zone derive the identical result')
  const lowerings = (productionCode.match(/\.toLowerCase\(\)/g) ?? []).length
  const idLowerings = (productionCode.match(/claimId\)?\.toLowerCase\(\)/g) ?? []).length
  check('T085', 'Locale invariance', probed !== null && same(probed[0], stable(twice[0].body)) && !/toLocale|Intl\.|localeCompare|toUpperCase|\.sort\(/.test(productionCode) && lowerings === idLowerings, `with a ${probed?.[2] ?? '?'} process locale the order and codes are the same; A7.9 never sorts, compares by locale or changes case except the path id (${idLowerings})`)
  const ownersNow = await ownersOf(C.claimId)
  const hundred = new Set(Array.from({ length: 100 }, () => JSON.stringify(deriveRevenueContinuity(ownersNow.timeline, ownersNow.delta))))
  check('T086', '100 pure reductions identical', hundred.size === 1 && same(JSON.parse([...hundred][0]).value.gaps, twice[0].body.gaps), 'one hundred reductions of the same owner results are byte-identical and equal the HTTP gaps')
  await linkedSource(S3, 'S3-LATER')
  const afterSources = await continuityOf(C.claimId)
  check('T087', 'Later new sources not retroactive', same(stable(afterSources.body), stable(twice[0].body)), "a source registered, classified and gated on S3 later leaves every gap byte-identical (S3's case is history)")
  const assess2 = await assessmentOf(CASE2.caseId)
  const afterAssessment = await continuityOf(C.claimId)
  const changedIndexes = afterAssessment.body.gaps.map((g: any, i: number) => (same(g, twice[0].body.gaps[i]) ? -1 : i)).filter((i: number) => i >= 0)
  check(
    'T088',
    'Later assessment not retroactive',
    same(changedIndexes, [1]) && afterAssessment.body.gaps[1].caseId === CASE2.caseId && afterAssessment.body.gaps[1].assessmentId === assess2.assessmentId && afterAssessment.body.gaps[1].gapCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && afterAssessment.body.continuityCode === twice[0].body.continuityCode,
    "after S2's case is assessed only S2's gap changes (now its recorded outcome); S1, S3, S4 and S5 are byte-identical and the Claim still reads UNRECORDED",
  )
  check('T089', 'Old gap history preserved after chain grows', beforeGrow.status === 200 && same(afterGrow.body.gaps.slice(0, 4), beforeGrow.body.gaps) && afterGrow.body.gaps[4].claimSubmissionId === S5 && afterGrow.body.gaps[4].gapCode === 'CASE_NOT_RECORDED', 'after S5 is frozen and linked, the four earlier gaps are byte-identical and S5 is appended as CASE_NOT_RECORDED')
  const beforeRestart = stable((await continuityOf(C.claimId)).body)
  const restartedOnce = spawnSync('docker', ['restart', dbContainer], { encoding: 'utf8' }).status === 0
  await waitFor(databaseUp, 90_000)
  await apiReady('reading after the database restart')
  const afterRestart = stable((await continuityOf(C.claimId)).body)
  check('T090', 'DB restart yields same stable DTO', restartedOnce && same(afterRestart, beforeRestart), 'after the database container restarts, the result reads back byte-identically (all but evaluatedAt)')

  // ---------------------------------------------------------------- privacy and no writes (T091–T100)
  section('Privacy: no PHI, clinical, money, payer, payload, source or transport detail; no audit on success or refusal; no browser persistence or logging')
  const results = [afterAssessment.body, DZ.body, DOne.body, DBc.body, DQ.body, DU.body, DR.body, uAfter.body]
  const exposed = JSON.stringify(results)
  const exposedKeys = [...deepKeys(JSON.parse(exposed))]
  check('T091', 'No PHI DTO', !exposed.includes(`${runId}-home-P`) && !exposed.includes('1990-01-01') && !exposedKeys.some((k) => /patient|member|name|birth|email|phone|address|gender|user|actor|recordedBy/i.test(k)), 'no patient, member, user or actor value or key')
  check('T092', 'No clinical values DTO', !exposedKeys.some((k) => /diagnos|procedure|activity|encounter|clinician|facility|^(claim)?lines?(Id)?$/i.test(k)) && !exposed.includes(key('home-DXA')) && !exposed.includes(key('home-PA')), 'no diagnosis, procedure, activity, encounter, clinician, facility or line key or value')
  check('T093', 'No money/currency/balance', !/125\.25|12\.125|200\.01|AED/.test(exposed) && !exposedKeys.some((k) => /amount|balance|currency|price|fee|total|money/i.test(k)), 'no amount, currency, balance, price or total')
  check('T094', 'No payer/remittance verdict', !exposedKeys.some((k) => /payer|payment|denial|adjudicat|remittance|status|verdict|settle/i.test(k)) && !/"(PAID|DENIED|SETTLED|ADJUDICATED|CLOSED)"/.test(exposed), 'no payer, payment, denial, adjudication, remittance or status key, and no paid/denied/settled value')
  check('T095', 'No payload or manifest bytes', !exposedKeys.some((k) => /bytes|payload|seal|canonical|manifest|raw|sha256|digest/i.test(k)), 'no frozen payload, manifest bytes, seal or digest')
  const fingerprints = (await prisma.sourceEvidenceClassification.findMany({ where: { sourceEvidence: { claimSubmissionId: S3 } }, select: { sourceFingerprintSha256: true } })).map((r) => r.sourceFingerprintSha256)
  check('T096', 'No per-source payload or secret', !exposedKeys.some((k) => /source(Reference|Evidence|Digest|Count)|fingerprint|secret|token|password|cookie/i.test(k)) && !exposed.includes(ref('S3-E1')) && fingerprints.length > 0 && fingerprints.every((f) => !exposed.includes(f)), 'no source reference, source id, source count, source digest or fingerprint, secret, token or cookie')
  check('T097', 'No external transport reference', !exposedKeys.some((k) => /transmission|outbox|dhpo|eclaim|external(Id|Reference)|batch|message|acknowledg/i.test(k)), 'no transmission, outbox, batch, message, acknowledgement or external reference field')
  const auditsBefore = await prisma.auditEvent.count()
  for (const who of [asAdmin, asViewer, B.who]) await continuityOf(C.claimId, who)
  const auditsAfterSuccess = await prisma.auditEvent.count()
  check('T098', 'No audit on successful GET', auditsAfterSuccess === auditsBefore, 'successful reads by three users wrote no audit')
  for (const r of [await continuityOf(MISSING), await continuityOf('not-a-uuid'), await continuityOf(C.claimId, anonymous), await continuityOf(C.claimId, O.who), await api('GET', `${continuityPath(C.claimId)}?latestOnly=1`)]) void r
  check('T099', 'No audit on refused GET', (await prisma.auditEvent.count()) === auditsAfterSuccess, 'missing, malformed, anonymous, foreign and selector reads wrote no audit')
  const frontend = committedCode(`${FE_DIR}/RevenueContinuityCheck.tsx`)
  const registry = committedCode('frontend/src/developer/checkRegistry.tsx')
  check('T100', 'No browser persistence or logging', frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|setInterval|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend) && /key: 'revenue-continuity'/.test(registry) && !/fetch\([^)]*,\s*\{/.test(frontend) && !/console\.|logger\.|process\.env/.test(productionCode), 'the registered check page makes one plain GET with no options, polls nothing and keeps nothing in browser storage; neither it nor the backend logs')

  // ---------------------------------------------------------------- immutability and scope (T101–T110)
  section('No A6 or A7.1–A7.5 row changed by reading, A7.6/A7.7/A7.8 reads unchanged, no A8/A9/ledger/payment/closure functionality')
  const claims = [C, Bc, U, R, Q, One, Z, F]
  const traceBefore = await get(`/api/closure-prerequisite-assessments/${ASSESS3.assessmentId}/basis-trace`)
  const timelineBefore = await get(`/api/claims/${C.claimId}/revenue-evidence-timeline`)
  const deltaBefore = await get(`/api/claims/${C.claimId}/revenue-evidence-delta`)
  const before101 = {
    freezes: await Promise.all(claims.map((c) => freezeHash(c.claimId))), lifecycles: await Promise.all([C, R].map((c) => lifecycleHash(c.claimId))), corrections: await Promise.all(claims.map((c) => correctionHash(c.claimId))),
    sources: await sourceHash(), classifications: await classificationHash(), readiness: await readinessHash(), cases: await allCasesHash(), assessments: await allAssessmentsHash(),
  }
  for (const c of claims.slice(0, 7)) await continuityOf(c.claimId)
  await continuityOf(F.claimId, O.who)
  check('T101', 'A6.7 frozen bytes unchanged', same(await Promise.all(claims.map((c) => freezeHash(c.claimId))), before101.freezes), 'every byte of every freeze and sealed manifest of eight Claims is identical after reading their continuity')
  check('T102', 'A6.8 lifecycle unchanged', same(await Promise.all([C, R].map((c) => lifecycleHash(c.claimId))), before101.lifecycles), 'every lifecycle event is identical')
  check('T103', 'A6.9 correction unchanged', same(await Promise.all(claims.map((c) => correctionHash(c.claimId))), before101.corrections), 'every correction link of eight Claims is identical')
  check('T104', 'A7.1 records unchanged', (await sourceHash()) === before101.sources, "every byte of this run's A7.1 sources is identical")
  check('T105', 'A7.2 classifications unchanged', (await classificationHash()) === before101.classifications, "every byte of this run's A7.2 classifications is identical")
  check('T106', 'A7.3 readiness unchanged', (await readinessHash()) === before101.readiness, "every byte of this run's A7.3 readiness results is identical")
  check('T107', 'A7.4 cases unchanged', (await allCasesHash()) === before101.cases, 'every byte of every A7.4 case header and entry is identical')
  check('T108', 'A7.5 assessments unchanged', (await allAssessmentsHash()) === before101.assessments, 'every byte of every A7.5 assessment is identical')
  const traceAfter = await get(`/api/closure-prerequisite-assessments/${ASSESS3.assessmentId}/basis-trace`)
  const timelineAfter = await get(`/api/claims/${C.claimId}/revenue-evidence-timeline`)
  const deltaAfter = await get(`/api/claims/${C.claimId}/revenue-evidence-delta`)
  check(
    'T109',
    'A7.6/A7.7/A7.8 read behavior unchanged',
    [traceBefore, traceAfter, timelineBefore, timelineAfter, deltaBefore, deltaAfter].every((r) => r.status === 200) && same(stable(traceAfter.body), stable(traceBefore.body)) && same(stable(timelineAfter.body), stable(timelineBefore.body)) && same(stable(deltaAfter.body), stable(deltaBefore.body)) &&
      same(stable(timelineAfter.body).submissions.map((e: any) => e.claimSubmissionId), afterAssessment.body.gaps.map((g: any) => g.claimSubmissionId)),
    "S3's A7.6 trace, C's A7.7 timeline and C's A7.8 delta read back identically around the continuity reads, and the timeline lists exactly the freezes A7.9 reports",
  )
  const laterRoutes = [await post(`/api/claims/${C.claimId}/closures`, {}), await post(`/api/claims/${C.claimId}/payments`, {}), await post(`/api/claims/${C.claimId}/remittances`, {}), await post(`/api/claims/${C.claimId}/exceptions`, {}), await post(continuityPath(C.claimId), {})]
  // Later phases' tables: those created by migrations committed after this package's own merge (none on its own
  // branch, so this boundary is unchanged there). Every table that existed when the package merged is judged as before.
  const laterPhaseTables = new Set(ownMerge ? migrationDirsAt('HEAD').filter((dir) => !migrationDirsAt(ownMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])) : [])
  const laterTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(adjudicat|denial|allowed|remittance|settle|import|inbound|outbox|queue|transmission|acknowledg|closure|reconcil|exception|continuit|delta|receivable|ledger|balance|payment)'`).map((row) => row.t).filter((t) => !laterPhaseTables.has(t))
  const moneyIdentifier = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|toFixed\(|[Ss]ettle|[Aa]llocat|[Aa]djust|[Rr]eceivable|[Bb]alance|[Ll]edger|[Pp]ayment|[Rr]emittance/
  check(
    'T110',
    'No A8/A9/financial closure',
    laterRoutes.every((r) => r.status === 404) && laterTables.length === 0 && !moneyIdentifier.test(productionCode) && !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|enqueue|setInterval|worker_threads|cron/i.test(productionCode) && committedProductionCodeOf([MODULE_DIR]).files.length === 5,
    'no closure, payment, remittance or exception route; no such table (nor a continuity table); the five A7.9 backend files hold no money, network, queue, job or worker code',
  )

  const goldenBefore = stable((await continuityOf(C.claimId)).body)

  // ---------------------------------------------------------------- nested regressions (T111–T120)
  section('Regressions — A7.8 invoked, nesting A7.7 -> A7.6 -> A7.5 -> A7.4 -> A7.3 -> A7.2 -> A7.1 -> A6.10 -> … -> A6.1 -> A5.10 -> A1')
  await apiReady('the A7.8 and backward regression chain')
  // Rows written from here on belong to the nested suites' own fixtures (each proves its own); T128 judges this run's.
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const chain = run('npm run test:a7:revenue-delta')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.8')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.8] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.8 asserts facts about its own branch (name, tracking, pushed HEAD, allowed paths) and re-proves A7.7's
  // branch-only causes against its own branch. On A7.9 those statements are obsolete by design; every other A7.8 check
  // is substantive. T120 below proves each cause independently.
  const a78NonApplicable: Record<string, string> = {
    T001: "A7.8 'Correct accepted A7.7 merge ancestry' requires the A7.8 feature branch (and reads any other A7 suite as later code); A7.9 is branched from the main that contains the A7.8 merge",
    T002: "A7.8 'Clean branch, origin parity at HEAD' requires tracking origin/feature/a7-8-…, deleted when it merged; the clean tree and exact parity of THIS branch are proved by T002 here",
    T010: "A7.8 'Diff allowlist, no later domain code' lists the paths A7.8 was allowed to change; A7.9 legitimately changes its own (T010 here)",
    T120: "A7.8 'Historical N/A independently justified' proves A7.7's branch-only causes against the A7.8 branch (its name, tracking, diff and pushed HEAD); on A7.9 those proofs are re-done here (T120)",
    T130: "A7.8 'Exact HEAD, scope, parity, two full runs' compares HEAD with origin/feature/a7-8-…, deleted when it merged, and A7.8's own allowlist; THIS branch's are proved by T002, T010 and T130 here",
  }
  const undocumented = failing.filter((id) => !(id in a78NonApplicable))
  const summary = chain.output.match(/\[A7\.8\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.8\] RUN ABORTED|\[A7\.8\] uncaught error|\[A7\.8\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a78Substantive = rows.filter((row) => !(row.id in a78NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a78Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T111',
    'A7.8 substantive regression',
    ran && reconciled && undocumented.length === 0 && a78Substantive.length === 0 && a78Passing >= 125 && ['T004', 'T007', 'T009', 'T034', 'T051', 'T070', 'T084', 'T110', 'T123', 'T127', 'T128', 'T129'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A7.8 suite did not complete'
      : !reconciled
        ? `A7.8 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.8 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.8\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.8] automated summary: ', 'A7.8 ')}; all ${a78Passing} substantive checks PASS and every failure is documented`,
  )
  for (const id of Object.keys(a78NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A7.8 ${titleOf(row.line)}`, a78NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T112', 'A7.7 substantive regression', verdictOf('T111') === 'PASS', `A7.8 T111 (A7.7 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A7.6 substantive regression', verdictOf('T112') === 'PASS', `A7.8 T112 (A7.6) ${verdictOf('T112')}`)
  check('T114', 'A7.5 substantive regression', verdictOf('T113') === 'PASS', `A7.8 T113 (A7.5) ${verdictOf('T113')}`)
  check('T115', 'A7.4 substantive regression', verdictOf('T114') === 'PASS', `A7.8 T114 (A7.4) ${verdictOf('T114')}`)
  check('T116', 'A7.3 substantive regression', verdictOf('T115') === 'PASS', `A7.8 T115 (A7.3) ${verdictOf('T115')}`)
  check('T117', 'A7.2 substantive regression', verdictOf('T116') === 'PASS', `A7.8 T116 (A7.2) ${verdictOf('T116')}`)
  check('T118', 'A7.1 substantive regression', verdictOf('T117') === 'PASS', `A7.8 T117 (A7.1) ${verdictOf('T117')}`)
  check('T119', 'A6.10→A1 substantive chain', verdictOf('T118') === 'PASS' && verdictOf('T119') === 'PASS', `A7.8 T118 (A6.10 and A6.1–A6.9) ${verdictOf('T118')} and T119 (A5 and A1–A4) ${verdictOf('T119')}`)
  // Each documented A7.8 failure must fail for its branch-only reason, proved independently on this branch.
  const allowed = ['backend/package.json', 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'frontend/src/developer/checkRegistry.tsx']
  const ownDirs = [MODULE_DIR, FE_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const a78Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA77 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const originA77 = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a77Branch}`])
  const originA78 = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a78Branch}`])
  const originA79 = gitArgs(['rev-parse', `origin/${a79Branch}`])
  const causes: Record<string, boolean> = {
    T001: branch === a79Branch && a78Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a78Merge} HEAD`),
    T002: dirty.length === 0 && tracking.includes(`origin/${a79Branch}`) && !/ahead|behind/.test(tracking),
    T010: a78Unexpected.length > 0 && a78Unexpected.every((path, index) => changedPaths.includes(path) || (index === a78Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A7.8 re-proves A7.7's branch-only causes against the A7.8 branch; on A7.9 only those tied to that branch can be
    // unproven — re-proved here against this branch.
    T120: unprovenA77.length > 0 && unprovenA77.every((id) => ['T001', 'T002', 'T010', 'T110', 'T122', 'T125'].includes(id)) && originA77 === '' && prismaStatus.length === 0 && outOfScope.length === 0 && tracking.includes(`origin/${a79Branch}`),
    T130: originA78 === '' && originA79 === headAtStart && headAtStart.length === 40 && outOfScope.length === 0,
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A7\.8\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T120',
    'All historical branch-only N/A justified',
    ran && failing.every((id) => id in a78NonApplicable) && unproven.length === 0 && naLines.length === 7 && naLines.every((line) => line.length > 80) && ownOwnerChanged.length === 0,
    unproven.length === 0
      ? `each documented A7.8 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved independently here; A7.8 itself justifies its seven A7.7 items (${naLines.length} lines)`
      : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- final gates (T121–T130)
  section('Units, typecheck, frontend, checksums and replay, outage and recovery, no 5xx, synthetic fixtures, worked example, exact head')
  const allUnit = run('npm run test:unit')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  check('T121', 'Backend unit tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 11/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 11 A7.9 reducer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Backend typecheck', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
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
  check('T126', 'Health 200/ready 503/recovery', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  check('T127', 'Zero unexpected HTTP 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runFreezes = await prisma.$queryRawUnsafe<{ org: string }[]>(
    `SELECT p.organization_id::text AS org FROM ${FREEZES} f JOIN claims k ON k.id = f.claim_id JOIN encounters e ON e.id = k.encounter_id JOIN patients p ON p.id = e.patient_id WHERE f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  const runSources = await prisma.$queryRawUnsafe<{ kind: string; reference: string }[]>(`SELECT source_kind AS kind, source_reference AS reference FROM revenue_source_evidence WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, runStartedAt.toISOString(), chainStartedAt.toISOString())
  check(
    'T128',
    'Synthetic-only fixtures',
    runFreezes.length > 0 && runFreezes.every((f) => [org, otherOrg].includes(f.org)) && runSources.length > 0 && runSources.every((s) => s.kind === SYNTHETIC && s.reference.includes(runToken)) && !/['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/.test(productionCode),
    `the ${runFreezes.length} freezes and ${runSources.length} sources this run recorded (before the nested chain) belong to the two synthetic organizations, every source INTERNAL_SYNTHETIC and keyed by ${runId}; no id is hard-coded in A7.9`,
  )
  const goldenAfter = stable((await continuityOf(C.claimId)).body)
  console.log(`[${TAG}]      worked example: Claim C ${C.claimId}: S1 -> S2 -> S3 -> S4 read ${DC.body.continuityCode} with gaps ${codesOf(DC.body).join(', ')} (bases ${DC.body.gaps.map((g: any) => g.basisCode ?? 'null').join(', ')})`)
  console.log(`[${TAG}]      worked example: S5 appended later through A6.9 left those four gaps byte-identical; no code says money is due, posted, collected or closed; corrupt or inconsistent histories -> 409 with no partial result`)
  check(
    'T129',
    'Worked example survives restart and chain',
    same(goldenAfter, goldenBefore) && same(codesOf(DC.body), ['CASE_NOT_RECORDED', 'PREREQUISITE_NOT_RECORDED', 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'SOURCE_CHAIN_INCOMPLETE']) && DC.body.continuityCode === 'HISTORICAL_EVIDENCE_UNRECORDED' && (goldenAfter as any).submissionCount === 5,
    'the §8 scenario (CASE_NOT_RECORDED, PREREQUISITE_NOT_RECORDED, EXTERNAL_FINANCIAL_EVIDENCE_ABSENT, SOURCE_CHAIN_INCOMPLETE) is reproduced, and after the nested chain and a database restart Claim C reads back identically (all but evaluatedAt)',
  )

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|reconcil|exception|integration\/a(8|9)|dhpo|eclaimlink|prisma\//i.test(file))
  check(
    'T010',
    'Exact changed-file allowlist',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A7.9 module, harness and check page, one error code, the route mount, the scripts and the registry entry; no migration, schema, permission, audit or owner change; no A8/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headNow = git('rev-parse HEAD')
  check(
    'T130',
    'Two complete runs, exact HEAD parity',
    headNow === headAtStart && headNow === originA79 && headNow.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a79Branch}`) && !/ahead|behind/.test(tracking) && outOfScope.length === 0 && same(goldenAfter, goldenBefore),
    `all evidence corresponds to ${headNow} (= origin/${a79Branch}); ${tracking}; fresh runId ${runId}; scope exact (T010); the two submitted runs must both state this HEAD`,
  )

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] REVENUE EVIDENCE CONTINUITY ACCEPTANCE COMPLETE` : `[${TAG}] A7.9 FINAL FAIL`)
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
