import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
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
import { getRevenueTimelineOf } from '../../modules/revenue-timeline/revenue-timeline.service.ts'
import { deriveRevenueDelta } from '../../modules/revenue-delta/revenue-delta.reducer.ts'
import { getRevenueDeltaOf } from '../../modules/revenue-delta/revenue-delta.service.ts'
import { deriveRevenueContinuity } from '../../modules/revenue-continuity/revenue-continuity.reducer.ts'
import { getRevenueContinuityOf } from '../../modules/revenue-continuity/revenue-continuity.service.ts'
import type { DeltaFacts, TimelineFacts } from '../../modules/revenue-continuity/revenue-continuity.types.ts'

// A7.10 — A7 Integration Acceptance & Phase Closure (acceptance label A7-PHASE-CLOSURE-1, T001–T130).
//
// An engineering acceptance checkpoint, never a financial closure: it proves that the accepted A7.1–A7.9 owners keep
// one coherent, explainable, immutable revenue-evidence history and that nothing claims a payment, a payer decision,
// a balance or a closed Claim. It adds no product code.
//
// Every Claim, freeze and correction link is built through its owners exactly as the A6.10 and A7.x suites build them;
// every source is registered through the A7.1 route, classified through A7.2, gated through A7.3, cased through A7.4
// and assessed through A7.5; traces, timelines, deltas and continuity results are read through their routes (or, on a
// harness-held snapshot, through their transaction-aware services). Real adversarial histories are made through the
// owners where an owner allows them (a second root frozen without a link) or refuses them (self and wrong-Claim
// corrections). Corrupt histories no owner can record are planted only in a transaction that is ALWAYS rolled back,
// owner guards off and the one blocking CHECK or index dropped inside it, and judged there by the production A7.7,
// A7.8 and A7.9 services. Disagreements between owners that cannot be stored are forged on the REAL owner results and
// judged by the production reducers; A7.9 output, which no product owner consumes, is judged by this harness's own
// acceptance cross-check against the A7.7 timeline and the stored rows. Synthetic users are provisioned per run
// through Better Auth's own server-side creation with a random password that is never printed.

const TAG = 'A7.10'
const ACCEPTANCE = 'A7-PHASE-CLOSURE-1'
let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []
const printed: string[] = []
const printedIds = new Map<string, number>()
const ownNa: string[] = []

