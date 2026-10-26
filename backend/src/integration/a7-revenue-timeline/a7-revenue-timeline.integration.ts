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
import { removeClaimLine } from '../../modules/claim-line/claim-line.service.ts'
import { recordCorrectionLink } from '../../modules/claim-correction/claim-correction.service.ts'
import { getCasesOf, assembleRevenueEvidenceCase } from '../../modules/evidence-case/evidence-case.service.ts'
import { assessClosurePrerequisites, getPrerequisiteAssessmentsOf } from '../../modules/case-prerequisite/case-prerequisite.service.ts'
import { assessmentCodes, basisCodes } from '../../modules/case-prerequisite/case-prerequisite.types.ts'
import { composeTimeline } from '../../modules/revenue-timeline/revenue-timeline.reducer.ts'
import { getRevenueTimelineOf } from '../../modules/revenue-timeline/revenue-timeline.service.ts'
import type { TimelineFacts } from '../../modules/revenue-timeline/revenue-timeline.types.ts'

// A7.7 — focused acceptance for Claim-Level Revenue Evidence Timeline (T001–T130).
//
// Every Claim, freeze and correction link is built through its owners, exactly as the A6.7–A7.6 suites build them
// (tariff world and rates, the A5.7 recorder, readiness, the Claim, lines, diagnoses and pointers, pricing, draft
// assessments, APPROVE/REVOKE by a separate synthetic Admin, every freeze through the A6.7 route and every correction
// link through the A6.9 route); every source is registered through the A7.1 route, classified through A7.2, gated
// through A7.3, cased through A7.4 and assessed through A7.5. The other organization builds its own world with its
// own two Admins. Timelines are read through the A7.7 route (or, on a harness-held snapshot, through its
// transaction-aware service). CORRUPT histories no owner can record (forks, joins, cycles, self-links, cross-Claim
// links, equal instants, extra roots, foreign, duplicate or unsupported cases and assessments) are planted only in a
// transaction that is ALWAYS rolled back — owner guards off, and where a CHECK or UNIQUE index would refuse the
// forgery, that one constraint dropped inside the same transaction — and judged there by the production service on
// that transaction. Synthetic users are provisioned per run through Better Auth's own server-side creation with a
// random password that is never printed. Every value is synthetic and keyed by this run's id.

