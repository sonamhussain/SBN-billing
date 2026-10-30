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
import { removeClaimLine } from '../../modules/claim-line/claim-line.service.ts'
import { recordLifecycleEvent } from '../../modules/claim-lifecycle/claim-lifecycle.service.ts'
import { registerRevenueSourceEvidence } from '../../modules/revenue-evidence/revenue-evidence.service.ts'
import { classifySourceEvidence } from '../../modules/evidence-classification/evidence-classification.service.ts'
import { getReadinessOf, recordAdjudicationReadiness } from '../../modules/evidence-gate/evidence-gate.service.ts'
import { assembleRevenueEvidenceCase } from '../../modules/evidence-case/evidence-case.service.ts'
import { findCaseById } from '../../modules/evidence-case/evidence-case.repository.ts'
import { deriveCasePrerequisite, recordedAssessmentAgrees } from '../../modules/case-prerequisite/case-prerequisite.reducer.ts'
import { findAssessmentByIdentity } from '../../modules/case-prerequisite/case-prerequisite.repository.ts'
import { assessClosurePrerequisites, getPrerequisiteAssessmentsOf } from '../../modules/case-prerequisite/case-prerequisite.service.ts'
import { BASIS_OF, type DerivationResult, type ReadinessFacts } from '../../modules/case-prerequisite/case-prerequisite.types.ts'

// A7.5 — focused acceptance for Revenue Case Closure-Prerequisite Assessment (T001–T130).
//
// Every frozen submission is built through its owners, exactly as the A6.7–A7.4 suites build them (tariff world and
// rates, the A5.7 recorder, readiness, the Claim, lines, diagnoses and pointers, pricing, draft assessments,
// APPROVE/REVOKE by a separate synthetic Admin, every freeze through the A6.7 route and the correction link through
// A6.9); every source is registered through the A7.1 route, classified through the A7.2 route, gated through the A7.3
// route and cased through the A7.4 route. The other organization builds its own world with its own two Admins.
// Assessments go through the A7.5 route (or, for barrier-controlled races and crash injection, its service
// in-process). ADVERSARIAL writes — and the future REVIEW/UNSUPPORTED cases, which no current source can reach — go in
// only to prove the reducer and a database guard; every one of them runs in a transaction that is ALWAYS rolled back.
// Synthetic Admins are provisioned per run through Better Auth's own server-side creation with a random password that
// is never printed. Every value is synthetic and keyed by this run's id.

const TAG = 'A7.5'
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