const say = (line: string) => {
  printed.push(line)
  console.log(line)
}

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  printedIds.set(id, (printedIds.get(id) ?? 0) + 1)
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
  ownNa.push(id)
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  say(`[${TAG}] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => say(`\n[${TAG}] ${title}`)
const progress = (text: string) => say(`[${TAG}]      ${text}`)

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

const runId = `A710-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(5)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
const A7_BRANCHES = [
  'feature/a7-1-revenue-source-evidence', 'feature/a7-2-evidence-classification', 'feature/a7-3-adjudication-evidence-readiness', 'feature/a7-4-revenue-evidence-case-assembly',
  'feature/a7-5-case-closure-prerequisite-assessment', 'feature/a7-6-closure-basis-trace', 'feature/a7-7-revenue-evidence-timeline', a78Branch, a79Branch,
]
const A610_BRANCH = 'feature/a6-10-a6-integration-acceptance'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const HARNESS_DIR = 'backend/src/integration/a7-phase-closure'
const CLOSURE_DOC = 'docs/A7_Phase_Closure.md'
const SCRIPT = 'node --env-file=.env src/integration/a7-phase-closure/a7-phase-closure.integration.ts'
const PREREQ = 'evidence_prereq_results'
const HEADER = 'evidence_case_snapshots'
const ENTRY = 'evidence_case_entries'
const LINKS = 'claim_correction_links'
const FREEZES = 'claim_freezes'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const A7_MODULES = ['revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case', 'case-prerequisite', 'closure-basis-trace', 'revenue-timeline', 'revenue-delta', 'revenue-continuity']
const A7_MODULE_DIRS = A7_MODULES.map((name) => `backend/src/modules/${name}`)
const CONTRACT_SOURCES: [string, string, string][] = [
  ['revenue-evidence/revenue-evidence.types.ts', 'REVENUE_SOURCE_CONTRACT_VERSION', 'A7-REVENUE-SOURCE-1'],
  ['evidence-classification/evidence-classification.types.ts', 'CLASSIFICATION_CONTRACT_VERSION', 'A7-EVIDENCE-CLASS-1'],
  ['evidence-gate/evidence-gate.types.ts', 'READINESS_CONTRACT_VERSION', 'A7-ADJ-READINESS-1'],
  ['evidence-case/evidence-case.types.ts', 'CASE_CONTRACT_VERSION', 'A7-REVENUE-CASE-1'],
  ['case-prerequisite/case-prerequisite.types.ts', 'PREREQ_CONTRACT_VERSION', 'A7-CLOSURE-PREREQ-1'],
  ['closure-basis-trace/closure-basis-trace.types.ts', 'TRACE_CONTRACT_VERSION', 'A7-CLOSURE-TRACE-1'],
  ['revenue-timeline/revenue-timeline.types.ts', 'TIMELINE_CONTRACT_VERSION', 'A7-REVENUE-TIMELINE-1'],
  ['revenue-delta/revenue-delta.types.ts', 'DELTA_CONTRACT_VERSION', 'A7-REVENUE-DELTA-1'],
  ['revenue-continuity/revenue-continuity.types.ts', 'CONTINUITY_CONTRACT_VERSION', 'A7-REVENUE-CONTINUITY-1'],
]
const GAP_CODES = ['CASE_NOT_RECORDED', 'PREREQUISITE_NOT_RECORDED', 'NO_SOURCE_BASIS', 'SOURCE_CHAIN_INCOMPLETE', 'REVIEW_REQUIRED', 'UNSUPPORTED_SOURCE', 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT']
const EXPECTED_IDS = Array.from({ length: 130 }, (_, i) => `T${String(i + 1).padStart(3, '0')}`)
// Every table a read could conceivably touch, in a fixed key order. A read must leave every one exactly as it was.
const COUNT_TABLES = [PREREQ, HEADER, ENTRY, 'evidence_gate_results', 'source_evidence_classifications', 'revenue_source_evidence', 'audit_events', 'claims', 'claim_lines', 'claim_pricing_runs', 'claim_review_events', FREEZES, 'claim_freeze_evidence_manifests', 'claim_freeze_lifecycle_events', LINKS]
// Known A10 warning classes and the phrase the closure record must use for each.
const KNOWN_WARNINGS: { name: string; line: RegExp; recorded: string }[] = [
  { name: 'pg client.query() deprecation', line: /client\.query\(\) when the client is already executing a query/, recorded: 'client.query()' },
  { name: 'Vite 500 kB chunk advisory', line: /chunks are larger than 500/i, recorded: '500 kB' },
]

const deepKeys = (value: unknown, found: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(value)) for (const item of value) deepKeys(item, found)
  else if (value !== null && typeof value === 'object')
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      found.add(key)
      deepKeys(child, found)
    }
  return found
}
// Every string value anywhere in a value.
const deepStrings = (value: unknown, found: string[] = []): string[] => {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const item of value) deepStrings(item, found)
  else if (value !== null && typeof value === 'object') for (const child of Object.values(value as Record<string, unknown>)) deepStrings(child, found)
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
// A projection without its evaluation instant: the only field that may differ between two reads of the same history.
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
  say(`[${TAG}] A7.10 A7 integration acceptance & phase closure (${ACCEPTANCE}) — run ${runId}`)
  say(`[${TAG}] HEAD at start ${headAtStart} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- preflight (T001–T010)
  section('Preflight: the accepted A7.9 merge, A6.10 and A7.1–A7.9 ancestry, no schema, migration, permission, audit or route change, contracts, diff scope')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a79Merge = mergeOf(a79Branch)
  const a610Merge = mergeOf(A610_BRANCH)
  const a7Merges = A7_BRANCHES.map((name) => ({ name, sha: mergeOf(name) }))
  const continuityExport = /export async function getRevenueContinuityOf\(claimId: string, tx: DbClient\)/.test(committedCode('backend/src/modules/revenue-continuity/revenue-continuity.service.ts'))
  const continuityRoute = /continuityRouter\.get\(\s*'\/:claimId\/revenue-evidence-continuity'/.test(committedCode('backend/src/modules/revenue-continuity/revenue-continuity.route.ts'))
  const constantOf = (path: string, name: string) => (committedText(`backend/src/modules/${path}`).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  check(
    'T001',
    'A7.9 exact merge ancestor confirmed',
    branch === a710Branch && a79Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a79Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && continuityExport && continuityRoute && constantOf(CONTRACT_SOURCES[8][0], CONTRACT_SOURCES[8][1]) === 'A7-REVENUE-CONTINUITY-1',
    `branch ${branch}; A7.9 merged as ${a79Merge.slice(0, 7) || 'NOT FOUND'} and is an ancestor; latest main ${git('rev-parse --short origin/main')} contained; A7.9 as implemented: GET /api/claims/:claimId/revenue-evidence-continuity, A7-REVENUE-CONTINUITY-1, getRevenueContinuityOf(claimId, tx)`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean synchronized HEAD, origin parity', dirty.length === 0 && tracking.includes(`origin/${a710Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'A6.10 and A7.1–A7.9 ancestry verified',
    a610Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a610Merge} HEAD`) && a7Merges.every((m) => m.sha.length === 40 && gitOk(`merge-base --is-ancestor ${m.sha} HEAD`)),
    `A6.10 ${a610Merge.slice(0, 7)}; A7.1–A7.9 ${a7Merges.map((m) => m.sha.slice(0, 7)).join(', ')} — every merge is an ancestor of HEAD`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const prismaStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  const baseMigrationDirs = migrationDirsAt('origin/main')
  check('T004', 'No new product migration or model', prismaStatus.length === 0 && same(headMigrationDirs, baseMigrationDirs) && !changedPaths.some((p) => /schema\.prisma|^backend\/src\/(modules|shared)\//.test(p)), prismaStatus.length === 0 ? `schema and all ${headMigrationDirs.length} migrations identical to main; no module or shared code changed` : `prisma changes: ${prismaStatus.join(' | ')}`)
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma validate/generate/status pass', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'the unchanged schema validates and generates; the working database is up to date (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check('T006', 'Scratch replay matches all migrations', replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length, `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD`)
  const authzDiff = gitArgs(['diff', 'origin/main...HEAD', '--', ':/backend/src/shared/authorization', ':/backend/src/scripts/bootstrap-authz-dev.ts', ':/backend/src/shared/audit', ':/backend/src/modules'])
  const permissionCount = await prisma.permission.count()
  check('T007', 'No new permission or audit action', authzDiff === '' && !changedPaths.some((p) => /authoriz|audit|bootstrap/i.test(p)) && permissionCount > 0, `no permission catalogue, bootstrap, audit or module code changed (${permissionCount} permissions as accepted)`)
  const appDiff = gitArgs(['diff', 'origin/main...HEAD', '--', ':/backend/src/app.ts', ':/backend/src/server.ts', ':/frontend/src'])
  check('T008', 'No extra route or payer send added', appDiff === '' && !changedPaths.some((p) => /route|router|adapter|outbox|transport|dhpo|eclaim/i.test(p)), 'app.ts, server.ts and the frontend are unchanged: no route, page or sender was added')
  const contractsNow = CONTRACT_SOURCES.map(([path, name]) => constantOf(path, name))
  const contractsMain = CONTRACT_SOURCES.map(([path, name]) => (gitArgs(['show', `origin/main:backend/src/modules/${path}`]).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1])
  check('T009', 'Accepted contract versions unchanged', same(contractsNow, CONTRACT_SOURCES.map((c) => c[2])) && same(contractsNow, contractsMain), `A7.1–A7.9: ${contractsNow.join(', ')} — exactly as accepted on main`)
  const packageDiff = gitArgs(['diff', 'origin/main...HEAD', '--', ':/backend/package.json']).split(/\r?\n/).filter((line) => /^[+-][^+-]/.test(line))
  const added = packageDiff.filter((line) => line.startsWith('+')).map((line) => line.slice(1).replace(/,$/, ''))
  const removed = packageDiff.filter((line) => line.startsWith('-')).map((line) => line.slice(1).replace(/,$/, ''))
  const packageOk = added.some((line) => line.trim() === `"test:a7:phase-closure": "${SCRIPT}"`) && same(added.filter((line) => !line.includes('test:a7:phase-closure')), removed)
  const allowed = ['backend/package.json', CLOSURE_DOC]
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${HARNESS_DIR}/`) && !allowed.includes(file))
  check(
    'T010',
    'Allowed diff, migrations unchanged',
    changedPaths.length > 0 && outOfScope.length === 0 && packageOk && prismaStatus.length === 0,
    outOfScope.length === 0 && packageOk
      ? `${changedPaths.length} path(s): the acceptance harness, the closure record and one package script (nothing else in package.json); no applied migration touched`
      : `unexpected: ${[...outOfScope, ...(packageOk ? [] : ['package.json beyond the one script'])].join(', ').slice(0, 220)}`,
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

  // Synthetic users: Better Auth's own server-side user and credential creation, then a membership (with the ORG_ADMIN
  // role, or — for the 403 proof — with no role at all). The password is random per run and never printed.
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
    return { id: user.id as string, who: as(signed.cookie), cookie: signed.cookie }
  }
  const B = await provisionMember('b')
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)
  const N = await provisionMember('norole', org, false)

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: two organizations; Claims with 0, 1, 2, 3 and 4 linked freezes, a second root, and evidence, cases and assessments')
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
  const runToken = runId.replace(/^A710-/, '')
  const ref = (suffix: string) => `SYN-${runToken}-${suffix}`.toUpperCase()
  const registerSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref(suffix) }, who)
    if (res.status !== 201) throw new Error(`fixture source ${suffix} could not be registered through A7.1: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.revenueSourceEvidenceId as string
  }
  const classifyOnly = async (E: string, who: Who = asAdmin) => {
    const C = (await post(`/api/revenue-source-evidence/${E}/classifications`, {}, who)).body.classificationId as string
    if (!C) throw new Error('fixture: classification refused')
    return C
  }
  const linkedSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const E = await registerSource(submissionId, suffix, who)
    const C = await classifyOnly(E, who)
    const R = (await post(`/api/revenue-evidence-classifications/${C}/adjudication-readiness`, {}, who)).body.readinessId as string
    if (!R) throw new Error(`fixture ${suffix}: readiness refused`)
    return { E, C, R }
  }
  const caseOf = async (submissionId: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-evidence-cases`, {}, who)
    if (res.status !== 201) throw new Error(`fixture case could not be assembled through A7.4: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { caseId: string; claimSubmissionId: string; assemblyCode: string; manifestSha256: string; itemCount: number; sourceCount: number; classifiedCount: number; readinessCount: number; items: any[] }
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
  // §9 — Claim C: S1 → S2 → S3; S1 and S2 each with one source classified, gated, cased and assessed; S3 bare.
  const C = await home.series('worked', 3)
  const [S1, S2, S3] = C.freezes
  const CL = await chainOf(C.claimId, C.freezes)
  const SRC1 = await linkedSource(S1, 'S1-E1')
  const CASE1 = await caseOf(S1)
  const ASSESS1 = await assessmentOf(CASE1.caseId)
  const SRC2 = await linkedSource(S2, 'S2-E1')
  const CASE2 = await caseOf(S2)
  const ASSESS2 = await assessmentOf(CASE2.caseId)
  // Q: four linked freezes — q1 bare; q2 a complete assessed case; q3 an incomplete case (one source never classified,
  // one classified without readiness) assessed INCOMPLETE_SOURCE_CHAIN; q4 a case never assessed.
  const Q = await home.series('four', 4)
  const [q1, q2, q3, q4] = Q.freezes
  const QL = await chainOf(Q.claimId, Q.freezes)
  await linkedSource(q2, 'Q2-E1')
  const QCASE2 = await caseOf(q2)
  const QASSESS2 = await assessmentOf(QCASE2.caseId)
  const UNCLASSIFIED = await registerSource(q3, 'Q3-UNCLASSIFIED')
  const NOREADY_E = await registerSource(q3, 'Q3-NOREADY')
  const NOREADY_C = await classifyOnly(NOREADY_E)
  const QCASE3 = await caseOf(q3)
  const QASSESS3 = await assessmentOf(QCASE3.caseId)
  await linkedSource(q4, 'Q4-E1')
  const QCASE4 = await caseOf(q4)
  // Z never frozen; One a single freeze; Bc two linked bare freezes; RR a second root (two freezes, never linked);
  // H three linked bare freezes for the snapshot and concurrency checks.
  const Z = await home.series('unfrozen', 0)
  const One = await home.series('single', 1)
  const Bc = await home.series('two', 2)
  const BL = await chainOf(Bc.claimId, Bc.freezes)
  const RR = await home.series('second root', 2)
  const H = await home.series('held', 3)
  const [h1, h2, h3] = H.freezes
  await chainOf(H.claimId, H.freezes)
  // The other organization: two linked freezes, a case and an assessment of its own.
  const F = await away.series('foreign', 2)
  await chainOf(F.claimId, F.freezes, O.who)
  await linkedSource(F.freezes[1], 'FOREIGN', O.who)
  const FCASE = await caseOf(F.freezes[1], O.who)
  await assessmentOf(FCASE.caseId, O.who)
  progress('fixtures ready: two synthetic AE-DU/DHA worlds; Claims with 0, 1, 2, 3, 3 and 4 freezes, a second root and a foreign 2-freeze Claim; evidence, cases and assessments through the A7.1–A7.5 owner routes')

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const freezeHash = (claimId: string) => hashOf(`SELECT f.*, m.id AS manifest_id, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') AS manifest FROM ${FREEZES} f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = $1::uuid`, claimId)
  const linkHash = (claimId: string) => hashOf(`SELECT l.* FROM ${LINKS} l WHERE l.claim_id = $1::uuid`, claimId)
  const caseHash = (claimId: string) => hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM ${HEADER} h JOIN ${FREEZES} f ON f.id = h.claim_submission_id WHERE f.claim_id = $1::uuid UNION ALL SELECT e.id, row_to_json(e)::text FROM ${ENTRY} e JOIN ${HEADER} h ON h.id = e.assembly_id JOIN ${FREEZES} f ON f.id = h.claim_submission_id WHERE f.claim_id = $1::uuid) x`, claimId)
  const assessmentHash = (claimId: string) => hashOf(`SELECT a.* FROM ${PREREQ} a JOIN ${HEADER} h ON h.id = a.evidence_case_id JOIN ${FREEZES} f ON f.id = h.claim_submission_id WHERE f.claim_id = $1::uuid`, claimId)
  const sourceHash = (claimId: string) => hashOf(`SELECT r.*, c.source_fingerprint_sha256 AS fp FROM revenue_source_evidence r LEFT JOIN source_evidence_classifications c ON c.source_evidence_id = r.id JOIN ${FREEZES} f ON f.id = r.claim_submission_id WHERE f.claim_id = $1::uuid`, claimId)
  const relaxable = [LINKS, FREEZES, HEADER, ENTRY, PREREQ].map((t) => `'${t}'::regclass`).join(', ')
  const constraintsHash = () => hashOf(`SELECT c.oid::text AS id, c.conrelid::regclass::text AS t, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid IN (${relaxable}) UNION ALL SELECT i.indexrelid::text, i.indrelid::regclass::text, i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid IN (${relaxable})`)
  const NOT_REFUSED = 'ROLLED_BACK'

  // A planted (corrupt) history: relaxations and forged rows go in with row triggers off; then the production A7.7, A7.8
  // and A7.9 services read that Claim on THIS transaction, which is then ALWAYS rolled back. Every plant is measured on
  // its own: all tables and every CHECK and index of the five relaxable tables must read back exactly.
  const plantedRuns = { total: 0, dirty: 0 }
  type Read = { ok: boolean; code?: string; message?: string; value?: unknown }
  type Planted = { timeline?: Read; delta?: Read; continuity?: Read; message: string }
  const planted = async (claimId: string, relax: string[], mutate: (tx: DbClient) => Promise<void>): Promise<Planted> => {
    const countsBefore = await counts()
    const constraintsBefore = await constraintsHash()
    const out: Omit<Planted, 'message'> = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          for (const ddl of relax) await tx.$executeRawUnsafe(ddl)
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
          await mutate(tx)
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
          out.timeline = (await getRevenueTimelineOf(claimId, tx)) as Read
          out.delta = (await getRevenueDeltaOf(claimId, tx)) as Read
          out.continuity = (await getRevenueContinuityOf(claimId, tx)) as Read
          throw new Error(NOT_REFUSED)
        },
        { timeout: 60_000 },
      ),
    )
    plantedRuns.total += 1
    if (!(await unchanged(countsBefore)) || (await constraintsHash()) !== constraintsBefore) plantedRuns.dirty += 1
    return { ...out, message }
  }
  const refusedAll = (p: Planted) =>
    p.message.includes(NOT_REFUSED) &&
    p.timeline?.ok === false && p.timeline.code === 'REVENUE_TIMELINE_PROVENANCE_CONFLICT' && !('value' in p.timeline) &&
    p.delta?.ok === false && p.delta.code === 'REVENUE_DELTA_PROVENANCE_CONFLICT' && !('value' in p.delta) &&
    p.continuity?.ok === false && p.continuity.code === 'REVENUE_CONTINUITY_PROVENANCE_CONFLICT' && !('value' in p.continuity)
  const detailOf = (p: Planted) => (p.timeline?.ok === false ? String(p.timeline.message).replace(/; nothing was (composed|compared|reconciled)$/, '') : `not refused: ${p.message.slice(0, 140)}`)
  const insertLink = (tx: DbClient, claimId: string, prior: string, corrected: string) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${LINKS} (id, claim_id, prior_submission_id, corrected_submission_id, reason_code, recorded_by_user_id, contract_version) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'CORRECTED_CODING', $4::uuid, 'A6-CORRECTION-1')`,
      claimId, prior, corrected, creatorId,
    ).then(() => undefined)
  const insertCase = (tx: DbClient, submissionId: string, o: { organization?: string; contract?: string; digest?: string } = {}) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${HEADER} (id, organization_id, claim_submission_id, contract_version, assembly_code, source_count, classified_count, readiness_count, item_count, manifest_sha256, recorded_by_user_id)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'NO_REVENUE_SOURCES', 0, 0, 0, 0, $4, $5::uuid)`,
      o.organization ?? org, submissionId, o.contract ?? 'A7-REVENUE-CASE-1', o.digest ?? createHash('sha256').update(randomBytes(8)).digest('hex'), creatorId,
    ).then(() => undefined)
  const insertAssessment = (tx: DbClient, caseId: string, digest: string, o: { contract?: string } = {}) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${PREREQ} (id, organization_id, evidence_case_id, contract_version, assessment_code, basis_code, case_manifest_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', $4, $5::uuid)`,
      org, caseId, o.contract ?? 'A7-CLOSURE-PREREQ-1', digest, creatorId,
    ).then(() => undefined)
  // Both owner results exactly as they answer on ONE snapshot, for forging inter-owner disagreements.
  const ownersOf = async (claimId: string) => {
    const read = await withReadSnapshot(undefined, async (tx) => ({ timeline: await getRevenueTimelineOf(claimId, tx), delta: await getRevenueDeltaOf(claimId, tx), continuity: await getRevenueContinuityOf(claimId, tx) }))
    if (!read.timeline.ok || !read.delta.ok || !read.continuity.ok) throw new Error(`fixture: the owners of ${claimId} could not be read`)
    return { timeline: read.timeline.value as TimelineFacts, delta: read.delta.value as DeltaFacts, continuity: read.continuity.value as any }
  }
  const pureRefusals: string[] = []
  const continuityVerdict = (timeline: TimelineFacts, delta: DeltaFacts) => {
    const result = deriveRevenueContinuity(timeline, delta)
    if (!result.ok) pureRefusals.push(result.detail)
    return result.ok ? `derived ${result.value.gaps.length}` : result.detail
  }
  const deltaVerdict = (timeline: TimelineFacts) => {
    const result = deriveRevenueDelta(timeline)
    if (!result.ok) pureRefusals.push(result.detail)
    return result.ok ? `derived ${result.value.comparisons.length}` : result.detail
  }
  // The acceptance cross-check of an A7.9 result, which no product owner consumes: its contract, Claim and counts, and
  // exactly one gap per A7.7 entry in order, naming that entry's own freeze, case and assessment with a controlled
  // code. It accepts or names why it refuses; it never repairs.
  const acceptContinuity = (continuity: any, timeline: TimelineFacts): string => {
    if (continuity?.contractVersion !== 'A7-REVENUE-CONTINUITY-1') return 'the continuity result is not an A7-REVENUE-CONTINUITY-1 projection'
    if (continuity.claimId !== timeline.claimId) return 'the continuity result names another claim'
    const entries = timeline.submissions
    if (continuity.submissionCount !== entries.length || continuity.comparisonCount !== Math.max(0, entries.length - 1)) return 'the continuity counts do not fit the timeline'
    if (!Array.isArray(continuity.gaps) || continuity.gaps.length !== entries.length) return 'the continuity result does not hold exactly one gap per freeze'
    if (new Set(continuity.gaps.map((g: any) => g.claimSubmissionId)).size !== entries.length) return 'a freeze has more than one gap'
    for (const [i, entry] of entries.entries()) {
      const gap = continuity.gaps[i]
      if (gap.ordinal !== i + 1 || gap.claimSubmissionId !== entry.claimSubmissionId) return 'a gap is not the freeze at its position in the timeline'
      if (gap.caseId !== (entry.caseSummaries[0]?.caseId ?? null) || gap.assessmentId !== (entry.prerequisiteSummaries[0]?.assessmentId ?? null)) return "a gap names another case or assessment than its freeze's"
      if (!GAP_CODES.includes(gap.gapCode)) return 'a gap carries an uncontrolled code'
    }
    return 'ACCEPTED'
  }

  const P = (claimId: string) => ({
    timeline: `/api/claims/${claimId}/revenue-evidence-timeline`,
    delta: `/api/claims/${claimId}/revenue-evidence-delta`,
    continuity: `/api/claims/${claimId}/revenue-evidence-continuity`,
  })
  const readAll = async (claimId: string, who: Who = asAdmin) => {
    const paths = P(claimId)
    return { timeline: await get(paths.timeline, who), delta: await get(paths.delta, who), continuity: await get(paths.continuity, who) }
  }
  const stableAll = (r: Awaited<ReturnType<typeof readAll>>) => ({ timeline: stable(r.timeline.body), delta: stable(r.delta.body), continuity: stable(r.continuity.body) })
  const traceOf = (assessmentId: string, who: Who = asAdmin) => get(`/api/closure-prerequisite-assessments/${assessmentId}/basis-trace`, who)

  // ---------------------------------------------------------------- synthetic owner continuity (T011–T020)
  section('Synthetic owner continuity: registration, classification, readiness, case, assessment, trace, timeline, delta and continuity of Claim C')
  const source1 = await get(`/api/revenue-source-evidence/${SRC1.E}`)
  const sourceRow = await prisma.revenueSourceEvidence.findUniqueOrThrow({ where: { id: SRC1.E } })
  const sourceReplay = await post(`/api/claim-submissions/${S1}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref('S1-E1') })
  check(
    'T011',
    'A7.1 source registration via owner',
    source1.status === 200 && source1.body.claimSubmissionId === S1 && source1.body.sourceKind === SYNTHETIC && sourceRow.claimSubmissionId === S1 && sourceReplay.status === 200 && sourceReplay.body.revenueSourceEvidenceId === SRC1.E,
    'S1\'s synthetic source is registered against S1 exactly as stored; the identical request replays (200) to the same id',
  )
  const class1 = await get(`/api/revenue-evidence-classifications/${SRC1.C}`)
  const classRow = await prisma.sourceEvidenceClassification.findUniqueOrThrow({ where: { id: SRC1.C } })
  const classReplay = await post(`/api/revenue-source-evidence/${SRC1.E}/classifications`, {})
  check(
    'T012',
    'A7.2 stored classification bound exactly',
    class1.status === 200 && class1.body.sourceEvidenceId === SRC1.E && class1.body.contractVersion === 'A7-EVIDENCE-CLASS-1' && class1.body.classificationCode === 'INTERNAL_DECLARATION' && classRow.sourceFingerprintSha256 === class1.body.sourceFingerprintSha256 && classReplay.status === 200 && classReplay.body.classificationId === SRC1.C,
    `bound to S1's source under A7-EVIDENCE-CLASS-1 (${class1.body?.classificationCode}), fingerprint as stored; a replay returns the same classification`,
  )
  const ready1 = await get(`/api/adjudication-evidence-readiness/${SRC1.R}`)
  check('T013', 'A7.3 readiness: external proof absent', ready1.status === 200 && ready1.body.classificationId === SRC1.C && ready1.body.readinessCode === 'NOT_READY_FOR_ADJUDICATION' && ready1.body.reasonCode === 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'the recorded readiness is NOT_READY_FOR_ADJUDICATION / EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT — no external proof, no payer decision')
  const case1 = await get(`/api/revenue-evidence-cases/${CASE1.caseId}`)
  const caseRow1 = await prisma.evidenceCaseSnapshot.findUniqueOrThrow({ where: { id: CASE1.caseId } })
  check(
    'T014',
    'A7.4 case snapshot assembled exactly',
    case1.status === 200 && case1.body.claimSubmissionId === S1 && case1.body.assemblyCode === 'INVENTORY_COMPLETE' && case1.body.itemCount === 1 && case1.body.items[0].sourceEvidenceId === SRC1.E && case1.body.items[0].classificationId === SRC1.C && case1.body.items[0].readinessId === SRC1.R && case1.body.items[0].itemReasonCode === 'LINKED' && caseRow1.manifestSha256 === case1.body.manifestSha256,
    "S1's case lists exactly its source, classification and readiness (LINKED, INVENTORY_COMPLETE) with the stored digest",
  )
  const assessRow1 = await prisma.evidencePrereqResult.findUniqueOrThrow({ where: { id: ASSESS1.assessmentId } })
  check('T015', 'A7.5 prerequisite maps to source basis', ASSESS1.caseId === CASE1.caseId && ASSESS1.assessmentCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && ASSESS1.basisCode === 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' && assessRow1.caseManifestSha256 === caseRow1.manifestSha256, "the assessment of S1's case records EXTERNAL_FINANCIAL_EVIDENCE_ABSENT / EXTERNAL_REMITTANCE_NOT_ESTABLISHED bound to that case's digest")
  const countsBeforeReads = await counts()
  const assessmentsBeforeTrace = await prisma.evidencePrereqResult.count()
  const trace1 = await traceOf(ASSESS1.assessmentId)
  check(
    'T016',
    'A7.6 explanation reproduces stored assessment',
    trace1.status === 200 && trace1.body.assessmentCode === assessRow1.assessmentCode && trace1.body.basisCode === assessRow1.basisCode && trace1.body.caseId === CASE1.caseId && trace1.body.traceItems.every((i: any) => i.explanationCode === 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT') && (await prisma.evidencePrereqResult.count()) === assessmentsBeforeTrace,
    'the trace states exactly the stored code and basis, item by item, and records nothing (no re-assessment)',
  )
  const RC = await readAll(C.claimId)
  const TCb = RC.timeline.body
  check(
    'T017',
    'A7.7 complete linked Claim timeline',
    RC.timeline.status === 200 && same(TCb.submissions.map((e: any) => e.claimSubmissionId), [S1, S2, S3]) && TCb.submissions[0].caseSummaries[0]?.caseId === CASE1.caseId && TCb.submissions[1].caseSummaries[0]?.caseId === CASE2.caseId && TCb.submissions[2].caseSummaries.length === 0 && TCb.submissions[1].correctionLinkId === CL[0] && TCb.submissions[2].correctionLinkId === CL[1],
    'S1, S2, S3 in link order with each freeze\'s own case and the two A6.9 links',
  )
  const DCb = RC.delta.body
  check('T018', 'A7.8 correct adjacent recorded delta', RC.delta.status === 200 && same(DCb.comparisons.map((c: any) => c.evidenceDeltaCode), ['RECORDED_SUMMARY_CHANGED', 'CASE_NO_LONGER_RECORDED']) && DCb.comparisons[0].correctionLinkId === CL[0] && DCb.comparisons[1].correctedCaseId === null, 'S1/S2 RECORDED_SUMMARY_CHANGED (each case binds its own freeze) and S2/S3 CASE_NO_LONGER_RECORDED')
  const CCb = RC.continuity.body
  const ownersC = await ownersOf(C.claimId)
  check('T019', 'A7.9 continuity / gaps from owners', RC.continuity.status === 200 && CCb.continuityCode === 'HISTORICAL_EVIDENCE_UNRECORDED' && same(codesOf(CCb), ['EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'CASE_NOT_RECORDED']) && acceptContinuity(CCb, ownersC.timeline) === 'ACCEPTED', 'HISTORICAL_EVIDENCE_UNRECORDED with gaps EXTERNAL_FINANCIAL_EVIDENCE_ABSENT ×2 and CASE_NOT_RECORDED; the acceptance cross-check accepts it against the timeline')
  const digestsAgree =
    TCb.submissions[0].caseSummaries[0].manifestSha256 === caseRow1.manifestSha256 && DCb.comparisons[0].predecessorCaseManifestSha256 === caseRow1.manifestSha256 && trace1.body.caseManifestSha256 === caseRow1.manifestSha256 &&
    TCb.submissions[0].prerequisiteSummaries[0].assessmentId === ASSESS1.assessmentId && CCb.gaps[0].assessmentId === ASSESS1.assessmentId && DCb.comparisons[0].predecessorAssessmentId === ASSESS1.assessmentId &&
    TCb.submissions[1].prerequisiteSummaries[0].assessmentId === ASSESS2.assessmentId && CCb.gaps[1].caseId === CASE2.caseId
  const worked = { timeline: stable(TCb), delta: stable(DCb), continuity: stable(CCb), trace: stable(trace1.body) }
  check('T020', 'Worked scenario end-to-end coherent', digestsAgree && same(DCb.comparisons.map((c: any) => [c.predecessorSubmissionId, c.correctedSubmissionId]), [[S1, S2], [S2, S3]]) && (await unchanged(countsBeforeReads)), 'case, assessment, trace, timeline, delta and continuity agree on every freeze, case, assessment, link and digest id; the trace, timeline, delta and continuity reads wrote nothing')

  // ---------------------------------------------------------------- empty, singleton and multi-freeze facts (T021–T030)
  section('Empty, singleton and multi-freeze facts: explicit absence, retained singletons, links, binding of every freeze, case and assessment')
  const RZ = await readAll(Z.claimId)
  check('T021', 'Zero frozen Claim explicit absence', RZ.timeline.body.chainCode === 'NO_FROZEN_SUBMISSION' && RZ.delta.body.baselineCode === 'NO_FROZEN_SUBMISSION' && RZ.continuity.body.continuityCode === 'NO_FROZEN_SUBMISSION' && (await prisma.claimFreeze.count({ where: { claimId: Z.claimId } })) === 0, 'an unfrozen Claim reads NO_FROZEN_SUBMISSION in the timeline, the delta and continuity')
  check('T022', 'Zero freeze gives no fabricated case', same(RZ.timeline.body.submissions, []) && same(RZ.delta.body.comparisons, []) && same(RZ.continuity.body.gaps, []) && ![...deepKeys(RZ)].some((k) => /caseId/.test(k)), 'no entry, comparison, gap or case id is invented for it')
  const ROne = await readAll(One.claimId)
  check('T023', 'Singleton freeze retained and ordered', ROne.timeline.body.submissions.length === 1 && ROne.timeline.body.submissions[0].ordinal === 1 && ROne.timeline.body.submissions[0].claimSubmissionId === One.freezes[0] && ROne.timeline.body.submissions[0].priorSubmissionId === null, 'the single freeze is the root, ordinal 1, with no predecessor')
  check('T024', 'Singleton no adjacent comparison', ROne.delta.body.baselineCode === 'SINGLE_FREEZE' && ROne.delta.body.comparisonCount === 0 && ROne.continuity.body.continuityCode === 'SINGLE_FREEZE_NO_COMPARISON' && ROne.continuity.body.gaps.length === 1, 'SINGLE_FREEZE with zero comparisons; continuity SINGLE_FREEZE_NO_COMPARISON still lists its one gap')
  const RBc = await readAll(Bc.claimId)
  const bcLinks = await prisma.claimCorrectionLink.findMany({ where: { claimId: Bc.claimId } })
  check('T025', 'Two adjacent freezes one correction link', RBc.timeline.body.submissions.length === 2 && bcLinks.length === 1 && RBc.timeline.body.submissions[1].correctionLinkId === BL[0] && bcLinks[0].priorSubmissionId === Bc.freezes[0] && RBc.delta.body.comparisonCount === 1, 'two freezes, exactly one stored link (prior → corrected), one comparison')
  const RQ = await readAll(Q.claimId)
  check('T026', 'Four freezes three ordered corrections', same(RQ.timeline.body.submissions.map((e: any) => e.claimSubmissionId), Q.freezes) && same(RQ.timeline.body.submissions.slice(1).map((e: any) => e.correctionLinkId), QL) && RQ.delta.body.comparisonCount === 3, 'q1 → q2 → q3 → q4 joined by exactly the three stored links, in order')
  const fixtureClaims = [C, Q, Bc, One, H]
  const timelines = await Promise.all(fixtureClaims.map(async (c) => (await get(P(c.claimId).timeline)).body))
  const allEntries = timelines.flatMap((t: any) => t.submissions.map((e: any) => ({ claimId: t.claimId, entry: e })))
  const freezeRows = await prisma.$queryRawUnsafe<{ id: string; claim: string; org: string }[]>(
    `SELECT f.id::text AS id, f.claim_id::text AS claim, p.organization_id::text AS org FROM ${FREEZES} f JOIN claims k ON k.id = f.claim_id JOIN encounters e ON e.id = k.encounter_id JOIN patients p ON p.id = e.patient_id WHERE f.claim_id = ANY($1::uuid[])`,
    fixtureClaims.map((c) => c.claimId),
  )
  check('T027', 'Every freeze Claim and tenant matches', allEntries.length === 13 && allEntries.every(({ claimId, entry }) => freezeRows.some((r) => r.id === entry.claimSubmissionId && r.claim === claimId && r.org === org)) && freezeRows.length === allEntries.length, `all ${allEntries.length} freezes listed belong to their Claim and to this organization, and every stored freeze is listed`)
  const listedCases = allEntries.flatMap(({ entry }) => entry.caseSummaries.map((c: any) => ({ freeze: entry.claimSubmissionId, c })))
  const caseRows = await prisma.evidenceCaseSnapshot.findMany({ where: { id: { in: listedCases.map((x) => x.c.caseId) } } })
  check('T028', 'Every case bound to exact freeze', listedCases.length === 5 && listedCases.every(({ freeze, c }) => caseRows.some((r) => r.id === c.caseId && r.claimSubmissionId === freeze && r.organizationId === org && r.manifestSha256 === c.manifestSha256)), `each of the ${listedCases.length} listed cases is the stored case of exactly that freeze and organization, with its stored digest`)
  const listedAssessments = allEntries.flatMap(({ entry }) => entry.prerequisiteSummaries)
  const assessmentRows = await prisma.evidencePrereqResult.findMany({ where: { id: { in: listedAssessments.map((a: any) => a.assessmentId) } } })
  check('T029', 'Every assessment bound to exact case', listedAssessments.length === 4 && listedAssessments.every((a: any) => assessmentRows.some((r) => r.id === a.assessmentId && r.evidenceCaseId === a.caseId && r.caseManifestSha256 === a.caseManifestSha256)), `each of the ${listedAssessments.length} listed assessments is bound to exactly its case and that case's digest`)
  const shapeReads = [RZ, ROne, RBc, RC, RQ]
  check('T030', 'Comparison count equals max(0, N-1)', shapeReads.every((r) => r.delta.body.comparisonCount === Math.max(0, r.timeline.body.submissions.length - 1) && r.continuity.body.comparisonCount === r.delta.body.comparisonCount && r.delta.body.comparisons.length === r.delta.body.comparisonCount), `0, 1, 2, 3 and 4 freezes give ${shapeReads.map((r) => r.delta.body.comparisonCount).join(', ')} comparisons in the delta and in continuity`)

  // ---------------------------------------------------------------- recorded evidence and absent states (T031–T040)
  section('Recorded evidence and absent states: no case, no assessment, an unclassified source, a source without readiness, controlled codes, copied digests')
  check('T031', 'Missing case stays absent, not zero', TCb.submissions[2].caseSummaries.length === 0 && DCb.comparisons[1].correctedCaseId === null && DCb.comparisons[1].sourceCountAfter === null && CCb.gaps[2].caseId === null && CCb.gaps[2].gapCode === 'CASE_NOT_RECORDED', 'S3 has no case: an empty case list, null case id and counts in the delta, CASE_NOT_RECORDED in continuity — never 0')
  const [, , qt3, qt4] = RQ.timeline.body.submissions
  check('T032', 'Missing assessment stays unassessed', qt4.caseSummaries[0]?.caseId === QCASE4.caseId && qt4.prerequisiteSummaries.length === 0 && RQ.delta.body.comparisons[2].correctedAssessmentId === null && RQ.continuity.body.gaps[3].gapCode === 'PREREQUISITE_NOT_RECORDED' && (await prisma.evidencePrereqResult.count({ where: { evidenceCaseId: QCASE4.caseId } })) === 0, "q4's case was never assessed: no assessment anywhere, PREREQUISITE_NOT_RECORDED in continuity")
  const qcase3 = await get(`/api/revenue-evidence-cases/${QCASE3.caseId}`)
  const qtrace3 = await traceOf(QASSESS3.assessmentId)
  const itemOf = (body: any, sourceId: string) => body.items?.find((i: any) => i.sourceEvidenceId === sourceId)
  const traceItemOf = (body: any, sourceId: string) => body.traceItems?.find((i: any) => i.sourceEvidenceId === sourceId)
  check(
    'T033',
    'Incomplete classification remains missing',
    itemOf(qcase3.body, UNCLASSIFIED)?.itemReasonCode === 'SOURCE_ONLY' && itemOf(qcase3.body, UNCLASSIFIED)?.classificationId === null && traceItemOf(qtrace3.body, UNCLASSIFIED)?.explanationCode === 'SOURCE_UNCLASSIFIED' && (await prisma.sourceEvidenceClassification.count({ where: { sourceEvidenceId: UNCLASSIFIED } })) === 0,
    'a source never classified stays SOURCE_ONLY with a null classification in the case and SOURCE_UNCLASSIFIED in the trace',
  )
  check(
    'T034',
    'Missing readiness remains explicit',
    itemOf(qcase3.body, NOREADY_E)?.itemReasonCode === 'CLASSIFIED_NO_READINESS' && itemOf(qcase3.body, NOREADY_E)?.classificationId === NOREADY_C && itemOf(qcase3.body, NOREADY_E)?.readinessId === null && traceItemOf(qtrace3.body, NOREADY_E)?.explanationCode === 'CLASSIFICATION_NO_READINESS' && QASSESS3.assessmentCode === 'INCOMPLETE_SOURCE_CHAIN' && RQ.continuity.body.gaps[2].gapCode === 'SOURCE_CHAIN_INCOMPLETE',
    'a classified source without readiness stays CLASSIFIED_NO_READINESS (null readiness), CLASSIFICATION_NO_READINESS in the trace; the case is INCOMPLETE_SOURCE_CHAIN and continuity SOURCE_CHAIN_INCOMPLETE',
  )
  const projections = [RC, RQ, RBc, ROne, RZ].flatMap((r) => [r.timeline.body, r.delta.body, r.continuity.body])
  check('T035', 'External financial absence stays controlled', CCb.gaps.slice(0, 2).every((g: any) => g.gapCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && g.basisCode === 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED') && projections.flatMap((p) => p.gaps ?? []).every((g: any) => GAP_CODES.includes(g.gapCode)), 'S1 and S2 report EXTERNAL_FINANCIAL_EVIDENCE_ABSENT with its basis; every gap anywhere is a controlled code')
  const readinessCodes = await prisma.evidenceGateResult.findMany({ where: { sourceEvidence: { sourceReference: { contains: runToken } } }, select: { readinessCode: true } })
  check('T036', 'No payer outcome inferred from readiness', readinessCodes.length > 0 && readinessCodes.every((r) => r.readinessCode === 'NOT_READY_FOR_ADJUDICATION') && ![...deepKeys(projections)].some((k) => !/^readinessCount(Before|After)?$/.test(k) && /readiness|adjudicat|payer|verdict|decision/i.test(k)), `all ${readinessCodes.length} readiness results of this run are NOT_READY_FOR_ADJUDICATION; no projection carries a readiness code, adjudication or payer field (only the recorded readiness counts)`)
  const readerCode = committedProductionCodeOf(['closure-basis-trace', 'revenue-timeline', 'revenue-delta', 'revenue-continuity'].map((m) => `backend/src/modules/${m}`)).code
  check('T037', 'Case digest copied without recalculation', digestsAgree && TCb.submissions[1].caseSummaries[0].manifestSha256 === CASE2.manifestSha256 && !/createHash|sha256\(|digest\(/.test(readerCode), 'the stored case digest is copied identically into the case, assessment, trace, timeline and delta; no A7.6–A7.9 reader hashes anything')
  const everyAssessmentShown = [...listedAssessments, ...[trace1.body, qtrace3.body]]
  const shownRows = await prisma.evidencePrereqResult.findMany({ where: { id: { in: everyAssessmentShown.map((a: any) => a.assessmentId) } } })
  check('T038', 'Assessment basis matches stored code', everyAssessmentShown.every((a: any) => shownRows.some((r) => r.id === a.assessmentId && r.assessmentCode === a.assessmentCode && r.basisCode === a.basisCode)), `each of the ${everyAssessmentShown.length} assessments shown by A7.6 and A7.7 carries exactly its stored code and basis`)
  const dbLinksQ = await prisma.claimCorrectionLink.findMany({ where: { claimId: Q.claimId } })
  const followsLinks = (t: any, links: { id: string; priorSubmissionId: string; correctedSubmissionId: string }[]) =>
    t.submissions.every((e: any, i: number) => (i === 0 ? e.priorSubmissionId === null : links.some((l) => l.id === e.correctionLinkId && l.priorSubmissionId === t.submissions[i - 1].claimSubmissionId && l.correctedSubmissionId === e.claimSubmissionId)))
  check('T039', 'Timeline entries ordered by A6.9 links', followsLinks(RQ.timeline.body, dbLinksQ) && followsLinks(TCb, await prisma.claimCorrectionLink.findMany({ where: { claimId: C.claimId } })), 'every entry follows the stored link from the entry before it; nothing is ordered by id or time')
  const caseBytesBefore = await caseHash(C.claimId)
  const beforeLater = stableAll(await readAll(C.claimId))
  await linkedSource(S1, 'S1-LATER')
  check('T040', 'Earlier evidence unchanged after later source', (await caseHash(C.claimId)) === caseBytesBefore && same(stableAll(await readAll(C.claimId)), beforeLater), "a source registered, classified and gated on S1 later leaves S1's case bytes and every projection of C byte-identical")

  // ---------------------------------------------------------------- adversarial history and lineage (T041–T050)
  section('Adversarial history: a real second root, real self and wrong-Claim corrections refused by A6.9, planted forks, joins, cycles and records (rolled back)')
  const RRR = await readAll(RR.claimId)
  check(
    'T041',
    'Second unrelated root fails closed',
    RRR.timeline.status === 409 && errorCode(RRR.timeline.body) === 'REVENUE_TIMELINE_PROVENANCE_CONFLICT' && RRR.delta.status === 409 && RRR.continuity.status === 409 && errorCode(RRR.continuity.body) === 'REVENUE_CONTINUITY_PROVENANCE_CONFLICT' && (await prisma.claimCorrectionLink.count({ where: { claimId: RR.claimId } })) === 0 && [RRR.timeline, RRR.delta, RRR.continuity].every((r) => !rawError(r.body) && !('submissions' in r.body) && !('gaps' in r.body)),
    'a Claim frozen twice through the real owner without a link answers 409 from the timeline, delta and continuity, with no partial body',
  )
  const fork = await planted(Q.claimId, ['DROP INDEX claim_correction_links_prior_submission_id_key', 'DROP INDEX claim_correction_links_corrected_submission_id_key'], (tx) => insertLink(tx, Q.claimId, q1, q3))
  check('T042', 'Forked correction link fails closed', refusedAll(fork) && /fork|join/.test(detailOf(fork)), `q1 corrected by both q2 and q3: the timeline, delta and continuity each refuse 409 (${detailOf(fork)})`)
  const join = await planted(Q.claimId, ['DROP INDEX claim_correction_links_corrected_submission_id_key'], (tx) => insertLink(tx, Q.claimId, q4, q2))
  check('T043', 'Joined correction link fails closed', refusedAll(join) && /join/.test(detailOf(join)), `q2 correcting both q1 and q4: 409 from all three (${detailOf(join)})`)
  const cycle = await planted(Q.claimId, [], (tx) => insertLink(tx, Q.claimId, q4, q1))
  check('T044', 'Cycle fails closed', refusedAll(cycle) && /cycle/.test(detailOf(cycle)), `q1 → q2 → q3 → q4 → q1: 409 from all three (${detailOf(cycle)})`)
  const linksBeforeSelf = await prisma.claimCorrectionLink.count()
  const selfRoute = await post(`/api/claims/${Q.claimId}/correction-links`, { priorSubmissionId: q4, correctedSubmissionId: q4, reasonCode: 'CORRECTED_CODING' })
  const selfPlant = await planted(Q.claimId, [`ALTER TABLE ${LINKS} DROP CONSTRAINT claim_correction_links_distinct_chk`, 'DROP INDEX claim_correction_links_prior_submission_id_key', 'DROP INDEX claim_correction_links_corrected_submission_id_key'], (tx) => insertLink(tx, Q.claimId, q4, q4))
  check('T045', 'Self-correction fails closed', [400, 409].includes(selfRoute.status) && !rawError(selfRoute.body) && refusedAll(selfPlant) && (await prisma.claimCorrectionLink.count()) === linksBeforeSelf, `A6.9 refuses q4 correcting itself (${selfRoute.status} ${errorCode(selfRoute.body)}); a planted self-link is refused 409 by all three readers (${detailOf(selfPlant)})`)
  const wrongRoute = await post(`/api/claims/${Q.claimId}/correction-links`, { priorSubmissionId: q4, correctedSubmissionId: One.freezes[0], reasonCode: 'CORRECTED_CODING' })
  const wrongPlant = await planted(Q.claimId, [], (tx) => insertLink(tx, Q.claimId, q4, One.freezes[0]))
  check('T046', 'Wrong-Claim correction refused', [400, 404, 409].includes(wrongRoute.status) && !rawError(wrongRoute.body) && refusedAll(wrongPlant) && /not this claim's/.test(detailOf(wrongPlant)) && (await prisma.claimCorrectionLink.count()) === linksBeforeSelf, `A6.9 refuses linking another Claim's freeze (${wrongRoute.status} ${errorCode(wrongRoute.body)}); planted, it is refused 409 by all three (${detailOf(wrongPlant)})`)
  const foreignCase = await planted(Q.claimId, [], (tx) => insertCase(tx, q1, { organization: otherOrg }))
  check('T047', 'Foreign organization case refused', refusedAll(foreignCase) && /another organization/.test(detailOf(foreignCase)), `a case of the other organization on q1: 409 from all three (${detailOf(foreignCase)})`)
  const duplicateCase = await planted(Q.claimId, ['DROP INDEX evidence_case_snapshots_identity_key'], (tx) => insertCase(tx, q2))
  check('T048', 'Duplicate A7.4 case refused', refusedAll(duplicateCase) && /more than one case/.test(detailOf(duplicateCase)), `a second v1 case for q2 (identity index dropped): 409 from all three, never the newest (${detailOf(duplicateCase)})`)
  const duplicateAssessment = await planted(Q.claimId, ['DROP INDEX evidence_prereq_results_identity_key'], (tx) => insertAssessment(tx, QCASE2.caseId, QCASE2.manifestSha256))
  check('T049', 'Duplicate A7.5 assessment refused', refusedAll(duplicateAssessment) && /more than one assessment/.test(detailOf(duplicateAssessment)), `a second v1 assessment of q2's case: 409 from all three (${detailOf(duplicateAssessment)})`)
  const chronology = await planted(Q.claimId, [], (tx) => tx.$executeRawUnsafe(`UPDATE ${FREEZES} SET frozen_at = (SELECT frozen_at FROM ${FREEZES} WHERE id = $1::uuid) - interval '1 day' WHERE id = $2::uuid`, q1, q2).then(() => undefined))
  check('T050', 'Corrupt chronology refused', refusedAll(chronology) && /strictly after/.test(detailOf(chronology)), `q2 frozen a day before q1: 409 from all three (${detailOf(chronology)})`)

  // ---------------------------------------------------------------- provenance and malformed contracts (T051–T060)
  section('Provenance and contracts: forged owner results judged by the production reducers, planted records by the production services, A7.9 by the acceptance cross-check')
  const TQf = (await ownersOf(Q.claimId))
  const t051 = deltaVerdict({ ...TQf.timeline, contractVersion: 'A7-REVENUE-TIMELINE-2' })
  const t051b = continuityVerdict({ ...TQf.timeline, contractVersion: 'A7-REVENUE-TIMELINE-2' }, TQf.delta)
  check('T051', 'Unknown A7.7 contract refused', /A7-REVENUE-TIMELINE-1/.test(t051) && /A7-REVENUE-TIMELINE-1/.test(t051b), `the real Q timeline under a future contract is refused by the A7.8 reducer (${t051}) and the A7.9 reducer (${t051b})`)
  const t052 = continuityVerdict(TQf.timeline, { ...TQf.delta, contractVersion: 'A7-REVENUE-DELTA-2' })
  check('T052', 'Unknown A7.8 contract refused', /A7-REVENUE-DELTA-1/.test(t052), `the real Q delta under a future contract is refused by the A7.9 reducer (${t052})`)
  const t053 = acceptContinuity({ ...TQf.continuity, contractVersion: 'A7-REVENUE-CONTINUITY-2' }, TQf.timeline)
  check('T053', 'Unknown A7.9 contract refused', acceptContinuity(TQf.continuity, TQf.timeline) === 'ACCEPTED' && /A7-REVENUE-CONTINUITY-1/.test(t053), `the real Q continuity is accepted; under a future contract the acceptance cross-check refuses it (${t053}) — no product owner consumes A7.9`)
  const futureCase = await planted(Q.claimId, [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_contract_chk`], (tx) => insertCase(tx, q1, { contract: 'A7-REVENUE-CASE-2' }))
  check('T054', 'Unknown A7.4 contract refused', refusedAll(futureCase) && /unsupported contract/.test(detailOf(futureCase)), `an A7-REVENUE-CASE-2 case on q1 (CHECK dropped): 409 from all three (${detailOf(futureCase)})`)
  const futureAssessment = await planted(Q.claimId, [`ALTER TABLE ${PREREQ} DROP CONSTRAINT evidence_prereq_results_contract_chk`], (tx) => insertAssessment(tx, QCASE4.caseId, QCASE4.manifestSha256, { contract: 'A7-CLOSURE-PREREQ-2' }))
  check('T055', 'Unknown A7.5 contract refused', refusedAll(futureAssessment) && /unsupported contract/.test(detailOf(futureAssessment)), `an A7-CLOSURE-PREREQ-2 assessment of q4's case (CHECK dropped): 409 from all three (${detailOf(futureAssessment)})`)
  const badDigest = await planted(Q.claimId, [`ALTER TABLE ${HEADER} DROP CONSTRAINT evidence_case_snapshots_manifest_chk`], (tx) => insertCase(tx, q1, { digest: 'ABC' }))
  check('T056', 'Malformed SHA-256 refused', refusedAll(badDigest) && /digest/.test(detailOf(badDigest)), `a case on q1 whose stored digest is "ABC" (CHECK dropped): 409 from all three (${detailOf(badDigest)})`)
  const mismatch = await planted(Q.claimId, [], (tx) => insertAssessment(tx, QCASE4.caseId, 'f'.repeat(64)))
  check('T057', 'Case/assessment digest mismatch refused', refusedAll(mismatch) && /digest/.test(detailOf(mismatch)), `an assessment of q4's case carrying another digest: 409 from all three (${detailOf(mismatch)})`)
  const [qc1, qc2, qc3] = TQf.delta.comparisons
  const t058a = continuityVerdict(TQf.timeline, { ...TQf.delta, comparisons: [qc1, { ...qc2, predecessorSubmissionId: q1 }, qc3] })
  const t058b = deltaVerdict({ ...TQf.timeline, submissions: TQf.timeline.submissions.map((e, i) => (i === 2 ? { ...e, priorSubmissionId: q4 } : e)) })
  check('T058', 'Mismatch in pair predecessor refused', /consecutive timeline entries/.test(t058a) && /predecessor is not the entry before it/.test(t058b), `a delta pair naming another predecessor is refused by the A7.9 reducer (${t058a}); a timeline entry naming another predecessor by the A7.8 reducer (${t058b})`)
  const gapsQ = TQf.continuity.gaps
  const t059a = acceptContinuity({ ...TQf.continuity, gaps: gapsQ.slice(0, 3) }, TQf.timeline)
  const t059b = acceptContinuity({ ...TQf.continuity, gaps: [gapsQ[0], gapsQ[1], gapsQ[1], gapsQ[3]] }, TQf.timeline)
  check('T059', 'Missing or duplicated gap refused', /exactly one gap per freeze/.test(t059a) && /more than one gap|not the freeze at its position/.test(t059b), `a result without q4's gap (${t059a}) and one repeating q2's gap (${t059b}) are refused by the acceptance cross-check`)
  const plants060 = [fork, join, cycle, selfPlant, wrongPlant, foreignCase, duplicateCase, duplicateAssessment, chronology, futureCase, futureAssessment, badDigest, mismatch]
  check(
    'T060',
    'Any contradiction: no partial projection',
    plants060.every(refusedAll) && plantedRuns.total === plants060.length && plantedRuns.dirty === 0 && pureRefusals.length === 5 && [t053, t059a, t059b].every((d) => d !== 'ACCEPTED'),
    `${plants060.length} planted histories each returned only the controlled 409 from the timeline, delta and continuity (no entries, comparisons or gaps) and left every row, CHECK and index byte-identical (${plantedRuns.dirty} dirty); ${pureRefusals.length} forged owner results refused by the reducers; 3 forged A7.9 results refused`,
  )

  // ---------------------------------------------------------------- snapshots and concurrency (T061–T070)
  section('Snapshots and concurrency: one REPEATABLE READ, READ ONLY snapshot per read on the caller client, no Claim lock, writers held uncommitted')
  const timelineService = committedCode('backend/src/modules/revenue-timeline/revenue-timeline.service.ts')
  const deltaService = committedCode('backend/src/modules/revenue-delta/revenue-delta.service.ts')
  const continuityService = committedCode('backend/src/modules/revenue-continuity/revenue-continuity.service.ts')
  const isolation = await withReadSnapshot(undefined, async (tx) => (await tx.$queryRaw<{ i: string; r: string }[]>`SELECT current_setting('transaction_isolation') AS i, current_setting('transaction_read_only') AS r`)[0])
  const held61 = await withReadSnapshot(undefined, async (tx) => {
    const first = await getRevenueTimelineOf(H.claimId, tx)
    const assembled = await assembleRevenueEvidenceCase(h1, {}, creatorId)
    const second = await getRevenueTimelineOf(H.claimId, tx)
    return { first, second, assembled: assembled.ok }
  })
  const hAfter61 = (await get(P(H.claimId).timeline)).body
  check(
    'T061',
    'A7.7 one read-only snapshot verified',
    isolation.i === 'repeatable read' && isolation.r === 'on' && /withReadSnapshot\(undefined, \(tx\) => getRevenueTimelineOf\(/.test(timelineService) && held61.assembled && held61.first.ok && held61.second.ok && same(stable(held61.first.value), stable(held61.second.value)) && hAfter61.submissions[0].caseSummaries.length === 1,
    'the timeline reads at REPEATABLE READ, READ ONLY; a case committed on h1 meanwhile is invisible to the held snapshot and visible to the next',
  )
  const h1Case = hAfter61.submissions[0].caseSummaries[0].caseId as string
  const held62 = await withReadSnapshot(undefined, async (tx) => {
    const first = await getRevenueDeltaOf(H.claimId, tx)
    const assessed = await assessClosurePrerequisites(h1Case, {}, creatorId)
    const second = await getRevenueDeltaOf(H.claimId, tx)
    return { first, second, assessed: assessed.ok }
  })
  const hAfter62 = (await get(P(H.claimId).delta)).body
  const deltaOfBody = deltaService.slice(deltaService.indexOf('export async function getRevenueDeltaOf'), deltaService.indexOf('export async function getRevenueDelta('))
  check(
    'T062',
    'A7.8 same caller DbClient verified',
    /getRevenueTimelineOf\(claimId, tx\)/.test(deltaOfBody) && !/prisma\.|withReadSnapshot/.test(deltaOfBody) && held62.assessed && held62.first.ok && held62.second.ok && same(stable(held62.first.value), stable(held62.second.value)) && hAfter62.comparisons[0].prerequisiteBefore !== null,
    "A7.8 reads the A7.7 owner on the caller's own client only; an assessment committed meanwhile is invisible to the held snapshot and visible to the next",
  )
  const continuityOfBody = continuityService.slice(continuityService.indexOf('export async function getRevenueContinuityOf'), continuityService.indexOf('export async function getRevenueContinuity('))
  const timelineA = await withReadSnapshot(undefined, (tx) => getRevenueTimelineOf(H.claimId, tx))
  await caseOf(h2)
  const deltaB = await withReadSnapshot(undefined, (tx) => getRevenueDeltaOf(H.claimId, tx))
  const mixed = timelineA.ok && deltaB.ok ? continuityVerdict(timelineA.value as TimelineFacts, deltaB.value as DeltaFacts) : 'owner read failed'
  check(
    'T063',
    'A7.9 shared read snapshot across owners',
    /getRevenueTimelineOf\(claimId, tx\)/.test(continuityOfBody) && /getRevenueDeltaOf\(claimId, tx\)/.test(continuityOfBody) && /evaluatedAt !== timeline\.value\.evaluatedAt/.test(continuityOfBody) && /other case or assessment facts/.test(mixed),
    `A7.9 reads both owners on one caller client and checks their shared instant; a timeline and a delta from two snapshots around a committed case are refused (${mixed})`,
  )
  const holdLock = holdAt('casePrerequisite.claim_locked')
  const lockHolder = assessClosurePrerequisites(CASE1.caseId, {}, creatorId)
  await Promise.race([holdLock.arrived, lockHolder])
  const duringLock = readAll(C.claimId)
  const lockFree = await settledWithin(duringLock, 4000)
  const lockedReads = await duringLock
  holdLock.release()
  const lockReplay = await lockHolder
  clearConcurrencyProbes()
  const readersCode = committedProductionCodeOf(['revenue-timeline', 'revenue-delta', 'revenue-continuity'].map((m) => `backend/src/modules/${m}`)).code
  check('T064', 'No Claim lock on pure GET', lockFree && [lockedReads.timeline, lockedReads.delta, lockedReads.continuity].every((r) => r.status === 200) && lockReplay.ok && !/lockRowForUpdate|FOR UPDATE|FOR SHARE|NOWAIT/.test(readersCode), "while an A7.5 request holds C's row lock, the timeline, delta and continuity answer at once; no reader requests a row lock")
  const raceAll = async (claimId: string, probe: string, writer: () => Promise<{ ok: boolean }>) => {
    const before = stableAll(await readAll(claimId))
    const hold = holdAt(probe)
    const w = writer()
    await Promise.race([hold.arrived, w])
    const during = readAll(claimId)
    const prompt = await settledWithin(during, 4000)
    const duringBody = stableAll(await during)
    hold.release()
    const written = await w
    clearConcurrencyProbes()
    const after = stableAll(await readAll(claimId))
    return { prompt, ok: written.ok, before, during: duringBody, after }
  }
  const r65 = await raceAll(C.claimId, 'revenueEvidence.inserted', () => registerRevenueSourceEvidence(S2, { sourceKind: SYNTHETIC, sourceReference: ref('A71-RACE') }, creatorId))
  check('T065', 'Concurrent A7.1 insert not partially visible', r65.prompt && r65.ok && same(r65.during, r65.before) && same(r65.after, r65.before), 'with an A7.1 registration on S2 uncommitted, all three projections answer at once with committed facts only; afterwards they are unchanged (the case is history)')
  const s66 = await registerSource(S2, 'A72-RACE')
  const r66 = await raceAll(C.claimId, 'evidenceClassification.inserted', () => classifySourceEvidence(s66, {}, creatorId))
  check('T066', 'Concurrent A7.2 write not partially visible', r66.prompt && r66.ok && same(r66.during, r66.before) && same(r66.after, r66.before), 'with an A7.2 classification uncommitted, all three answer at once and stay identical')
  const c67 = await classifyOnly(await registerSource(S2, 'A73-RACE'))
  const r67 = await raceAll(C.claimId, 'evidenceGate.inserted', () => recordAdjudicationReadiness(c67, {}, creatorId))
  check('T067', 'Concurrent A7.3 write not partially visible', r67.prompt && r67.ok && same(r67.during, r67.before) && same(r67.after, r67.before), 'with an A7.3 readiness uncommitted, all three answer at once and stay identical')
  await linkedSource(h3, 'H3-E1')
  const r68 = await raceAll(H.claimId, 'evidenceCase.entries_inserted', () => assembleRevenueEvidenceCase(h3, {}, creatorId))
  check('T068', 'Uncommitted case absent until commit', r68.prompt && r68.ok && r68.during.timeline.submissions[2].caseSummaries.length === 0 && r68.during.continuity.gaps[2].gapCode === 'CASE_NOT_RECORDED' && r68.after.continuity.gaps[2].gapCode === 'PREREQUISITE_NOT_RECORDED', "while h3's case header and entries were written but uncommitted every projection showed no case; after commit, the case — never half a case")
  const h3Case = r68.after.timeline.submissions[2].caseSummaries[0].caseId as string
  const r69 = await raceAll(H.claimId, 'casePrerequisite.inserted', () => assessClosurePrerequisites(h3Case, {}, creatorId))
  check('T069', 'Uncommitted assessment absent until commit', r69.prompt && r69.ok && r69.during.continuity.gaps[2].gapCode === 'PREREQUISITE_NOT_RECORDED' && r69.during.delta.comparisons[1].prerequisiteAfter === null && r69.after.continuity.gaps[2].gapCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'while the assessment of h3\'s case was uncommitted no projection showed it; after commit, exactly the recorded outcome')
  const h4 = await H.extend()
  const unlinked = await readAll(H.claimId)
  const holdLink = holdAt('claimCorrection.inserted')
  const linking = recordCorrectionLink(H.claimId, { priorSubmissionId: h3, correctedSubmissionId: h4, reasonCode: 'CORRECTED_CODING' }, creatorId)
  await Promise.race([holdLink.arrived, linking])
  const duringLink = readAll(H.claimId)
  const linkPrompt = await settledWithin(duringLink, 4000)
  const duringLinkReads = await duringLink
  holdLink.release()
  const linked = await linking
  clearConcurrencyProbes()
  const afterLink = await readAll(H.claimId)
  check(
    'T070',
    'Uncommitted correction never half-visible',
    [unlinked.timeline, unlinked.delta, unlinked.continuity].every((r) => r.status === 409) && linkPrompt && [duringLinkReads.timeline, duringLinkReads.delta, duringLinkReads.continuity].every((r) => r.status === 409) && linked.ok && afterLink.timeline.body.submissions.length === 4 && afterLink.continuity.body.submissionCount === 4,
    'with h4 frozen but its h3→h4 link uncommitted, every read answered at once from the committed history (an unlinked freeze: 409, never a half-linked pair); after the link commits, four freezes',
  )

  // ---------------------------------------------------------------- authentication, tenancy, privacy (T071–T080)
  section('Authentication, tenancy and privacy: 401, 403, foreign = missing 404, 400 selectors and spoofing, no PHI, money, payload or audit')
  const readers = (claimId: string) => Object.values(P(claimId))
  const noSession = await Promise.all(readers(C.claimId).map((p) => get(p, anonymous)))
  check('T071', 'No-session 401', noSession.every((r) => r.status === 401) && (await get(`/api/closure-prerequisite-assessments/${ASSESS1.assessmentId}/basis-trace`, anonymous)).status === 401, 'without a session the timeline, delta, continuity and trace answer 401')
  const noGrant = await Promise.all(readers(C.claimId).map((p) => get(p, N.who)))
  const routeFiles = ['revenue-timeline/revenue-timeline.route.ts', 'revenue-delta/revenue-delta.route.ts', 'revenue-continuity/revenue-continuity.route.ts'].map((f) => committedCode(`backend/src/modules/${f}`))
  const fiveGrants = ['claim.read', 'claimFreeze.read', 'claimCorrection.read', 'evidenceCase.read', 'evidenceCasePrereq.read']
  check('T072', 'Member without all grants 403', noGrant.every((r) => r.status === 403 && !rawError(r.body)) && routeFiles.every((code) => same([...code.matchAll(/requireMemberPermission\(organizationIdFromClaim, '([^']+)'\)/g)].map((m) => m[1]), fiveGrants)), 'a member of the organization holding no grant receives 403 from all three readers; each route requires all five reads')
  const foreign = await Promise.all(readers(C.claimId).map((p) => get(p, O.who)))
  const missing = await Promise.all(readers(MISSING).map((p) => get(p, O.who)))
  check('T073', 'Foreign tenant matches missing 404', foreign.every((r, i) => r.status === 404 && same({ ...r.body?.error, requestId: null }, { ...missing[i].body?.error, requestId: null })) && (await Promise.all(readers(F.claimId).map((p) => get(p)))).every((r) => r.status === 404), "another organization's Admin gets exactly the missing-Claim envelope from all three, and this tenant's Admin 404 for theirs")
  const malformed = (await Promise.all(['not-a-uuid', encodeURIComponent("1' OR '1'='1"), '..%2F..%2Fadmin', `${MISSING}0`].flatMap((id) => readers(id).map((p) => get(p))))).concat(await get('/api/closure-prerequisite-assessments/not-a-uuid/basis-trace'))
  check('T074', 'Malformed Claim id safely 400', malformed.every((r) => r.status === 400 && !rawError(r.body)), `${malformed.length} malformed, SQL- and traversal-shaped ids: 400 with a safe body`)
  const selectors = await Promise.all(readers(C.claimId).flatMap((p) => [get(`${p}?latest=true`), get(`${p}?organizationId=${otherOrg}`), getWithBody(p, JSON.stringify({ gaps: [] }), admin.cookie)]))
  check('T075', 'Query/body selector refused 400', selectors.every((r) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR'), `${selectors.length} selector, tenant-query and body attempts refused 400 by all three readers`)
  const spoofed = await Promise.all(readers(C.claimId).map((p) => api('GET', `${p}?organizationId=${org}`, undefined, (init = {}) => O.who({ ...init, headers: { 'X-Organization-Id': org, 'X-Actor-Id': creatorId } }))))
  check('T076', 'No actor or tenant spoofing', spoofed.every((r) => r.status === 404 && !rawError(r.body)), 'a foreign Admin naming this organization and actor in headers and query still gets 404 from all three; identity comes only from the session')
  const exposure = [RC, RQ, RBc, ROne].flatMap((r) => [r.timeline.body, r.delta.body, r.continuity.body]).concat([trace1.body, qtrace3.body])
  const exposed = JSON.stringify(exposure)
  const exposedKeys = [...deepKeys(exposure)]
  check('T077', 'No PHI or clinical values in DTO', !exposed.includes(`${runId}-home-P`) && !exposed.includes('1990-01-01') && !exposedKeys.some((k) => /patient|member|name|birth|email|phone|address|gender|diagnos|procedure|activity|encounter|clinician|facility|^(claim)?lines?(Id)?$/i.test(k)) && !exposed.includes(key('home-DXA')), 'no patient, member, clinical, encounter, clinician, facility or line value or key in the timeline, delta, continuity or trace')
  check('T078', 'No amounts, payer or balances in DTO', !/125\.25|12\.125|200\.01|AED/.test(exposed) && !exposedKeys.some((k) => /amount|balance|currency|price|fee|total|money|payer|payment|remit|settle/i.test(k)), 'no amount, currency, balance, price, payer, payment or settlement value or key')
  check('T079', 'No frozen payload/source bytes exposed', !exposedKeys.some((k) => /payload|bytes|seal|canonical|raw|sourceReference|fingerprint|secret|token|cookie/i.test(k)) && !exposed.includes(ref('S1-E1')) && !exposed.includes(classRow.sourceFingerprintSha256), 'no frozen payload, seal, source reference, fingerprint, secret or cookie is exposed')
  const auditBefore = await prisma.auditEvent.count()
  await readAll(C.claimId)
  await readAll(C.claimId, asViewer)
  await traceOf(ASSESS1.assessmentId)
  await Promise.all(readers(MISSING).map((p) => get(p)))
  await Promise.all(readers(C.claimId).map((p) => get(p, O.who)))
  await Promise.all(readers(C.claimId).map((p) => get(p, N.who)))
  check('T080', 'No audit for successful/refused read', (await prisma.auditEvent.count()) === auditBefore, 'successful, missing, foreign and forbidden reads of A7.6–A7.9 wrote no audit event')

  // ---------------------------------------------------------------- stability and prior history (T081–T090)
  section('Stability and prior history: repeat reads, time zone and locale, ordinals, a later freeze and correction, read-back after a restart')
  const twiceA = stableAll(await readAll(C.claimId))
  const twiceB = await readAll(C.claimId)
  check('T081', 'Repeat read stable excluding evaluatedAt', same(twiceA, stableAll(twiceB)) && [twiceB.timeline, twiceB.delta, twiceB.continuity].every((r) => /Z$/.test(r.body.evaluatedAt)), 'two reads of the timeline, delta and continuity are byte-identical apart from evaluatedAt')
  const probe = spawnSync(
    process.execPath,
    ['--env-file=.env', '--input-type=module', '-e', `import { prisma } from './src/shared/database/prisma.ts'; import { getRevenueTimeline } from './src/modules/revenue-timeline/revenue-timeline.service.ts'; import { getRevenueDelta } from './src/modules/revenue-delta/revenue-delta.service.ts'; import { getRevenueContinuity } from './src/modules/revenue-continuity/revenue-continuity.service.ts'; const strip = (r) => { const { evaluatedAt, ...rest } = r.ok ? r.value : {}; return rest }; const out = [strip(await getRevenueTimeline('${C.claimId}')), strip(await getRevenueDelta('${C.claimId}')), strip(await getRevenueContinuity('${C.claimId}'))]; console.log(JSON.stringify([out, Intl.DateTimeFormat().resolvedOptions().timeZone, Intl.DateTimeFormat().resolvedOptions().locale])); await prisma.$disconnect()`],
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
    return [await getRevenueTimelineOf(C.claimId, tx), await getRevenueDeltaOf(C.claimId, tx), await getRevenueContinuityOf(C.claimId, tx)]
  })
  const twiceList = [twiceA.timeline, twiceA.delta, twiceA.continuity]
  check('T082', 'Timezone change leaves facts identical', probed !== null && probed[1] === 'Pacific/Kiritimati' && same(probed[0], twiceList) && zoned.every((r, i) => r.ok && same(stable(r.value), twiceList[i])), 'a separate process in Pacific/Kiritimati and a database session in that zone derive identical timeline, delta and continuity')
  check('T083', 'Locale change leaves ordering identical', probed !== null && same(probed[0], twiceList) && !/toLocale|Intl\.|localeCompare|\.sort\(\s*\)/.test(readersCode), `with a ${probed?.[2] ?? '?'} process locale the order is identical; no reader compares by locale or sorts without an explicit code-point comparator (chain order comes from the A6.9 links)`)
  const ordinalsOk = (r: Awaited<ReturnType<typeof readAll>>) =>
    [r.timeline.body.submissions, r.delta.body.comparisons, r.continuity.body.gaps].every((list: any[]) => same(list.map((x) => x.ordinal), list.map((_, i) => i + 1)))
  check('T084', 'All ordinals contiguous', [RC, RQ, RBc, ROne, RZ, afterLink].every(ordinalsOk), 'timeline, comparison and gap ordinals are exactly 1..N on every Claim')
  const history = async () => ({ freezes: await freezeHash(C.claimId), links: await linkHash(C.claimId), cases: await caseHash(C.claimId), assessments: await assessmentHash(C.claimId), sources: await sourceHash(C.claimId) })
  const oldFreezeHash = () => hashOf(`SELECT f.*, m.id AS manifest_id, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') AS manifest FROM ${FREEZES} f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.id = ANY($1::uuid[])`, [S1, S2, S3])
  const oldFreezesBefore = await oldFreezeHash()
  const historyBefore = await history()
  const linkRowsBefore = await prisma.claimCorrectionLink.findMany({ where: { claimId: C.claimId }, orderBy: { id: 'asc' } })
  const projectionsBefore = stableAll(await readAll(C.claimId))
  const S4 = await C.extend()
  const CL3 = await linkOf(C.claimId, S3, S4)
  const afterGrow = await readAll(C.claimId)
  check('T085', 'Old freezes byte-identical', (await oldFreezeHash()) === oldFreezesBefore && (await freezeHash(C.claimId)) !== historyBefore.freezes && afterGrow.timeline.body.submissions.slice(0, 3).every((e: any, i: number) => same(e, projectionsBefore.timeline.submissions[i])), 'after S4 is frozen, S1–S3 and their manifests read back byte-identically (only S4 is new) and their timeline entries are identical')
  const linkRowsAfter = await prisma.claimCorrectionLink.findMany({ where: { claimId: C.claimId }, orderBy: { id: 'asc' } })
  check('T086', 'Old correction history identical', linkRowsAfter.length === 3 && linkRowsBefore.every((l) => linkRowsAfter.some((a) => same(a, l))) && linkRowsAfter.some((l) => l.id === CL3 && l.priorSubmissionId === S3 && l.correctedSubmissionId === S4), 'both earlier links are byte-identical; exactly one new link S3→S4 was added through A6.9')
  check('T087', 'Old A7.4 cases identical', (await caseHash(C.claimId)) === historyBefore.cases && (await sourceHash(C.claimId)) === historyBefore.sources, 'every byte of C\'s case headers and entries (and its sources and fingerprints) is unchanged')
  check('T088', 'Old A7.5 assessments identical', (await assessmentHash(C.claimId)) === historyBefore.assessments, "every byte of C's assessments is unchanged")
  check('T089', 'Old comparisons after extension identical', same(afterGrow.delta.body.comparisons.slice(0, 2), projectionsBefore.delta.comparisons) && same(afterGrow.continuity.body.gaps.slice(0, 3), projectionsBefore.continuity.gaps) && afterGrow.continuity.body.gaps[3].gapCode === 'CASE_NOT_RECORDED', 'S1/S2 and S2/S3 are byte-identical; the first three gaps are unchanged and S4 is appended as CASE_NOT_RECORDED (no old gap cleared)')
  const beforeRestart = stableAll(await readAll(C.claimId))
  const restartedOnce = spawnSync('docker', ['restart', dbContainer], { encoding: 'utf8' }).status === 0
  await waitFor(databaseUp, 90_000)
  await apiReady('reading after the database restart')
  check('T090', 'Restart readback identical', restartedOnce && same(stableAll(await readAll(C.claimId)), beforeRestart), 'after the database container restarts, the timeline, delta and continuity of C read back byte-identically')

  // ---------------------------------------------------------------- phase boundaries (T091–T100)
  section('Clear phase boundaries: no payer submission, adjudication, remittance, patient responsibility, receivable, adjustment, ledger, A8 or A9 functionality')
  const tableNames = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`).map((r) => r.t)
  const tablesLike = (re: RegExp) => tableNames.filter((t) => re.test(t))
  const a7Code = committedProductionCodeOf(A7_MODULE_DIRS).code
  // Identifiers only: messages and other string literals may name what a module refuses to do.
  const a7Identifiers = a7Code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")
  const routeStatus = async (method: string, path: string) => (await api(method, path, method === 'GET' ? undefined : {})).status
  const transmitRoutes = [await routeStatus('POST', `/api/claim-submissions/${S1}/transmissions`), await routeStatus('POST', `/api/claims/${C.claimId}/payer-submissions`), await routeStatus('GET', `/api/claim-submissions/${S1}/acknowledgements`)]
  check('T091', 'No real payer submission implied', transmitRoutes.every((s) => s === 404) && tablesLike(/outbox|transmission|acknowledg|payer_submission/).length === 0 && !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici/.test(a7Code), 'no transmission, payer-submission or acknowledgement route or table; no A7 module opens a network connection')
  check('T092', 'No actual payer adjudication inferred', tablesLike(/adjudicat|denial|allowed_amount/).length === 0 && !deepStrings(exposure).some((v) => /^(ADJUDICATED|APPROVED|DENIED|REJECTED|PAID)$/.test(v)) && readinessCodes.every((r) => r.readinessCode === 'NOT_READY_FOR_ADJUDICATION'), 'no adjudication or denial table; no projection carries an adjudicated, approved, denied or paid value')
  const moneyRoutes = [await routeStatus('POST', `/api/claims/${C.claimId}/payments`), await routeStatus('POST', `/api/claims/${C.claimId}/remittances`), await routeStatus('GET', `/api/claims/${C.claimId}/remittance-advice`)]
  check('T093', 'No remittance/payment inferred', moneyRoutes.every((s) => s === 404) && tablesLike(/remittance|payment|settle|cash|receipt/).length === 0 && CCb.gaps.every((g: any) => g.gapCode !== 'PAID'), 'no payment or remittance route or table; EXTERNAL_FINANCIAL_EVIDENCE_ABSENT is reported as an absence, never as payment or denial')
  check('T094', 'No patient-responsibility calculation', tablesLike(/copay|coinsurance|deductible|patient_share|patient_resp/).length === 0 && !/patientResponsibility|copay|coinsurance|deductible/i.test(a7Identifiers), 'no copay, coinsurance, deductible or patient-share table or code in any A7 module')
  const countsBefore95 = await counts()
  for (const c of [C, Q, Bc, One, Z]) await readAll(c.claimId)
  check('T095', 'No receivables or journal writes', tablesLike(/receivable|journal|posting|ledger_entry/).length === 0 && (await unchanged(countsBefore95)), 'no receivable, journal or posting table; reading five Claims through all three readers changed no row anywhere')
  check('T096', 'No adjustment/write-off assumed', tablesLike(/adjust|write_off|writeoff/).length === 0 && !/[Aa]djustment|[Ww]rite-?[Oo]ff/.test(a7Identifiers) && ![...deepKeys(exposure)].some((k) => /adjust|writeOff/i.test(k)), 'no adjustment or write-off table, code or field')
  check('T097', 'No ledger/AR reconciliation', tablesLike(/ledger|reconcil|balance|accounts_receivable|\bar_/).length === 0 && !/[Ll]edger|[Rr]econcil|[Rr]eceivable|[Bb]alance/.test(a7Identifiers), 'no ledger, reconciliation, balance or receivable table or code in A7')
  const oneBefore = stableAll(await readAll(One.claimId))
  await post(`/api/claim-submissions/${One.freezes[0]}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null })
  const oneLifecycle = (await get(`/api/claim-submissions/${One.freezes[0]}/lifecycle`)).body
  const oneAfter = await readAll(One.claimId)
  check('T098', 'A6.8 internal release not payer release', oneLifecycle?.state === 'RELEASE_ELIGIBLE' && same(stableAll(oneAfter), oneBefore) && ![...deepKeys(stableAll(oneAfter))].some((k) => /disposition|lifecycle|release|status|sent/i.test(k)), "after an internal AUTHORIZE_RELEASE (RELEASE_ELIGIBLE) One's timeline, delta and continuity are byte-identical and carry no release, send or status")
  const tracked = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/)
  check('T099', 'No A8 exception workflow added', tracked.filter((f) => /exception|work-?queue|integration\/a8/i.test(f) && !/error/i.test(f)).length === 0 && tablesLike(/exception|work_queue|task_assign/).length === 0 && (await routeStatus('POST', `/api/claims/${C.claimId}/exceptions`)) === 404, 'no exception, work-queue or A8 module, table or route')
  check('T100', 'No A9 external adapter added', tracked.filter((f) => /dhpo|eclaimlink|x12|hl7|payer-adapter|integration\/a9/i.test(f)).length === 0 && !/soap|xml2js|x12|hl7/i.test(a7Identifiers), 'no DHPO, eClaimLink, X12, HL7 or payer adapter file, and no A7 module speaks an exchange format')

  const goldenBefore = { ...stableAll(await readAll(C.claimId)), trace: stable((await traceOf(ASSESS1.assessmentId)).body) }

  // ---------------------------------------------------------------- nested integration and regressions (T101–T111)
  section('Regressions — A7.9 invoked, nesting A7.8 -> A7.7 -> A7.6 -> A7.5 -> A7.4 -> A7.3 -> A7.2 -> A7.1 -> A6.10 -> … -> A1')
  await apiReady('the A7.9 and backward regression chain')
  // Rows written from here on belong to the nested suites' own fixtures (each proves its own); T119 judges this run's.
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const chain = run('npm run test:a7:revenue-continuity')
  const nestedLog = `a710-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.9')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.9] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.9 asserts facts about its own branch (name, tracking, allowed paths, pushed HEAD) and re-proves A7.8's
  // branch-only causes against its own branch. On A7.10 those statements are obsolete by design; every other A7.9 check
  // is substantive. T111 below proves each cause independently.
  const a79NonApplicable: Record<string, string> = {
    T001: "A7.9 'A7.8 FINAL PASS merge is an ancestor' requires the A7.9 feature branch (and reads any other A7 suite as later code); A7.10 is branched from the main that contains the A7.9 merge",
    T002: "A7.9 'Clean HEAD and origin parity' requires tracking origin/feature/a7-9-…, deleted when it merged; the clean tree and exact parity of THIS branch are proved by T002 and T122 here",
    T010: "A7.9 'Exact changed-file allowlist' lists the paths A7.9 was allowed to change; A7.10 legitimately changes its own (T010 here)",
    T120: "A7.9 'All historical branch-only N/A justified' proves A7.8's branch-only causes against the A7.9 branch (its name, tracking, diff and pushed HEAD); on A7.10 those proofs are re-done here (T111)",
    T130: "A7.9 'Two complete runs, exact HEAD parity' compares HEAD with origin/feature/a7-9-…, deleted when it merged, and A7.9's own allowlist; THIS branch's are proved by T010, T122 and T130 here",
  }
  const undocumented = failing.filter((id) => !(id in a79NonApplicable))
  const summary = chain.output.match(/\[A7\.9\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.9\] RUN ABORTED|\[A7\.9\] uncaught error|\[A7\.9\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a79Substantive = rows.filter((row) => !(row.id in a79NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a79Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  check(
    'T101',
    'A7.9 own substantive acceptance passes',
    ran && reconciled && undocumented.length === 0 && a79Substantive.length === 0 && a79Passing >= 125 && ['T004', 'T007', 'T009', 'T034', 'T051', 'T060', 'T070', 'T084', 'T110', 'T123', 'T127', 'T128', 'T129'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A7.9 suite did not complete'
      : !reconciled
        ? `A7.9 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.9 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.9\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.9] automated summary: ', 'A7.9 ')}; all ${a79Passing} substantive checks PASS and every failure is documented`,
  )
  for (const id of Object.keys(a79NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T101/${id}`, `A7.9 ${titleOf(row.line)}`, a79NonApplicable[id])
  }
  check('T102', 'A7.8 substantive regression passes', verdictOf('T111') === 'PASS', `A7.9 T111 (A7.8 with its own justified N/A) ${verdictOf('T111')}`)
  check('T103', 'A7.7 substantive regression passes', verdictOf('T112') === 'PASS', `A7.9 T112 (A7.7) ${verdictOf('T112')}`)
  check('T104', 'A7.6 substantive regression passes', verdictOf('T113') === 'PASS', `A7.9 T113 (A7.6) ${verdictOf('T113')}`)
  check('T105', 'A7.5 substantive regression passes', verdictOf('T114') === 'PASS', `A7.9 T114 (A7.5) ${verdictOf('T114')}`)
  check('T106', 'A7.4 substantive regression passes', verdictOf('T115') === 'PASS', `A7.9 T115 (A7.4) ${verdictOf('T115')}`)
  check('T107', 'A7.3 substantive regression passes', verdictOf('T116') === 'PASS', `A7.9 T116 (A7.3) ${verdictOf('T116')}`)
  check('T108', 'A7.2 substantive regression passes', verdictOf('T117') === 'PASS', `A7.9 T117 (A7.2) ${verdictOf('T117')}`)
  check('T109', 'A7.1 substantive regression passes', verdictOf('T118') === 'PASS', `A7.9 T118 (A7.1) ${verdictOf('T118')}`)
  check('T110', 'A6.10→A1 substantive chain passes', verdictOf('T119') === 'PASS', `A7.9 T119 (A6.10 and A6.1–A6.9, A5 and A1–A4) ${verdictOf('T119')}`)
  // Each documented A7.9 failure must fail for its branch-only reason, proved independently on this branch.
  const a79Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA78 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const originA78 = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a78Branch}`])
  const originA79 = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a79Branch}`])
  const originA710 = gitArgs(['rev-parse', `origin/${a710Branch}`])
  const causes: Record<string, boolean> = {
    T001: branch === a710Branch && a79Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a79Merge} HEAD`),
    T002: dirty.length === 0 && tracking.includes(`origin/${a710Branch}`) && !/ahead|behind/.test(tracking),
    T010: a79Unexpected.length > 0 && a79Unexpected.every((path, index) => changedPaths.includes(path) || (index === a79Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A7.9 re-proves A7.8's branch-only causes against the A7.9 branch; on A7.10 only those tied to that branch can be
    // unproven — re-proved here against this branch.
    T120: unprovenA78.length > 0 && unprovenA78.every((id) => ['T001', 'T002', 'T010', 'T120', 'T130'].includes(id)) && originA78 === '' && prismaStatus.length === 0 && outOfScope.length === 0 && tracking.includes(`origin/${a710Branch}`),
    T130: originA79 === '' && originA710 === headAtStart && headAtStart.length === 40 && outOfScope.length === 0,
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A7\.9\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T111',
    'All prior branch-only N/A justified',
    ran && failing.every((id) => id in a79NonApplicable) && unproven.length === 0 && naLines.length === 5 && naLines.every((line) => line.length > 80),
    unproven.length === 0
      ? `each documented A7.9 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved independently here; A7.9 itself justifies its five A7.8 items (${naLines.length} lines)`
      : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- build and database gates (T112–T120)
  section('Build and database gates: units, typecheck, frontend, every migration checksum and replay, outage and recovery, no 5xx, synthetic data, A10 warnings')
  const allUnit = run('npm run test:unit')
  check('T112', 'Backend unit suite passes', allUnit.ok && /ℹ fail 0/.test(allUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, every A1–A7 owner unit suite`)
  const typecheck = run('npm run typecheck')
  check('T113', 'Backend TypeScript typecheck passes', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T114', 'Frontend lint passes', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T115', 'Frontend production build passes', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  // Prisma's checksum is the SHA-256 of the migration file as it was read when applied. With core.autocrlf the
  // committed blob (LF) and its checkout (CRLF) are the same committed content; any other difference means the file
  // was changed after apply.
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumForms = applied.map((row) => {
    const path = `backend/prisma/migrations/${row.name}/migration.sql`
    const blob = committedBlob(path)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    const form = blob.length > 0 && sha256Of(blob) === row.checksum ? 'blob' : existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum ? 'checkout' : 'DIFFERS'
    return { name: row.name, form }
  })
  const checksumMismatch = checksumForms.filter((row) => row.form === 'DIFFERS').map((row) => row.name)
  check(
    'T116',
    'All migration checksums match, replay clean',
    status.ok && applied.length === headMigrationDirs.length && same(applied.map((row) => row.name), headMigrationDirs.map((dir) => dir.split('/').pop())) && checksumMismatch.length === 0 && replay.ok,
    checksumMismatch.length === 0 ? `all ${applied.length} committed migrations applied in order, each with the checksum of its committed file; scratch replay ALL CHECKS PASS (T006)` : `checksum differs: ${checksumMismatch.join(', ')}`,
  )
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
  check('T117', 'Health 200 / ready 503 / recovery 200', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  check('T118', 'No unexpected 5xx or connection resets', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runFreezes = await prisma.$queryRawUnsafe<{ org: string }[]>(
    `SELECT p.organization_id::text AS org FROM ${FREEZES} f JOIN claims k ON k.id = f.claim_id JOIN encounters e ON e.id = k.encounter_id JOIN patients p ON p.id = e.patient_id WHERE f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  const runSources = await prisma.$queryRawUnsafe<{ kind: string; reference: string }[]>(`SELECT source_kind AS kind, source_reference AS reference FROM revenue_source_evidence WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, runStartedAt.toISOString(), chainStartedAt.toISOString())
  const secrets = [adminPassword, viewerPassword, admin.cookie, viewer.cookie].filter((s) => s.length > 8)
  const printedText = printed.join('\n')
  check(
    'T119',
    'Only synthetic fixtures and safe logs',
    runFreezes.length > 0 && runFreezes.every((f) => [org, otherOrg].includes(f.org)) && runSources.length > 0 && runSources.every((s) => s.kind === SYNTHETIC && s.reference.includes(runToken)) && secrets.every((s) => !printedText.includes(s) && !chain.output.includes(s)),
    `the ${runFreezes.length} freezes and ${runSources.length} sources this run recorded (before the nested chain) belong to the two synthetic organizations, every source INTERNAL_SYNTHETIC keyed by ${runId}; no password or session cookie appears in this run's output or the nested output`,
  )
  const closureDoc = committedText(CLOSURE_DOC)
  const a10Section = (closureDoc.split(/^## Deferred to A10.*$/m)[1] ?? '').split(/^## /m)[0]
  const warningLines = [chain.output, allUnit.output, typecheck.output, lint.output, build.output, validate.output, generate.output, status.output, replay.output]
    .join('\n')
    .split(/\r?\n/)
    .filter((line) => /DeprecationWarning|ExperimentalWarning|chunks are larger than/i.test(line))
  const unknownWarnings = [...new Set(warningLines.filter((line) => !KNOWN_WARNINGS.some((w) => w.line.test(line))).map((line) => line.replace(/\(node:\d+\)/, '(node)').trim()))]
  const seen = KNOWN_WARNINGS.filter((w) => warningLines.some((line) => w.line.test(line)))
  check(
    'T120',
    'Known A10 deprecations recorded, none hidden',
    a10Section.length > 0 && KNOWN_WARNINGS.every((w) => a10Section.includes(w.recorded)) && unknownWarnings.length === 0 && allUnit.ok && typecheck.ok && lint.ok && build.ok && failing.every((id) => id in a79NonApplicable),
    unknownWarnings.length === 0
      ? `${warningLines.length} warning line(s) seen (${seen.map((w) => w.name).join(', ') || 'none'}); every warning class is recorded under "Deferred to A10" in the closure record; no gate passed with a hidden failure`
      : `unrecorded warning(s): ${unknownWarnings.join(' | ').slice(0, 300)}`,
  )

  // ---------------------------------------------------------------- final identity and closure evidence (T121–T130)
  section('Final identity and closure evidence: exact HEAD, parity, run identity, explicit results, retained nested output, golden scenario, closure record')
  const headNow = git('rev-parse HEAD')
  say(`[${TAG}] HEAD at end ${headNow}`)
  check('T121', 'Exact HEAD printed at beginning and end', headNow === headAtStart && headNow.length === 40 && printed.some((l) => l.includes(`HEAD at start ${headAtStart}`)) && printed.some((l) => l.includes(`HEAD at end ${headNow}`)), `HEAD ${headNow} printed at the start and at the end of this run, unchanged`)
  const trackingNow = git('status -sb').split(/\r?\n/)[0]
  check('T122', 'Git tree clean, branch matches origin', git('status --porcelain') === '' && trackingNow.includes(`origin/${a710Branch}`) && !/ahead|behind/.test(trackingNow) && originA710 === headNow, `${trackingNow}; origin/${a710Branch} = ${originA710.slice(0, 12)}`)
  const runIdUses = await prisma.patient.count({ where: { familyName: { startsWith: runId } } })
  check('T123', 'Independent run ID at exact HEAD', /^A710-\d{13}$/.test(runId) && runIdUses > 0 && headNow === headAtStart && headNow === originA710, `fresh run ID ${runId} (its synthetic records exist only from this run) at exact pushed HEAD ${headNow}; the two submitted runs must both state this HEAD with different run IDs`)
  const idsSoFar = EXPECTED_IDS.slice(0, 123)
  const explicit = idsSoFar.every((id) => printedIds.get(id) === 1) && [...printedIds.keys()].every((id) => EXPECTED_IDS.includes(id))
  check('T124', 'Every test has an explicit result', explicit, explicit ? 'T001–T123 each printed exactly one PASS/FAIL; T124–T130 follow (T130 checks all 130)' : `missing or repeated: ${idsSoFar.filter((id) => printedIds.get(id) !== 1).join(', ')}`)
  const nestedText = existsSync(nestedLog) ? readFileSync(nestedLog, 'utf8') : ''
  const nestedFailLines = chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL/.test(l))
  check(
    'T125',
    'Nested stdout and failure reasons retained',
    nestedText.length > 0 && nestedText === chain.output && /\[A7\.9\] automated summary/.test(nestedText) && nestedFailLines.every((l) => printedText.includes(l.slice(0, 400))),
    `the full nested output (${nestedText.length} chars, SHA-256 ${sha256Of(Buffer.from(nestedText)).slice(0, 16)}…) is kept in backend/${nestedLog}; each of its ${nestedFailLines.length} FAIL lines is repeated in this run's output`,
  )
  check('T126', 'No functional test marked N/A', ownNa.length === 5 && ownNa.every((id) => /^T101\/T\d{3}$/.test(id)) && EXPECTED_IDS.every((id) => !ownNa.includes(id)), `the only N/A lines are the ${ownNa.length} documented nested A7.9 items under T101; every T001–T130 has a PASS/FAIL verdict`)
  const goldenAfter = { ...stableAll(await readAll(C.claimId)), trace: stable((await traceOf(ASSESS1.assessmentId)).body) }
  progress(`golden scenario: Claim C ${C.claimId}: S1 -> S2 -> S3 (then S4): timeline ${worked.timeline.submissions.length} entries; delta ${worked.delta.comparisons.map((c: any) => c.evidenceDeltaCode).join(', ')}; continuity ${worked.continuity.continuityCode} with ${codesOf(worked.continuity).join(', ')}; A7.6 trace ${worked.trace.assessmentCode}`)
  progress('golden scenario: after S4, the nested chain and two database restarts every earlier freeze, link, case, assessment, comparison and gap is byte-identical; no code says money is due, posted, collected, denied or closed')
  check('T127', 'Golden example stable after nested replay', same(goldenAfter, goldenBefore) && goldenAfter.continuity.submissionCount === 4, 'after the full nested A7.9 → A1 chain and the outage, Claim C\'s timeline, delta, continuity and S1\'s A7.6 trace read back identically (all but evaluatedAt)')
  const limitationTerms = ['500 kB', 'client.query()', 'TRUNCATE', 'Lock-wait', 'Time zone', 'P2028', 'ECONNRESET', 'retention']
  check('T128', 'A7 closure record names limitations', closureDoc.length > 0 && limitationTerms.every((t) => a10Section.includes(t)) && /Engineering closure is not financial closure/.test(closureDoc) && /never asserts/.test(closureDoc), `the committed ${CLOSURE_DOC} separates engineering from financial closure and records every A10 limitation (${limitationTerms.join(', ')})`)
  const handoff = (closureDoc.split(/^## A8 and A9 handoff boundary.*$/m)[1] ?? '').split(/^## /m)[0]
  const docMerges = [a610Merge, ...a7Merges.map((m) => m.sha)].map((sha) => sha.slice(0, 7))
  check('T129', 'A8 and A9 handoff boundaries documented', /A8 exception operations/.test(handoff) && /A9 real payer integration/.test(handoff) && /RELEASE_ELIGIBLE/.test(handoff) && /EXTERNAL_FINANCIAL_EVIDENCE_ABSENT/.test(handoff) && docMerges.every((sha) => closureDoc.includes(`\`${sha}\``)), `the record names what A8 and A9 receive and must never infer, and lists the ten accepted merges exactly as git records them (${docMerges.join(', ')})`)
  const allPrinted = EXPECTED_IDS.slice(0, 129).every((id) => printedIds.get(id) === 1)
  check(
    'T130',
    'Final summary 130/130; no hidden failures',
    allPrinted && failed === 0 && passed === 129 && ownNa.length === 5 && headNow === headAtStart,
    `${passed} of the 129 checks before this one PASS, ${failed} FAIL; every id printed exactly once; the two submitted runs must both end 130/130 at ${headNow}`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  say(`[${TAG}] A7.9 accepted merge ${a79Merge}; nested output kept in backend/${nestedLog}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 && passed === 130 ? `[${TAG}] A7 INTEGRATION ACCEPTANCE & PHASE CLOSURE COMPLETE (engineering only — no financial closure)` : `[${TAG}] A7.10 FINAL FAIL`)
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
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[${TAG}] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