const TAG = 'A7.7'
let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []
const printedIds: string[] = []
const notApplicableIds: string[] = []
let failLines = 0

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  printedIds.push(id)
  if (condition) {
    passed += 1
    console.log(`[${TAG}] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failLines += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[${TAG}] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  notApplicableIds.push(id)
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

const runId = `A77-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a77Branch = 'feature/a7-7-revenue-evidence-timeline'
const a76Branch = 'feature/a7-6-closure-basis-trace'
const a75Branch = 'feature/a7-5-case-closure-prerequisite-assessment'
const a74Branch = 'feature/a7-4-revenue-evidence-case-assembly'
const a73Branch = 'feature/a7-3-adjudication-evidence-readiness'
const a72Branch = 'feature/a7-2-evidence-classification'
const a71Branch = 'feature/a7-1-revenue-source-evidence'
const a610Branch = 'feature/a6-10-a6-integration-acceptance'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/revenue-timeline'
const FE_DIR = 'frontend/src/modules/revenue-timeline'
const HARNESS_DIR = 'backend/src/integration/a7-revenue-timeline'
const A75_MIGRATION_NAME = '20261025090000_a7_5_case_prerequisite'
const A75_MIGRATION = `backend/prisma/migrations/${A75_MIGRATION_NAME}/migration.sql`
const UNIT_TESTS = [`${MODULE_DIR}/revenue-timeline.reducer.test.ts`, `${MODULE_DIR}/revenue-timeline.validation.test.ts`]
const PREREQ = 'evidence_prereq_results'
const HEADER = 'evidence_case_snapshots'
const ENTRY = 'evidence_case_entries'
const LINKS = 'claim_correction_links'
const FREEZES = 'claim_freezes'
const CONTRACT = 'A7-REVENUE-TIMELINE-1'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const DTO_KEYS = ['contractVersion', 'claimId', 'evaluatedAt', 'chainCode', 'submissions', 'historyCount']
const ENTRY_KEYS = ['ordinal', 'claimSubmissionId', 'priorSubmissionId', 'correctionLinkId', 'frozenAt', 'caseSummaries', 'prerequisiteSummaries']
const CASE_KEYS = ['caseId', 'contractVersion', 'assemblyCode', 'sourceCount', 'classifiedCount', 'readinessCount', 'itemCount', 'manifestSha256']
const PREREQ_KEYS = ['assessmentId', 'caseId', 'contractVersion', 'assessmentCode', 'basisCode', 'caseManifestSha256']
const READ_PERMISSIONS = ['claim.read', 'claimFreeze.read', 'claimCorrection.read', 'evidenceCase.read', 'evidenceCasePrereq.read']
// The owners A7.7 consumes or must leave untouched: the A5/A6 modules and A7.1–A7.6 (backend, pages and suites).
const OWNER_DIRS = [
  ...[
    'claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction',
    'pre-claim-validation', 'pre-claim-readiness', 'validation-run', 'revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'closure-basis-trace', 'encounter-billing-context',
  ].map((name) => `backend/src/modules/${name}`),
  'backend/src/shared/database',
  'backend/src/shared/authorization',
  'backend/prisma',
  'frontend/src/modules/revenue-evidence',
  'frontend/src/modules/evidence-classification',
  'frontend/src/modules/evidence-gate',
  'frontend/src/modules/evidence-case',
  'frontend/src/modules/case-prerequisite',
  'frontend/src/modules/closure-basis-trace',
  'backend/src/integration/a7-revenue-source-evidence',
  'backend/src/integration/a7-evidence-classification',
  'backend/src/integration/a7-evidence-gate',
  'backend/src/integration/a7-evidence-case',
  'backend/src/integration/a7-case-prerequisite',
  'backend/src/integration/a7-closure-basis-trace',
]
// Every table a timeline could conceivably touch, read in this fixed key order (a UNION ALL may come back in
// Parallel Append order). A timeline must leave every one of them exactly as it found it.
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
// A timeline without its evaluation instant: the only field that may differ between two reads of the same history.
const stable = (body: any) => {
  if (!body || typeof body !== 'object') return body
  const { evaluatedAt: _evaluatedAt, ...rest } = body
  return rest
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  const headAtStart = git('rev-parse HEAD')
  console.log(`[${TAG}] A7.7 claim-level revenue evidence timeline — run ${runId}`)
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
  section('Preflight: accepted A7.6, ancestry, no schema or migration, Prisma, unchanged replay and permissions, one GET route, owners untouched')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a76Merge = mergeOf(a76Branch)
  const upstreamMerges = [a610Branch, a71Branch, a72Branch, a73Branch, a74Branch, a75Branch, a76Branch].map((name) => ({ name, sha: mergeOf(name) }))
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|settlement|receivable|claim-transport|claim-outbox|payer-response|integration\/a(8|9)|integration\/a7-(?!revenue-source-evidence|evidence-classification|evidence-gate|evidence-case|case-prerequisite|closure-basis-trace|revenue-timeline)|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Correct A7.6 merge and branch ancestry',
    branch === a77Branch && a76Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a76Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A7.6 merged as ${a76Merge.slice(0, 7) || 'NOT FOUND'} and is an ancestor; contains latest main ${git('rev-parse --short origin/main')}, not stacked on an unmerged branch; no A7.8+/A8/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean synchronized HEAD, origin parity', dirty.length === 0 && tracking.includes(`origin/${a77Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  const ownerExports = [
    ['A6.7 findClaimForFreeze', /export async function findClaimForFreeze\(claimId: string, db: DbClient\)/.test(committedCode('backend/src/modules/claim-submission/claim-submission.repository.ts'))],
    ['A6.7 findFreezesOfClaim', /export async function findFreezesOfClaim\(claimId: string, db: DbClient\)/.test(committedCode('backend/src/modules/claim-submission/claim-submission.repository.ts'))],
    ['A6.9 getCorrectionChain', /export async function getCorrectionChain\(claimId: string, tx: DbClient\)/.test(committedCode('backend/src/modules/claim-correction/claim-correction.service.ts'))],
    ['A6.9 findFreezeFacts', /export async function findFreezeFacts\(submissionId: string, db: DbClient\)/.test(committedCode('backend/src/modules/claim-correction/claim-correction.repository.ts'))],
    ['A7.4 getCasesOf', /export async function getCasesOf\(submissionId: string, tx: DbClient\)/.test(committedCode('backend/src/modules/evidence-case/evidence-case.service.ts'))],
    ['A7.5 getPrerequisiteAssessmentsOf', /export async function getPrerequisiteAssessmentsOf\(caseId: string, tx: DbClient\)/.test(committedCode('backend/src/modules/case-prerequisite/case-prerequisite.service.ts'))],
    ['withReadSnapshot', /export async function withReadSnapshot/.test(committedCode('backend/src/shared/database/read-snapshot.ts'))],
  ] as const
  check(
    'T003',
    'All A6.1–A7.6 accepted ancestors',
    upstreamMerges.every((m) => m.sha.length === 40 && gitOk(`merge-base --is-ancestor ${m.sha} HEAD`)) && ownerExports.every(([, present]) => present),
    `${upstreamMerges.map((m) => `${m.name.replace(/^feature\//, '').split('-').slice(0, 2).join('.')} ${m.sha.slice(0, 7)}`).join(', ')} are ancestors (A6.10 carries A6.1–A6.9); every owner read A7.7 consumes exists: ${ownerExports.map(([name]) => name).join(', ')}`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const prismaStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  const baseMigrationDirs = migrationDirsAt('origin/main')
  check(
    'T004',
    'No schema or migration introduced',
    prismaStatus.length === 0 && same(headMigrationDirs, baseMigrationDirs),
    prismaStatus.length === 0 ? `nothing under backend/prisma changed: schema and all ${headMigrationDirs.length} migrations identical to main` : `prisma changes: ${prismaStatus.join(' | ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma validate and generate unchanged', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output) && prismaStatus.length === 0, 'the unchanged schema validates and generates; the working database is up to date (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check(
    'T006',
    'From-empty replay agrees with base',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === baseMigrationDirs.length && appliedCount === headMigrationDirs.length && /PASS {2}the A7\.5 tables are exactly evidence_prereq_results/.test(replay.output),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${baseMigrationDirs.length} on main; every guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const routeCode = committedCode(`${MODULE_DIR}/revenue-timeline.route.ts`)
  const authzDiff = gitArgs(['diff', 'origin/main...HEAD', '--', ':/backend/src/shared/authorization', ':/backend/src/scripts/bootstrap-authz-dev.ts'])
  const routePermissions = [...routeCode.matchAll(/requireMemberPermission\(organizationIdFromClaim, '([^']+)'\)/g)].map((m) => m[1])
  const grants = await Promise.all(READ_PERMISSIONS.map(grantsOf))
  check(
    'T007',
    'Existing permission catalogue unchanged',
    authzDiff === '' && !allCodes.some((code) => /timeline|history/i.test(code)) && same(routePermissions, READ_PERMISSIONS) && grants.every((g) => g === 'ORG_ADMIN,ORG_VIEWER'),
    `the catalogue and its bootstrap are unchanged; the route requires exactly the existing ${READ_PERMISSIONS.join(', ')} (each granted to Admin and Viewer); no timeline permission exists`,
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

  // Synthetic users: Better Auth's own server-side user and credential creation, then a membership through the
  // existing tables — with the ORG_ADMIN role, or with NO role (a member who holds no permission). The password is
  // random per run and never printed.
  const authContext = await auth.$context
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' }, select: { id: true } })
  const provisionMember = async (label: string, organizationId = org, roleId: string | null = adminRole.id) => {
    const email = `${runId.toLowerCase()}-${label}@reviewers.sbn.test`
    const secretValue = randomBytes(24).toString('base64url')
    const user = await authContext.internalAdapter.createUser({ email, name: `Synthetic member ${label}`, emailVerified: false }, { method: 'email-password' })
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', issuer: 'local:credential', accountId: user.id, password: await authContext.password.hash(secretValue) })
    const membership = await prisma.organizationMembership.create({ data: { organizationId, userId: user.id } })
    if (roleId) await prisma.membershipRole.create({ data: { membershipId: membership.id, roleId } })
    const signed = await signIn(email, secretValue)
    if (signed.status !== 200) throw new Error(`fixture member ${label} could not sign in (${signed.status})`)
    return { id: user.id as string, who: as(signed.cookie), cookie: signed.cookie }
  }
  // B approves (separation of duties for A6.5) and reads as a second Admin; N is a member with no role; O and O2 are
  // the two Admins of the OTHER organization.
  const B = await provisionMember('b')
  const N = await provisionMember('n', org, null)
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)

  const timelinePath = (claimId: string) => `/api/claims/${claimId}/revenue-evidence-timeline`
  const timelineOf = (claimId: string, who: Who = asAdmin) => get(timelinePath(claimId), who)
  const wiring = await timelineOf(MISSING)
  const absent = [
    await api('POST', timelinePath(MISSING), {}),
    await api('PUT', timelinePath(MISSING), {}),
    await api('PATCH', timelinePath(MISSING), {}),
    await api('DELETE', timelinePath(MISSING)),
    await api('GET', `${timelinePath(MISSING)}/latest`),
    await api('GET', `${timelinePath(MISSING)}/current`),
    await api('GET', '/api/claims/revenue-evidence-timeline'),
    await api('GET', '/api/revenue-evidence-timelines'),
    await api('GET', `/api/claim-submissions/${MISSING}/revenue-evidence-timeline`),
  ]
  const unauthenticated = await timelineOf(MISSING, anonymous)
  check(
    'T008',
    'Exactly one GET route; mutations absent',
    wiring.status === 404 && errorCode(wiring.body) === 'NOT_FOUND' && absent.every((res) => res.status === 404 || res.status === 400) && absent.slice(0, 6).every((res) => res.status === 404) && unauthenticated.status === 401 &&
      (routeCode.match(/timelineRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 1 && /timelineRouter\.get\(\s*'\/:claimId\/revenue-evidence-timeline'/.test(routeCode),
    `GET answers a missing Claim with a privacy-safe 404; POST/PUT/PATCH/DELETE, latest and current are absent (${absent.map((r) => r.status).join('/')}) — no all-organization search exists; unauthenticated ${unauthenticated.status}`,
  )
  const constantOf = (path: string, name: string) => (committedText(path).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-submission/claim-submission.types.ts', 'SUBMISSION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-lifecycle/claim-lifecycle.types.ts', 'LIFECYCLE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-correction/claim-correction.types.ts', 'CORRECTION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/revenue-evidence/revenue-evidence.types.ts', 'REVENUE_SOURCE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-classification/evidence-classification.types.ts', 'CLASSIFICATION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-gate/evidence-gate.types.ts', 'READINESS_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-case/evidence-case.types.ts', 'CASE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/case-prerequisite/case-prerequisite.types.ts', 'PREREQ_CONTRACT_VERSION'),
    constantOf('backend/src/modules/closure-basis-trace/closure-basis-trace.types.ts', 'TRACE_CONTRACT_VERSION'),
  ]
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file))
  const expectedContracts = ['A6-CLAIM-1', 'A6-SUBMISSION-1', 'A6-LIFECYCLE-1', 'A6-CORRECTION-1', 'A7-REVENUE-SOURCE-1', 'A7-EVIDENCE-CLASS-1', 'A7-ADJ-READINESS-1', 'A7-REVENUE-CASE-1', 'A7-CLOSURE-PREREQ-1', 'A7-CLOSURE-TRACE-1']
  check(
    'T009',
    'All previous contracts untouched',
    same(contracts, expectedContracts) && ownerChanged.length === 0,
    ownerChanged.length === 0 ? `${expectedContracts.join(', ')} unchanged; no A5/A6/A7.1–A7.6 module, page or suite, shared database or authorization code, or prisma file changed` : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: Claims with 0, 1, 2 and 4 linked freezes, evidence, cases and assessments of two organizations')
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
  const ref = (suffix: string) => `SYN-${runId.replace(/^A77-/, '')}-${suffix}`.toUpperCase()
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
    return res.body as { caseId: string; assemblyCode: string; manifestSha256: string; itemCount: number }
  }
  const assessmentOf = async (caseId: string, who: Who = asAdmin) => {
    const res = await post(`/api/revenue-evidence-cases/${caseId}/closure-prerequisite-assessments`, {}, who)
    if (res.status !== 201) throw new Error(`fixture assessment could not be recorded through A7.5: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { assessmentId: string; caseId: string; assessmentCode: string; basisCode: string; caseManifestSha256: string }
  }
  const linkOf = async (claimId: string, prior: string, corrected: string, who: Who = asAdmin) => {
    const res = await post(`/api/claims/${claimId}/correction-links`, { priorSubmissionId: prior, correctedSubmissionId: corrected, reasonCode: 'CORRECTED_CODING' }, who)
    if (res.status !== 201) throw new Error(`fixture: the A6.9 link was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return (res.body.correctionLinkId ?? res.body.link?.correctionLinkId) as string
  }
  // §8 — Claim K: S1 and S2 linked by L12; CASE1 (+ASSESS1) only on S1; CASE2 (unassessed) only on S2.
  const W = await home.series('worked', 2)
  const [S1, S2] = W.freezes
  const L12 = await linkOf(W.claimId, S1, S2)
  const K1 = await linkedSource(S1, 'E1')
  await linkedSource(S1, 'E2')
  await linkedSource(S2, 'S2-E1')
  const CASE1 = await caseOf(S1)
  const ASSESS1 = await assessmentOf(CASE1.caseId)
  const CASE2 = await caseOf(S2)
  // A Claim never frozen, a one-freeze Claim, a snapshot Claim, and a four-freeze chain: C4 S1 without a case, S2 with
  // an unassessed case, S3 and S4 each with a case and assessment.
  const Z = await home.series('unfrozen', 0)
  const One = await home.series('single', 1)
  const Snap = await home.series('snapshot', 1)
  const C4 = await home.series('four', 4)
  const C4L = [await linkOf(C4.claimId, C4.freezes[0], C4.freezes[1]), await linkOf(C4.claimId, C4.freezes[1], C4.freezes[2]), await linkOf(C4.claimId, C4.freezes[2], C4.freezes[3])]
  await linkedSource(C4.freezes[1], 'C4-S2')
  const C4case2 = await caseOf(C4.freezes[1])
  await linkedSource(C4.freezes[2], 'C4-S3')
  const C4case3 = await caseOf(C4.freezes[2])
  const C4assess3 = await assessmentOf(C4case3.caseId)
  await linkedSource(C4.freezes[3], 'C4-S4')
  const C4case4 = await caseOf(C4.freezes[3])
  const C4assess4 = await assessmentOf(C4case4.caseId)
  // The other organization: two linked freezes, a case and an assessment of its own.
  const F = await away.series('foreign', 2)
  const FL = await linkOf(F.claimId, F.freezes[0], F.freezes[1], O.who)
  await linkedSource(F.freezes[0], 'FOREIGN', O.who)
  const FCASE = await caseOf(F.freezes[0], O.who)
  const FASSESS = await assessmentOf(FCASE.caseId, O.who)
  const foreignIds = [F.claimId, ...F.freezes, FL, FCASE.caseId, FASSESS.assessmentId]
  console.log(`[${TAG}]      fixtures ready: two synthetic AE-DU/DHA worlds; Claims with 0, 1, 2 and 4 linked freezes and a foreign 2-freeze Claim; evidence, cases and assessments through the A7.1–A7.5 owner routes`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const runToken = runId.replace(/^A77-/, '')
  const freezeHash = (claimId: string) => hashOf(`SELECT f.*, m.id AS manifest_id, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') AS manifest FROM ${FREEZES} f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = $1::uuid`, claimId)
  const lifecycleHash = (claimId: string) => hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN ${FREEZES} f ON f.id = e.claim_submission_id WHERE f.claim_id = $1::uuid`, claimId)
  const correctionHash = (claimId: string) => hashOf(`SELECT l.* FROM ${LINKS} l WHERE l.claim_id = $1::uuid`, claimId)
  const sourceHash = () => hashOf(`SELECT r.* FROM revenue_source_evidence r WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const classificationHash = () => hashOf(`SELECT c.* FROM source_evidence_classifications c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const readinessHash = () => hashOf(`SELECT g.* FROM evidence_gate_results g JOIN revenue_source_evidence r ON r.id = g.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const caseHash = (caseId: string) => hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM ${HEADER} h WHERE h.id = $1::uuid UNION ALL SELECT e.id, row_to_json(e)::text FROM ${ENTRY} e WHERE e.assembly_id = $1::uuid) x`, caseId)
  const allCasesHash = () => hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM ${HEADER} h UNION ALL SELECT e.id, row_to_json(e)::text FROM ${ENTRY} e) x`)
  const allAssessmentsHash = () => hashOf(`SELECT a.* FROM ${PREREQ} a`)
  const relaxable = [LINKS, FREEZES, HEADER, ENTRY, PREREQ].map((t) => `'${t}'::regclass`).join(', ')
  const constraintsHash = () => hashOf(`SELECT c.oid::text AS id, c.conrelid::regclass::text AS t, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid IN (${relaxable}) UNION ALL SELECT i.indexrelid::text, i.indrelid::regclass::text, i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid IN (${relaxable})`)
  const NOT_REFUSED = 'ROLLED_BACK'

  // A planted (corrupt) history: the relaxations and forged rows go in with row triggers off, then the production A7.7
  // service composes that Claim's timeline on THIS transaction, which is then ALWAYS rolled back. Every plant is
  // measured on its own: all tables and every CHECK and index of the five relaxable tables must read back exactly.
  const plantedRuns = { total: 0, dirty: 0 }
  type Planted = { result?: Awaited<ReturnType<typeof getRevenueTimelineOf>>; message: string }
  const planted = async (claimId: string, relax: string[], mutate: (tx: DbClient) => Promise<void>): Promise<Planted> => {
    const countsBefore = await counts()
    const constraintsBefore = await constraintsHash()
    const out: { result?: Awaited<ReturnType<typeof getRevenueTimelineOf>> } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          for (const ddl of relax) await tx.$executeRawUnsafe(ddl)
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
          await mutate(tx)
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
          out.result = await getRevenueTimelineOf(claimId, tx)
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
  const insertCase = async (tx: DbClient, submissionId: string, o: { organization?: string; contract?: string; code?: string } = {}) =>
    (await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ${HEADER} (id, organization_id, claim_submission_id, contract_version, assembly_code, source_count, classified_count, readiness_count, item_count, manifest_sha256, recorded_by_user_id)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, 0, 0, 0, 0, $5, $6::uuid) RETURNING id::text AS id`,
      o.organization ?? org, submissionId, o.contract ?? 'A7-REVENUE-CASE-1', o.code ?? 'NO_REVENUE_SOURCES', createHash('sha256').update(randomBytes(8)).digest('hex'), creatorId,
    ))[0].id
  const insertAssessment = (tx: DbClient, caseId: string, digest: string, o: { organization?: string; code?: string; basis?: string } = {}) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${PREREQ} (id, organization_id, evidence_case_id, contract_version, assessment_code, basis_code, case_manifest_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'A7-CLOSURE-PREREQ-1', $3, $4, $5, $6::uuid)`,
      o.organization ?? org, caseId, o.code ?? 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', o.basis ?? 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', digest, creatorId,
    )
  const refused = (p: Planted) => p.message.includes(NOT_REFUSED) && p.result?.ok === false && p.result.code === 'REVENUE_TIMELINE_PROVENANCE_CONFLICT' && !('value' in (p.result as object))
  const detailOf = (p: Planted) => (p.result?.ok === false ? String(p.result.message).replace(/; nothing was composed$/, '') : p.result?.ok ? `composed ${p.result.value.historyCount} entries` : `not planted: ${p.message.slice(0, 140)}`)
  // The facts the composer reads, read here by the harness through the same owners, for pure-composer forgeries.
  const factsFor = (claimId: string): Promise<TimelineFacts> =>
    withReadSnapshot(undefined, async (tx) => {
      const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId }, select: { encounter: { select: { patient: { select: { organizationId: true } } } } } })
      const freezes = await tx.$queryRaw<{ id: string; claim_id: string; frozen_at: Date; us: bigint }[]>`SELECT id::text, claim_id::text, frozen_at, (extract(epoch FROM frozen_at) * 1000000)::bigint AS us FROM claim_freezes WHERE claim_id = ${claimId}::uuid`
      const links = await tx.claimCorrectionLink.findMany({ where: { claimId } })
      const ordered: typeof links = []
      const byPrior = new Map(links.map((l) => [l.priorSubmissionId, l]))
      const root = links.find((l) => !links.some((o) => o.correctedSubmissionId === l.priorSubmissionId))
      for (let l = root; l; l = byPrior.get(l.correctedSubmissionId)) ordered.push(l)
      const cases = await tx.evidenceCaseSnapshot.findMany({ where: { claimSubmissionId: { in: freezes.map((f) => f.id) } } })
      const assessments = await tx.evidencePrereqResult.findMany({ where: { evidenceCaseId: { in: cases.map((c) => c.id) } } })
      return {
        claimId,
        organizationId: claim.encounter.patient.organizationId,
        freezes: freezes.map((f) => ({ submissionId: f.id, claimId: f.claim_id, frozenAt: f.frozen_at.toISOString(), frozenAtMicros: Number(f.us) })),
        links: ordered.map((l) => ({ correctionLinkId: l.id, claimId: l.claimId, priorSubmissionId: l.priorSubmissionId, correctedSubmissionId: l.correctedSubmissionId })),
        cases: cases.map((c) => ({ caseId: c.id, claimSubmissionId: c.claimSubmissionId, organizationId: c.organizationId, contractVersion: c.contractVersion, assemblyCode: c.assemblyCode, sourceCount: c.sourceCount, classifiedCount: c.classifiedCount, readinessCount: c.readinessCount, itemCount: c.itemCount, manifestSha256: c.manifestSha256 })),
        assessments: assessments.map((a) => ({ assessmentId: a.id, caseId: a.evidenceCaseId, organizationId: a.organizationId, contractVersion: a.contractVersion, assessmentCode: a.assessmentCode, basisCode: a.basisCode, caseManifestSha256: a.caseManifestSha256 })),
      }
    })

  // ---------------------------------------------------------------- strict access and input (T011–T020)
  section('Strict access and input: contract, no body or selector, malformed and injected ids, session, roles, tenants, missing Claim')
  const countsAtStart = await counts()
  const TW = await timelineOf(W.claimId)
  check('T011', 'Literal A7-REVENUE-TIMELINE-1 DTO', TW.status === 200 && TW.body?.contractVersion === CONTRACT && constantOf(`${MODULE_DIR}/revenue-timeline.types.ts`, 'TIMELINE_CONTRACT_VERSION') === CONTRACT, 'A7-REVENUE-TIMELINE-1 is the literal contract in code and on every timeline')
  const withBody = [await getWithBody(timelinePath(W.claimId), JSON.stringify({ submissions: [{ claimSubmissionId: S2 }] }), admin.cookie), await getWithBody(timelinePath(W.claimId), JSON.stringify({ claimId: Z.claimId }), admin.cookie)]
  check('T012', 'GET takes no body or client history', withBody.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && /carries no body/.test(res.body?.error?.message ?? '')), `a GET carrying a client-supplied history or Claim is refused (${withBody.map((r) => r.status).join('/')}); the history comes only from the owners`)
  const selectors = [await get(`${timelinePath(W.claimId)}?latestOnly=true`), await get(`${timelinePath(W.claimId)}?status=PAID`), await get(`${timelinePath(W.claimId)}?includePayload=1&country=US`), await get(`${timelinePath(W.claimId)}?submissionId=${S2}`)]
  check('T013', 'Unknown query selector latestOnly refused', selectors.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && /unsupported query parameter/.test(res.body?.error?.message ?? '')), `latestOnly, status, includePayload/country and a submission selector are refused, never ignored (${selectors.map((r) => r.status).join('/')})`)
  const malformed = [await timelineOf('not-a-uuid'), await timelineOf(MISSING.slice(0, 35)), await timelineOf(MISSING.replace(/-/g, '')), await timelineOf(`${MISSING}0`)]
  check('T014', 'Malformed Claim UUID 400', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR'), `malformed ids: ${malformed.map((r) => r.status).join('/')}`)
  const injected = [await timelineOf(encodeURIComponent("1' OR '1'='1")), await timelineOf(encodeURIComponent(`${W.claimId}' OR '1'='1`)), await timelineOf(encodeURIComponent(`${W.claimId};DROP TABLE claims`))]
  check('T015', 'UUID injection refused, no raw SQL', injected.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `SQL-shaped path ids are refused before any lookup with a safe body: ${injected.map((r) => r.status).join('/')}`)
  const anon = await timelineOf(W.claimId, anonymous)
  check('T016', 'Anonymous GET 401', anon.status === 401 && unauthenticated.status === 401, 'no session: 401 for an existing and a missing Claim')
  const viewerTW = await timelineOf(W.claimId, asViewer)
  check('T017', 'Viewer with read permission 200', viewerTW.status === 200 && same(stable(viewerTW.body), stable(TW.body)), 'a Viewer (all five reads) gets the identical timeline (200)')
  const noRole = await timelineOf(W.claimId, N.who)
  check('T018', 'Missing read permission 403', noRole.status === 403 && errorCode(noRole.body) === 'FORBIDDEN' && !JSON.stringify(noRole.body).includes(S1), 'a member of the organization holding no read permission is refused 403 with no history in the body')
  const foreignOnHome = await timelineOf(W.claimId, O.who)
  const missingAsForeign = await timelineOf(MISSING, O.who)
  const homeOnForeign = await timelineOf(F.claimId)
  check(
    'T019',
    'Foreign tenant Claim privacy-safe 404',
    foreignOnHome.status === 404 && same({ ...foreignOnHome.body?.error, requestId: null }, { ...missingAsForeign.body?.error, requestId: null }) && homeOnForeign.status === 404,
    "the other organization's Admin gets exactly the missing-id envelope for this tenant's Claim, and this tenant's Admin 404 for theirs",
  )
  const missingClaim = await timelineOf(MISSING)
  check('T020', 'Non-existent Claim 404, no write', missingClaim.status === 404 && errorCode(missingClaim.body) === 'NOT_FOUND' && (await unchanged(countsAtStart)), 'a non-existent Claim: 404, and nothing in any of the 15 tables was written by any request so far')

  // ---------------------------------------------------------------- legitimate chronology (T021–T030)
  section('Legitimate chronology: empty, one-node, two-node and four-node histories against the stored freezes and links')
  const TZ0 = await timelineOf(Z.claimId)
  check('T021', 'No freezes: explicit empty history', TZ0.status === 200 && TZ0.body.chainCode === 'NO_FROZEN_SUBMISSION' && same(TZ0.body.submissions, []) && TZ0.body.historyCount === 0 && (await prisma.claimFreeze.count({ where: { claimId: Z.claimId } })) === 0, 'an unfrozen Claim (zero freezes confirmed by A6.7) returns NO_FROZEN_SUBMISSION with an empty history')
  const T1 = await timelineOf(One.claimId)
  check('T022', 'One freeze: one root, null predecessor', T1.status === 200 && T1.body.chainCode === 'LINEAR_HISTORY' && T1.body.historyCount === 1 && T1.body.submissions[0].claimSubmissionId === One.freezes[0] && T1.body.submissions[0].priorSubmissionId === null && T1.body.submissions[0].correctionLinkId === null, 'a one-freeze Claim is a valid one-node chain: ordinal 1, no predecessor and no link')
  const wEntries = TW.body.submissions as any[]
  check(
    'T023',
    'Two linked freezes in correction order',
    TW.status === 200 && TW.body.chainCode === 'LINEAR_HISTORY' && same(wEntries.map((e) => e.claimSubmissionId), [S1, S2]) && wEntries[0].correctionLinkId === null && wEntries[1].correctionLinkId === L12 && wEntries[1].priorSubmissionId === S1,
    'S1 then S2; the link L12 is attached only to S2, whose predecessor is S1',
  )
  const T4 = await timelineOf(C4.claimId)
  const c4Entries = T4.body.submissions as any[]
  check('T024', 'Four linked freezes: contiguous ordinals', T4.status === 200 && same(c4Entries.map((e) => e.ordinal), [1, 2, 3, 4]) && same(c4Entries.map((e) => e.claimSubmissionId), C4.freezes) && same(c4Entries.slice(1).map((e) => e.correctionLinkId), C4L), 'ordinals 1..4 follow S1→S2→S3→S4 with each link on its corrected freeze')
  const dbFreezes = async (claimId: string) => (await prisma.$queryRaw<{ id: string; us: bigint }[]>`SELECT id::text, (extract(epoch FROM frozen_at) * 1000000)::bigint AS us FROM claim_freezes WHERE claim_id = ${claimId}::uuid`).map((r) => ({ id: r.id, us: Number(r.us) }))
  const dbLinks = async (claimId: string) => prisma.claimCorrectionLink.findMany({ where: { claimId } })
  const histories = [{ claimId: W.claimId, body: TW.body }, { claimId: One.claimId, body: T1.body }, { claimId: C4.claimId, body: T4.body }]
  const facts25 = await Promise.all(histories.map(async (h) => ({ ...h, freezes: await dbFreezes(h.claimId), links: await dbLinks(h.claimId) })))
  check('T025', 'Every freeze belongs to exact Claim', facts25.every((h) => same(h.body.submissions.map((e: any) => e.claimSubmissionId).sort(), h.freezes.map((f) => f.id).sort())), 'each timeline lists exactly the stored freezes of its Claim — none missing, none foreign, none repeated')
  check('T026', 'Every link belongs to exact A6.9 chain', facts25.every((h) => same(h.body.submissions.map((e: any) => e.correctionLinkId).filter(Boolean).sort(), h.links.map((l) => l.id).sort()) && h.links.every((l) => l.claimId === h.claimId)), "each timeline carries exactly its Claim's stored links, each once")
  const micros = (h: (typeof facts25)[number]) => h.body.submissions.map((e: any) => h.freezes.find((f) => f.id === e.claimSubmissionId)?.us ?? Number.NaN)
  check('T027', 'Strict freeze-time chronology', facts25.every((h) => micros(h).every((us: number, i: number, all: number[]) => i === 0 || us > all[i - 1])), 'along every timeline the stored freeze instant (microseconds) strictly increases')
  check('T028', 'Root has no incoming correction link', facts25.every((h) => !h.links.some((l) => l.correctedSubmissionId === h.body.submissions[0].claimSubmissionId)), 'no stored link corrects any root')
  check(
    'T029',
    'Every successor uses exact predecessor ID',
    facts25.every((h) => h.body.submissions.slice(1).every((e: any, i: number) => e.priorSubmissionId === h.body.submissions[i].claimSubmissionId && h.links.some((l) => l.id === e.correctionLinkId && l.priorSubmissionId === e.priorSubmissionId && l.correctedSubmissionId === e.claimSubmissionId))),
    'each successor names exactly the entry before it, through exactly the stored link between them',
  )
  check('T030', 'HistoryCount equals actual entries', [TZ0.body, T1.body, TW.body, T4.body].every((b) => b.historyCount === b.submissions.length) && same(c4Entries.map((e) => Object.keys(e)), c4Entries.map(() => ENTRY_KEYS)), 'historyCount is exactly submissions.length on every timeline (0, 1, 2 and 4)')

  // ---------------------------------------------------------------- exact case and assessment joins (T031–T040)
  section('Exact joins: explicit absence, copied counts, digests, outcomes; a correction keeps its own evidence; a later S3 never changes S1 or S2')
  check('T031', 'No case: explicit absence', same(c4Entries[0].caseSummaries, []) && same(c4Entries[0].prerequisiteSummaries, []) && (await prisma.evidenceCaseSnapshot.count({ where: { claimSubmissionId: C4.freezes[0] } })) === 0, 'a freeze with no recorded case shows empty case and assessment lists — no sentinel, no zero balance')
  const w1cases = wEntries[0].caseSummaries as any[]
  check('T032', 'One case links to its exact freeze', same(w1cases.map((c) => c.caseId), [CASE1.caseId]) && !wEntries[1].caseSummaries.some((c: any) => c.caseId === CASE1.caseId) && (await prisma.evidenceCaseSnapshot.findUniqueOrThrow({ where: { id: CASE1.caseId } })).claimSubmissionId === S1, 'CASE1 appears only on S1, whose freeze it belongs to')
  const head1 = await prisma.evidenceCaseSnapshot.findUniqueOrThrow({ where: { id: CASE1.caseId } })
  check('T033', 'Case counts copied, never recomputed', same(Object.keys(w1cases[0]), CASE_KEYS) && same([w1cases[0].assemblyCode, w1cases[0].sourceCount, w1cases[0].classifiedCount, w1cases[0].readinessCount, w1cases[0].itemCount], [head1.assemblyCode, head1.sourceCount, head1.classifiedCount, head1.readinessCount, head1.itemCount]), `assembly code and counts are the stored header's (${head1.assemblyCode}, ${head1.itemCount} items)`)
  check('T034', 'Case digest copied byte-for-byte', w1cases[0].manifestSha256 === head1.manifestSha256 && w1cases[0].manifestSha256 === CASE1.manifestSha256, `the stored digest ${head1.manifestSha256.slice(0, 12)}… is copied`)
  const w1pre = wEntries[0].prerequisiteSummaries as any[]
  check('T035', 'One assessment links to exact case', same(w1pre.map((a) => [a.assessmentId, a.caseId]), [[ASSESS1.assessmentId, CASE1.caseId]]) && same(Object.keys(w1pre[0]), PREREQ_KEYS), 'ASSESS1 appears once, on S1, naming CASE1')
  const row1 = await prisma.evidencePrereqResult.findUniqueOrThrow({ where: { id: ASSESS1.assessmentId } })
  check('T036', 'Assessment outcome and basis copied', w1pre[0].assessmentCode === row1.assessmentCode && w1pre[0].basisCode === row1.basisCode && w1pre[0].contractVersion === row1.contractVersion, `the recorded ${row1.assessmentCode} / ${row1.basisCode} is copied`)
  check('T037', 'Assessment digest matches case digest', w1pre[0].caseManifestSha256 === w1cases[0].manifestSha256 && row1.caseManifestSha256 === head1.manifestSha256, "the assessment's case digest equals its case's digest")
  check('T038', 'Missing assessment shown as unassessed', same(wEntries[1].caseSummaries.map((c: any) => c.caseId), [CASE2.caseId]) && same(wEntries[1].prerequisiteSummaries, []) && (await prisma.evidencePrereqResult.count({ where: { evidenceCaseId: CASE2.caseId } })) === 0, 'S2 shows CASE2 with an empty assessment list: unassessed, never a paid, denied or closure-ready label')
  check(
    'T039',
    'Corrected freeze keeps its own evidence',
    same(c4Entries.map((e) => e.caseSummaries.map((c: any) => c.caseId)), [[], [C4case2.caseId], [C4case3.caseId], [C4case4.caseId]]) && same(c4Entries.map((e) => e.prerequisiteSummaries.map((a: any) => a.assessmentId)), [[], [], [C4assess3.assessmentId], [C4assess4.assessmentId]]),
    'along S1→S2→S3→S4 each corrected freeze carries only its own case and assessment',
  )
  // §8 — a later S3 appended through A6.9: frozen first (the committed history then has an unlinked freeze), linked
  // while a read runs against the uncommitted link, then read again after the link commits.
  const before40 = stable(TW.body)
  const priorCaseHashes = [await caseHash(CASE1.caseId), await caseHash(CASE2.caseId)]
  const priorAssessmentHash = await hashOf(`SELECT a.* FROM ${PREREQ} a WHERE a.id = $1::uuid`, ASSESS1.assessmentId)
  const S3 = await W.extend()
  const unlinkedState = await timelineOf(W.claimId)
  const holdLink = holdAt('claimCorrection.inserted')
  const linking = recordCorrectionLink(W.claimId, { priorSubmissionId: S2, correctedSubmissionId: S3, reasonCode: 'CORRECTED_CODING' }, creatorId)
  await Promise.race([holdLink.arrived, linking])
  const duringLinkPromise = timelineOf(W.claimId)
  const duringLinkPrompt = await settledWithin(duringLinkPromise, 3000)
  const duringLink = await duringLinkPromise
  holdLink.release()
  const linked = await linking
  clearConcurrencyProbes()
  const afterLink = await timelineOf(W.claimId)
  const L23 = linked.ok ? (linked.value as any).link?.correctionLinkId ?? (linked.value as any).correctionLinkId : null
  check(
    'T040',
    'Prior evidence unchanged by correction',
    afterLink.status === 200 && afterLink.body.historyCount === 3 && same(afterLink.body.submissions.slice(0, 2), before40.submissions) && afterLink.body.submissions[2].claimSubmissionId === S3 &&
      same([await caseHash(CASE1.caseId), await caseHash(CASE2.caseId)], priorCaseHashes) && (await hashOf(`SELECT a.* FROM ${PREREQ} a WHERE a.id = $1::uuid`, ASSESS1.assessmentId)) === priorAssessmentHash,
    'after S3 is frozen and linked, S1 and S2 (with CASE1, ASSESS1 and CASE2) read back byte-identically and S3 is appended as ordinal 3',
  )

  // ---------------------------------------------------------------- corruption refusals (T041–T050)
  section('Corrupt histories (planted on the four-freeze Claim, always rolled back): roots, forks, joins, cycles, self-links, cross-Claim links, instants, unlinked freezes')
  const [c1, c2, c3, c4] = C4.freezes
  const secondRoot = await planted(C4.claimId, [], (tx) => deleteLink(tx, C4L[1]).then(() => undefined))
  check('T041', 'Second unrelated root refused', refused(secondRoot) && /more than one chain/.test(detailOf(secondRoot)), `S1→S2 and S3→S4 as two chains (S2→S3 removed) is refused 409: ${detailOf(secondRoot)}`)
  const fork = await planted(C4.claimId, ['DROP INDEX claim_correction_links_prior_submission_id_key', 'DROP INDEX claim_correction_links_corrected_submission_id_key'], (tx) => insertLink(tx, C4.claimId, c1, c3).then(() => undefined))
  check('T042', 'Fork in A6.9 history refused', refused(fork) && /fork|join/.test(detailOf(fork)), `S1 corrected by both S2 and S3 (link indexes dropped) is refused 409: ${detailOf(fork)}`)
  const join = await planted(C4.claimId, ['DROP INDEX claim_correction_links_corrected_submission_id_key'], (tx) => insertLink(tx, C4.claimId, c4, c2).then(() => undefined))
  check('T043', 'Join of two predecessors refused', refused(join) && /join/.test(detailOf(join)), `S2 correcting both S1 and S4 (corrected index dropped) is refused 409: ${detailOf(join)}`)
  const cycle2 = await planted(C4.claimId, [], async (tx) => {
    await deleteLink(tx, C4L[1])
    await deleteLink(tx, C4L[2])
    await insertLink(tx, C4.claimId, c2, c1)
  })
  check('T044', 'Two-node cycle refused', refused(cycle2) && /cycle/.test(detailOf(cycle2)), `S1→S2→S1 is refused 409: ${detailOf(cycle2)}`)
  const cycleLong = await planted(C4.claimId, [], (tx) => insertLink(tx, C4.claimId, c4, c1).then(() => undefined))
  check('T045', 'Longer cycle refused', refused(cycleLong) && /cycle/.test(detailOf(cycleLong)), `S1→S2→S3→S4→S1 is refused 409: ${detailOf(cycleLong)}`)
  const selfLink = await planted(C4.claimId, ['DROP INDEX claim_correction_links_corrected_submission_id_key', `ALTER TABLE ${LINKS} DROP CONSTRAINT claim_correction_links_distinct_chk`], (tx) => insertLink(tx, C4.claimId, c4, c4).then(() => undefined))
  check('T046', 'Self-link refused', refused(selfLink) && /itself/.test(detailOf(selfLink)), `S4 correcting itself (distinct CHECK and corrected index dropped) is refused 409: ${detailOf(selfLink)}`)
  const crossClaim = await planted(C4.claimId, [], (tx) => insertLink(tx, C4.claimId, c4, One.freezes[0]).then(() => undefined))
  check('T047', 'Cross-Claim linked freeze refused', refused(crossClaim) && /not this claim's/.test(detailOf(crossClaim)), `a link of this Claim to another Claim's freeze is refused 409: ${detailOf(crossClaim)}`)
  const equalInstant = await planted(C4.claimId, [], (tx) => tx.$executeRawUnsafe(`UPDATE ${FREEZES} SET frozen_at = (SELECT frozen_at FROM ${FREEZES} WHERE id = $1::uuid) WHERE id = $2::uuid`, c1, c2).then(() => undefined))
  check('T048', 'Equal freeze instant: no UUID tiebreak', refused(equalInstant) && /strictly after/.test(detailOf(equalInstant)), `S2 frozen at exactly S1's instant is refused 409 rather than ordered by id: ${detailOf(equalInstant)}`)
  const unlinkedPlanted = await planted(C4.claimId, [], (tx) => deleteLink(tx, C4L[2]).then(() => undefined))
  check(
    'T049',
    'Unlinked additional freeze refused',
    unlinkedState.status === 409 && errorCode(unlinkedState.body) === 'REVENUE_TIMELINE_PROVENANCE_CONFLICT' && refused(unlinkedPlanted) && /more than one root/.test(detailOf(unlinkedPlanted)),
    `the REAL committed history (S3 frozen, not yet linked) answered 409, and a planted unlinked S4 is refused 409: ${detailOf(unlinkedPlanted)}`,
  )
  const graphRefusals = [secondRoot, fork, join, cycle2, cycleLong, selfLink, crossClaim, equalInstant, unlinkedPlanted]
  check(
    'T050',
    'Every rejection: safe 409, no partial DTO',
    graphRefusals.every(refused) && !('submissions' in (unlinkedState.body ?? {})) && same(Object.keys(unlinkedState.body?.error ?? {}).sort(), ['code', 'message', 'requestId']) && !rawError(unlinkedState.body),
    'every refused history returns only the controlled 409 code, a safe message and a request id — never a partial submissions list',
  )

  // ---------------------------------------------------------------- case and assessment provenance (T051–T060)
  section('Case and assessment provenance (planted on the four-freeze Claim, always rolled back): foreign, duplicate, misplaced, unsupported, mismatched, uncontrolled')
  const foreignCase = await planted(C4.claimId, [], (tx) => insertCase(tx, c1, { organization: otherOrg }).then(() => undefined))
  check('T051', 'Foreign A7.4 case refused', refused(foreignCase) && /another organization/.test(detailOf(foreignCase)), `a case of the other organization on S1 is refused 409: ${detailOf(foreignCase)}`)
  const duplicateCase = await planted(C4.claimId, ['DROP INDEX evidence_case_snapshots_identity_key'], (tx) => insertCase(tx, c2).then(() => undefined))
  check('T052', 'Duplicate v1 case refused, no newest', refused(duplicateCase) && /more than one case/.test(detailOf(duplicateCase)), `a second v1 case for S2 (identity index dropped) is refused 409, never resolved to the newest: ${detailOf(duplicateCase)}`)
  const facts4 = await factsFor(C4.claimId)
  const misplaced = composeTimeline({ ...facts4, cases: facts4.cases.map((c, i) => (i === 0 ? { ...c, claimSubmissionId: S1 } : c)) })
  const scoped = await withReadSnapshot(undefined, async (tx) => {
    const lists = await Promise.all(C4.freezes.map(async (f) => ({ f, r: await getCasesOf(f, tx) })))
    return lists.every(({ f, r }) => r.ok && r.value.items.every((h) => h.claimSubmissionId === f))
  })
  check('T053', 'A7.4 case for wrong freeze refused', !misplaced.ok && /freeze that is not this claim's/.test(misplaced.ok ? '' : misplaced.detail) && scoped, "a case naming another Claim's freeze is refused by the composer; the A7.4 owner read returns only each freeze's own cases")
  const unsupportedCase = await planted(C4.claimId, [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_contract_chk`], (tx) => insertCase(tx, c1, { contract: 'A7-REVENUE-CASE-2' }).then(() => undefined))
  check('T054', 'Unsupported case contract refused', refused(unsupportedCase) && /unsupported contract/.test(detailOf(unsupportedCase)), `an A7-REVENUE-CASE-2 case (CHECK dropped) is refused 409, not skipped: ${detailOf(unsupportedCase)}`)
  const foreignAssessment = await planted(C4.claimId, [], (tx) => insertAssessment(tx, C4case2.caseId, C4case2.manifestSha256, { organization: otherOrg }).then(() => undefined))
  check('T055', 'Foreign A7.5 assessment refused', refused(foreignAssessment) && /another organization/.test(detailOf(foreignAssessment)), `an assessment of the other organization on S2's case is refused 409: ${detailOf(foreignAssessment)}`)
  const duplicateAssessment = await planted(C4.claimId, ['DROP INDEX evidence_prereq_results_identity_key'], (tx) => insertAssessment(tx, C4case3.caseId, C4case3.manifestSha256).then(() => undefined))
  check('T056', 'Duplicate v1 assessment refused', refused(duplicateAssessment) && /more than one assessment/.test(detailOf(duplicateAssessment)), `a second v1 assessment of S3's case (identity index dropped) is refused 409: ${detailOf(duplicateAssessment)}`)
  const mismatchedCase = composeTimeline({ ...facts4, assessments: facts4.assessments.map((a, i) => (i === 0 ? { ...a, caseId: CASE1.caseId } : a)) })
  const scopedAssessments = await withReadSnapshot(undefined, async (tx) => {
    const lists = await Promise.all([C4case3.caseId, C4case4.caseId].map(async (c) => ({ c, r: await getPrerequisiteAssessmentsOf(c, tx) })))
    return lists.every(({ c, r }) => r.ok && r.value.items.every((a) => a.caseId === c))
  })
  check('T057', 'Assessment case mismatch refused', !mismatchedCase.ok && /not one of this claim's/.test(mismatchedCase.ok ? '' : mismatchedCase.detail) && scopedAssessments, "an assessment naming another Claim's case is refused by the composer; the A7.5 owner read returns only each case's own assessments")
  const digestMismatch = await planted(C4.claimId, [], (tx) => insertAssessment(tx, C4case2.caseId, 'f'.repeat(64)).then(() => undefined))
  check('T058', 'Assessment digest mismatch refused', refused(digestMismatch) && /digest/.test(detailOf(digestMismatch)), `an assessment whose case digest is not S2's case digest is refused 409: ${detailOf(digestMismatch)}`)
  const badPair = await planted(C4.claimId, [`ALTER TABLE ${PREREQ} DROP CONSTRAINT evidence_prereq_results_pairing_chk`], (tx) => insertAssessment(tx, C4case2.caseId, C4case2.manifestSha256, { basis: 'NO_REGISTERED_SOURCES' }).then(() => undefined))
  check('T059', 'Unrecognized assessment pair refused', refused(badPair) && /outcome\/basis pair/.test(detailOf(badPair)), `EXTERNAL_FINANCIAL_EVIDENCE_ABSENT with NO_REGISTERED_SOURCES (pairing CHECK dropped) is refused 409: ${detailOf(badPair)}`)
  const latestRoutes = [await get(`${timelinePath(W.claimId)}/latest`), await get(`${timelinePath(W.claimId)}?latestOnly=true`)]
  check(
    'T060',
    'No latest/current case implicitly chosen',
    refused(duplicateCase) && latestRoutes[0].status === 404 && latestRoutes[1].status === 400 && ![...deepKeys(afterLink.body)].some((k) => /latest|current|newest|selected|active/i.test(k)) && !/orderBy: \{ (recordedAt|frozenAt|createdAt): 'desc'|\.at\(-1\)|latest|newest/i.test(committedProductionCodeOf([MODULE_DIR]).code),
    'two v1 cases are a conflict, not a newest pick; there is no latest route or selector, no latest or current field, and the code never picks a newest record',
  )

  // ---------------------------------------------------------------- history consistency (T061–T070)
  section('History consistency: one snapshot, uncommitted A6.9 link, A7.4 case and A7.5 assessment, concurrent Claim edits, no lock, no writes')
  const snapFreeze = Snap.freezes[0]
  await linkedSource(snapFreeze, 'SNAPSHOT')
  const snapshotProof = await withReadSnapshot(undefined, async (tx) => {
    const first = await getRevenueTimelineOf(Snap.claimId, tx)
    const assembled = await assembleRevenueEvidenceCase(snapFreeze, {}, creatorId)
    const second = await getRevenueTimelineOf(Snap.claimId, tx)
    const ownerCases = await getCasesOf(snapFreeze, tx)
    return { first, second, assembled: assembled.ok, ownerCount: ownerCases.ok ? ownerCases.value.items.length : -1 }
  })
  const snapAfter = await timelineOf(Snap.claimId)
  check(
    'T061',
    'One coherent snapshot across owner reads',
    snapshotProof.assembled && snapshotProof.first.ok && snapshotProof.second.ok && same(stable(snapshotProof.first.value), stable(snapshotProof.second.value)) && snapshotProof.ownerCount === 0 && snapAfter.body?.submissions?.[0]?.caseSummaries?.length === 1,
    'on a held snapshot a case committed meanwhile is invisible to every owner read and the timeline is identical; a new snapshot sees it',
  )
  check(
    'T062',
    'Uncommitted A6.9 link: committed history',
    duringLinkPrompt && duringLink.status === 409 && errorCode(duringLink.body) === 'REVENUE_TIMELINE_PROVENANCE_CONFLICT' && unlinkedState.status === 409,
    'while the S2→S3 link was inserted but uncommitted, the read answered at once from the committed history — S3 frozen and still unlinked, which is a conflict (409) — never a half-linked chain',
  )
  check('T063', 'After link commit: full new chain', linked.ok && afterLink.status === 200 && same(afterLink.body.submissions.map((e: any) => e.claimSubmissionId), [S1, S2, S3]) && afterLink.body.submissions[2].priorSubmissionId === S2 && (L23 === null || afterLink.body.submissions[2].correctionLinkId === L23), 'after the link commits the timeline is S1→S2→S3 with the new link on S3')
  await linkedSource(S3, 'S3-E1')
  const hold64 = holdAt('evidenceCase.entries_inserted')
  const assembling = assembleRevenueEvidenceCase(S3, {}, creatorId)
  await Promise.race([hold64.arrived, assembling])
  const during64Promise = timelineOf(W.claimId)
  const prompt64 = await settledWithin(during64Promise, 3000)
  const during64 = await during64Promise
  hold64.release()
  const assembled64 = await assembling
  clearConcurrencyProbes()
  check('T064', 'Uncommitted A7.4 case: prior case list', prompt64 && during64.status === 200 && same(during64.body.submissions[2].caseSummaries, []), 'while the S3 case header and entries were written but uncommitted, the read answered at once with S3 showing no case')
  const after65 = await timelineOf(W.claimId)
  const case3 = assembled64.ok ? (assembled64.value as any).case : null
  const head3 = case3 ? await prisma.evidenceCaseSnapshot.findUnique({ where: { id: case3.caseId } }) : null
  check(
    'T065',
    'After case commit: whole case',
    head3 !== null && same(after65.body.submissions[2].caseSummaries, [{ caseId: head3.id, contractVersion: head3.contractVersion, assemblyCode: head3.assemblyCode, sourceCount: head3.sourceCount, classifiedCount: head3.classifiedCount, readinessCount: head3.readinessCount, itemCount: head3.itemCount, manifestSha256: head3.manifestSha256 }]),
    'after it commits, S3 shows exactly the stored case header summary',
  )
  const hold66 = holdAt('casePrerequisite.inserted')
  const assessing = assessClosurePrerequisites(CASE2.caseId, {}, creatorId)
  await Promise.race([hold66.arrived, assessing])
  const during66Promise = timelineOf(W.claimId)
  const prompt66 = await settledWithin(during66Promise, 3000)
  const during66 = await during66Promise
  hold66.release()
  const assessed66 = await assessing
  clearConcurrencyProbes()
  check('T066', 'Uncommitted A7.5 assessment: prior', prompt66 && during66.status === 200 && same(during66.body.submissions[1].prerequisiteSummaries, []), 'while the CASE2 assessment was inserted but uncommitted, the read answered at once with S2 still unassessed')
  const after67 = await timelineOf(W.claimId)
  const ASSESS2 = assessed66.ok ? assessed66.value.assessment : null
  check(
    'T067',
    'After assessment commit: exact result',
    ASSESS2 !== null && same(after67.body.submissions[1].prerequisiteSummaries, [{ assessmentId: ASSESS2.assessmentId, caseId: CASE2.caseId, contractVersion: ASSESS2.contractVersion, assessmentCode: ASSESS2.assessmentCode, basisCode: ASSESS2.basisCode, caseManifestSha256: ASSESS2.caseManifestSha256 }]),
    'after it commits, S2 shows exactly the recorded assessment',
  )
  const before68 = await timelineOf(C4.claimId)
  const hold68 = holdAt('claimLine.removed')
  const removing = removeClaimLine(C4.lineIds[1], {}, creatorId)
  await Promise.race([hold68.arrived, removing])
  const during68Promise = timelineOf(C4.claimId)
  const prompt68 = await settledWithin(during68Promise, 3000)
  const during68 = await during68Promise
  hold68.release()
  const removed68 = await removing
  clearConcurrencyProbes()
  const after68 = await timelineOf(C4.claimId)
  check('T068', 'No mixing snapshots across Claim edits', prompt68 && removed68.ok && same(stable(during68.body), stable(before68.body)) && same(stable(after68.body), stable(before68.body)), 'an A6.2 line removal on the four-freeze Claim (held uncommitted) neither blocks nor changes its timeline, before, during or after')
  const productionCode = committedProductionCodeOf([MODULE_DIR]).code
  const holdLock = holdAt('casePrerequisite.claim_locked')
  const lockHolder = assessClosurePrerequisites(CASE1.caseId, {}, creatorId)
  await Promise.race([holdLock.arrived, lockHolder])
  const duringLockPromise = timelineOf(W.claimId)
  const lockFree = await settledWithin(duringLockPromise, 3000)
  const duringLock = await duringLockPromise
  holdLock.release()
  const lockReplay = await lockHolder
  clearConcurrencyProbes()
  check('T069', 'No write lock needed for pure GET', lockFree && duringLock.status === 200 && lockReplay.ok && lockReplay.value.replayed && !/lockRowForUpdate|FOR UPDATE|FOR SHARE|NOWAIT|row-lock/.test(productionCode), "while an A7.5 request holds the Claim's row lock, the timeline answers at once; the A7.7 code requests no row lock")
  const countsBefore70 = await counts()
  for (const id of [W.claimId, C4.claimId, One.claimId, Z.claimId]) await timelineOf(id)
  const readOnlyProof = await attemptAdversarial(() => withReadSnapshot(undefined, async (tx) => tx.$executeRawUnsafe(`UPDATE ${LINKS} SET reason_code = reason_code WHERE id = $1::uuid`, L12)))
  const noXid = await prisma.$transaction(async (tx) => {
    await getRevenueTimelineOf(W.claimId, tx)
    return (await tx.$queryRaw<{ x: string | null }[]>`SELECT txid_current_if_assigned()::text AS x`)[0].x
  })
  check(
    'T070',
    'All history reads write zero rows',
    (await unchanged(countsBefore70)) && /read-only transaction/.test(readOnlyProof) && noXid === null && !/\.create\(|\.update\(|\.delete\(|\.upsert\(|INSERT |UPDATE |DELETE |recordAuditEvent|\$executeRaw/i.test(productionCode),
    'four timelines changed no row in any of the 15 tables; the snapshot refuses any write; a timeline never assigns a transaction id; the A7.7 code holds no write or audit call',
  )

  // ---------------------------------------------------------------- tenant and privacy (T071–T080)
  section('Tenant and privacy: scope first, no foreign freeze, link, case or assessment, no PHI, clinical, money, payload or secret, no audit on GET')
  const foreignWithSelector = await get(`${timelinePath(W.claimId)}?latestOnly=true`, O.who)
  const anonWithSelector = await get(`${timelinePath(W.claimId)}?latestOnly=true`, anonymous)
  const routeOrder = routeCode.indexOf("'evidenceCasePrereq.read'") < routeCode.indexOf('refuseSelectors,') && routeCode.indexOf('requireClaimId,') < routeCode.indexOf("'claim.read'")
  check('T071', 'Tenant-scoped Claim identity first', foreignWithSelector.status === 404 && anonWithSelector.status === 401 && routeOrder, 'the session and the tenant scope are judged before the request shape: a foreign Admin with a selector still gets 404, an anonymous caller 401')
  const homeTimelines = [TW.body, T1.body, T4.body, TZ0.body, afterLink.body, after67.body, snapAfter.body]
  const homeText = JSON.stringify(homeTimelines)
  const foreignBodies = JSON.stringify([foreignOnHome.body, homeOnForeign.body, foreignWithSelector.body])
  const OF = await timelineOf(F.claimId, O.who)
  check('T072', 'Foreign freeze never exposed', F.freezes.every((f) => !homeText.includes(f) && !foreignBodies.includes(f)) && !foreignBodies.includes(S1) && OF.status === 200 && same(OF.body.submissions.map((e: any) => e.claimSubmissionId), F.freezes), "no timeline or refusal of this tenant names the other organization's freezes (they appear only on its own timeline), and no refusal names this tenant's")
  check('T073', 'Foreign correction link never exposed', !homeText.includes(FL) && !foreignBodies.includes(FL) && !foreignBodies.includes(L12) && OF.body.submissions[1].correctionLinkId === FL, "the other organization's link appears only on its own timeline")
  check('T074', 'Foreign case ID never exposed', !homeText.includes(FCASE.caseId) && !foreignBodies.includes(FCASE.caseId) && !foreignBodies.includes(CASE1.caseId), "the other organization's case appears only on its own timeline")
  check('T075', 'Foreign assessment ID never exposed', !homeText.includes(FASSESS.assessmentId) && !foreignBodies.includes(FASSESS.assessmentId) && !foreignBodies.includes(ASSESS1.assessmentId), "the other organization's assessment appears only on its own timeline")
  const exposedKeys = [...deepKeys(JSON.parse(homeText))]
  check('T076', 'No patient name or membership fields', !homeText.includes(`${runId}-home-P`) && !homeText.includes('1990-01-01') && !exposedKeys.some((k) => /patient|member|name|birth|email|phone|address|gender|user|actor|recordedBy/i.test(k)), 'no patient, member, user or actor value or key')
  check('T077', 'No diagnosis, procedure or clinician', !exposedKeys.some((k) => /diagnos|procedure|activity|encounter|clinician|facility|line/i.test(k)) && !homeText.includes(key('home-DXA')) && !homeText.includes(key('home-PA')), 'no diagnosis, procedure, activity, encounter, clinician, facility or line key or value')
  check('T078', 'No amounts, currency, balance, verdict', !/125\.25|12\.125|200\.01|AED/.test(homeText) && !exposedKeys.some((k) => /amount|balance|currency|price|fee|payer|payment|denial|adjudicat|status|verdict|disposition|lifecycle/i.test(k)) && !/"(PAID|DENIED|SETTLED|CLOSED|RELEASE_ELIGIBLE|READY_FOR_CLOSURE)"/.test(homeText), 'no amount, currency, balance, payer, payment, denial, verdict, status or disposition key or value')
  check('T079', 'No payload, manifest bytes or secrets', !exposedKeys.some((k) => /bytes|payload|seal|manifestText|sourceReference|fingerprint|secret|token|password|cookie|raw/i.test(k)) && !homeText.includes(ref('E1')) && !homeText.includes(K1.E), 'no frozen payload, manifest bytes, seal, fingerprint, source reference, source id or secret — only identifiers, codes, counts and case digests')
  const auditsBefore80 = await prisma.auditEvent.count()
  for (const who of [asAdmin, asViewer, B.who, N.who, O.who]) await timelineOf(W.claimId, who)
  await timelineOf(MISSING)
  await timelineOf('not-a-uuid')
  check('T080', 'No GET audit event created', (await prisma.auditEvent.count()) === auditsBefore80, 'successful and refused timeline reads by five users wrote no audit')

  // ---------------------------------------------------------------- determinism and pure reducer (T081–T090)
  section('Determinism: identical reads, immutable history under new evidence, UTC+14 and locale, stable empty case, no newest, no state, unknown code, unit vectors')
  const twice = [await timelineOf(W.claimId), await timelineOf(W.claimId)]
  check('T081', 'Identical history: identical output', same(stable(twice[0].body), stable(twice[1].body)) && same(stable(twice[0].body), stable(after67.body)) && twice.every((r) => typeof r.body.evaluatedAt === 'string' && new Date(r.body.evaluatedAt).toISOString() === r.body.evaluatedAt), 'two reads of the unchanged history are byte-identical apart from evaluatedAt, a canonical UTC instant')
  const case1Before82 = await caseHash(CASE1.caseId)
  const s1Before82 = twice[0].body.submissions[0]
  await linkedSource(S1, 'E-LATER')
  const after82 = await timelineOf(W.claimId)
  check('T082', 'Source insertion cannot mutate a case', (await caseHash(CASE1.caseId)) === case1Before82 && same(after82.body.submissions[0], s1Before82), 'a source registered, classified and gated on S1 later leaves CASE1 and S1\'s entry byte-identical')
  const case2Hash = await caseHash(CASE2.caseId)
  check('T083', 'New assessment does not alter a case', ASSESS2 !== null && (await caseHash(CASE2.caseId)) === case2Hash && same(after82.body.submissions[1].caseSummaries, wEntries[1].caseSummaries), 'after ASSESS2 is recorded, CASE2 and its summary are unchanged; only the assessment list gained ASSESS2')
  const probe = spawnSync(
    process.execPath,
    ['--env-file=.env', '--input-type=module', '-e', `import { prisma } from './src/shared/database/prisma.ts'; import { getRevenueTimeline } from './src/modules/revenue-timeline/revenue-timeline.service.ts'; const r = await getRevenueTimeline('${W.claimId}'); const { evaluatedAt, ...rest } = r.ok ? r.value : {}; console.log(JSON.stringify([rest, Intl.DateTimeFormat().resolvedOptions().timeZone, Intl.DateTimeFormat().resolvedOptions().locale])); await prisma.$disconnect()`],
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
    return getRevenueTimelineOf(W.claimId, tx)
  })
  check('T084', 'Deterministic across UTC+14 runtime', probed !== null && probed[1] === 'Pacific/Kiritimati' && same(probed[0], stable(after82.body)) && zoned.ok && same(stable(zoned.value), stable(after82.body)), 'a separate process in Pacific/Kiritimati and a database session in that zone compose the identical timeline')
  const lowerings = (productionCode.match(/\.toLowerCase\(\)/g) ?? []).length
  const idLowerings = (productionCode.match(/claimId\)?\.toLowerCase\(\)/g) ?? []).length
  check('T085', 'Deterministic across locale change', probed !== null && same(probed[0], stable(after82.body)) && !/toLocale|Intl\.|localeCompare|toUpperCase/.test(productionCode) && lowerings === idLowerings, `with a ${probed?.[2] ?? '?'} process locale the sequence and codes are the same; A7.7 orders by chain edges and code-unit comparison only, and only lower-cases the path id (${idLowerings})`)
  const oneTwice = [await timelineOf(One.claimId), await timelineOf(One.claimId)]
  check('T086', 'One-node empty-case stable', oneTwice.every((r) => same(stable(r.body), stable(T1.body))) && same(T1.body.submissions[0].caseSummaries, []) && same(T1.body.submissions[0].prerequisiteSummaries, []), 'the one-freeze, no-case timeline reads back identically every time')
  const wCount = await prisma.claimFreeze.count({ where: { claimId: W.claimId } })
  check('T087', 'No hidden newest selection', after82.body.historyCount === wCount && wCount === 3 && after82.body.submissions[0].claimSubmissionId === S1 && !/findFirst|take: 1|\.at\(-1\)|\[0\]\.claimSubmissionId/.test(productionCode), 'every freeze of the Claim is listed (3 of 3), the root first; nothing selects a newest submission')
  const allCodes88 = [...homeTimelines, after82.body].flatMap((t: any) => t.submissions.flatMap((e: any) => e.prerequisiteSummaries.map((a: any) => a.assessmentCode)))
  check('T088', 'No silent ready/closed/paid state', allCodes88.every((c) => (assessmentCodes as readonly string[]).includes(c)) && !/READY|CLOSED|PAID|SETTLED|RECONCILED/.test(JSON.stringify([...homeTimelines, after82.body]).replace(/NOT_READY_FOR_ADJUDICATION/g, '')) && !exposedKeys.some((k) => /ready|closed|paid|settled/i.test(k)), 'only the recorded A7.5 codes appear; no ready, closed, paid or settled value or field')
  const unknownCode = await planted(C4.claimId, [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_code_chk`, `ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_code_counts_chk`], (tx) => insertCase(tx, c1, { code: 'INVENTORY_READY' }).then(() => undefined))
  check('T089', 'Unknown controlled code produces 409', refused(unknownCode) && /uncontrolled assembly code/.test(detailOf(unknownCode)), `an INVENTORY_READY case (CHECKs dropped) is refused 409, never shown: ${detailOf(unknownCode)}`)
  const unit90 = run(`node --test ${UNIT_TESTS[0].replace('backend/', '')}`)
  const unitText = readFileSync(`../${UNIT_TESTS[0]}`, 'utf8')
  check('T090', 'Reducer tests cover legal and illegal graphs', unit90.ok && /ℹ pass 9/.test(unit90.output) && /ℹ fail 0/.test(unit90.output) && ['one freeze', 'four linked', 'fork', 'join', 'two-node cycle', 'longer cycle', 'self-link', 'cross-claim', 'equal freeze instant', 'unlinked extra freeze', 'two unrelated roots', 'duplicate', 'foreign'].every((word) => unitText.includes(word)), 'the 9 pure-composer tests pass and cover one-node, four-node, unlinked, second root, fork, join, both cycles, self-link, cross-Claim, equal instants, foreign and duplicate cases and assessments')

  // ---------------------------------------------------------------- boundary protections (T091–T100)
  section('Boundaries: no A6 or A7.1–A7.5 row changed by reading, no disposition as payer release, no A7.6 duplication, no A7.8–A9 domain')
  const before91 = {
    freezes: await Promise.all([W, C4, One, Z, F].map((c) => freezeHash(c.claimId))), lifecycles: await Promise.all([W, C4].map((c) => lifecycleHash(c.claimId))), corrections: await Promise.all([W, C4, F].map((c) => correctionHash(c.claimId))),
    sources: await sourceHash(), classifications: await classificationHash(), readiness: await readinessHash(), cases: await allCasesHash(), assessments: await allAssessmentsHash(),
  }
  for (const c of [W, C4, One, Z]) await timelineOf(c.claimId)
  await timelineOf(F.claimId, O.who)
  check('T091', 'A6.7 frozen bytes untouched by GET', same(await Promise.all([W, C4, One, Z, F].map((c) => freezeHash(c.claimId))), before91.freezes), 'every byte of every freeze and sealed manifest of five Claims is identical after reading their timelines')
  const Re = await home.series('release eligible', 1)
  await post(`/api/claim-submissions/${Re.freezes[0]}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null })
  const reLifecycle = await lifecycleHash(Re.claimId)
  const reTimeline = await timelineOf(Re.claimId)
  check(
    'T092',
    'A6.8 disposition not called payer release',
    reTimeline.status === 200 && (await get(`/api/claim-submissions/${Re.freezes[0]}/lifecycle`)).body?.state === 'RELEASE_ELIGIBLE' && ![...deepKeys(reTimeline.body)].some((k) => /disposition|lifecycle|release|state|status|sent/i.test(k)) && !JSON.stringify(reTimeline.body).includes('RELEASE') && (await lifecycleHash(Re.claimId)) === reLifecycle && same(before91.lifecycles, await Promise.all([W, C4].map((c) => lifecycleHash(c.claimId)))),
    'a RELEASE_ELIGIBLE freeze reads with no disposition, release or status anywhere in its timeline (v1 omits the internal disposition); every lifecycle is byte-identical',
  )
  check('T093', 'A6.9 correction history unchanged', same(await Promise.all([W, C4, F].map((c) => correctionHash(c.claimId))), before91.corrections), 'every correction link of three Claims is byte-identical after reading')
  check('T094', 'A7.1 source owner unchanged', (await sourceHash()) === before91.sources, "every byte of this run's A7.1 sources is identical")
  check('T095', 'A7.2 classification owner unchanged', (await classificationHash()) === before91.classifications, "every byte of this run's A7.2 classifications is identical")
  check('T096', 'A7.3 readiness owner unchanged', (await readinessHash()) === before91.readiness, "every byte of this run's A7.3 readiness results is identical")
  check('T097', 'A7.4 snapshots unchanged', (await allCasesHash()) === before91.cases, 'every byte of every A7.4 case header and entry is identical')
  check('T098', 'A7.5 assessments unchanged', (await allAssessmentsHash()) === before91.assessments, 'every byte of every A7.5 assessment is identical')
  check('T099', 'A7.6 trace logic not duplicated', !/closure-basis-trace|traceClosureBasis|getClosureBasisTrace|explanationCode|traceItems|explanationOfReadiness/.test(productionCode) && ![...deepKeys(JSON.parse(homeText))].some((k) => /trace|explanation/i.test(k)), 'A7.7 neither imports nor re-implements the A7.6 trace and returns no trace or explanation field')
  const laterRoutes = [await post(`/api/claims/${W.claimId}/closures`, {}), await post(`/api/claims/${W.claimId}/payments`, {}), await post(`/api/claims/${W.claimId}/remittances`, {}), await post(`/api/claims/${W.claimId}/exceptions`, {}), await post(timelinePath(W.claimId), {})]
  const laterTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(adjudicat|denial|allowed|remittance|settle|import|inbound|outbox|queue|transmission|acknowledg|closure|reconcil|exception|timeline|receivable|ledger|balance|payment)'`).map((row) => row.t)
  const moneyIdentifier = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|toFixed\(|[Ss]ettle|[Aa]llocat|[Aa]djust|[Rr]eceivable|[Bb]alance|[Ll]edger|[Pp]ayment|[Rr]emittance/
  check(
    'T100',
    'No A7.8/A8/A9 domain or integration code',
    laterRoutes.every((r) => r.status === 404) && laterTables.length === 0 && !moneyIdentifier.test(productionCode) && !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|enqueue|setInterval|worker_threads|cron/i.test(productionCode) && committedProductionCodeOf([MODULE_DIR]).files.length === 5,
    'no closure, payment, remittance or exception route, no such table (nor a timeline table), and the five A7.7 backend files hold no money, network, queue, job or worker code',
  )

  const goldenBefore = stable((await timelineOf(W.claimId)).body)

  // ---------------------------------------------------------------- nested substantive regressions (T101–T110)
  section('Regressions — A7.6 invoked, nesting A7.5 -> A7.4 -> A7.3 -> A7.2 -> A7.1 -> A6.10 -> … -> A6.1 -> A5.10 -> A1')
  await apiReady('the A7.6 and backward regression chain')
  // Rows written from here on belong to the nested suites' own fixtures (each proves its own); T120 judges this run's.
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const chain = run('npm run test:a7:closure-basis-trace')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.6')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.6] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.6 asserts facts about its own branch (name, tracking, production diff), its nested N/A proofs against its own
  // branch, and its own upstream. On A7.7 those statements are obsolete by design; every other A7.6 check — its
  // no-migration gate T004 included — is substantive. T110 below proves each cause independently, never from the id.
  const a76NonApplicable: Record<string, string> = {
    T001: "A7.6 'Correct A7.5 merge prerequisite' requires the A7.6 feature branch (and reads any other A7 suite as later code); A7.7 is branched from the main that contains the A7.6 merge",
    T002: "A7.6 'Clean tree and exact origin parity' requires tracking origin/feature/a7-6-…, deleted when it merged; the clean tree and exact origin parity of THIS branch are proved by T002 here",
    T010: "A7.6 'Only allowlisted A7.6 files changed' lists the paths A7.6 was allowed to change; A7.7 legitimately changes its own (T010 here)",
    T120: "A7.6 'Historical N/A independently justified' proves A7.5's branch-only causes against the A7.6 branch (its name, tracking and diff); on A7.7 those proofs are re-done here (T110)",
    T130: "A7.6 'Exact head, scope and two complete runs' requires the upstream to be the A7.6 feature branch, deleted when it merged (exact head and repeatability are T122/T125 here)",
  }
  const undocumented = failing.filter((id) => !(id in a76NonApplicable))
  const summary = chain.output.match(/\[A7\.6\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.6\] RUN ABORTED|\[A7\.6\] uncaught error|\[A7\.6\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a76Substantive = rows.filter((row) => !(row.id in a76NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a76Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T101',
    'A7.6 read-only trace suite PASS',
    ran && reconciled && undocumented.length === 0 && a76Substantive.length === 0 && a76Passing >= 125 && ['T004', 'T006', 'T009', 'T070', 'T080', 'T128'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A7.6 suite did not complete'
      : !reconciled
        ? `A7.6 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.6 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.6\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.6] automated summary: ', 'A7.6 ')}; all ${a76Passing} substantive checks PASS (its no-migration T004 included) and every failure is documented`,
  )
  for (const id of Object.keys(a76NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T101/${id}`, `A7.6 ${titleOf(row.line)}`, a76NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T102', 'A7.5 assessment suite PASS', verdictOf('T111') === 'PASS', `A7.6 T111 (A7.5 with its own justified N/A) ${verdictOf('T111')}`)
  check('T103', 'A7.4 case suite PASS', verdictOf('T112') === 'PASS', `A7.6 T112 (A7.4) ${verdictOf('T112')}`)
  check('T104', 'A7.3 readiness suite PASS', verdictOf('T113') === 'PASS', `A7.6 T113 (A7.3) ${verdictOf('T113')}`)
  check('T105', 'A7.2 classification suite PASS', verdictOf('T114') === 'PASS', `A7.6 T114 (A7.2) ${verdictOf('T114')}`)
  check('T106', 'A7.1 revenue-source suite PASS', verdictOf('T115') === 'PASS', `A7.6 T115 (A7.1) ${verdictOf('T115')}`)
  check('T107', 'A6.10 cumulative suite PASS', verdictOf('T116') === 'PASS', `A7.6 T116 (A6.10) ${verdictOf('T116')}`)
  check('T108', 'A6.1–A6.9 suites PASS', verdictOf('T117') === 'PASS', `A7.6 T117 (A6.9 … A6.1) ${verdictOf('T117')}`)
  check('T109', 'A5 and A1–A4 regressions PASS', verdictOf('T118') === 'PASS' && verdictOf('T119') === 'PASS', `A7.6 T118 (A5.10 → A5.1) ${verdictOf('T118')} and T119 (A1–A4) ${verdictOf('T119')}`)
  // Each documented A7.6 failure must fail for its branch-only reason, proved independently on this branch.
  const allowed = ['backend/package.json', 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'frontend/src/developer/checkRegistry.tsx']
  const ownDirs = [MODULE_DIR, FE_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const a76Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA75 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const causes: Record<string, boolean> = {
    T001: branch === a77Branch && a76Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a76Merge} HEAD`),
    T002: /working tree clean/.test(lineOfRow('T002')) && dirty.length === 0 && tracking.includes(`origin/${a77Branch}`) && !/ahead|behind/.test(tracking),
    T010: a76Unexpected.length > 0 && a76Unexpected.every((path, index) => changedPaths.includes(path) || (index === a76Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A7.6 re-proves A7.5's branch-only causes against the A7.6 branch; on A7.7 only those tied to the branch (its
    // name, tracking, diff and upstream) can be unproven — re-proved here against this branch.
    T120: unprovenA75.length > 0 && unprovenA75.every((id) => ['T001', 'T002', 'T004', 'T010', 'T120', 'T130'].includes(id)) && prismaStatus.length === 0 && outOfScope.length === 0 && tracking.includes(`origin/${a77Branch}`),
    T130: tracking.includes(`origin/${a77Branch}`) && !/origin\/feature\/a7-6/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A7\.6\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T110',
    'Only documented obsolete branch guards N/A',
    ran && failing.every((id) => id in a76NonApplicable) && unproven.length === 0 && naLines.length === 6 && naLines.every((line) => line.length > 80) && ownerChanged.length === 0,
    unproven.length === 0
      ? `each documented A7.6 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved independently here; A7.6 itself justifies its six A7.5 items (${naLines.length} lines)`
      : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- build and database gates (T111–T120)
  section('Units, typecheck, frontend, unchanged migrations and checksums, outage and recovery, no 5xx, synthetic fixtures')
  const allUnit = run('npm run test:unit')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  check('T111', 'Backend unit tests PASS', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 13/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 13 A7.7 composer and request tests`)
  const typecheck = run('npm run typecheck')
  check('T112', 'Backend typecheck PASS', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T113', 'Frontend lint PASS', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T114', 'Frontend build PASS', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const appliedTotal = Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].n)
  check('T115', 'Database migration status unchanged', status.ok && /Database schema is up to date/.test(status.output) && appliedTotal === headMigrationDirs.length && same(headMigrationDirs, baseMigrationDirs), `${appliedTotal} applied = ${headMigrationDirs.length} committed = main's; nothing added`)
  const appliedChecksum = (await prisma.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM _prisma_migrations WHERE migration_name = ${A75_MIGRATION_NAME} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.checksum
  const blob = spawnSync('git', ['show', `HEAD:${A75_MIGRATION}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  check('T116', 'From-empty replay and checksums PASS', replay.ok && /ALL CHECKS PASS/.test(replay.output) && (appliedChecksum === sha256Of(readFileSync(`../${A75_MIGRATION}`)) || appliedChecksum === sha256Of(blob)), `scratch replay ALL CHECKS PASS (T006); the newest applied migration still carries its committed checksum (${(appliedChecksum ?? '').slice(0, 12)}…)`)
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
  check('T117', 'Health 200, readiness 503 in DB outage', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady, 'up 200/200; with the database stopped health stayed 200 and ready reported 503')
  const restarted = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  await waitFor(databaseUp, 60_000)
  check('T118', 'Recovery readiness 200', restarted && recovered, 'after the database restarts, ready reports 200 again')
  check('T119', 'No unexpected HTTP 5xx or reset', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runFreezes = await prisma.$queryRawUnsafe<{ org: string }[]>(
    `SELECT p.organization_id::text AS org FROM ${FREEZES} f JOIN claims k ON k.id = f.claim_id JOIN encounters e ON e.id = k.encounter_id JOIN patients p ON p.id = e.patient_id WHERE f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  const runSources = await prisma.$queryRawUnsafe<{ kind: string; reference: string }[]>(`SELECT source_kind AS kind, source_reference AS reference FROM revenue_source_evidence WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, runStartedAt.toISOString(), chainStartedAt.toISOString())
  check(
    'T120',
    'Synthetic-only fixtures, no real PHI',
    runFreezes.length > 0 && runFreezes.every((f) => [org, otherOrg].includes(f.org)) && runSources.length > 0 && runSources.every((s) => s.kind === SYNTHETIC && s.reference.includes(runToken)) && !/['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]/.test(productionCode),
    `the ${runFreezes.length} freezes and ${runSources.length} sources this run recorded (before the nested chain) are all of the two synthetic organizations, every source INTERNAL_SYNTHETIC and keyed by ${runId}; no id is hard-coded in A7.7`,
  )

  // ---------------------------------------------------------------- scope (T010) and final identity (T121–T130)
  section('Diff scope, exact head and final identity')
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|reconcil|exception|integration\/a(8|9)|dhpo|eclaimlink|prisma\//i.test(file))
  check(
    'T010',
    'Only A7.7 allowed file paths changed',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A7.7 module, harness and check page, one error code, the route mount, the scripts and the registry entry; no migration, schema, permission, audit or owner change; no A7.8+/A8/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  check('T121', 'Actual run ID printed', /^A77-\d{13}$/.test(runId) && Number(runId.slice(4)) === runStartedAt.getTime(), `this execution is run ${runId}, printed at its start and in its summary; the two submitted runs carry two distinct ids`)
  const headNow = git('rev-parse HEAD')
  const originHead = gitArgs(['rev-parse', `origin/${a77Branch}`])
  check('T122', 'Run uses the exact pushed HEAD', headNow === headAtStart && headNow === originHead && headNow.length === 40, `HEAD ${headNow} at start and end, equal to origin/${a77Branch}; both submitted runs must print this same HEAD`)
  const expected = Array.from({ length: 122 }, (_, i) => `T${String(i + 1).padStart(3, '0')}`)
  const seen = new Map<string, number>()
  for (const id of printedIds) seen.set(id, (seen.get(id) ?? 0) + 1)
  check('T123', 'Every check has an explicit result', expected.every((id) => seen.get(id) === 1) && printedIds.filter((id) => !expected.includes(id)).length === 0, `T001–T122 each printed exactly one PASS/FAIL line so far (T123–T130 follow); ${notApplicable} nested N/A line(s) are separate and named`)
  const goldenAfter = stable((await timelineOf(W.claimId)).body)
  console.log(`[${TAG}]      worked example: Claim K ${W.claimId}: S1 ${S1} (CASE1 ${CASE1.caseId} + ASSESS1 ${ASSESS1.assessmentId} ${ASSESS1.assessmentCode}) -> L12 -> S2 ${S2} (CASE2, unassessed until ASSESS2) -> S3 appended through A6.9 without changing S1 or S2`)
  console.log(`[${TAG}]      worked example: corrupt histories (second root, fork, join, cycles, self-link, cross-Claim, equal instant, unlinked freeze) planted and rolled back -> 409 with no partial timeline; nothing paid, closed or adjudicated`)
  check('T124', 'Golden chain identical after restart', same(goldenAfter, goldenBefore) && goldenAfter.historyCount === 3, 'after the nested chain and a database restart, Claim K reads back identically (all but evaluatedAt)')
  const dirtyNow = git('status --porcelain')
  const trackingNow = git('status -sb').split(/\r?\n/)[0]
  check('T125', 'Exact HEAD, origin clean, no unauthorized change', dirtyNow === '' && trackingNow.includes(`origin/${a77Branch}`) && !/ahead|behind/.test(trackingNow) && outOfScope.length === 0 && ownerChanged.length === 0, `${trackingNow}; working tree clean; the diff is exactly the allowed A7.7 scope (T010)`)
  const handoff = `[${TAG}] HANDOFF: A7.7 is a read-only projection of A6.7 freezes, the A6.9 chain, A7.4 cases and A7.5 assessments; the next module boundary is A7.8 — any payer evidence, adjudication, remittance, payment, balance, exception workflow (A8) or external adapter (A9) stays outside A7.7`
  console.log(handoff)
  check('T126', 'Written handoff names next boundary', /HANDOFF: .* next module boundary is A7\.8/.test(handoff), 'the handoff above names A7.8 as the next boundary and keeps A8/A9 outside')
  check('T127', 'No skipped or suppressed failed check', failures.length === failed && failLines === failed && printedIds.length === passed + failed, `${failed} failure(s) recorded, ${failLines} FAIL line(s) printed, ${printedIds.length} checks printed = ${passed} passed + ${failed} failed; none skipped`)
  check('T128', 'No broad N/A substitution', notApplicableIds.every((id) => /^T101\/T\d{3}$/.test(id) && id.slice(5) in a76NonApplicable) && notApplicable <= Object.keys(a76NonApplicable).length && !printedIds.some((id) => id.includes('/')), `${notApplicable} N/A line(s), all documented A7.6 branch-only items under T101; no functional check of A7.7 is N/A`)
  const financialTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(payment|remittance|ledger|receivable|balance|settle|adjudicat)'`).map((row) => row.t)
  check('T129', 'No generated payer or financial outcome', financialTables.length === 0 && allCodes88.every((c) => (assessmentCodes as readonly string[]).includes(c)) && [...homeTimelines].every((t: any) => t.submissions.every((e: any) => e.prerequisiteSummaries.every((a: any) => (basisCodes as readonly string[]).includes(a.basisCode)))), 'no payer or financial table exists; every outcome shown is a recorded A7.5 prerequisite code, never a payment, remittance or balance')
  check('T130', 'Written acceptance summary 130/130', failed === 0 && passed === 129 && printedIds.length === 129, `${passed}/129 checks before this one PASS; this run's summary below states ${failed === 0 ? '130/130' : 'a failure'} — a second independent run must state the same`)

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] REVENUE EVIDENCE TIMELINE ACCEPTANCE COMPLETE` : `[${TAG}] A7.7 FINAL FAIL`)
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