const runId = `A75-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a75Branch = 'feature/a7-5-case-closure-prerequisite-assessment'
const a74Branch = 'feature/a7-4-revenue-evidence-case-assembly'
const a73Branch = 'feature/a7-3-adjudication-evidence-readiness'
const a72Branch = 'feature/a7-2-evidence-classification'
const a71Branch = 'feature/a7-1-revenue-source-evidence'
const a610Branch = 'feature/a6-10-a6-integration-acceptance'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/case-prerequisite'
const FE_DIR = 'frontend/src/modules/case-prerequisite'
const HARNESS_DIR = 'backend/src/integration/a7-case-prerequisite'
const MIGRATION_NAME = '20261025090000_a7_5_case_prerequisite'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const UNIT_TESTS = [`${MODULE_DIR}/case-prerequisite.reducer.test.ts`, `${MODULE_DIR}/case-prerequisite.validation.test.ts`]
const TABLE = 'evidence_prereq_results'
const HEADER = 'evidence_case_snapshots'
const ENTRY = 'evidence_case_entries'
const CONTRACT = 'A7-CLOSURE-PREREQ-1'
const CASE_CONTRACT = 'A7-REVENUE-CASE-1'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const DTO_KEYS = ['assessmentId', 'caseId', 'contractVersion', 'assessmentCode', 'basisCode', 'caseManifestSha256', 'recordedByUserId', 'recordedAt']
const AUDIT_KEYS = ['assessmentId', 'caseId', 'contractVersion', 'assessmentCode', 'basisCode', 'recordedAt']
const COLUMNS = ['id', 'organization_id', 'evidence_case_id', 'contract_version', 'assessment_code', 'basis_code', 'case_manifest_sha256', 'recorded_by_user_id', 'recorded_at', 'created_at']
const NOT_READY = { readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' }
const REVIEW = { readinessCode: 'SOURCE_REQUIRES_REVIEW', reasonCode: 'CLASSIFICATION_REVIEW_REQUIRED' }
const UNSUPPORTED = { readinessCode: 'SOURCE_UNSUPPORTED', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }
// The owners A7.5 consumes or must leave untouched: the A5/A6 modules and A7.1–A7.4 (backend, pages and suites).
const OWNER_DIRS = [
  ...[
    'claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction',
    'pre-claim-validation', 'pre-claim-readiness', 'validation-run', 'revenue-evidence', 'evidence-classification', 'evidence-gate', 'evidence-case',
  ].map((name) => `backend/src/modules/${name}`),
  'frontend/src/modules/revenue-evidence',
  'frontend/src/modules/evidence-classification',
  'frontend/src/modules/evidence-gate',
  'frontend/src/modules/evidence-case',
  'backend/src/integration/a7-revenue-source-evidence',
  'backend/src/integration/a7-evidence-classification',
  'backend/src/integration/a7-evidence-gate',
  'backend/src/integration/a7-evidence-case',
]
// The tables whose rows a refusal, a read or a rolled-back write must leave untouched, always read in this fixed
// key order (a UNION ALL may come back in Parallel Append order).
const COUNT_TABLES = [TABLE, HEADER, ENTRY, 'evidence_gate_results', 'source_evidence_classifications', 'revenue_source_evidence', 'audit_events', 'claims', 'claim_pricing_runs', 'claim_review_events', 'claim_freezes', 'claim_freeze_evidence_manifests', 'claim_freeze_lifecycle_events', 'claim_correction_links']

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

function failAt(probe: string) {
  clearConcurrencyProbes()
  setConcurrencyProbe(probe, async () => {
    throw new Error(`INJECTED_CRASH_AT_${probe}`)
  })
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
const outcomeOf = (result: DerivationResult | undefined) => (!result ? '?' : result.ok ? `${result.value.assessmentCode}/${result.value.basisCode}` : 'refused PROVENANCE_CONFLICT')

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[${TAG}] A7.5 revenue case closure-prerequisite assessment — run ${runId}`)
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
  section('Preflight: accepted A7.4, the one A7.5 migration, Prisma, replay, permissions, routes, contracts and ownership')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a74Merge = mergeOf(a74Branch)
  const a73Merge = mergeOf(a73Branch)
  const a72Merge = mergeOf(a72Branch)
  const a71Merge = mergeOf(a71Branch)
  const a610Merge = mergeOf(a610Branch)
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|settlement|receivable|claim-transport|claim-outbox|payer-response|integration\/a(8|9)|integration\/a7-(?!revenue-source-evidence|evidence-classification|evidence-gate|evidence-case|case-prerequisite)|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Correct A7.4 merge prerequisite',
    branch === a75Branch && a74Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a74Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A7.4 merged as ${a74Merge.slice(0, 7) || 'NOT FOUND'} and is an ancestor; contains latest main ${git('rev-parse --short origin/main')}, not stacked on an unmerged branch; no A7.6+/A8/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean HEAD and origin parity', dirty.length === 0 && tracking.includes(`origin/${a75Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  const a74RepositoryCode = committedCode('backend/src/modules/evidence-case/evidence-case.repository.ts')
  const a73ServiceCode = committedCode('backend/src/modules/evidence-gate/evidence-gate.service.ts')
  check(
    'T003',
    'A6.10/A7.1–A7.4 ancestry and ownership',
    [a610Merge, a71Merge, a72Merge, a73Merge, a74Merge].every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)) &&
      /export async function findCaseById\(id: string, db: DbClient = prisma\)/.test(a74RepositoryCode) && /export async function getReadinessOf\(classificationId: string, tx: DbClient\)/.test(a73ServiceCode),
    `A6.10 ${a610Merge.slice(0, 7)}, A7.1 ${a71Merge.slice(0, 7)}, A7.2 ${a72Merge.slice(0, 7)}, A7.3 ${a73Merge.slice(0, 7)} and A7.4 ${a74Merge.slice(0, 7)} are ancestors; the exact A7.4 case read (findCaseById on a DbClient) and A7.3 getReadinessOf(classificationId, tx) are the owners' existing exports`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma/migrations']).split(/\r?\n/).filter(Boolean)
  check(
    'T004',
    'One additive migration only',
    same(migrationStatus, [`A\t${MIGRATION}`]),
    migrationStatus.length === 1 ? `one added migration, no applied migration modified: ${MIGRATION_NAME}` : `migration changes: ${migrationStatus.join(' | ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma validate/generate/status', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, the working database is up to date (never reset)')
  const replay = run('npm run db:verify:replay')
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  const replayExpected = [
    /PASS {2}the A7\.5 tables are exactly evidence_prereq_results/,
    /PASS {2}evidence_prereq_results_insert_guard_trg is present after a clean replay/,
    /PASS {2}evidence_prereq_results_append_only_trg is present after a clean replay/,
    /PASS {2}evidence_prereq_results_no_truncate_trg is present after a clean replay/,
    /PASS {2}the A7\.5 CHECKs pin A7-CLOSURE-PREREQ-1, exactly the five outcomes and five bases, with no closure or payment code/,
    /PASS {2}one assessment per case and contract is unique/,
    /PASS {2}evidence_prereq_results carries exactly its 10 A7\.5 columns/,
    /PASS {2}the A7\.4 tables are exactly evidence_case_entries and evidence_case_snapshots/,
    /PASS {2}the A7\.3 tables are exactly evidence_gate_results/,
    /PASS {2}the A7\.2 tables are exactly source_evidence_classifications/,
    /PASS {2}the A7\.1 tables are exactly revenue_source_evidence/,
  ]
  check(
    'T006',
    'From-empty migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === headMigrationDirs.length && headMigrationDirs.some((dir) => MIGRATION.startsWith(`${dir}/`)),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — all ${headMigrationDirs.length} committed at HEAD, the A7.5 migration included; every A7.1–A7.5 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^evidenceCasePrereq\./.test(code)).sort()
  const invented = allCodes.filter((code) => /(prereq|closure)/i.test(code) && /(pay|remit|post|settle|adjudicat|denial|receivable|ledger|verif|send|transmit|submit|approve|import|balance|close\b|reconcil)/i.test(code))
  check(
    'T007',
    'Exact permission catalogue',
    same(family, ['evidenceCasePrereq.create', 'evidenceCasePrereq.read']) &&
      (await grantsOf('evidenceCasePrereq.create')) === 'ORG_ADMIN' &&
      (await grantsOf('evidenceCasePrereq.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      same(allCodes.filter((code) => /^evidenceCase\./.test(code)).sort(), ['evidenceCase.create', 'evidenceCase.read']) &&
      (await grantsOf('evidenceCase.create')) === 'ORG_ADMIN' &&
      (await grantsOf('adjudicationReadiness.create')) === 'ORG_ADMIN' &&
      same(allCodes.filter((code) => /^revenue/i.test(code)).sort(), ['revenueEvidence.create', 'revenueEvidence.read']) &&
      invented.length === 0,
    'evidenceCasePrereq.create (Admin) and .read (Admin, Viewer) only — scoped clear of the A7.1 revenue* and A7.4 evidenceCase.* families, both unchanged; no pay, settle, post, close or reconcile permission',
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
  const markerOf = (message: string) =>
    (message.match(/[a-z_]+_(chk|fkey|key)\b/) ?? message.match(/evidence_[a-z_]+ is append-only: [A-Z]+|evidence_prereq_[a-z]+|null value|cannot truncate/) ?? [message.includes('ROLLED_BACK') ? 'ACCEPTED' : message === '' ? 'COMMITTED' : '?'])[0]

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
  // B approves (separation of duties for A6.5) and assesses as a second actor; O and O2 are the two Admins of the
  // OTHER organization, who build its own frozen submission, evidence and case.
  const B = await provisionAdmin('b')
  const O = await provisionAdmin('o', otherOrg)
  const O2 = await provisionAdmin('o2', otherOrg)

  const assessPath = (caseId: string) => `/api/revenue-evidence-cases/${caseId}/closure-prerequisite-assessments`
  const onePath = (assessmentId: string) => `/api/closure-prerequisite-assessments/${assessmentId}`
  const assess = (caseId: string, who: Who = asAdmin, body: unknown = {}) => post(assessPath(caseId), body, who)
  const historyOf = async (caseId: string, who: Who = asAdmin) => (await get(assessPath(caseId), who)).body?.items ?? []
  const wiring = [await assess(MISSING), await get(assessPath(MISSING)), await get(onePath(MISSING))]
  const absent = [
    await api('PATCH', onePath(MISSING), {}),
    await api('PUT', onePath(MISSING), {}),
    await api('DELETE', onePath(MISSING)),
    await api('DELETE', assessPath(MISSING)),
    await api('PUT', assessPath(MISSING), {}),
    await api('POST', '/api/closure-prerequisite-assessments', {}),
    await api('GET', '/api/closure-prerequisite-assessments'),
    await api('GET', `${assessPath(MISSING)}/latest`),
    await api('POST', `${onePath(MISSING)}/close`, {}),
    await api('POST', `/api/revenue-evidence-cases/${MISSING}/closures`, {}),
    await api('GET', `/api/claim-submissions/${MISSING}/closure-prerequisite-assessments`),
    await api('GET', `/api/claims/${MISSING}/closure-prerequisite-assessments`),
  ]
  const unauthenticated = [await assess(MISSING, anonymous), await get(assessPath(MISSING), anonymous), await get(onePath(MISSING), anonymous)]
  check(
    'T008',
    'Three routes wired, forbidden absent',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && absent.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `three routes answer a missing target with a privacy-safe 404; PATCH/PUT/DELETE, collection, latest, close, closures, per-submission and per-Claim routes are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
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
  ]
  // A7.5's own scope for T009: on its own branch, its diff against main; on any later branch, exactly what its own
  // merge added, judged by the same rules. A later package's changes (A8.1's, a later harness correction's) are
  // that package's to prove.
  const ownMerge = branch === a75Branch ? '' : mergeOf(a75Branch)
  const ownRange = ownMerge ? `${ownMerge}^1..${ownMerge}` : 'origin/main...HEAD'
  const ownChangedPaths = gitArgs(['diff', '--name-only', ownRange]).split(/\r?\n/).filter(Boolean)
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file))
  const ownOwnerChanged = ownChangedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file))
  check(
    'T009',
    'All prior contracts and owner code preserved',
    same(contracts, ['A6-CLAIM-1', 'A6-SUBMISSION-1', 'A6-LIFECYCLE-1', 'A6-CORRECTION-1', 'A7-REVENUE-SOURCE-1', 'A7-EVIDENCE-CLASS-1', 'A7-ADJ-READINESS-1', CASE_CONTRACT]) && ownOwnerChanged.length === 0,
    ownOwnerChanged.length === 0
      ? 'A6-CLAIM-1 … A6-CORRECTION-1, A7-REVENUE-SOURCE-1, A7-EVIDENCE-CLASS-1, A7-ADJ-READINESS-1 and A7-REVENUE-CASE-1 unchanged; no A5/A6/A7.1–A7.4 owner module, page or suite changed (the A7.4 exact case read is consumed unchanged)'
      : `changed: ${ownOwnerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: frozen submissions, a correction link, A7.1 sources, A7.2 classifications, A7.3 results and A7.4 cases of two organizations')
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
  const P = await home.series('pool', 18)
  let poolNext = 0
  const fresh = () => {
    const submission = P.freezes[poolNext]
    poolNext += 1
    if (!submission) throw new Error('fixture: the submission pool is exhausted')
    return submission
  }
  const [S1, S2] = W.freezes
  const ref = (suffix: string) => `SYN-${runId.replace(/^A75-/, '')}-${suffix}`.toUpperCase()
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
    return res.body as { caseId: string; assemblyCode: string; manifestSha256: string; itemCount: number }
  }
  // A fresh pool submission with one linked source and its A7.4 case.
  const linkedCase = async (suffix: string, submissionId = fresh()) => {
    await linkedSource(submissionId, suffix)
    return { submissionId, case: await caseOf(submissionId) }
  }
  const link = await post(`/api/claims/${W.claimId}/correction-links`, { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'CORRECTED_CODING' })
  if (link.status !== 201) throw new Error(`fixture: the worked correction link was refused with ${link.status}`)
  const K1 = await linkedSource(S1, 'E1')
  const K2 = await linkedSource(S1, 'E2')
  const KS2 = await linkedSource(S2, 'S2-E1')
  await linkedSource(F.freezes[0], 'FOREIGN', O.who)
  const CASE1 = await caseOf(S1)
  const CASE_F = await caseOf(F.freezes[0], O.who)
  console.log(`[${TAG}]      fixtures ready: two synthetic AE-DU/DHA worlds, a frozen submission and its correction freeze, a pool of ${P.freezes.length} frozen submissions, linked evidence and cases recorded through the A7.1–A7.4 owner routes`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const delta = (before: Record<string, number>, after: Record<string, number>) => Object.fromEntries(COUNT_TABLES.map((table) => [table, after[table] - before[table]])) as Record<string, number>
  const onlyAssessment = (d: Record<string, number>) => same(d, { ...Object.fromEntries(COUNT_TABLES.map((t) => [t, 0])), [TABLE]: 1, audit_events: 1 })
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const runToken = runId.replace(/^A75-/, '')
  const freezeHash = (claimId: string) => hashOf(`SELECT f.*, m.id AS manifest_id, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = $1::uuid`, claimId)
  const lifecycleHash = (claimId: string) => hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = $1::uuid`, claimId)
  const correctionHash = (claimId: string) => hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = $1::uuid`, claimId)
  const sourceHash = () => hashOf(`SELECT r.* FROM revenue_source_evidence r WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const classificationHash = () => hashOf(`SELECT c.* FROM source_evidence_classifications c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const readinessHash = () => hashOf(`SELECT g.* FROM evidence_gate_results g JOIN revenue_source_evidence r ON r.id = g.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const caseHash = (caseId: string) => hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM ${HEADER} h WHERE h.id = $1::uuid UNION ALL SELECT e.id, row_to_json(e)::text FROM ${ENTRY} e WHERE e.assembly_id = $1::uuid) x`, caseId)
  const allCasesHash = () => hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM ${HEADER} h UNION ALL SELECT e.id, row_to_json(e)::text FROM ${ENTRY} e) x`)
  const assessmentHash = (assessmentId: string) => hashOf(`SELECT a.* FROM ${TABLE} a WHERE a.id = $1::uuid`, assessmentId)
  const allAssessmentsHash = () => hashOf(`SELECT a.* FROM ${TABLE} a`)
  const NOT_REFUSED = 'ROLLED_BACK'
  const refusedBy = (message: string, marker: RegExp) => message !== '' && !message.includes(NOT_REFUSED) && marker.test(message)
  const accepted = (message: string) => message.includes(NOT_REFUSED)

  // The outcome the pure reducer derives for a case from the owners' facts read on `db` — the harness reads the
  // owners itself, exactly as the service does, to judge the service and the database independently.
  const ownerFacts = async (caseId: string, db: DbClient = prisma) => {
    const stored = await findCaseById(caseId, db)
    if (!stored) throw new Error(`fixture: the case ${caseId} could not be read through A7.4`)
    const readiness: ReadinessFacts[] = []
    for (const entry of stored.entries) {
      if (entry.classificationId === null || entry.readinessId === null) continue
      const results = await getReadinessOf(entry.classificationId, db)
      const named = results.ok ? results.value.items.find((item) => item.readinessId === entry.readinessId) : undefined
      if (named) readiness.push(named)
    }
    return { stored, readiness }
  }
  type Derived = { caseId: string; organizationId: string; digest: string; code: string; basis: string }
  const deriveFor = async (caseId: string, db: DbClient = prisma): Promise<Derived> => {
    const { stored, readiness } = await ownerFacts(caseId, db)
    const result = deriveCasePrerequisite(stored, stored.entries, readiness)
    if (!result.ok) throw new Error(`fixture: the expected assessment of ${caseId} is a conflict (${result.detail})`)
    return { caseId, organizationId: stored.organizationId, digest: stored.manifestSha256, code: result.value.assessmentCode, basis: result.value.basisCode }
  }
  type Override = { organization?: string; caseId?: string; contract?: string | null; code?: string | null; basis?: string | null; digest?: string | null; actor?: string; recordedAt?: boolean; createdAt?: boolean; zone?: boolean }
  // A direct INSERT of an assessment, ALWAYS rolled back. `guardOff` switches row triggers off so a refusal can only
  // come from a CHECK, NOT NULL or key; `zone` runs it in a far time zone with C messages (the guard must not care).
  const directAssessment = (d: Derived, o: Override = {}, guardOff = false) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        if (guardOff) await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        if (o.zone) {
          await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Kiritimati'")
          await tx.$executeRawUnsafe("SET LOCAL lc_messages = 'C'")
        }
        const extraColumns = `${o.recordedAt ? ', recorded_at' : ''}${o.createdAt ? ', created_at' : ''}`
        const extraValues = `${o.recordedAt ? ", now() - interval '1 day'" : ''}${o.createdAt ? ", now() + interval '1 day'" : ''}`
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, organization_id, evidence_case_id, contract_version, assessment_code, basis_code, case_manifest_sha256, recorded_by_user_id${extraColumns})
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid${extraValues})`,
          o.organization ?? d.organizationId,
          o.caseId ?? d.caseId,
          'contract' in o ? o.contract : CONTRACT,
          'code' in o ? o.code : d.code,
          'basis' in o ? o.basis : d.basis,
          'digest' in o ? o.digest : d.digest,
          o.actor ?? creatorId,
        )
        throw new Error(NOT_REFUSED)
      }),
    )
  // A FUTURE case no current source can reach (REVIEW or UNSUPPORTED readiness, a cross-linked or missing readiness),
  // planted in a transaction that is ALWAYS rolled back: the A7.3 results and the A7.4 header and entries go in with
  // row triggers off (the A7.3/A7.4 guards would refuse them — that is what makes them future), then the triggers are
  // back on and the production reducer judges the owners' reads of that transaction, and the A7.5 insert guard judges
  // a claimed outcome.
  type Pair = { readinessCode: string; reasonCode: string }
  const plantedCase = async (submissionId: string, sources: { E: string; C: string }[], pairs: Pair[], shape: 'linked' | 'cross' | 'missing', claim: 'derived' | { code: string; basis: string }) => {
    const out: { derived?: DerivationResult } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        const gates: string[] = []
        for (const [index, source] of sources.entries()) {
          if (shape === 'missing') {
            gates.push(randomBytes(16).toString('hex').replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12})$/, '$1-$2-4$3-8$4-$5'))
            continue
          }
          const fp = (await tx.sourceEvidenceClassification.findUniqueOrThrow({ where: { id: source.C } })).sourceFingerprintSha256
          const [gate] = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO evidence_gate_results (id, organization_id, source_evidence_id, classification_id, contract_version, readiness_code, reason_code, classification_fingerprint_sha256, recorded_by_user_id)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'A7-ADJ-READINESS-1', $4, $5, $6, $7::uuid) RETURNING id::text AS id`,
            org, source.E, source.C, pairs[index].readinessCode, pairs[index].reasonCode, fp, creatorId,
          )
          gates.push(gate.id)
        }
        const n = sources.length
        const digest = createHash('sha256').update(`${runId}-planted-${shape}`).digest('hex')
        const [h] = await tx.$queryRawUnsafe<{ id: string }[]>(
          `INSERT INTO ${HEADER} (id, organization_id, claim_submission_id, contract_version, assembly_code, source_count, classified_count, readiness_count, item_count, manifest_sha256, recorded_by_user_id)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'INVENTORY_COMPLETE', $4, $4, $4, $4, $5, $6::uuid) RETURNING id::text AS id`,
          org, submissionId, CASE_CONTRACT, n, digest, creatorId,
        )
        for (const [index, source] of sources.entries())
          await tx.$executeRawUnsafe(
            `INSERT INTO ${ENTRY} (id, assembly_id, ordinal, source_evidence_id, classification_id, readiness_id, item_reason_code) VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'LINKED')`,
            h.id, index + 1, source.E, source.C, shape === 'cross' ? gates[(index + 1) % n] : gates[index],
          )
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
        const { stored, readiness } = await ownerFacts(h.id, tx)
        out.derived = deriveCasePrerequisite(stored, stored.entries, readiness)
        const claimed =
          claim === 'derived' ? (out.derived.ok ? { code: out.derived.value.assessmentCode, basis: out.derived.value.basisCode } : { code: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basis: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' }) : claim
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, organization_id, evidence_case_id, contract_version, assessment_code, basis_code, case_manifest_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)`,
          org, h.id, CONTRACT, claimed.code, claimed.basis, digest, creatorId,
        )
        throw new Error(NOT_REFUSED)
      }),
    )
    return { ...out, message }
  }

  // ---------------------------------------------------------------- strict contract and security (T011–T020)
  section('Strict request: contract, empty body, server-owned fields, UUIDs, session, roles, tenants and actor')
  const countsAtStart = await counts()
  check(
    'T011',
    'Exact A7-CLOSURE-PREREQ-1 version',
    constantOf(`${MODULE_DIR}/case-prerequisite.types.ts`, 'PREREQ_CONTRACT_VERSION') === CONTRACT && /"contract_version" = 'A7-CLOSURE-PREREQ-1'/.test(readFileSync(`../${MIGRATION}`, 'utf8')),
    'A7-CLOSURE-PREREQ-1 is the literal contract in code and in the database CHECK (and on every assessment and DTO, T021)',
  )
  const nonObject = [await post(assessPath(CASE1.caseId), []), await post(assessPath(CASE1.caseId), [{ assessmentCode: 'NO_SOURCE_BASIS' }])]
  check('T012', 'POST absent or empty object only', nonObject.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR'), `the body must be absent or {}: array bodies are refused (${nonObject.map((r) => r.status).join('/')}); every assessment value is derived by the server (no body and {} are accepted, T041)`)
  const serverOwned = await Promise.all(
    [{ assessmentCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' }, { basisCode: 'NO_REGISTERED_SOURCES' }, { contractVersion: CONTRACT }, { caseManifestSha256: 'a'.repeat(64) }, { fingerprint: 'x' }, { caseId: MISSING }, { claimSubmissionId: S2 }, { sourceEvidenceId: K1.E }, { amount: '1' }, { fee: '1' }, { balance: 0 }, { paid: true }, { closed: true }, { status: 'CLOSED' }, { payment: {} }, { date: '2026-01-01' }].map((body) => assess(CASE1.caseId, asAdmin, body)),
  )
  const unknownFields = [await assess(CASE1.caseId, asAdmin, { extra: 1 }), await assess(CASE1.caseId, asAdmin, JSON.parse('{"__proto__": {"assessmentCode": "NO_SOURCE_BASIS"}}'))]
  check(
    'T013',
    'Unknown and prototype keys refused',
    serverOwned.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')) && unknownFields.every((res) => res.status === 400 && /unknown field/.test(res.body?.error?.message ?? '')),
    `code, basis, contract, digest, fingerprint, case, submission, source, amount, fee, balance, paid, closed, status, payment and date are refused by name (${serverOwned.length} × 400); unknown fields, including a parsed __proto__ key, are refused`,
  )
  const malformed = [
    await post('/api/revenue-evidence-cases/not-a-uuid/closure-prerequisite-assessments', {}),
    await get('/api/revenue-evidence-cases/1234/closure-prerequisite-assessments'),
    await get('/api/closure-prerequisite-assessments/not-a-uuid'),
    await get(`/api/closure-prerequisite-assessments/${MISSING.slice(0, 35)}`),
    await post(`/api/revenue-evidence-cases/${encodeURIComponent("1' OR '1'='1")}/closure-prerequisite-assessments`, {}),
  ]
  check('T014', 'Path malformed/injected UUIDs refused', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `malformed and injected path ids: ${malformed.map((r) => r.status).join('/')}; no raw database text`)
  const anon = [await assess(CASE1.caseId, anonymous), await get(assessPath(CASE1.caseId), anonymous), await get(onePath(MISSING), anonymous)]
  check('T015', 'No session gives 401 all routes', anon.every((res) => res.status === 401), 'every A7.5 route requires a session: 401 without one')
  const auditsBeforeViewer = await prisma.auditEvent.count()
  const viewerPost = await assess(CASE1.caseId, asViewer)
  check('T016', 'Viewer POST 403 without audit', viewerPost.status === 403 && errorCode(viewerPost.body) === 'FORBIDDEN' && (await prisma.auditEvent.count()) === auditsBeforeViewer, 'a Viewer is refused the assessment (403) and no audit is written')

  const earlyRefusalsLeftNothing = await unchanged(countsAtStart)
  // The worked assessment (§8): CASE1 holds two linked sources whose readiness are both NOT_READY_FOR_ADJUDICATION.
  const upstreamBefore = { sources: await sourceHash(), classifications: await classificationHash(), readiness: await readinessHash(), freeze: await freezeHash(W.claimId), case1: await caseHash(CASE1.caseId) }
  const before21 = await counts()
  const ASSESS1 = await assess(CASE1.caseId)
  const after21 = await counts()
  const viewerHistory = await get(assessPath(CASE1.caseId), asViewer)
  const viewerOne = await get(onePath(ASSESS1.body?.assessmentId ?? MISSING), asViewer)
  check(
    'T017',
    'Viewer reads history with identical DTO',
    viewerHistory.status === 200 && same(viewerHistory.body?.items, [ASSESS1.body]) && viewerOne.status === 200 && same(viewerOne.body, ASSESS1.body),
    "a Viewer reads the case's assessment history and the single assessment (200), identical to the Admin's create response",
  )
  const foreignOnHome = [await assess(CASE1.caseId, O.who), await get(assessPath(CASE1.caseId), O.who)]
  const foreignMissing = await get(assessPath(MISSING), O.who)
  const homeOnForeign = [await assess(CASE_F.caseId), await get(assessPath(CASE_F.caseId))]
  check(
    'T018',
    'Foreign tenant indistinguishable 404',
    foreignOnHome.every((res) => res.status === 404 && same(res.body?.error?.message, foreignMissing.body?.error?.message)) && homeOnForeign.every((res) => res.status === 404),
    "the other organization's Admin gets 404 for this tenant's case — exactly like a missing one — and this tenant's Admin gets 404 for theirs",
  )
  const beforeMissing = await counts()
  const missingCase = [await assess(MISSING), await get(assessPath(MISSING))]
  check('T019', 'Missing case 404 with no write', missingCase.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && (await unchanged(beforeMissing)), 'a non-existent case: 404, and no row or audit is written')
  const spoofs = await Promise.all([{ recordedByUserId: B.id }, { actorUserId: B.id }, { organizationId: otherOrg }, { caseId: CASE_F.caseId }, { evidenceCaseId: MISSING }, { recordedAt: '2020-01-01T00:00:00Z' }].map((body) => assess(CASE1.caseId, asAdmin, body)))
  check(
    'T020',
    'Actor/tenant/case cannot be spoofed',
    spoofs.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')) && ASSESS1.body?.recordedByUserId === creatorId && ASSESS1.body?.caseId === CASE1.caseId,
    'actor, organization, case and instant in the body are refused (400); the assessment names the signed-in Admin and the case from the path',
  )
  // The refusals before ASSESS1 left everything as it was at the start, and those after it everything as ASSESS1 left it.
  const refusalsLeftNothing = earlyRefusalsLeftNothing && (await unchanged(after21))

  // ---------------------------------------------------------------- core outcomes (T021–T030)
  section('Core outcomes: the worked complete case, server-owned values, copied digest, one audit, empty and incomplete cases, exact pairing')
  const expected1 = await deriveFor(CASE1.caseId)
  check(
    'T021',
    'Complete synthetic case: external absent',
    ASSESS1.status === 201 && same(Object.keys(ASSESS1.body ?? {}), DTO_KEYS) && ASSESS1.body.assessmentCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && ASSESS1.body.basisCode === 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' && ASSESS1.body.contractVersion === CONTRACT && CASE1.assemblyCode === 'INVENTORY_COMPLETE',
    '201: the complete case of two NOT_READY_FOR_ADJUDICATION sources is EXTERNAL_FINANCIAL_EVIDENCE_ABSENT / EXTERNAL_REMITTANCE_NOT_ESTABLISHED under A7-CLOSURE-PREREQ-1; the DTO carries exactly its fields',
  )
  const row1 = await prisma.evidencePrereqResult.findUniqueOrThrow({ where: { id: ASSESS1.body.assessmentId } })
  check(
    'T022',
    'Server controls code, basis, contract, instant',
    row1.assessmentCode === expected1.code && row1.basisCode === expected1.basis && row1.contractVersion === CONTRACT && ASSESS1.body.recordedAt === row1.recordedAt.toISOString() && serverOwned.every((res) => res.status === 400),
    'the stored code and basis equal the independent derivation from the owners\' facts; contract and instant are the server\'s; every supplied value was refused (T013)',
  )
  const snapshot1 = await prisma.evidenceCaseSnapshot.findUniqueOrThrow({ where: { id: CASE1.caseId } })
  check(
    'T023',
    'Copied exact caseId and digest',
    row1.evidenceCaseId === CASE1.caseId && row1.caseManifestSha256 === snapshot1.manifestSha256 && ASSESS1.body.caseManifestSha256 === CASE1.manifestSha256 && (await caseHash(CASE1.caseId)) === upstreamBefore.case1,
    `the assessment names exactly CASE1 and carries its stored digest ${snapshot1.manifestSha256.slice(0, 12)}… copied, never recomputed; CASE1 is byte-identical`,
  )
  const audits1 = await prisma.auditEvent.findMany({ where: { entityId: ASSESS1.body.assessmentId } })
  check('T024', 'Exactly one business audit', audits1.length === 1 && audits1[0].actionCode === 'evidence_case_prerequisite.assessed' && onlyAssessment(delta(before21, after21)), 'one evidence_case_prerequisite.assessed audit; the request wrote exactly one assessment and that audit')
  const timeRow = (await prisma.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT a.recorded_at = a.created_at AND a.recorded_at <= now() AND a.recorded_at >= h.recorded_at AS ok FROM ${TABLE} a JOIN ${HEADER} h ON h.id = a.evidence_case_id WHERE a.id = $1::uuid`, row1.id))[0]
  check('T025', 'Transaction-time actor and timestamp', timeRow?.ok === true && row1.recordedByUserId === creatorId && audits1[0]?.actorUserId === creatorId, 'recorded and created at the one database transaction time, after the case; the actor is the signed-in Admin on the row and its audit')
  check(
    'T026',
    'No A7.4 or earlier records modified',
    (await sourceHash()) === upstreamBefore.sources && (await classificationHash()) === upstreamBefore.classifications && (await readinessHash()) === upstreamBefore.readiness && (await freezeHash(W.claimId)) === upstreamBefore.freeze &&
      (await caseHash(CASE1.caseId)) === upstreamBefore.case1,
    "every byte of this run's sources, classifications, readiness results, the freezes and CASE1 is identical after the assessment",
  )
  const SE = fresh()
  const emptyCase = await caseOf(SE)
  const emptyAssessment = await assess(emptyCase.caseId)
  check(
    'T027',
    'Empty case yields NO_SOURCE_BASIS',
    emptyCase.assemblyCode === 'NO_REVENUE_SOURCES' && emptyAssessment.status === 201 && emptyAssessment.body.assessmentCode === 'NO_SOURCE_BASIS' && emptyAssessment.body.basisCode === 'NO_REGISTERED_SOURCES',
    'a NO_REVENUE_SOURCES case (zero items) is NO_SOURCE_BASIS / NO_REGISTERED_SOURCES — no inventory, never a zero balance',
  )
  const SI = fresh()
  await registerSource(SI, 'INC-SOURCE-ONLY')
  await classifySource(await registerSource(SI, 'INC-CLASSIFIED'))
  await linkedSource(SI, 'INC-LINKED')
  const incCase = await caseOf(SI)
  const incAssessment = await assess(incCase.caseId)
  check(
    'T028',
    'Incomplete case: INCOMPLETE_SOURCE_CHAIN',
    incCase.assemblyCode === 'INVENTORY_INCOMPLETE' && incAssessment.status === 201 && incAssessment.body.assessmentCode === 'INCOMPLETE_SOURCE_CHAIN' && incAssessment.body.basisCode === 'SOURCE_LINKS_INCOMPLETE',
    'a case with a SOURCE_ONLY, a CLASSIFIED_NO_READINESS and a LINKED item is INCOMPLETE_SOURCE_CHAIN / SOURCE_LINKS_INCOMPLETE',
  )
  // SF carries three classified sources without readiness and never receives a real case: the future and broken
  // cases below are planted on it, always rolled back.
  const SF = fresh()
  const futureSources: { E: string; C: string }[] = []
  for (const suffix of ['F1', 'F2', 'F3']) {
    const E = await registerSource(SF, `FUTURE-${suffix}`)
    futureSources.push({ E, C: await classifySource(E) })
  }
  // CZ is a complete case that is never assessed through the API: every direct-insert test below uses it, so a
  // refusal can only come from the guard or constraint under test, never from an existing identity.
  const CZ = await linkedCase('Z1')
  const dZ = await deriveFor(CZ.case.caseId)
  const dF = await deriveFor(CASE_F.caseId)
  const countsBeforePlanted = await counts()
  const missingReadiness = await plantedCase(SF, futureSources.slice(0, 2), [NOT_READY, NOT_READY], 'missing', 'derived')
  check(
    'T029',
    'Missing readiness never counted as ready',
    incAssessment.body?.assessmentCode === 'INCOMPLETE_SOURCE_CHAIN' && outcomeOf(missingReadiness.derived) === 'refused PROVENANCE_CONFLICT' && /missing; it is never assumed ready/.test(missingReadiness.derived && !missingReadiness.derived.ok ? missingReadiness.derived.detail : '') && refusedBy(missingReadiness.message, /evidence_prereq_conflict/),
    'a classification without readiness keeps the case INCOMPLETE; an entry that names a readiness result that does not exist (planted, rolled back) is a provenance conflict for the reducer and the database — never assumed NOT_READY or ready',
  )
  const apiAssessments = [ASSESS1.body, emptyAssessment.body, incAssessment.body]
  const mispaired = await directAssessment(dZ, { basis: 'NO_REGISTERED_SOURCES' })
  check(
    'T030',
    'Reason paired exactly with code',
    apiAssessments.every((a: any) => BASIS_OF[a.assessmentCode as keyof typeof BASIS_OF] === a.basisCode) && refusedBy(mispaired, /evidence_prereq_results_pairing_chk/),
    `every assessment carries exactly the basis of its outcome (1:1, from one table); the right outcome with another outcome's basis is refused by the database (${markerOf(mispaired)})`,
  )

  // ---------------------------------------------------------------- adversarial and future boundary (T031–T040)
  section('Future REVIEW/UNSUPPORTED cases and a contradictory case (always rolled back), forged digest, correction independence, no latest, disposition, future contract')
  const review = await plantedCase(SF, futureSources.slice(0, 2), [NOT_READY, REVIEW], 'linked', 'derived')
  const reviewForged = await plantedCase(SF, futureSources.slice(0, 2), [NOT_READY, REVIEW], 'linked', { code: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basis: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' })
  check(
    'T031',
    'Controlled review fixture: REVIEW_REQUIRED',
    outcomeOf(review.derived) === 'REVIEW_REQUIRED/EVIDENCE_REVIEW_REQUIRED' && accepted(review.message) && refusedBy(reviewForged.message, /evidence_prereq_derivation/),
    'a complete case holding a SOURCE_REQUIRES_REVIEW readiness (planted, rolled back) derives REVIEW_REQUIRED / EVIDENCE_REVIEW_REQUIRED, which the database accepts; an external-absent claim of it is refused',
  )
  const unsupported = await plantedCase(SF, futureSources.slice(0, 2), [NOT_READY, UNSUPPORTED], 'linked', 'derived')
  const unsupportedForged = await plantedCase(SF, futureSources.slice(0, 2), [NOT_READY, UNSUPPORTED], 'linked', { code: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basis: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' })
  check(
    'T032',
    'Unsupported fixture: UNSUPPORTED_SOURCE_BASIS',
    outcomeOf(unsupported.derived) === 'UNSUPPORTED_SOURCE_BASIS/UNSUPPORTED_EVIDENCE' && accepted(unsupported.message) && refusedBy(unsupportedForged.message, /evidence_prereq_derivation/),
    'a complete case holding a SOURCE_UNSUPPORTED readiness and no review derives UNSUPPORTED_SOURCE_BASIS / UNSUPPORTED_EVIDENCE, which the database accepts; an external-absent claim of it is refused',
  )
  const mixed = await plantedCase(SF, futureSources, [UNSUPPORTED, REVIEW, NOT_READY], 'linked', 'derived')
  const mixedForged = await plantedCase(SF, futureSources, [UNSUPPORTED, REVIEW, NOT_READY], 'linked', { code: 'UNSUPPORTED_SOURCE_BASIS', basis: 'UNSUPPORTED_EVIDENCE' })
  check(
    'T033',
    'Mixed review/unsupported uses priority',
    outcomeOf(mixed.derived) === 'REVIEW_REQUIRED/EVIDENCE_REVIEW_REQUIRED' && accepted(mixed.message) && refusedBy(mixedForged.message, /evidence_prereq_derivation/),
    'a complete case holding both an unsupported and a review readiness is REVIEW_REQUIRED (review outranks unsupported), for the reducer and the database; the lower-priority claim is refused',
  )
  const contradiction = await plantedCase(SF, futureSources.slice(0, 2), [NOT_READY, NOT_READY], 'cross', 'derived')
  const serviceCode = committedCode(`${MODULE_DIR}/case-prerequisite.service.ts`)
  check(
    'T034',
    'Contradictory readiness refuses 409',
    outcomeOf(contradiction.derived) === 'refused PROVENANCE_CONFLICT' && refusedBy(contradiction.message, /evidence_prereq_conflict/) && /if \(!derived\.ok\) return refuse\('EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT'/.test(serviceCode),
    'a case whose entries name each other\'s readiness (planted, rolled back) is a provenance conflict for the production reducer — the service answers 409 and records nothing — and the database refuses any assessment of it',
  )
  const plantedLeftNothing = await unchanged(countsBeforePlanted)
  const forgedDigest = await directAssessment(dZ, { digest: 'a'.repeat(64) })
  const otherCaseDigest = await directAssessment(dZ, { digest: CASE1.manifestSha256 })
  check(
    'T035',
    'Different case digest refuses forged row',
    refusedBy(forgedDigest, /evidence_prereq_digest/) && refusedBy(otherCaseDigest, /evidence_prereq_digest/) && accepted(await directAssessment(dZ)),
    "an assessment carrying an invented digest, or another case's digest, is refused; the exactly copied digest is accepted (rolled back)",
  )
  const chainBefore = await correctionHash(W.claimId)
  const assess1Before = await assessmentHash(ASSESS1.body.assessmentId)
  const CASE_S2 = await caseOf(S2)
  const ASSESS_S2 = await assess(CASE_S2.caseId)
  check(
    'T036',
    'A6.9 corrected submission independent',
    ASSESS_S2.status === 201 && ASSESS_S2.body.caseId === CASE_S2.caseId && ASSESS_S2.body.assessmentId !== ASSESS1.body.assessmentId && (await assessmentHash(ASSESS1.body.assessmentId)) === assess1Before && (await correctionHash(W.claimId)) === chainBefore && same((await get(onePath(ASSESS1.body.assessmentId))).body, ASSESS1.body),
    'the corrected freeze S2 (an A6.9 link from S1) gets its own case and its own assessment; ASSESS1 and the link are byte-identical',
  )
  const columns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${TABLE}`).map((row) => row.c)
  const latestRoutes = [await assess(S1), await get(assessPath(S1)), await get(`/api/claim-submissions/${S1}/closure-prerequisite-assessments`), await get(`/api/claims/${W.claimId}/closure-prerequisite-assessments`), await get(`${assessPath(CASE1.caseId)}/latest`)]
  check(
    'T037',
    'No implicit latest-case selection',
    latestRoutes.every((res) => res.status === 404) && !columns.some((c) => /current|latest|newest|superseded|claim_submission|claim_id/.test(c)) && same((await historyOf(CASE1.caseId)).map((i: any) => i.assessmentId), [ASSESS1.body.assessmentId]),
    'an assessment names one exact case from the path: a submission id is not a case (404), there is no per-submission, per-Claim or latest route and no current, latest or submission column; S2 did not touch CASE1\'s history',
  )
  const Re = await home.series('release eligible', 1)
  const caseRe = await linkedCase('RELEASED', Re.freezes[0])
  await post(`/api/claim-submissions/${Re.freezes[0]}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null })
  const reLifecycleBefore = await lifecycleHash(Re.claimId)
  const onReleased = await assess(caseRe.case.caseId)
  check(
    'T038',
    'RELEASE_ELIGIBLE never payer release',
    onReleased.status === 201 && onReleased.body.assessmentCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && (await get(`/api/claim-submissions/${Re.freezes[0]}/lifecycle`)).body?.state === 'RELEASE_ELIGIBLE' && (await lifecycleHash(Re.claimId)) === reLifecycleBefore,
    'the case of a RELEASE_ELIGIBLE freeze still lacks external financial evidence — internal release is never payer release — and the lifecycle is byte-identical',
  )
  const Wd = await home.series('withdrawn', 1)
  const caseWd = await linkedCase('WITHDRAWN', Wd.freezes[0])
  const beforeWithdrawal = await assess(caseWd.case.caseId)
  const withdrawal = await post(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle-events`, { eventCode: 'WITHDRAW_INTERNAL', reasonCode: 'INTERNAL_OTHER' })
  const afterWithdrawal = await assess(caseWd.case.caseId)
  check(
    'T039',
    'WITHDRAWN_INTERNAL does not alter it',
    beforeWithdrawal.status === 201 && [200, 201].includes(withdrawal.status) && (await get(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle`)).body?.state === 'WITHDRAWN_INTERNAL' && afterWithdrawal.status === 200 && same(afterWithdrawal.body, beforeWithdrawal.body),
    "an internal withdrawal after the assessment leaves it exactly as recorded (200, identical); the disposition is the A6.8 owner's and the assessment neither reads nor changes it",
  )
  const futureContract = await directAssessment(dZ, { contract: 'A7-CLOSURE-PREREQ-2' }, true)
  check('T040', 'Future contract version forbidden', refusedBy(futureContract, /evidence_prereq_results_contract_chk/), 'A7-CLOSURE-PREREQ-2 is refused until a later owner admits it; a revision would be its own row under (case, contract), never a mutation')

  // ---------------------------------------------------------------- replay and concurrent identity (T041–T050)
  section('Replay, actor, recorded disagreement, direct duplicates, concurrent identical requests, read-after-commit, a later source')
  const before41 = await counts()
  const replay1 = await assess(CASE1.caseId)
  const replayNoBody = await api('POST', assessPath(CASE1.caseId), undefined)
  check('T041', 'Identical POST replay 200 original', [replay1, replayNoBody].every((res) => res.status === 200 && same(res.body, ASSESS1.body)), 'the identical request (with {} and with no body): 200 with exactly ASSESS1')
  const replayByB = await assess(CASE1.caseId, B.who)
  check('T042', 'Replay retains original actor', replayByB.status === 200 && same(replayByB.body, ASSESS1.body) && replayByB.body.recordedByUserId === creatorId, 'another Admin repeating the request gets ASSESS1 with its original actor and time')
  const d41 = delta(before41, await counts())
  check('T043', 'Replay produces no extra row', d41[TABLE] === 0 && (await prisma.evidencePrereqResult.count({ where: { evidenceCaseId: CASE1.caseId } })) === 1, 'three replays wrote no assessment; CASE1 still has exactly one')
  check('T044', 'Replay produces no audit', d41.audit_events === 0 && (await prisma.auditEvent.count({ where: { entityId: ASSESS1.body.assessmentId } })) === 1, 'three replays wrote no audit; ASSESS1 still has exactly one')
  const replaysLeftNothing = await unchanged(before41)
  // A recorded assessment that disagrees with its derivation cannot be written through the guard, so it is forged in
  // a transaction that is ALWAYS rolled back (row triggers off) and judged by the production replay decision.
  const forgedRecord = async (change: { code?: string; basis?: string; digest?: string }) => {
    const out: { agrees?: boolean } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, organization_id, evidence_case_id, contract_version, assessment_code, basis_code, case_manifest_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)`,
          dZ.organizationId, dZ.caseId, CONTRACT, change.code ?? dZ.code, change.basis ?? dZ.basis, change.digest ?? dZ.digest, creatorId,
        )
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
        const recorded = await findAssessmentByIdentity(dZ.caseId, CONTRACT, tx)
        const now = await deriveFor(dZ.caseId, tx)
        if (recorded) out.agrees = recordedAssessmentAgrees(recorded, { assessmentCode: now.code, basisCode: now.basis, caseManifestSha256: now.digest, organizationId: now.organizationId, contractVersion: CONTRACT })
        throw new Error(NOT_REFUSED)
      }),
    )
    return { ...out, message }
  }
  const routeCode = committedCode(`${MODULE_DIR}/case-prerequisite.route.ts`)
  const conflictWired =
    /if \(!recordedAssessmentAgrees\(existing, expected\)\)\s*return refuse\('EVIDENCE_CASE_PREREQUISITE_PROVENANCE_CONFLICT'/.test(serviceCode) && /code === 'NOT_FOUND' \? 404 : code === 'VALIDATION_ERROR' \? 400 : 409/.test(routeCode)
  const agreeing = await forgedRecord({})
  const disagreeing = [await forgedRecord({ code: 'UNSUPPORTED_SOURCE_BASIS', basis: 'UNSUPPORTED_EVIDENCE' }), await forgedRecord({ digest: 'f'.repeat(64) })]
  check(
    'T045',
    'Stored contradiction rejects, no rewrite',
    accepted(agreeing.message) && agreeing.agrees === true && disagreeing.every((r) => accepted(r.message) && r.agrees === false) && conflictWired && (await historyOf(dZ.caseId)).length === 0,
    'a recorded assessment with another outcome or digest (forged, rolled back) is a disagreement for the production decision, which the service answers as a 409 and never rewrites; the matching control row agrees',
  )
  const duplicateSql = await directAssessment(await deriveFor(CASE1.caseId))
  check('T046', 'Direct duplicate insert refused', refusedBy(duplicateSql, /evidence_prereq_results_identity_key|duplicate key/), `a second, otherwise valid assessment of CASE1 inserted directly is refused by the unique identity (${markerOf(duplicateSql)})`)
  const R2 = await linkedCase('RACE2')
  const before47 = await counts()
  const pair = await Promise.all([assess(R2.case.caseId), assess(R2.case.caseId)])
  const d47 = delta(before47, await counts())
  check('T047', 'Two concurrent POSTs: 201 and 200', same(pair.map((r) => r.status).sort(), [200, 201]) && same(pair[0].body, pair[1].body) && d47[TABLE] === 1 && d47.audit_events === 1, `${pair.map((r) => r.status).sort().join('/')}: one assessment, one audit, one identical body`)
  const R5 = await linkedCase('RACE5')
  const before48 = await counts()
  const five = await Promise.all([assess(R5.case.caseId), assess(R5.case.caseId), assess(R5.case.caseId, B.who), assess(R5.case.caseId), assess(R5.case.caseId)])
  const d48 = delta(before48, await counts())
  check(
    'T048',
    'Five concurrent: one 201, four 200',
    five.filter((r) => r.status === 201).length === 1 && five.filter((r) => r.status === 200).length === 4 && five.every((r) => same(r.body, five[0].body)) && d48[TABLE] === 1 && d48.audit_events === 1,
    `five at once (two actors): ${five.map((r) => (r.status >= 300 ? `${r.status} ${errorCode(r.body) ?? ''}`.trim() : r.status)).join('/')}; ${d48[TABLE]} assessment and ${d48.audit_events} audit`,
  )
  const read1 = await get(onePath(ASSESS1.body.assessmentId))
  const history1 = await historyOf(CASE1.caseId)
  const inTx = await withReadSnapshot(undefined, (tx) => getPrerequisiteAssessmentsOf(CASE1.caseId, tx))
  check(
    'T049',
    'History/readback matches create',
    read1.status === 200 && same(read1.body, ASSESS1.body) && same(history1, [ASSESS1.body]) && inTx.ok && same(inTx.value.items, history1),
    'the single read and the history are exactly the create response; getPrerequisiteAssessmentsOf(caseId, tx) equals the HTTP read',
  )
  const K3 = await linkedSource(S1, 'E3-LATER')
  const caseAgain = await post(`/api/claim-submissions/${S1}/revenue-evidence-cases`, {})
  const afterLater = await assess(CASE1.caseId)
  check(
    'T050',
    'Old result unchanged after later source',
    caseAgain.status === 200 && caseAgain.body.caseId === CASE1.caseId && afterLater.status === 200 && same(afterLater.body, ASSESS1.body) && (await assessmentHash(ASSESS1.body.assessmentId)) === assess1Before && (await caseHash(CASE1.caseId)) === upstreamBefore.case1,
    'after E3 is registered, classified and gated on S1, CASE1 is still the A7.4 answer (200) and its assessment replays exactly as recorded; both are byte-identical',
  )

  // ---------------------------------------------------------------- direct SQL constraints (T051–T060)
  section('Direct SQL: RESTRICT keys, CHECKs with the guard off and NULL pitfalls, pairing, coherence, digest, identity, time, immutability')
  const fkRows = await prisma.$queryRaw<{ name: string; del: string }[]>`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = ${TABLE}`
  const removeCase = await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE evidence_case_snapshots DISABLE TRIGGER evidence_case_snapshots_append_only_trg')
      await tx.$executeRawUnsafe('DELETE FROM evidence_case_snapshots WHERE id = $1::uuid', emptyCase.caseId)
      throw new Error(NOT_REFUSED)
    }),
  )
  check(
    'T051',
    'All foreign keys RESTRICT, no CASCADE',
    fkRows.length === 3 && fkRows.every((row) => row.del === 'r') && refusedBy(removeCase, /evidence_prereq_results_evidence_case_id_fkey|foreign key/),
    'organization, case and actor are all ON DELETE RESTRICT; even with the A7.4 guard off (rolled back) an assessed case cannot be deleted',
  )
  const contractSql = [await directAssessment(dZ, { contract: 'A7-CLOSURE-PREREQ-0' }, true), await directAssessment(dZ, { contract: null }, true), await directAssessment(dZ, { contract: 'a7-closure-prereq-1' }, true)]
  check('T052', 'Contract rejects other/NULL values', refusedBy(contractSql[0], /evidence_prereq_results_contract_chk/) && refusedBy(contractSql[1], /null value/) && refusedBy(contractSql[2], /evidence_prereq_results_contract_chk/), `another, a lower-case or a NULL contract is refused even with the guard off (${contractSql.map(markerOf).join(', ')})`)
  const codeSql = [
    await directAssessment(dZ, { code: 'READY_FOR_CLOSURE' }, true),
    await directAssessment(dZ, { code: 'external_financial_evidence_absent' }, true),
    await directAssessment(dZ, { code: 'CLOSED' }),
  ]
  const codeDef = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'evidence_prereq_results_code_chk'`)[0]?.def ?? ''
  check(
    'T053',
    'Only five controlled assessment codes',
    refusedBy(codeSql[0], /evidence_prereq_results_code_chk/) && refusedBy(codeSql[1], /evidence_prereq_results_code_chk/) && refusedBy(codeSql[2], /evidence_prereq_derivation/) && (codeDef.match(/'[A-Z_]+'::text/g) ?? []).length === 5,
    `an invented or lower-case code is refused by the CHECK with the guard off, and by the guard's derivation with it on (${codeSql.map(markerOf).join(', ')}); the CHECK lists exactly five codes`,
  )
  const pairingSql = [await directAssessment(dZ, { basis: 'NO_REGISTERED_SOURCES' }), await directAssessment(dZ, { basis: 'SETTLED' }, true), await directAssessment(dZ, { code: 'NO_SOURCE_BASIS', basis: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' }, true)]
  check(
    'T054',
    'Reason and code exact pairing',
    refusedBy(pairingSql[0], /evidence_prereq_results_pairing_chk/) && refusedBy(pairingSql[1], /evidence_prereq_results_basis_chk/) && refusedBy(pairingSql[2], /evidence_prereq_results_pairing_chk/),
    `the right outcome with another outcome's basis, an invented basis and a mismatched pair are refused (${pairingSql.map(markerOf).join(', ')})`,
  )
  const coherenceSql = [await directAssessment(dZ, { organization: otherOrg }), await directAssessment(dF, { organization: org })]
  check('T055', 'Organization matches referenced case', coherenceSql.every((m) => refusedBy(m, /evidence_prereq_coherence/)), "an assessment naming another organization than the one owning its case and frozen submission is refused, in both directions")
  const digestSql = [forgedDigest, await directAssessment(dZ, { digest: dZ.digest.toUpperCase() }, true), await directAssessment(dZ, { digest: null }, true)]
  const storedDigests = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${TABLE} a JOIN ${HEADER} h ON h.id = a.evidence_case_id WHERE a.case_manifest_sha256 <> h.manifest_sha256`))[0].n)
  check(
    'T056',
    'Case digest equals stored digest',
    refusedBy(digestSql[0], /evidence_prereq_digest/) && refusedBy(digestSql[1], /evidence_prereq_results_digest_chk/) && refusedBy(digestSql[2], /null value/) && storedDigests === 0,
    `a wrong digest is refused by the guard, an upper-case or NULL one by the CHECK and NOT NULL (${digestSql.map(markerOf).join(', ')}); every stored assessment carries exactly its case's digest`,
  )
  const identityDef = (await prisma.$queryRaw<{ def: string }[]>`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'evidence_prereq_results_identity_key'`)[0]?.def ?? ''
  const duplicateOff = await directAssessment(await deriveFor(CASE1.caseId), {}, true)
  check(
    'T057',
    'UNIQUE case+contract enforced',
    /CREATE UNIQUE INDEX evidence_prereq_results_identity_key ON public\.evidence_prereq_results USING btree \(evidence_case_id, contract_version\)/.test(identityDef) && refusedBy(duplicateSql, /identity_key|duplicate key/) && refusedBy(duplicateOff, /identity_key|duplicate key/),
    'one assessment per (case, contract): a duplicate is refused with the guard on (T046) and off',
  )
  const timeSql = [await directAssessment(dZ, { recordedAt: true }), await directAssessment(dZ, { createdAt: true })]
  check('T058', 'Database timestamps cannot be supplied', timeSql.every((m) => refusedBy(m, /evidence_prereq_time/)) && ASSESS1.body.recordedAt === row1.recordedAt.toISOString(), 'a backdated recorded_at and a future created_at are refused; every assessment takes the database transaction time')
  const rewrites = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET assessment_code = assessment_code WHERE id = $1::uuid`, ASSESS1.body.assessmentId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET assessment_code = 'NO_SOURCE_BASIS', basis_code = 'NO_REGISTERED_SOURCES' WHERE id = $1::uuid`, ASSESS1.body.assessmentId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET contract_version = 'A7-CLOSURE-PREREQ-2' WHERE id = $1::uuid`, ASSESS1.body.assessmentId)),
  ]
  check('T059', 'UPDATE including no-op refused', rewrites.every((m) => /evidence_prereq_results is append-only: UPDATE/.test(m)) && (await assessmentHash(ASSESS1.body.assessmentId)) === assess1Before, 'a no-op update, a downgrade and a contract change of ASSESS1 are refused; it is byte-identical')
  const triggers = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'evidence_prereq_results_no_truncate_trg'`).map((row) => row.def)
  const beforeWipe = await allAssessmentsHash()
  const casesBeforeWipe = await allCasesHash()
  const wipe = (sql: string) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(sql)
        throw new Error(NOT_REFUSED)
      }),
    )
  const deletes = [await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, ASSESS1.body.assessmentId)), await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${TABLE}`))]
  const wipes = [await wipe(`TRUNCATE ${TABLE}`), await wipe(`TRUNCATE ${TABLE} CASCADE`), await wipe(`TRUNCATE ${HEADER} CASCADE`)]
  check(
    'T060',
    'DELETE, TRUNCATE and CASCADE refused',
    deletes.every((m) => /evidence_prereq_results is append-only: DELETE/.test(m)) && refusedBy(wipes[0], /evidence_prereq_results is append-only: TRUNCATE/) && refusedBy(wipes[1], /evidence_prereq_results is append-only: TRUNCATE/) && refusedBy(wipes[2], /is append-only: TRUNCATE/) &&
      triggers.length === 1 && /BEFORE TRUNCATE ON public\.evidence_prereq_results FOR EACH STATEMENT EXECUTE FUNCTION evidence_prereq_append_only\(\)/.test(triggers[0]) &&
      (await allAssessmentsHash()) === beforeWipe && (await allCasesHash()) === casesBeforeWipe,
    `DELETE of one and of all rows, TRUNCATE, TRUNCATE … CASCADE and a CASCADE from the A7.4 header are refused (${[...deletes, ...wipes].map(markerOf).join(', ')}); every assessment and case byte is identical afterwards`,
  )

  // ---------------------------------------------------------------- atomicity and audit (T061–T070)
  section('One row and one audit, nothing else mutated, crash after row and after audit, safe rerun, audits exactly once, missing keys, forged outcomes')
  check('T061', 'One result and one audit only', onlyAssessment(delta(before21, after21)) && audits1.length === 1, 'the first assessment wrote exactly one row and one audit')
  check(
    'T062',
    'No other table mutated',
    delta(before21, after21)[HEADER] === 0 && delta(before21, after21)[ENTRY] === 0 && delta(before21, after21).evidence_gate_results === 0 && delta(before21, after21).claim_freeze_lifecycle_events === 0 && (await caseHash(CASE1.caseId)) === upstreamBefore.case1,
    'no case, entry, readiness, classification, source, Claim, freeze, lifecycle or correction row was written or changed by recording',
  )
  const CK = await linkedCase('CRASH')
  const countsBeforeCrash = await counts()
  const crashAt = async (probe: string) => {
    failAt(probe)
    const message = await attemptAdversarial(() => assessClosurePrerequisites(CK.case.caseId, {}, creatorId))
    clearConcurrencyProbes()
    return { message, unchanged: await unchanged(countsBeforeCrash), visible: (await historyOf(CK.case.caseId)).length }
  }
  const crash1 = await crashAt('casePrerequisite.inserted')
  const crash2 = await crashAt('casePrerequisite.audited')
  check('T063', 'Crash after row rolls back', crash1.message.includes('INJECTED_CRASH') && crash1.unchanged && crash1.visible === 0, 'a failure after the row insert rolls back everything: no assessment, no audit')
  check('T064', 'Crash after audit rolls back both', crash2.message.includes('INJECTED_CRASH') && crash2.unchanged && crash2.visible === 0, 'a failure after the audit, before commit, rolls back the assessment and the audit')
  const retry = await assess(CK.case.caseId)
  check('T065', 'Safe rerun creates exactly once', retry.status === 201 && (await historyOf(CK.case.caseId)).length === 1 && same(delta(countsBeforeCrash, await counts()), { ...Object.fromEntries(COUNT_TABLES.map((t) => [t, 0])), [TABLE]: 1, audit_events: 1 }), 'the rerun after both crashes records the assessment once, with one audit')
  const orphanAudits = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM audit_events a WHERE a.action_code = 'evidence_case_prerequisite.assessed' AND NOT EXISTS (SELECT 1 FROM ${TABLE} r WHERE r.id = a.entity_id)`))[0].n)
  check('T066', 'No orphan audits', orphanAudits === 0, 'every evidence_case_prerequisite.assessed audit names an existing assessment')
  const auditOnce = Number((await prisma.$queryRawUnsafe<{ bad: bigint }[]>(`SELECT count(*) AS bad FROM ${TABLE} r WHERE (SELECT count(*) FROM audit_events a WHERE a.entity_id = r.id AND a.action_code = 'evidence_case_prerequisite.assessed') <> 1`))[0].bad)
  check('T067', 'No result without exactly one audit', auditOnce === 0, 'every assessment in the database has exactly one evidence_case_prerequisite.assessed audit')
  const missingKeys = [await directAssessment(dZ, { caseId: MISSING }), await directAssessment(dZ, { actor: MISSING })]
  check('T068', 'Missing case/actor FK refuses', refusedBy(missingKeys[0], /evidence_prereq_results_evidence_case_id_fkey/) && refusedBy(missingKeys[1], /evidence_prereq_results_recorded_by_user_id_fkey/), `an assessment of a non-existent case or by a non-existent actor is refused by its key (${missingKeys.map(markerOf).join(', ')})`)
  const positiveSql = [
    await directAssessment(dZ, { code: 'READY_FOR_CLOSURE', basis: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' }),
    await directAssessment(dZ, { code: 'PAID', basis: 'PAID' }),
    await directAssessment(dZ, { code: 'CLOSED', basis: 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED' }, true),
    await directAssessment(dZ, { code: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', basis: 'SETTLED' }, true),
  ]
  check(
    'T069',
    'Forged paid/closed/ready refused',
    refusedBy(positiveSql[0], /evidence_prereq_derivation/) && refusedBy(positiveSql[1], /evidence_prereq_derivation/) && refusedBy(positiveSql[2], /evidence_prereq_results_code_chk/) && refusedBy(positiveSql[3], /evidence_prereq_results_basis_chk/),
    `READY_FOR_CLOSURE and PAID are refused by the guard's derivation, CLOSED and SETTLED by the CHECKs even with the guard off (${positiveSql.map(markerOf).join(', ')})`,
  )
  check('T070', 'Refusals and replays write zero audit', refusalsLeftNothing && replaysLeftNothing && crash1.unchanged && crash2.unchanged && plantedLeftNothing, 'every 400/401/403/404, every replay, both crashes and every planted case wrote no assessment or audit')

  // ---------------------------------------------------------------- locking and races (T071–T080)
  section('Concurrency: Claim lock first, SERIALIZABLE, races with A6.2, A6.8, A6.9 and A7.1–A7.4 writers, bounded wait, retries, no blind retry')
  const txBody = serviceCode.slice(serviceCode.indexOf('async function assessOnTransaction'), serviceCode.indexOf('export async function assessClosurePrerequisites'))
  const readsBody = serviceCode.slice(serviceCode.indexOf('async function readLinkedReadiness'), serviceCode.indexOf('async function assessOnTransaction'))
  const L = await home.series('line edit', 1)
  const caseL = await linkedCase('LINE', L.freezes[0])
  const hold71 = holdAt('claimLine.removed')
  const removal = removeClaimLine(L.lineIds[1], {}, creatorId)
  await Promise.race([hold71.arrived, removal])
  const c71 = assessClosurePrerequisites(caseL.case.caseId, {}, creatorId)
  const waited71 = !(await settledWithin(c71, 3000))
  hold71.release()
  const [removed71, r71] = await Promise.all([removal, c71])
  clearConcurrencyProbes()
  check(
    'T071',
    'Claim lock first SERIALIZABLE statement',
    /lockRowForUpdateNowait\(tx, 'claims', owner\.claimId\)/.test(txBody.split('\n').slice(0, 3).join('\n')) && /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && waited71 && removed71.ok && r71.ok && !r71.value.replayed,
    'the Claim row lock (NOWAIT) is the first statement of the SERIALIZABLE transaction; an assessment during an uncommitted A6.2 line edit waits for it, then records',
  )
  const C80 = await linkedCase('ISOLATION')
  const hold72 = holdAt('casePrerequisite.audited')
  const pending72 = assessClosurePrerequisites(C80.case.caseId, {}, creatorId)
  await Promise.race([hold72.arrived, pending72])
  const during72 = get(assessPath(C80.case.caseId))
  const prompt72 = await settledWithin(during72, 5000)
  const duringItems = (await during72).body?.items ?? null
  hold72.release()
  const r72 = await pending72
  clearConcurrencyProbes()
  check(
    'T072',
    'All reads and writes on one tx client',
    /findCaseForPrerequisite\(caseId, tx\)/.test(txBody) && /findCaseById\(caseId, tx\)/.test(txBody) && /readLinkedReadiness\(stored\.entries, tx\)/.test(txBody) && /getReadinessOf\(entry\.classificationId, tx\)/.test(readsBody) &&
      !/prisma\.|withReadSnapshot/.test(txBody) && !/prisma\.|withReadSnapshot/.test(readsBody) && prompt72 && Array.isArray(duringItems) && duringItems.length === 0 && r72.ok && (await historyOf(C80.case.caseId)).length === 1,
    'the lock identity, the A7.4 case, every A7.3 readiness, the row and the audit all use the one transaction client; a read while the assessment is uncommitted answers at once with committed history only (none), then one',
  )
  const raceAssess = async (caseId: string, other: () => Promise<{ ok: boolean }>) => {
    const hold = holdAt('casePrerequisite.claim_locked')
    const c = assessClosurePrerequisites(caseId, {}, creatorId)
    await Promise.race([hold.arrived, c])
    const o = other()
    const waited = !(await settledWithin(o, 3000))
    hold.release()
    const [rc, ro] = await Promise.all([c, o])
    clearConcurrencyProbes()
    return { waited, rc: rc as any, ro: ro as any }
  }
  const C73 = await linkedCase('A62')
  const r73 = await raceAssess(C73.case.caseId, () => removeClaimLine(P.lineIds[1], {}, creatorId))
  check('T073', 'Concurrent A6.2 mutation serializes', r73.waited && r73.rc.ok && r73.ro.ok, 'an A6.2 line removal on the same Claim during an in-flight assessment waits for the shared Claim lock; both commit')
  const Lc = await home.series('lifecycle race', 1)
  const caseLc = await linkedCase('LIFECYCLE', Lc.freezes[0])
  const r74 = await raceAssess(caseLc.case.caseId, () => recordLifecycleEvent(Lc.freezes[0], { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }, creatorId))
  check('T074', 'Concurrent A6.8 lifecycle serializes', r74.waited && r74.rc.ok && r74.ro.ok && r74.rc.value.assessment.assessmentCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'an A6.8 lifecycle event during an in-flight assessment waits for the Claim lock; both commit and the assessment changed no disposition')
  const Cr = await home.series('correction race', 2)
  const caseCr = await linkedCase('CORRECTION', Cr.freezes[0])
  const crChainBefore = await correctionHash(Cr.claimId)
  const r75 = await raceAssess(caseCr.case.caseId, async () => {
    const res = await post(`/api/claims/${Cr.claimId}/correction-links`, { priorSubmissionId: Cr.freezes[0], correctedSubmissionId: Cr.freezes[1], reasonCode: 'CORRECTED_CODING' })
    return { ok: res.status === 201 }
  })
  check(
    'T075',
    'Concurrent A6.9 correction stays separate',
    r75.waited && r75.rc.ok && r75.ro.ok && (await correctionHash(Cr.claimId)) !== crChainBefore && same((await historyOf(caseCr.case.caseId)).map((i: any) => i.assessmentId), [r75.rc.value.assessment.assessmentId]),
    'an A6.9 correction link created during an in-flight assessment waits for the Claim lock; both commit, the link is A6.9\'s own row and the assessment of the prior freeze\'s case is unchanged by it',
  )
  const C76 = await linkedCase('A71')
  const case76Before = await caseHash(C76.case.caseId)
  const r76 = await raceAssess(C76.case.caseId, () => registerRevenueSourceEvidence(C76.submissionId, { sourceKind: SYNTHETIC, sourceReference: ref('A71-DURING') }, creatorId))
  check(
    'T076',
    'Concurrent A7.1 registration serializes',
    r76.waited && r76.rc.ok && r76.ro.ok && r76.rc.value.assessment.assessmentCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && (await caseHash(C76.case.caseId)) === case76Before && C76.case.itemCount === 1,
    'an A7.1 registration during an in-flight assessment waits; both commit, and the immutable one-item case is byte-identical and still lacks only external financial evidence',
  )
  const S77 = fresh()
  const unclassified77 = await registerSource(S77, 'A72-PRE')
  const case77 = await caseOf(S77)
  const r77a = await raceAssess(case77.caseId, () => classifySourceEvidence(unclassified77, {}, creatorId))
  const classification77 = r77a.ro.ok ? (r77a.ro.value.classification.classificationId as string) : null
  const r77b = await raceAssess(case77.caseId, () => recordAdjudicationReadiness(classification77 ?? MISSING, {}, creatorId))
  check(
    'T077',
    'Concurrent A7.2/A7.3 writes serialize',
    r77a.waited && r77a.rc.ok && r77a.ro.ok && r77b.waited && r77b.rc.ok && r77b.rc.value.replayed && r77b.ro.ok && r77a.rc.value.assessment.assessmentCode === 'INCOMPLETE_SOURCE_CHAIN' && same(r77b.rc.value.assessment, r77a.rc.value.assessment),
    'an A7.2 classification and then an A7.3 readiness during in-flight assessments each wait for the Claim lock; all commit, and the assessment of the case recorded before them stays INCOMPLETE_SOURCE_CHAIN',
  )
  const C78x = await linkedCase('A74-HELD')
  const S78y = fresh()
  await linkedSource(S78y, 'A74-DURING')
  const r78 = await raceAssess(C78x.case.caseId, () => assembleRevenueEvidenceCase(S78y, {}, creatorId))
  check('T078', 'Concurrent A7.4 case insert serializes', r78.waited && r78.rc.ok && r78.ro.ok && !r78.ro.value.replayed, 'an A7.4 case assembly for another freeze of the same Claim during an in-flight assessment waits for the Claim lock; both commit')
  const C79 = await linkedCase('HELD')
  const hold79 = holdAt('casePrerequisite.inserted')
  const first79 = assessClosurePrerequisites(C79.case.caseId, {}, creatorId)
  await Promise.race([hold79.arrived, first79])
  const second79 = assessClosurePrerequisites(C79.case.caseId, {}, B.id)
  const waited79 = !(await settledWithin(second79, 3000))
  hold79.release()
  const [r79a, r79b] = await Promise.all([first79, second79])
  clearConcurrencyProbes()
  const C79b = await linkedCase('IN-PROCESS')
  const inProcess = await Promise.all([1, 2, 3].map(() => assessClosurePrerequisites(C79b.case.caseId, {}, creatorId)))
  check(
    'T079',
    'Bounded wait, jitter, three retries',
    /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode) && /5 \+ Math\.floor\(Math\.random\(\) \* 20\)/.test(serviceCode) && /await pauseAfterLockWait\(\)/.test(serviceCode) && /const MAX_ASSESSMENT_ATTEMPTS = 3/.test(serviceCode) && /P2034/.test(serviceCode) && /40001/.test(serviceCode) && /isUniqueViolation\(error\)/.test(serviceCode) &&
      waited79 && r79a.ok && !r79a.value.replayed && r79b.ok && r79b.value.replayed && same(r79a.value.assessment, r79b.value.assessment) &&
      inProcess.every((r) => r.ok) && inProcess.filter((r) => r.ok && !r.value.replayed).length === 1 && (await prisma.evidencePrereqResult.count({ where: { evidenceCaseId: C79b.case.caseId } })) === 1,
    'a second request during an uncommitted first waits for the Claim lock (30-second budget, 5–25 ms random pause) and replays it; serialization, deadlock and unique races retry at most three times — three identical in-process requests give one assessment and two replays',
  )
  check(
    'T080',
    'Unknown outcome never retried blindly',
    /if \(isUnknownOutcome\(error\)\)\s*return \{ ok: false, code: 'EVIDENCE_CASE_PREREQUISITE_CONFLICT'/.test(serviceCode) && /P2028/.test(serviceCode) && crash2.visible === 0 && (await historyOf(CK.case.caseId)).length === 1,
    'a lost connection or ambiguous commit is a safe 409 telling the caller to read the case\'s assessment history, never a second insert; after the crashes the history was empty and after the rerun it holds one assessment',
  )

  // ---------------------------------------------------------------- privacy and safe interface (T081–T090)
  section('Privacy: minimal DTO, no PHI, money, verdict, bytes or fingerprint, metadata-only audit, no logs or browser storage, safe errors, tenant reads')
  const assessmentFor = await assess(CASE_F.caseId, O.who)
  const dtos = [ASSESS1.body, ASSESS_S2.body, emptyAssessment.body, incAssessment.body, read1.body, assessmentFor.body, ...history1]
  const auditRow1 = audits1[0]
  const exposed = JSON.stringify([dtos, auditRow1?.afterState])
  const exposedKeys = [...deepKeys(JSON.parse(exposed))]
  check('T081', 'Minimal assessment DTO shape', dtos.every((d: any) => same(Object.keys(d ?? {}), DTO_KEYS)), 'every create, replay, history and single read carries exactly assessmentId, caseId, contract, code, basis, case digest, actor and time')
  check('T082', 'No patient/member fields', !exposed.includes(`${runId}-home-P`) && !exposed.includes(`${runId}-away-P`) && !exposed.includes('1990-01-01') && !exposedKeys.some((k) => /patient|member|name|birth|email|phone|address|gender/i.test(k)), 'no patient, member or contact value or key in any DTO or audit')
  check('T083', 'No diagnoses/procedures or PHI', !exposedKeys.some((k) => /diagnos|procedure|activity|encounter|clinician|facility/i.test(k)) && !exposed.includes(key('home-DXA')) && !exposed.includes(key('home-PA')), 'no diagnosis, procedure, activity, encounter, clinician or facility key or value')
  check('T084', 'No money, payment or denial', !/125\.25|12\.125|200\.01|AED/.test(exposed) && !exposedKeys.some((k) => /amount|balance|currency|paid|price|fee|payer|payment|denial|adjudicat|status|verdict/i.test(k)) && !/"(PAID|DENIED|SETTLED|CLOSED|READY_FOR_CLOSURE)"/.test(exposed), 'no amount, balance, currency, fee, payer, payment, denial, status or verdict key or value')
  check('T085', 'No bytes, manifest or source fingerprint', !exposedKeys.some((k) => /bytes|payload|seal|fingerprint|sourceReference|sourceEvidenceId|raw|^manifest$|manifestText|items/i.test(k)) && !exposed.includes(ref('E1')) && !exposed.includes(K1.E), 'no frozen payload or manifest bytes, seal, source fingerprint, source id or reference leaves the server — only the case digest')
  check(
    'T086',
    'Metadata-only audit vocabulary',
    auditRow1?.actionCode === 'evidence_case_prerequisite.assessed' && auditRow1.entityType === 'EVIDENCE_CASE_PREREQUISITE' && auditRow1.actorUserId === creatorId && auditRow1.organizationId === org && same(Object.keys(auditRow1.afterState as object).sort(), [...AUDIT_KEYS].sort()) && auditRow1.beforeState === null,
    'evidence_case_prerequisite.assessed on EVIDENCE_CASE_PREREQUISITE, naming the actor and organization, with exactly ids, contract, codes and time (no digest)',
  )
  const production = committedProductionCodeOf([MODULE_DIR])
  check('T087', 'No secrets or evidence bytes in logs', production.files.length === 6 && !/console\.|logger\.|process\.env/.test(production.code), 'the six A7.5 backend files log nothing and read no environment or secret')
  const frontend = committedCode(`${FE_DIR}/CasePrerequisiteCheck.tsx`)
  const registry = committedCode('frontend/src/developer/checkRegistry.tsx')
  check(
    'T088',
    'Check page GET only, no browser storage',
    frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend) && /key: 'case-prerequisite'/.test(registry) && /\/closure-prerequisite-assessments`\)/.test(frontend) && !/fetch\([^)]*,\s*\{/.test(frontend),
    'the Developer Tools page is registered, makes one plain GET (no request options, so no write) and keeps nothing in browser storage',
  )
  const errorBodies = [...nonObject, ...serverOwned, ...unknownFields, ...malformed, ...anon, viewerPost, ...foreignOnHome, ...homeOnForeign, ...missingCase, ...spoofs, ...latestRoutes]
  const viewerPostAgain = await assess(CASE1.caseId, asViewer)
  check(
    'T089',
    'Deterministic safe errors, no raw SQL',
    errorBodies.every((res) => !rawError(res.body) && typeof res.body?.error?.code === 'string' && typeof res.body?.error?.message === 'string') && same({ ...viewerPostAgain.body.error, requestId: null }, { ...viewerPost.body.error, requestId: null }),
    `all ${errorBodies.length} refusals carry a code, a safe message and a request id only; the same refusal repeats exactly`,
  )
  const foreignReads = [await get(onePath(ASSESS1.body.assessmentId), O.who), await get(onePath(assessmentFor.body?.assessmentId ?? MISSING))]
  const missingAsForeign = await get(onePath(MISSING), O.who)
  const queryPost = await post(`${assessPath(CASE1.caseId)}?caseId=${CASE_S2.caseId}&token=SYN-SECRET`, {})
  check(
    'T090',
    'Other-tenant exact read 404',
    assessmentFor.status === 201 && foreignReads.every((res) => res.status === 404) && same(foreignReads[0].body?.error?.message, missingAsForeign.body?.error?.message) && queryPost.status === 200 && same(queryPost.body, ASSESS1.body) && !/req\.query/.test(routeCode),
    "the other organization assesses its own case (201) but cannot read this tenant's assessment, nor this tenant theirs: 404, like a missing one; a case id or token in the query string changes nothing",
  )

  // ---------------------------------------------------------------- deterministic semantics (T091–T100)
  section('Fifty identical derivations, time zone and locale invariance, no balance, no closure, priority never guessed, history, no pointer, future contract')
  const facts1 = await ownerFacts(CASE1.caseId)
  const repeated = Array.from({ length: 50 }, () => JSON.stringify(deriveCasePrerequisite(facts1.stored, facts1.stored.entries, facts1.readiness)))
  check('T091', 'Fifty pure derivations identical', new Set(repeated).size === 1 && outcomeOf(JSON.parse(repeated[0])) === `${ASSESS1.body.assessmentCode}/${ASSESS1.body.basisCode}`, 'fifty derivations of CASE1\'s stored facts give identical bytes, equal to the recorded assessment')
  const probeInput = JSON.stringify({ header: facts1.stored, items: facts1.stored.entries, readiness: facts1.readiness })
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import { deriveCasePrerequisite } from './src/modules/case-prerequisite/case-prerequisite.reducer.ts'; const i = JSON.parse(process.env.A75_INPUT); console.log(JSON.stringify([deriveCasePrerequisite(i.header, i.items, i.readiness), Intl.DateTimeFormat().resolvedOptions().timeZone, Intl.DateTimeFormat().resolvedOptions().locale, 'i'.toUpperCase()]))"],
    { encoding: 'utf8', cwd: process.cwd(), env: childEnv({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', A75_INPUT: probeInput }) },
  )
  const probed = (() => {
    try {
      return JSON.parse((probe.stdout ?? '').trim().split(/\r?\n/).pop() ?? '')
    } catch {
      return null
    }
  })()
  const zoned = await directAssessment(dZ, { zone: true })
  check('T092', 'Time zone invariance', probed !== null && probed[1] === 'Pacific/Kiritimati' && outcomeOf(probed[0]) === outcomeOf(JSON.parse(repeated[0])) && accepted(zoned), 'a separate process in Pacific/Kiritimati (UTC+14) derives the identical outcome, and the database guard accepts the derived assessment in that session time zone (rolled back)')
  const lowerings = (production.code.match(/\.toLowerCase\(\)/g) ?? []).length
  const idLowerings = (production.code.match(/(caseId|assessmentId)\)?\.toLowerCase\(\)/g) ?? []).length
  check(
    'T093',
    'Locale invariance',
    probed !== null && outcomeOf(probed[0]) === outcomeOf(JSON.parse(repeated[0])) && accepted(zoned) && !/toLocale|Intl\.|localeCompare|toUpperCase/.test(production.code) && lowerings === idLowerings,
    `with a ${probed?.[2] ?? '?'} process locale and C database messages the outcome is the same; the A7.5 code compares controlled tokens exactly and only lower-cases path ids (${idLowerings})`,
  )
  const ledgerTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(receivable|ledger|balance|posting|journal|allocation|settle|payment|cash|receipt|copay|patient_share)'`).map((row) => row.t)
  check('T094', 'No source is not zero balance', emptyAssessment.body.assessmentCode === 'NO_SOURCE_BASIS' && ledgerTables.length === 0 && !columns.some((c) => /balance|amount|currency/.test(c)), 'NO_SOURCE_BASIS states only that no source inventory exists: no balance, amount or currency exists anywhere to be zero')
  const closureTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(closure|closed|reconcil|write_off|writeoff)'`).map((row) => row.t)
  check('T095', 'Incomplete case is not closure', incAssessment.body.assessmentCode === 'INCOMPLETE_SOURCE_CHAIN' && closureTables.length === 0 && !/'(CLOSED|READY_FOR_CLOSURE|RECONCILED)'/.test(readFileSync(`../${MIGRATION}`, 'utf8')), 'INCOMPLETE_SOURCE_CHAIN is a missing prerequisite: no closure, closed or reconciliation table or code exists')
  const completeCodes = await prisma.$queryRawUnsafe<{ code: string; n: bigint }[]>(`SELECT a.assessment_code AS code, count(*) AS n FROM ${TABLE} a JOIN ${HEADER} h ON h.id = a.evidence_case_id WHERE h.assembly_code = 'INVENTORY_COMPLETE' GROUP BY 1`)
  const syntheticKinds = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${TABLE} a JOIN ${ENTRY} e ON e.assembly_id = a.evidence_case_id JOIN revenue_source_evidence r ON r.id = e.source_evidence_id WHERE r.source_kind <> 'INTERNAL_SYNTHETIC'`))[0].n)
  check(
    'T096',
    'Complete synthetic case never closure ready',
    completeCodes.length === 1 && completeCodes[0].code === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' && syntheticKinds === 0 && !/READY_FOR_CLOSURE/.test(production.code),
    `every committed assessment of a complete case is EXTERNAL_FINANCIAL_EVIDENCE_ABSENT (${completeCodes.map((r) => `${r.code} ${r.n}`).join(', ')}); every assessed source is INTERNAL_SYNTHETIC; no closure-ready code exists`,
  )
  const tamperedPair = deriveCasePrerequisite(facts1.stored, facts1.stored.entries, facts1.readiness.map((r, i) => (i === 0 ? { ...r, reasonCode: 'CLASSIFICATION_UNSUPPORTED' } : r)))
  const tamperedCode = deriveCasePrerequisite(facts1.stored, facts1.stored.entries, facts1.readiness.map((r, i) => (i === 0 ? { ...r, readinessCode: 'READY_FOR_ADJUDICATION' } : r)))
  const uncontrolledStored = await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await tx.$executeRawUnsafe(`UPDATE evidence_gate_results SET reason_code = 'CLASSIFICATION_UNSUPPORTED' WHERE id = $1::uuid`, K1.R)
      throw new Error(NOT_REFUSED)
    }),
  )
  check(
    'T097',
    'Uncontrolled pair refused, never guessed',
    !tamperedPair.ok && !tamperedCode.ok && /approved readiness\/reason pair/.test(tamperedPair.ok ? '' : tamperedPair.detail) && refusedBy(uncontrolledStored, /evidence_gate_results_[a-z]+_chk/) && !/orderBy: \{ recordedAt: 'desc'|\.at\(-1\)|latest|newest/i.test(production.code.replace(/refusedByName = \[[\s\S]*?\] as const/, '')),
    `an uncontrolled readiness/reason pair or an invented readiness is a provenance conflict for the reducer, never mapped to the nearest outcome; the A7.3 CHECK keeps one from being stored (${markerOf(uncontrolledStored)}); no latest record is ever chosen`,
  )
  check(
    'T098',
    'Historical result unaffected by new evidence',
    (await assessmentHash(ASSESS1.body.assessmentId)) === assess1Before && (await prisma.evidenceCaseEntry.count({ where: { assemblyId: CASE1.caseId, sourceEvidenceId: K3.E } })) === 0 && outcomeOf(deriveCasePrerequisite((await ownerFacts(CASE1.caseId)).stored, (await ownerFacts(CASE1.caseId)).stored.entries, (await ownerFacts(CASE1.caseId)).readiness)) === outcomeOf(JSON.parse(repeated[0])),
    'E3 belongs to no entry of CASE1; ASSESS1 is history, unchanged to the byte, and its stored case still derives the same outcome',
  )
  const upstreamColumns = await prisma.$queryRaw<{ t: string; n: bigint }[]>`SELECT table_name AS t, count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('claims', 'claim_freezes', 'revenue_source_evidence', 'source_evidence_classifications', 'evidence_gate_results', 'evidence_case_snapshots', 'evidence_case_entries') GROUP BY 1 ORDER BY 1`
  check(
    'T099',
    'No current/latest pointer columns',
    same(upstreamColumns.map((r) => [r.t, Number(r.n)]), [['claim_freezes', 13], ['claims', 7], ['evidence_case_entries', 7], ['evidence_case_snapshots', 13], ['evidence_gate_results', 11], ['revenue_source_evidence', 10], ['source_evidence_classifications', 11]]) && columns.length === 10 && columns.every((c) => COLUMNS.includes(c)) && !columns.some((c) => /current|latest|status|state|pointer/.test(c)),
    'the assessment has exactly its 10 columns — no current, latest, status or pointer — and no upstream table, the A7.4 header and entries included, gained a column',
  )
  check(
    'T100',
    'Future contract cannot rewrite previous',
    refusedBy(futureContract, /evidence_prereq_results_contract_chk/) && /evidence_case_id, contract_version/.test(identityDef) && /is append-only: UPDATE/.test(rewrites[2]),
    'identity is (case, contract): A7-CLOSURE-PREREQ-2 is refused today, would be its own row when admitted, and rewriting an existing row to it is refused',
  )

  // ---------------------------------------------------------------- phase boundaries (T101–T110)
  section('No A6 or A7.1–A7.4 change, no A7.6–A9 work, no send, import, network, queue, ledger, payment, adjustment or market switch')
  const wFreeze = await freezeHash(W.claimId)
  const pFreeze = await freezeHash(P.claimId)
  const wLifecycle = await lifecycleHash(W.claimId)
  const CB = await linkedCase('BOUNDARY')
  const beforeBoundary = { sources: await sourceHash(), classifications: await classificationHash(), readiness: await readinessHash(), cases: await allCasesHash() }
  const boundaryAssessment = await assess(CB.case.caseId)
  check('T101', 'A6.7 frozen payload untouched', boundaryAssessment.status === 201 && (await freezeHash(W.claimId)) === wFreeze && (await freezeHash(P.claimId)) === pFreeze, 'every byte of the freezes and their sealed manifests is identical after an assessment')
  check('T102', 'A6.8 lifecycle unchanged', (await lifecycleHash(W.claimId)) === wLifecycle && (await lifecycleHash(Re.claimId)) === reLifecycleBefore, 'every lifecycle event is identical')
  check('T103', 'A6.9 lineage unchanged', (await correctionHash(W.claimId)) === chainBefore, 'the worked correction link is identical')
  check('T104', 'A7.1 source rows unchanged', (await sourceHash()) === beforeBoundary.sources, "every byte of this run's A7.1 sources is identical after an assessment")
  check('T105', 'A7.2 classification rows unchanged', (await classificationHash()) === beforeBoundary.classifications, "every byte of this run's A7.2 classifications is identical after an assessment")
  check('T106', 'A7.3 readiness rows unchanged', (await readinessHash()) === beforeBoundary.readiness, "every byte of this run's A7.3 readiness results is identical after an assessment")
  check('T107', 'A7.4 snapshot and entries unchanged', (await allCasesHash()) === beforeBoundary.cases && (await caseHash(CASE1.caseId)) === upstreamBefore.case1, 'every byte of every A7.4 case header and entry is identical after an assessment; CASE1 is identical since before its assessment')
  const laterRoutes = [
    await post(`${onePath(ASSESS1.body.assessmentId)}/close`, {}),
    await post(`/api/revenue-evidence-cases/${CASE1.caseId}/closures`, {}),
    await post(`/api/revenue-evidence-cases/${CASE1.caseId}/reconciliations`, {}),
    await post(`/api/claim-submissions/${S1}/remittances`, {}),
    await post(`/api/claim-submissions/${S1}/payments`, {}),
    await post(`/api/claim-submissions/${S1}/adjudications`, {}),
  ]
  const laterTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(adjudicat|denial|allowed|remittance|settle|import|inbound|outbox|queue|transmission|acknowledg|closure|reconcil|payer_response)'`).map((row) => row.t)
  const jobsChanged = changedPaths.filter((file) => /^backend\/src\/jobs\//.test(file))
  // Judged on behaviour, not vocabulary: an awaited in-request pause (the lock-wait jitter) is not background work.
  const awaitedPause = /new Promise\(\(resolve\) => setTimeout\(resolve, [^\n]*/g
  const awaitedPauses = production.code.match(awaitedPause) ?? []
  const backgroundWork = production.code.replace(awaitedPause, '')
  const jobsWiring = committedFiles('backend/src/jobs').filter((file) => /\.ts$/.test(file)).some((file) => /prereq/i.test(file) || /case-prerequisite|casePrerequisite|evidenceCasePrereq/i.test(committedCode(file)))
  check(
    'T108',
    'No A7.6–A9 or payer integration',
    laterRoutes.every((res) => res.status === 404) && laterTables.length === 0 &&
      !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|<\?xml|\bx12\b|\bhl7\b|\bfhir\b|dhpo|eclaimlink|enqueue/i.test(production.code) && jobsChanged.length === 0 && !jobsWiring && !/setInterval|setTimeout|setImmediate|worker_threads|\bnew Worker\(|cron|schedule\(/i.test(backgroundWork) && awaitedPauses.length === 1,
    `no close, closure, reconciliation, remittance, payment or adjudication route or table; no network client, XML/X12/HL7/FHIR, queue, job, worker or background timer in A7.5 code (its only timer is the awaited lock-wait pause, ${awaitedPauses.length})`,
  )
  const moneyIdentifier = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|toFixed\(|[Ss]ettle|[Aa]llocat|[Aa]djust|[Rr]eceivable|[Bb]alance|[Ll]edger|[Pp]ayment|[Rr]emittance/
  const moneyCode = production.code.replace(/refusedByName = \[[\s\S]*?\] as const/, '').replace(/EXTERNAL_REMITTANCE_NOT_ESTABLISHED/g, '')
  const pricingOfW = await prisma.claimPricingRun.findMany({ where: { claimId: W.claimId }, orderBy: { evaluatedAt: 'asc' } })
  check(
    'T109',
    'No ledger, remittance, payment, adjustment',
    !moneyIdentifier.test(moneyCode) && ledgerTables.length === 0 && pricingOfW.length === 1 && pricingOfW[0].totalExtendedAmount?.toFixed(2) === '200.01' && !columns.some((c) => /patient|balance|amount/.test(c)),
    'A7.5 computes no money and creates no ledger, remittance, payment, adjustment or patient-balance table or column; the Claim keeps its one pricing run and its AED 200.01 total',
  )
  check('T110', 'Synthetic only, no market switch', syntheticKinds === 0 && !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION)\w*|['"`](AE-DU|DHA|AED|US)['"`]/.test(production.code), 'every assessed source is INTERNAL_SYNTHETIC; A7.5 holds no UAE/US market literal (future US support stays configuration)')

  const workedRows = async () => {
    const r = await prisma.evidencePrereqResult.findUniqueOrThrow({ where: { id: ASSESS1.body.assessmentId } })
    return JSON.stringify({ ...r, recordedAt: r.recordedAt.toISOString(), createdAt: r.createdAt.toISOString() })
  }
  const worked = { row: await workedRows(), read: read1.body }

  // ---------------------------------------------------------------- nested regressions (T111–T120)
  section('Regressions — A7.4 invoked, nesting A7.3 -> A7.2 -> A7.1 -> A6.10 -> A6.9 -> … -> A6.1 -> A5.10 -> A1')
  await apiReady('the A7.4 and backward regression chain')
  const chain = run('npm run test:a7:revenue-evidence-case')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.4')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.4] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.4 asserts facts about its own branch (name, tracking, migration, production diff), its nested N/A proofs against
  // its own branch, and its own upstream. On A7.5 those statements are obsolete by design; every other A7.4 check is
  // substantive. T120 below proves each cause independently, never from the id.
  const a74NonApplicable: Record<string, string> = {
    T001: "A7.4 'Correct A7.3 merge prerequisite' requires the A7.4 feature branch (and reads any other A7 suite as later code); A7.5 is branched from the main that contains the A7.4 merge",
    T002: "A7.4 'Clean HEAD and origin parity' requires tracking origin/feature/a7-4-…, deleted when it merged; the clean tree and exact origin parity of THIS branch are proved by T002 here",
    T004: "A7.4 'One additive migration only' expects its own migration as the branch's only addition; A7.5 adds exactly one different migration (T004 here)",
    T010: "A7.4 'Scope, diff and no later-owner code' lists the paths A7.4 was allowed to change; A7.5 legitimately changes its own (T010 here)",
    T120: "A7.4 'Exact protected owner diffs only' proves A7.3's branch-only causes against the A7.4 branch (its name, migration, diff and upstream); on A7.5 those proofs are re-done here (T120)",
    T130: "A7.4 'Exact HEAD, two full runs' requires the upstream to be the A7.4 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a74NonApplicable))
  const summary = chain.output.match(/\[A7\.4\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.4\] RUN ABORTED|\[A7\.4\] uncaught error|\[A7\.4\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a74Substantive = rows.filter((row) => !(row.id in a74NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a74Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T111',
    'A7.4 substantive checks invoked',
    ran && reconciled && undocumented.length === 0 && a74Substantive.length === 0 && a74Passing >= 124 && ['T060', 'T107', 'T009', 'T006'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A7.4 suite did not complete'
      : !reconciled
        ? `A7.4 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.4 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.4\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.4] automated summary: ', 'A7.4 ')}; all ${a74Passing} substantive checks PASS (T060 with the A7.5 key into the header, T107 with the A7.5 table and routes) and every failure is documented`,
  )
  for (const id of Object.keys(a74NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A7.4 ${titleOf(row.line)}`, a74NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T112', 'A7.3 substantive checks invoked', verdictOf('T111') === 'PASS', `A7.4 T111 (A7.3 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A7.2 substantive checks invoked', verdictOf('T112') === 'PASS', `A7.4 T112 (A7.2) ${verdictOf('T112')}`)
  check('T114', 'A7.1 substantive checks invoked', verdictOf('T113') === 'PASS', `A7.4 T113 (A7.1) ${verdictOf('T113')}`)
  check('T115', 'A6.10 cumulative regression', verdictOf('T114') === 'PASS', `A7.4 T114 (A6.10) ${verdictOf('T114')}`)
  check('T116', 'A6.1–A6.9 substantive regressions', verdictOf('T115') === 'PASS', `A7.4 T115 (A6.9 … A6.1) ${verdictOf('T115')}`)
  check('T117', 'A5.1–A5.10 substantive regressions', verdictOf('T116') === 'PASS', `A7.4 T116 (A5.10 → A5.1) ${verdictOf('T116')}`)
  check('T118', 'A1–A4 substantive regressions', verdictOf('T117') === 'PASS', `A7.4 T117 (A1–A4) ${verdictOf('T117')}`)
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A7\.4\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T119',
    'Only obsolete branch-only N/A, with reasons',
    ran && failing.every((id) => id in a74NonApplicable) && naLines.length === 5 && naLines.every((line) => line.length > 80) && verdictOf('T118') === 'PASS' && verdictOf('T119') === 'PASS',
    `the A7.4 branch-only items (${failing.join(', ') || 'none'}) are each printed with an explicit reason here, and A7.4 itself justifies its five A7.3 items (${naLines.length} lines, its T118/T119 ${verdictOf('T118')}/${verdictOf('T119')})`,
  )
  // Each documented A7.4 failure must fail for its branch-only reason, proved independently on this branch.
  const allowed = [
    'backend/package.json',
    'backend/src/app.ts',
    'backend/prisma/schema.prisma',
    MIGRATION,
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/errors/error.types.ts',
    'backend/src/modules/audit/audit.types.ts',
    'frontend/src/developer/checkRegistry.tsx',
  ]
  const ownDirs = [MODULE_DIR, FE_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const a74Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA73 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const causes: Record<string, boolean> = {
    T001: branch === a75Branch && a74Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a74Merge} HEAD`),
    T002: /working tree clean/.test(lineOfRow('T002')) && dirty.length === 0 && tracking.includes(`origin/${a75Branch}`) && !/ahead|behind/.test(tracking),
    T004: same(migrationStatus, [`A\t${MIGRATION}`]),
    T010: a74Unexpected.length > 0 && a74Unexpected.every((path, index) => changedPaths.includes(path) || (index === a74Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A7.4 re-proves A7.3's branch-only causes against the A7.4 branch; on A7.5 only those tied to the branch (its
    // name, migration, diff and upstream) can be unproven — re-proved here against this branch.
    T120: unprovenA73.length > 0 && unprovenA73.every((id) => ['T001', 'T004', 'T010', 'T120', 'T130'].includes(id)) && same(migrationStatus, [`A\t${MIGRATION}`]) && outOfScope.length === 0 && tracking.includes(`origin/${a75Branch}`),
    T130: tracking.includes(`origin/${a75Branch}`) && !/origin\/feature\/a7-4/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  check(
    'T120',
    'All nested substantive checks PASS',
    ran && a74Substantive.length === 0 && unproven.length === 0 && ownOwnerChanged.length === 0,
    unproven.length === 0
      ? `every substantive check of A7.4 and of every package it nests PASSES; each documented A7.4 failure (${failing.filter((id) => id in a74NonApplicable).join(', ') || 'none'}) fails only for its branch-only reason, proved independently; no owner file changed`
      : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- build and exact-head acceptance (T121–T130)
  section('Units, typecheck, frontend, Prisma checksum, replay, outage and recovery, no 5xx, synthetic fixtures, golden example, exact head')
  const allUnit = run('npm run test:unit')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  check('T121', 'Unit suite with reducer cases', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 16/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 16 A7.5 reducer and strict-request tests (empty, incomplete, complete, review, unsupported, contradictory)`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Backend typecheck clean', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint clean', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build clean', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const appliedChecksum = (await prisma.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM _prisma_migrations WHERE migration_name = ${MIGRATION_NAME} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.checksum
  const blob = spawnSync('git', ['show', `HEAD:${MIGRATION}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checkoutChecksum = sha256Of(readFileSync(`../${MIGRATION}`))
  check(
    'T125',
    'Migration checksums and scratch replay',
    status.ok && replay.ok && (appliedChecksum === checkoutChecksum || appliedChecksum === sha256Of(blob)),
    `the A7.5 migration is applied with the checksum of its committed file (${(appliedChecksum ?? '').slice(0, 12)}…); status up to date; scratch replay ALL CHECKS PASS (T006)`,
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
  check('T126', 'Health 200 DB down; readiness 503', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')
  await waitFor(databaseUp, 60_000)
  check('T127', 'No unexpected 5xx or reset', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runAssessments = await prisma.$queryRawUnsafe<{ org: string; sub: string }[]>(`SELECT a.organization_id::text AS org, h.claim_submission_id::text AS sub FROM ${TABLE} a JOIN ${HEADER} h ON h.id = a.evidence_case_id WHERE a.created_at >= $1::timestamptz`, runStartedAt.toISOString())
  const runSubmissions = new Set([...W.freezes, ...P.freezes, ...F.freezes, ...L.freezes, ...Lc.freezes, ...Cr.freezes, ...Re.freezes, ...Wd.freezes])
  check(
    'T128',
    'Synthetic fixtures, independent tenants',
    runAssessments.length > 0 && runAssessments.every((a) => runSubmissions.has(a.sub) && [org, otherOrg].includes(a.org)) && runAssessments.some((a) => a.org === otherOrg) && syntheticKinds === 0,
    `${runAssessments.length} assessments recorded since this run started, all of this run's synthetic cases in the two synthetic organizations (each assessing only its own); every source INTERNAL_SYNTHETIC`,
  )
  const afterRow = await workedRows()
  const afterRead = (await get(onePath(ASSESS1.body.assessmentId))).body
  const afterDerived = await deriveFor(CASE1.caseId)
  console.log(`[${TAG}]      worked example: S1 ${S1} (organization ${org}) -> CASE1 ${CASE1.caseId} (2 sources, both NOT_READY_FOR_ADJUDICATION) -> ASSESS1 ${ASSESS1.body.assessmentId} ${ASSESS1.body.assessmentCode} / ${ASSESS1.body.basisCode}, digest ${ASSESS1.body.caseManifestSha256.slice(0, 12)}… copied, 1 audit`)
  console.log(`[${TAG}]      worked example: repeat POST -> ${replay1.status} identical, +${d41.audit_events} audit; later E3 on S1 -> CASE1 and ASSESS1 byte-identical; corrected S2 -> its own case and assessment; empty -> ${emptyAssessment.body.assessmentCode}; incomplete -> ${incAssessment.body.assessmentCode}; five-way -> ${five.map((r) => r.status).join('/')}; nothing paid, closed or adjudicated`)
  check(
    'T129',
    'Golden worked example after restart',
    ASSESS1.status === 201 && replay1.status === 200 && d41.audit_events === 0 && ASSESS_S2.status === 201 && emptyAssessment.body.assessmentCode === 'NO_SOURCE_BASIS' && incAssessment.body.assessmentCode === 'INCOMPLETE_SOURCE_CHAIN' &&
      afterRow === worked.row && same(afterRead, worked.read) && afterDerived.code === ASSESS1.body.assessmentCode && afterDerived.digest === ASSESS1.body.caseManifestSha256,
    'the §8 scenario is reproduced, and after the nested chain and a database restart ASSESS1 reads back byte-identically and its stored case derives the same outcome and digest',
  )

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|reconcil|integration\/a(8|9)|dhpo|eclaimlink/i.test(file))
  check(
    'T010',
    'Exact changed-file scope, no later domain',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A7.5 module, migration and model, harness and check page, two permissions, two error codes, one audit action, the replay block and wiring; no A5/A6/A7.1–A7.4 owner changed; no A7.6+/A8/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  check(
    'T130',
    'Exact HEAD, two full runs, clean parity',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a75Branch}`) && !/ahead|behind/.test(tracking) && afterRow === worked.row,
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; after the database restart the worked assessment reads back identically`,
  )

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] CASE CLOSURE-PREREQUISITE ASSESSMENT ACCEPTANCE COMPLETE` : `[${TAG}] A7.5 FINAL FAIL`)
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
