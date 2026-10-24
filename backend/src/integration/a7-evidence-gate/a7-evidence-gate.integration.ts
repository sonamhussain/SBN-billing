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
import { recordCorrectionLink } from '../../modules/claim-correction/claim-correction.service.ts'
import { registerRevenueSourceEvidence } from '../../modules/revenue-evidence/revenue-evidence.service.ts'
// The A7.2 owner builds its own rows in the rolled-back proofs exactly as it would (its classifier, fingerprint and
// insert); A7.3 production code never calls them.
import { classifySource, sourceFingerprintSha256 } from '../../modules/evidence-classification/evidence-classification.classifier.ts'
import { findSourceForClassification, insertClassification } from '../../modules/evidence-classification/evidence-classification.repository.ts'
import { classifySourceEvidence } from '../../modules/evidence-classification/evidence-classification.service.ts'
import { deriveReadiness, recordedReadinessAgrees } from '../../modules/evidence-gate/evidence-gate.reducer.ts'
import { findClassificationForGate, findReadinessByIdentity, insertReadiness } from '../../modules/evidence-gate/evidence-gate.repository.ts'
import { getReadinessOf, recordAdjudicationReadiness } from '../../modules/evidence-gate/evidence-gate.service.ts'
import type { Readiness, ReducerResult } from '../../modules/evidence-gate/evidence-gate.types.ts'

// A7.3 — focused acceptance for Adjudication Evidence Readiness & Provenance Gate (T001–T130).
//
// Every frozen submission is built through its owners, exactly as the A6.7–A7.2 suites build them (tariff world and
// rates, the A5.7 recorder, readiness, the Claim, lines, diagnoses and pointers, pricing, draft assessments,
// APPROVE/REVOKE by a separate synthetic Admin, every freeze through the A6.7 route and the correction link through
// A6.9); every source is registered through the A7.1 route and classified through the A7.2 route. The other
// organization builds its own world with its own two Admins. Readiness results go through the A7.3 route (or, for
// barrier-controlled races and crash injection, its service in-process). ADVERSARIAL writes go in only to prove a
// database guard; every one of them — including the ones that relax an A7.1 CHECK or switch row triggers off to
// build an upstream row no owner can write today — runs in a transaction that is always rolled back. Synthetic
// Admins are provisioned per run through Better Auth's own server-side creation with a random password that is never
// printed. Every value is synthetic and keyed by this run's id.

const TAG = 'A7.3'
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

const runId = `A73-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a73Branch = 'feature/a7-3-adjudication-evidence-readiness'
const a72Branch = 'feature/a7-2-evidence-classification'
const a71Branch = 'feature/a7-1-revenue-source-evidence'
const a610Branch = 'feature/a6-10-a6-integration-acceptance'
const correctiveBranch = 'fix/a6-harness-replay-count-head'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/evidence-gate'
const FE_DIR = 'frontend/src/modules/evidence-gate'
const HARNESS_DIR = 'backend/src/integration/a7-evidence-gate'
const MIGRATION_NAME = '20261023090000_a7_3_evidence_gate'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const A72_HARNESS = 'backend/src/integration/a7-evidence-classification/a7-evidence-classification.integration.ts'
const UNIT_TESTS = [`${MODULE_DIR}/evidence-gate.reducer.test.ts`, `${MODULE_DIR}/evidence-gate.validation.test.ts`]
const TABLE = 'evidence_gate_results'
const CONTRACT = 'A7-ADJ-READINESS-1'
const CLASS_CONTRACT = 'A7-EVIDENCE-CLASS-1'
const SOURCE_CONTRACT = 'A7-REVENUE-SOURCE-1'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const NOT_READY: Readiness = { readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' }
const REVIEW: Readiness = { readinessCode: 'SOURCE_REQUIRES_REVIEW', reasonCode: 'CLASSIFICATION_REVIEW_REQUIRED' }
const UNSUPPORTED: Readiness = { readinessCode: 'SOURCE_UNSUPPORTED', reasonCode: 'CLASSIFICATION_UNSUPPORTED' }
const DTO_KEYS = ['readinessId', 'classificationId', 'sourceEvidenceId', 'contractVersion', 'readinessCode', 'reasonCode', 'recordedByUserId', 'recordedAt']
const AUDIT_KEYS = ['readinessId', 'classificationId', 'sourceEvidenceId', 'contractVersion', 'readinessCode', 'reasonCode', 'recordedAt']
const A73_COLUMNS = ['id', 'organization_id', 'source_evidence_id', 'classification_id', 'contract_version', 'readiness_code', 'reason_code', 'classification_fingerprint_sha256', 'recorded_by_user_id', 'recorded_at', 'created_at']
// The owners A7.3 consumes or must leave untouched: the A5/A6 modules, A7.1 and A7.2 (backend, pages and A7.1 suite).
const OWNER_DIRS = [
  ...[
    'claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction',
    'pre-claim-validation', 'pre-claim-readiness', 'validation-run', 'revenue-evidence', 'evidence-classification',
  ].map((name) => `backend/src/modules/${name}`),
  'frontend/src/modules/revenue-evidence',
  'frontend/src/modules/evidence-classification',
  'backend/src/integration/a7-revenue-source-evidence',
  'backend/src/integration/a7-evidence-classification',
]
// The tables whose rows a refusal, a read or a rolled-back write must leave untouched, always read in this fixed
// key order (a UNION ALL may come back in Parallel Append order).
const COUNT_TABLES = [TABLE, 'source_evidence_classifications', 'revenue_source_evidence', 'audit_events', 'claims', 'claim_pricing_runs', 'claim_review_events', 'claim_freezes', 'claim_freeze_evidence_manifests', 'claim_freeze_lifecycle_events', 'claim_correction_links']

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

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[${TAG}] A7.3 adjudication evidence readiness & provenance gate — run ${runId}`)
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
  section('Preflight: accepted A7.2, the one A7.3 migration, Prisma, replay, permissions, routes, contracts and ownership')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a72Merge = mergeOf(a72Branch)
  const a71Merge = mergeOf(a71Branch)
  const a610Merge = mergeOf(a610Branch)
  const correctiveMerge = mergeOf(correctiveBranch)
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|settlement|receivable|claim-transport|claim-outbox|payer-response|integration\/a(8|9)|integration\/a7-(?!revenue-source-evidence|evidence-classification|evidence-gate)|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Start gate after A7.2',
    branch === a73Branch && a72Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a72Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A7.2 merged as ${a72Merge.slice(0, 7) || 'NOT FOUND'} and is an ancestor; contains latest main ${git('rev-parse --short origin/main')}; no A7.4+/A8/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Clean repository tree', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'A6.10, A7.1 and A7.2 ancestry',
    [a610Merge, correctiveMerge, a71Merge, a72Merge].every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)) && committedText('docs/A6_Phase_Closure.md').includes('A6 Claim Lifecycle — Phase Closure Record'),
    `A6.10 ${a610Merge.slice(0, 7)}, the A6 harness correction ${correctiveMerge.slice(0, 7)}, A7.1 ${a71Merge.slice(0, 7)} and A7.2 ${a72Merge.slice(0, 7)} are ancestors of HEAD; the A6 closure record is present`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma/migrations']).split(/\r?\n/).filter(Boolean)
  check(
    'T004',
    'Exactly one additive migration',
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
    /PASS {2}the A7\.3 tables are exactly evidence_gate_results/,
    /PASS {2}evidence_gate_results_insert_guard_trg is present after a clean replay/,
    /PASS {2}evidence_gate_results_append_only_trg is present after a clean replay/,
    /PASS {2}evidence_gate_results_no_truncate_trg is present after a clean replay/,
    /PASS {2}the A7\.3 CHECKs pin A7-ADJ-READINESS-1 and exactly the three readiness codes and reasons, with no positive verdict/,
    /PASS {2}one readiness result per classification and contract is unique/,
    /PASS {2}evidence_gate_results carries exactly its 11 A7\.3 columns/,
    /PASS {2}the A7\.2 tables are exactly source_evidence_classifications/,
    /PASS {2}the A7\.1 tables are exactly revenue_source_evidence/,
  ]
  check(
    'T006',
    'From-empty migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === headMigrationDirs.length && headMigrationDirs.some((dir) => MIGRATION.startsWith(`${dir}/`)),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — all ${headMigrationDirs.length} committed at HEAD, the A7.3 migration included; every A7.1, A7.2 and A7.3 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^adjudication/i.test(code)).sort()
  const invented = allCodes.filter((code) => /adjudicat|gate/i.test(code) && /(pay|remit|post|settle|denial|receivable|ledger|verif|send|transmit|submit|approve|import)/i.test(code))
  check(
    'T007',
    'Permission grants precisely scoped',
    same(family, ['adjudicationReadiness.create', 'adjudicationReadiness.read']) &&
      (await grantsOf('adjudicationReadiness.create')) === 'ORG_ADMIN' &&
      (await grantsOf('adjudicationReadiness.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('evidenceClassification.create')) === 'ORG_ADMIN' &&
      (await grantsOf('evidenceClassification.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('revenueEvidence.create')) === 'ORG_ADMIN' &&
      invented.length === 0,
    'adjudicationReadiness.create (Admin) and .read (Admin, Viewer) only; the A7.1 and A7.2 grants unchanged; no pay, settle, import, verify, approve or transmit permission',
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
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /evidence_gate_result|source_evidence_classification|revenue_source_evidence_[a-z]|claim_freeze/.test(text)
  }
  const markerOf = (message: string) =>
    (message.match(/[a-z_]+_(chk|fkey|key)\b/) ?? message.match(/evidence_gate_result_(time|linkage|coherence|conflict|derivation|fingerprint)|is append-only|null value/) ?? [message.includes('ROLLED_BACK') ? 'ACCEPTED' : '?'])[0]

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
  // B approves (separation of duties for A6.5) and records as a second actor; O and O2 are the two Admins of the
  // OTHER organization, who build its own frozen submission, source and classification.
  const B = await provisionAdmin('b')
  const O = await provisionAdmin('o', otherOrg)
  const O2 = await provisionAdmin('o2', otherOrg)

  const readinessPath = (classificationId: string) => `/api/revenue-evidence-classifications/${classificationId}/adjudication-readiness`
  const resultPath = (id: string) => `/api/adjudication-evidence-readiness/${id}`
  const gate = (classificationId: string, who: Who = asAdmin, body: unknown = {}) => post(readinessPath(classificationId), body, who)
  const historyOf = async (classificationId: string, who: Who = asAdmin) => (await get(readinessPath(classificationId), who)).body?.items ?? []
  const wiring = [await gate(MISSING), await get(readinessPath(MISSING)), await get(resultPath(MISSING))]
  const absent = [
    await api('PATCH', resultPath(MISSING), {}),
    await api('PUT', resultPath(MISSING), {}),
    await api('DELETE', resultPath(MISSING)),
    await api('DELETE', readinessPath(MISSING)),
    await api('PUT', readinessPath(MISSING), {}),
    await api('PATCH', readinessPath(MISSING), {}),
    await api('POST', '/api/adjudication-evidence-readiness', {}),
    await api('GET', '/api/adjudication-evidence-readiness'),
    await api('POST', `${resultPath(MISSING)}/verify`, {}),
    await api('POST', `${resultPath(MISSING)}/approve`, {}),
    await api('POST', `/api/revenue-evidence-classifications/${MISSING}/adjudications`, {}),
    await api('GET', `/api/claim-submissions/${MISSING}/adjudication-readiness`),
  ]
  const unauthenticated = [await gate(MISSING, anonymous), await get(readinessPath(MISSING), anonymous), await get(resultPath(MISSING), anonymous)]
  check(
    'T008',
    'Route registration, missing targets',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && absent.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `three routes answer a missing target with a privacy-safe 404; PATCH/PUT/DELETE, collection, verify, approve, adjudication and per-submission routes are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
  )
  const constantOf = (path: string, name: string) => (committedText(path).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-submission/claim-submission.types.ts', 'SUBMISSION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-evidence/claim-evidence.types.ts', 'EVIDENCE_MANIFEST_VERSION'),
    constantOf('backend/src/modules/claim-lifecycle/claim-lifecycle.types.ts', 'LIFECYCLE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-correction/claim-correction.types.ts', 'CORRECTION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/revenue-evidence/revenue-evidence.types.ts', 'REVENUE_SOURCE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/evidence-classification/evidence-classification.types.ts', 'CLASSIFICATION_CONTRACT_VERSION'),
  ]
  // The one owner file A7.3 may change: A7.3's RESTRICT key into source_evidence_classifications makes PostgreSQL
  // refuse a plain TRUNCATE before A7.2's guard runs (A7.2 T060), and A7.2 T105 read any later A7 suite's files as an
  // adjudication domain. Accepted only when every changed hunk lies inside those two blocks, on both sides of the diff.
  const blockOf = (text: string, startMarker: string, endMarker: string) => {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((line) => line.includes(startMarker))
    const end = lines.findIndex((line, index) => index > start && line.includes(endMarker))
    return start >= 0 && end > start ? { start: start + 1, end: end + 1 } : null
  }
  const a72Blocks = (text: string) => [blockOf(text, 'const truncateTrigger = ', 'database backstop and atomicity (T061–T070)'), blockOf(text, 'const later = [await post(', "check('T105'")]
  const a72HarnessDiff = gitArgs(['diff', '-U0', 'origin/main...HEAD', '--', `:/${A72_HARNESS}`])
  const a72Hunks = [...a72HarnessDiff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({ oldStart: Number(m[1]), oldCount: Number(m[2] ?? 1), newStart: Number(m[3]), newCount: Number(m[4] ?? 1) }))
  const oldBlocks = a72Blocks(gitArgs(['show', `origin/main:${A72_HARNESS}`]))
  const newBlocks = a72Blocks(committedText(A72_HARNESS))
  const insideBlocks = (start: number, count: number, blocks: ({ start: number; end: number } | null)[]) =>
    count === 0 || blocks.some((block) => block !== null && start >= block.start && start + count - 1 <= block.end)
  const a72HarnessOnlyFixes = a72Hunks.length > 0 && a72Hunks.every((hunk) => insideBlocks(hunk.oldStart, hunk.oldCount, oldBlocks) && insideBlocks(hunk.newStart, hunk.newCount, newBlocks))
  const ownerChanged = changedPaths.filter(
    (file) => !(file === A72_HARNESS && a72HarnessOnlyFixes) && (OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file)),
  )
  check(
    'T009',
    'Upstream ownership preserved',
    same(contracts, ['A6-CLAIM-1', 'A6-SUBMISSION-1', 'A6-EVIDENCE-1', 'A6-LIFECYCLE-1', 'A6-CORRECTION-1', SOURCE_CONTRACT, CLASS_CONTRACT]) && ownerChanged.length === 0,
    ownerChanged.length === 0
      ? `A6-CLAIM-1 … A6-CORRECTION-1, A7-REVENUE-SOURCE-1 and A7-EVIDENCE-CLASS-1 unchanged; no A5/A6/A7.1/A7.2 owner module or page changed${changedPaths.includes(A72_HARNESS) ? `; the A7.2 suite changed only inside its T060 and T105 blocks (${a72Hunks.length} hunk(s))` : ''}`
      : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: frozen submissions, a correction link, A7.1 sources and A7.2 classifications of two organizations')
  // One organization's synthetic world, built by its own Admin (`who`, actor `actorId`) with a separate approver,
  // then Claims with lawfully frozen submissions.
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
    const assess = async (claimId: string, pricingRunId: string) => {
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
      let assessment = await assess(claim.id, pricing.body.id)
      let approvalId = await approve(claim.id, assessment)
      freezes.push(await freezeNow(claim.id, assessment, approvalId))
      for (let i = 1; i < count; i += 1) {
        await revoke(claim.id, assessment, approvalId)
        assessment = await assess(claim.id, pricing.body.id)
        approvalId = await approve(claim.id, assessment)
        freezes.push(await freezeNow(claim.id, assessment, approvalId))
      }
      return { claimId: claim.id as string, freezes, lineIds }
    }
    return { series }
  }
  const home = await tenantWorld('home', org, asAdmin, creatorId, B.who)
  const away = await tenantWorld('away', otherOrg, O.who, O.id, O2.who)
  // §10 — S1 is a frozen submission and S2 its correction freeze (an A6.9 link); F is the other organization's.
  const W = await home.series('worked', 2)
  const F = await away.series('foreign', 1)
  const [S1, S2] = W.freezes
  const ref = (suffix: string) => `SYN-${runId.replace(/^A73-/, '')}-${suffix}`.toUpperCase()
  // A source registered through the A7.1 route and classified through the A7.2 route, by one organization's Admin.
  const classified = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const registered = await post(`/api/claim-submissions/${submissionId}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref(suffix) }, who)
    if (registered.status !== 201) throw new Error(`fixture source ${suffix} could not be registered through A7.1: ${registered.status} ${errorCode(registered.body) ?? ''}`)
    const sourceId = registered.body.revenueSourceEvidenceId as string
    const classification = await post(`/api/revenue-source-evidence/${sourceId}/classifications`, {}, who)
    if (classification.status !== 201) throw new Error(`fixture classification ${suffix} could not be recorded through A7.2: ${classification.status} ${errorCode(classification.body) ?? ''}`)
    return { sourceId, classificationId: classification.body.classificationId as string, classification: classification.body }
  }
  const linkWorked = await post(`/api/claims/${W.claimId}/correction-links`, { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'CORRECTED_CODING' })
  if (linkWorked.status !== 201) throw new Error(`fixture: the worked correction link was refused with ${linkWorked.status}`)
  const K1 = await classified(S1, 'E1')
  const K1b = await classified(S1, 'E1-SECOND')
  const K2 = await classified(S2, 'E2')
  const KF = await classified(F.freezes[0], 'FOREIGN', O.who)
  const [E1, C1] = [K1.sourceId, K1.classificationId]
  console.log(`[${TAG}]      fixtures ready: two synthetic AE-DU/DHA worlds, a frozen submission and its correction freeze, A7.1 sources and A7.2 classifications recorded through their owner routes`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const delta = (before: Record<string, number>, after: Record<string, number>) => Object.fromEntries(COUNT_TABLES.map((table) => [table, after[table] - before[table]])) as Record<string, number>
  const onlyRecorded = (d: Record<string, number>, rows = 1) => same(d, { ...Object.fromEntries(COUNT_TABLES.map((t) => [t, 0])), [TABLE]: rows, audit_events: rows })
  // Every stored byte of a set of rows, for "nothing changed" proofs.
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const runToken = runId.replace(/^A73-/, '')
  const freezeHash = (claimId: string) => hashOf(`SELECT f.*, m.id AS manifest_id, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = $1::uuid`, claimId)
  const lifecycleHash = (claimId: string) => hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = $1::uuid`, claimId)
  const correctionHash = (claimId: string) => hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = $1::uuid`, claimId)
  const sourceHash = () => hashOf(`SELECT r.* FROM revenue_source_evidence r WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const classificationHash = () => hashOf(`SELECT c.* FROM source_evidence_classifications c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const resultHash = () => hashOf(`SELECT g.* FROM ${TABLE} g`)
  const NOT_REFUSED = 'ROLLED_BACK'
  const refusedBy = (message: string, marker: RegExp) => message !== '' && !message.includes(NOT_REFUSED) && marker.test(message)
  const accepted = (message: string) => message.includes(NOT_REFUSED)
  const outcomeOf = (result: ReducerResult | undefined) => (result === undefined ? 'unread' : result.ok ? `${result.value.readinessCode}/${result.value.reasonCode}` : `refused ${result.refusal}`)

  // The readiness the A7.3 reducer derives for a classification, from the stored facts read on `db`.
  type Derived = { classificationId: string; sourceEvidenceId: string; organizationId: string; fingerprint: string; derived: ReducerResult; readiness: Readiness }
  const deriveFor = async (classificationId: string, db: DbClient = prisma): Promise<Derived> => {
    const located = await findClassificationForGate(classificationId, db)
    if (!located) throw new Error(`fixture: classification ${classificationId} not found`)
    const derived = deriveReadiness(located)
    return { classificationId, sourceEvidenceId: located.sourceEvidenceId, organizationId: located.organizationId, fingerprint: located.sourceFingerprintSha256, derived, readiness: derived.ok ? derived.value : NOT_READY }
  }
  // A direct INSERT of a readiness result inside a transaction that is always rolled back. `guardOff` switches the
  // row triggers off (session_replication_role = replica) so a refusal can only come from a CHECK or NOT NULL.
  type Direct = { organization?: string; source?: string; classification?: string; contract?: string | null; readiness?: string | null; reason?: string | null; fingerprint?: string | null; actor?: string; recordedAt?: boolean; createdAt?: boolean; guardOff?: boolean }
  const directInsert = (d: Derived, v: Direct = {}) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        if (v.guardOff) await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, organization_id, source_evidence_id, classification_id, contract_version, readiness_code, reason_code, classification_fingerprint_sha256, recorded_by_user_id${v.recordedAt ? ', recorded_at' : ''}${v.createdAt ? ', created_at' : ''})
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid${v.recordedAt ? ", now() - interval '1 day'" : ''}${v.createdAt ? ", now() + interval '1 hour'" : ''})`,
          v.organization ?? d.organizationId,
          v.source ?? d.sourceEvidenceId,
          v.classification ?? d.classificationId,
          'contract' in v ? v.contract : CONTRACT,
          'readiness' in v ? v.readiness : d.readiness.readinessCode,
          'reason' in v ? v.reason : d.readiness.reasonCode,
          'fingerprint' in v ? v.fingerprint : d.fingerprint,
          v.actor ?? creatorId,
        )
        throw new Error(NOT_REFUSED)
      }),
    )
  // A classification that A7.2 cannot record today (A7.1's CHECKs admit INTERNAL_SYNTHETIC, the fixed contract, an
  // opaque reference and no digest only), built inside a transaction that is ALWAYS rolled back after relaxing those
  // four A7.1 CHECKs: the A7.1 row, then the A7.2 row exactly as the A7.2 owner derives it (its guard accepts it),
  // then the A7.3 result the reducer derives from the stored classification — which the A7.3 guard is asked to accept.
  type Relaxed = { kind: string; reference: string; version: string; digest?: string | null }
  const relaxedGate = async (source: Relaxed, recordAs: 'derived' | Readiness) => {
    const out: { derived?: ReducerResult; classified?: string } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE revenue_source_evidence DROP CONSTRAINT revenue_source_evidence_kind_chk, DROP CONSTRAINT revenue_source_evidence_reference_chk, DROP CONSTRAINT revenue_source_evidence_version_chk, DROP CONSTRAINT revenue_source_evidence_digest_chk',
          )
          const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO revenue_source_evidence (id, organization_id, claim_submission_id, source_kind, source_reference, source_version, source_digest_sha256, recorded_by_user_id)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid) RETURNING id::text AS id`,
            org, S1, source.kind, source.reference, source.version, source.digest ?? null, creatorId,
          )
          const located = await findSourceForClassification(row.id, tx)
          if (!located) throw new Error('relaxed source not readable')
          const classifiedNow = classifySource(located.facts)
          if (!classifiedNow.ok) throw new Error('UNCLASSIFIABLE')
          out.classified = `${classifiedNow.value.classificationCode}/${classifiedNow.value.normalizationOutcome}`
          const classification = await insertClassification(
            { organizationId: org, sourceEvidenceId: row.id, contractVersion: CLASS_CONTRACT, ...classifiedNow.value, sourceFingerprintSha256: sourceFingerprintSha256(located.facts), recordedByUserId: creatorId },
            tx,
          )
          const d = await deriveFor(classification.id, tx)
          out.derived = d.derived
          const value = recordAs === 'derived' ? d.readiness : recordAs
          await insertReadiness({ organizationId: org, sourceEvidenceId: row.id, classificationId: classification.id, contractVersion: CONTRACT, ...value, classificationFingerprintSha256: d.fingerprint, recordedByUserId: creatorId }, tx)
          throw new Error(NOT_REFUSED)
        },
        { maxWait: 10_000, timeout: 30_000 },
      ),
    )
    return { ...out, message }
  }
  // A classification no guard admits (an impossible combination of individually controlled codes), forged with the
  // row triggers off in a transaction that is ALWAYS rolled back; the triggers are switched back on before A7.3 is
  // asked to record a result for it.
  const forgedClassificationGate = async (sourceId: string, codes: [string, string, string]) => {
    const out: { derived?: ReducerResult } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        const located = await findSourceForClassification(sourceId, tx)
        if (!located) throw new Error('forged source not readable')
        const fingerprint = sourceFingerprintSha256(located.facts)
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
          `INSERT INTO source_evidence_classifications (id, organization_id, source_evidence_id, contract_version, classification_code, normalization_outcome, reason_code, source_fingerprint_sha256, recorded_by_user_id)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid) RETURNING id::text AS id`,
          org, sourceId, CLASS_CONTRACT, codes[0], codes[1], codes[2], fingerprint, creatorId,
        )
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
        const d = await deriveFor(row.id, tx)
        out.derived = d.derived
        await insertReadiness({ organizationId: org, sourceEvidenceId: sourceId, classificationId: row.id, contractVersion: CONTRACT, ...NOT_READY, classificationFingerprintSha256: fingerprint, recordedByUserId: creatorId }, tx)
        throw new Error(NOT_REFUSED)
      }),
    )
    return { ...out, message }
  }

  // ---------------------------------------------------------------- strict request (T011–T020)
  section('Strict request: contract, empty body, unknown fields, UUIDs, session, roles, tenants, actor and organization')
  const countsAtStart = await counts()
  check(
    'T011',
    'Versioned readiness contract',
    constantOf(`${MODULE_DIR}/evidence-gate.types.ts`, 'READINESS_CONTRACT_VERSION') === CONTRACT && /"contract_version" = 'A7-ADJ-READINESS-1'/.test(readFileSync(`../${MIGRATION}`, 'utf8')),
    'A7-ADJ-READINESS-1 is the literal contract in code and in the database CHECK (and on every row and DTO, T021)',
  )
  const nonObject = [await post(readinessPath(C1), []), await post(readinessPath(C1), [NOT_READY])]
  check('T012', 'Empty request only', nonObject.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR'), 'the body must be absent or {}: an array body is refused (400); every readiness value is derived by the server')
  const unknownFields = [await gate(C1, asAdmin, { extra: 1 }), await gate(C1, asAdmin, { format: 'X12' }), await gate(C1, asAdmin, JSON.parse('{"__proto__": {"readinessCode": "READY"}}'))]
  check('T013', 'Unknown body fields rejected', unknownFields.every((res) => res.status === 400 && /unknown field/.test(res.body?.error?.message ?? '')), 'an unknown field (including a parsed __proto__ key) is refused by name: 400')
  const malformed = [
    await post('/api/revenue-evidence-classifications/not-a-uuid/adjudication-readiness', {}),
    await get('/api/revenue-evidence-classifications/1234/adjudication-readiness'),
    await get('/api/adjudication-evidence-readiness/not-a-uuid'),
    await get(`/api/adjudication-evidence-readiness/${MISSING.slice(0, 35)}`),
    await post(`/api/revenue-evidence-classifications/${encodeURIComponent("1' OR '1'='1")}/adjudication-readiness`, {}),
  ]
  check('T014', 'Malformed UUIDs rejected', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `malformed and injected path ids: ${malformed.map((r) => r.status).join('/')}; no raw database text`)
  const anon = [await gate(C1, anonymous), await get(readinessPath(C1), anonymous), await get(resultPath(MISSING), anonymous)]
  check('T015', 'Unauthenticated denied 401', anon.every((res) => res.status === 401), 'every A7.3 route requires a session: 401 without one')
  const viewerPost = await gate(C1, asViewer)
  check('T016', 'Viewer cannot record', viewerPost.status === 403 && errorCode(viewerPost.body) === 'FORBIDDEN', 'a Viewer is refused the readiness record: 403')
  const viewerList = await get(readinessPath(C1), asViewer)
  check('T017', 'Viewer may read', viewerList.status === 200 && Array.isArray(viewerList.body?.items), "a Viewer reads the classification's readiness history (200); the single read is shown in T090")
  const foreignOnHome = [await gate(C1, O.who), await get(readinessPath(C1), O.who)]
  const foreignMissing = await get(readinessPath(MISSING), O.who)
  const homeOnForeign = [await gate(KF.classificationId), await get(readinessPath(KF.classificationId))]
  check(
    'T018',
    'Foreign tenant refuses 404',
    foreignOnHome.every((res) => res.status === 404 && same(res.body?.error?.message, foreignMissing.body?.error?.message)) && homeOnForeign.every((res) => res.status === 404),
    "the other organization's Admin gets 404 for this tenant's classification — exactly like a missing one — and this tenant's Admin gets 404 for the other one's",
  )
  const missingClassification = [await gate(MISSING), await get(readinessPath(MISSING))]
  check('T019', 'Missing classification 404', missingClassification.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND'), 'a non-existent classification: 404')
  const spoofs = await Promise.all([{ recordedByUserId: B.id }, { actorUserId: B.id }, { organizationId: otherOrg }, { classificationId: K2.classificationId }, { sourceEvidenceId: K2.sourceId }, { recordedAt: '2020-01-01T00:00:00Z' }, { id: MISSING }].map((body) => gate(C1, asAdmin, body)))
  check('T020', 'Actor and tenant spoofing refused', spoofs.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')), 'actor, organization, classification, source, instant and id in the body are refused by name: 400 (the session actor is named in T021)')
  const refusalsLeftNothing = await unchanged(countsAtStart)

  // ---------------------------------------------------------------- exact binding (T021–T030)
  section('Exact A7.2 binding: derived synthetic NOT_READY, audit, database time, copied fingerprint, no source alteration')
  const sourcesBefore = await sourceHash()
  const classificationsBefore = await classificationHash()
  const a72ReadBefore = (await get(`/api/revenue-evidence-classifications/${C1}`)).body
  const before21 = await counts()
  const R1 = await gate(C1)
  const after21 = await counts()
  const dC1 = await deriveFor(C1)
  check(
    'T021',
    'Synthetic classification is NOT_READY',
    R1.status === 201 && same(Object.keys(R1.body ?? {}), DTO_KEYS) && R1.body.readinessCode === NOT_READY.readinessCode && R1.body.reasonCode === NOT_READY.reasonCode && R1.body.contractVersion === CONTRACT &&
      R1.body.recordedByUserId === creatorId && R1.body.classificationId === C1 && R1.body.sourceEvidenceId === E1 && onlyRecorded(delta(before21, after21)),
    '201: NOT_READY_FOR_ADJUDICATION / EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT under A7-ADJ-READINESS-1, by the session Admin, for exactly C1/E1; one result and one audit; the DTO carries exactly its eight fields',
  )
  const forgedBodies = await Promise.all([{ readinessCode: 'READY_FOR_ADJUDICATION' }, { readinessCode: 'NOT_READY_FOR_ADJUDICATION' }, { reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' }, { contractVersion: CONTRACT }, { adjudicated: true }, { ready: true }].map((body) => gate(K1b.classificationId, asAdmin, body)))
  check(
    'T022',
    'Server-derived, not client-chosen',
    forgedBodies.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')) && dC1.derived.ok && same(dC1.readiness, NOT_READY) && same([R1.body.readinessCode, R1.body.reasonCode], [dC1.readiness.readinessCode, dC1.readiness.reasonCode]),
    'a supplied readiness, reason, contract or verdict is refused (400) even when it names the correct value; the stored values are exactly the reducer\'s on the stored classification',
  )
  const rowR1 = await prisma.evidenceGateResult.findUniqueOrThrow({ where: { id: R1.body.readinessId } })
  const rowC1 = await prisma.sourceEvidenceClassification.findUniqueOrThrow({ where: { id: C1 } })
  check(
    'T023',
    'Exact A7.2 binding and fingerprint',
    rowR1.classificationId === C1 && rowR1.sourceEvidenceId === rowC1.sourceEvidenceId && rowR1.organizationId === rowC1.organizationId && rowC1.organizationId === org && rowR1.classificationFingerprintSha256 === rowC1.sourceFingerprintSha256,
    "the row names exactly C1, the source C1 belongs to and their organization; the fingerprint is C1's stored fingerprint, copied (never recomputed by A7.3)",
  )
  const auditR1 = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: rowR1.id } })
  check(
    'T024',
    'One metadata-only audit',
    auditR1.actionCode === 'adjudication_readiness.recorded' && auditR1.entityType === 'ADJUDICATION_READINESS' && auditR1.actorUserId === creatorId && auditR1.organizationId === org &&
      same(Object.keys(auditR1.afterState as object).sort(), [...AUDIT_KEYS].sort()) && auditR1.beforeState === null,
    'adjudication_readiness.recorded on ADJUDICATION_READINESS, naming the actor and organization, with exactly ids, codes, contract and time',
  )
  const timeRow = await prisma.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT recorded_at = created_at AND recorded_at <= now() AS ok FROM ${TABLE} WHERE id = $1::uuid`, rowR1.id)
  check('T025', 'Database time', timeRow[0]?.ok === true && R1.body.recordedAt === rowR1.recordedAt.toISOString() && (auditR1.afterState as any)?.recordedAt === rowR1.recordedAt.toISOString(), "recorded and created at the database's own transaction time; the DTO and audit carry that instant")
  check(
    'T026',
    'No source or classification altered',
    (await sourceHash()) === sourcesBefore && (await classificationHash()) === classificationsBefore && same((await get(`/api/revenue-evidence-classifications/${C1}`)).body, a72ReadBefore) && delta(before21, after21).source_evidence_classifications === 0,
    "every byte of this run's A7.1 sources and A7.2 classifications, and the A7.2 read, are identical after the readiness record",
  )
  const R1b = await gate(K1b.classificationId, B.who)
  const R2 = await gate(K2.classificationId)
  check(
    'T027',
    'Distinct classifications stay distinct',
    R1b.status === 201 && R2.status === 201 && new Set([R1.body.readinessId, R1b.body.readinessId, R2.body.readinessId]).size === 3 && R1b.body.recordedByUserId === B.id && R2.body.classificationId === K2.classificationId,
    "a second classification on S1 (recorded by the second Admin, who is named) and the correction freeze's classification each get their own result",
  )
  const readR1 = await get(resultPath(R1.body.readinessId))
  check('T028', 'Exact readback', readR1.status === 200 && same(readR1.body, R1.body) && same(await historyOf(C1), [R1.body]), 'the single read and the history are exactly the create response')
  const positive = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${TABLE} WHERE readiness_code <> 'NOT_READY_FOR_ADJUDICATION'`))[0].n)
  check('T029', 'No external readiness from synthetic', positive === 0 && R1.body.readinessCode === 'NOT_READY_FOR_ADJUDICATION', 'every result in the database is NOT_READY_FOR_ADJUDICATION: synthetic evidence never establishes payer-adjudication readiness')
  const dU = await deriveFor((await classified(S1, 'DIRECT')).classificationId)
  const caseSql = [await directInsert(dU, { readiness: 'not_ready_for_adjudication', guardOff: true }), await directInsert(dU, { reason: 'External_Adjudication_Evidence_Absent', guardOff: true }), await directInsert(dU, { contract: 'a7-adj-readiness-1', guardOff: true })]
  check('T030', 'Case-sensitive controlled vocabulary', caseSql.every((message) => refusedBy(message, /_chk/)), `lower- or mixed-case readiness, reason and contract are refused by their CHECKs even with the guard switched off (${caseSql.map(markerOf).join(', ')})`)

  // ---------------------------------------------------------------- review, unsupported, invalid context (T031–T040)
  section('NEEDS_REVIEW and UNSUPPORTED (always rolled back), impossible and unlinked context, correction-chain independence, no latest')
  // A source registered through A7.1 but deliberately left unclassified: the rolled-back forgery in T034 gives it the
  // only classification it will ever have.
  const unclassified = await post(`/api/claim-submissions/${S1}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref('FORGED-COMBO') })
  if (unclassified.status !== 201) throw new Error(`fixture: the unclassified source was refused with ${unclassified.status}`)
  const countsBefore31 = await counts()
  const a71ConstraintsBefore = await hashOf(`SELECT c.oid::text AS id, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'revenue_source_evidence'::regclass`)
  const review = await relaxedGate({ kind: 'EXTERNAL_DECLARED', reference: ref('DECLARED'), version: SOURCE_CONTRACT }, 'derived')
  const reviewForged = await relaxedGate({ kind: 'EXTERNAL_DECLARED', reference: ref('DECLARED'), version: SOURCE_CONTRACT }, NOT_READY)
  check(
    'T031',
    'NEEDS_REVIEW requires review',
    review.classified === 'EXTERNAL_SOURCE_UNVERIFIED/NEEDS_REVIEW' && outcomeOf(review.derived) === 'SOURCE_REQUIRES_REVIEW/CLASSIFICATION_REVIEW_REQUIRED' && accepted(review.message) && refusedBy(reviewForged.message, /evidence_gate_result_derivation/),
    `a declared external source that A7.2 records as ${review.classified ?? '?'} derives ${outcomeOf(review.derived)}, which the database accepts; a NOT_READY claim of it is refused`,
  )
  const unsupported = await relaxedGate({ kind: 'PAYER_PORTAL', reference: ref('PORTAL'), version: SOURCE_CONTRACT }, 'derived')
  const unsupportedContract = await relaxedGate({ kind: SYNTHETIC, reference: ref('NEXTCONTRACT'), version: 'A7-REVENUE-SOURCE-2' }, 'derived')
  const unsupportedForged = await relaxedGate({ kind: 'PAYER_PORTAL', reference: ref('PORTAL'), version: SOURCE_CONTRACT }, REVIEW)
  check(
    'T032',
    'UNSUPPORTED is SOURCE_UNSUPPORTED',
    [unsupported, unsupportedContract].every((r) => r.classified === 'UNSUPPORTED_SOURCE/UNSUPPORTED' && outcomeOf(r.derived) === 'SOURCE_UNSUPPORTED/CLASSIFICATION_UNSUPPORTED' && accepted(r.message)) && refusedBy(unsupportedForged.message, /evidence_gate_result_derivation/),
    'an unsupported kind and an unsupported A7.1 contract (A7.2 UNSUPPORTED) both derive SOURCE_UNSUPPORTED/CLASSIFICATION_UNSUPPORTED; a review claim of them is refused',
  )
  const missingContext = await relaxedGate({ kind: SYNTHETIC, reference: '', version: SOURCE_CONTRACT }, 'derived')
  const contradictory = await relaxedGate({ kind: SYNTHETIC, reference: ref('DIGEST'), version: SOURCE_CONTRACT, digest: 'a'.repeat(64) }, 'derived')
  check(
    'T033',
    'Missing or contradictory context reviewed',
    [missingContext, contradictory].every((r) => r.classified === 'INSUFFICIENT_CONTEXT/NEEDS_REVIEW' && outcomeOf(r.derived) === 'SOURCE_REQUIRES_REVIEW/CLASSIFICATION_REVIEW_REQUIRED' && accepted(r.message)),
    'a source missing its reference and one carrying an untrusted digest (A7.2 INSUFFICIENT_CONTEXT) both derive SOURCE_REQUIRES_REVIEW, never NOT_READY or a guessed result',
  )
  const forgedCombo = await forgedClassificationGate(unclassified.body.revenueSourceEvidenceId as string, ['INSUFFICIENT_CONTEXT', 'CLASSIFIED', 'SOURCE_CONTEXT_MISSING'])
  const serviceCode = committedCode(`${MODULE_DIR}/evidence-gate.service.ts`)
  check(
    'T034',
    'Impossible classification fails closed',
    outcomeOf(forgedCombo.derived) === 'refused PROVENANCE_CONFLICT' && refusedBy(forgedCombo.message, /evidence_gate_result_conflict/) &&
      /if \(!derived\.ok\) return refuse\('ADJUDICATION_READINESS_PROVENANCE_CONFLICT'/.test(serviceCode),
    'a classification forged as an impossible combination (rolled back) is a provenance conflict for the reducer (the service answers 409 and records nothing) and the database refuses any result for it',
  )
  const unlinked = [await directInsert(dC1, { source: K1b.sourceId }), await directInsert(dC1, { classification: K2.classificationId })]
  check(
    'T035',
    'Unlinked context refused',
    refusedBy(unlinked[0], /evidence_gate_result_linkage/) && refusedBy(unlinked[1], /evidence_gate_result_linkage|evidence_gate_result_fingerprint/) &&
      /located\.sourceId === located\.sourceEvidenceId/.test(serviceCode) && /getClassificationsOf\(located\.sourceEvidenceId, tx\)/.test(serviceCode),
    `a result naming C1 with another source, or another classification with C1's source and fingerprint, is refused (${unlinked.map(markerOf).join(', ')}); the service confirms the linkage through both owners before deriving`,
  )
  const relaxedLeftNothing = (await hashOf(`SELECT c.oid::text AS id, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'revenue_source_evidence'::regclass`)) === a71ConstraintsBefore && (await unchanged(countsBefore31))
  const chainBefore = await correctionHash(W.claimId)
  check(
    'T036',
    'Correction chain independence',
    linkWorked.status === 201 && R2.status === 201 && R2.body.readinessCode === R1.body.readinessCode && same((await get(resultPath(R1.body.readinessId))).body, R1.body) && (await correctionHash(W.claimId)) === chainBefore && relaxedLeftNothing,
    'the correction freeze S2 (an A6.9 link from S1) took its own result R2 while R1 is byte-identical; the link is unchanged; every rolled-back relaxation left the A7.1 constraints and all rows intact',
  )
  const latestRoutes = [await get(`/api/claim-submissions/${S1}/adjudication-readiness`), await get(`/api/revenue-source-evidence/${E1}/adjudication-readiness`), await gate(E1), await gate(S1)]
  const resultColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${TABLE}`).map((row) => row.c)
  check(
    'T037',
    'No latest selection',
    latestRoutes.every((res) => res.status === 404) && !resultColumns.some((c) => /current|latest|newest|superseded|claim_submission/.test(c)) && same((await historyOf(C1)).map((i: any) => i.readinessId), [R1.body.readinessId]),
    'a result names one exact classification from the path; a submission or source id is not a classification (404), there is no "latest" route or column, and R2 did not touch C1\'s history',
  )
  const Re = await home.series('release eligible', 1)
  const KRe = await classified(Re.freezes[0], 'RELEASED')
  await post(`/api/claim-submissions/${Re.freezes[0]}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null })
  const reFreezeBefore = await freezeHash(Re.claimId)
  const reLifecycleBefore = await lifecycleHash(Re.claimId)
  const onReleased = await gate(KRe.classificationId)
  check(
    'T038',
    'Internal release is not adjudication',
    onReleased.status === 201 && onReleased.body.readinessCode === 'NOT_READY_FOR_ADJUDICATION' && (await get(`/api/claim-submissions/${Re.freezes[0]}/lifecycle`)).body?.state === 'RELEASE_ELIGIBLE' && (await freezeHash(Re.claimId)) === reFreezeBefore && (await lifecycleHash(Re.claimId)) === reLifecycleBefore,
    'evidence on a RELEASE_ELIGIBLE freeze is still NOT_READY_FOR_ADJUDICATION — internal release is never payer adjudication — and the freeze and lifecycle are byte-identical',
  )
  const Wd = await home.series('withdrawn', 1)
  const KWd = await classified(Wd.freezes[0], 'WITHDRAWN')
  await post(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle-events`, { eventCode: 'WITHDRAW_INTERNAL', reasonCode: 'INTERNAL_OTHER' })
  const onWithdrawn = await gate(KWd.classificationId)
  check(
    'T039',
    'Disposition neither gates nor changes',
    onWithdrawn.status === 201 && onWithdrawn.body.readinessCode === 'NOT_READY_FOR_ADJUDICATION' && (await get(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle`)).body?.state === 'WITHDRAWN_INTERNAL',
    "a WITHDRAWN_INTERNAL disposition is the A6.8 owner's: the readiness record neither depends on it nor changes it",
  )
  const nextContract = await directInsert(dU, { contract: 'A7-ADJ-READINESS-2', guardOff: true })
  check('T040', 'A later contract is separate', refusedBy(nextContract, /evidence_gate_results_contract_chk/) && /evidence_gate_results_identity_key ON public\.evidence_gate_results USING btree \(classification_id, contract_version\)/.test((await prisma.$queryRaw<{ def: string }[]>`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'evidence_gate_results_identity_key'`)[0]?.def ?? ''), 'a second contract version is refused until a later owner admits it; identity is (classification, contract), so a revision would be its own row, never a rewrite')

  // ---------------------------------------------------------------- idempotency (T041–T050)
  section('Replay, duplicate SQL, concurrent identical and conflicting requests, unchanged originals')
  const before41 = await counts()
  const replay1 = await gate(C1)
  const replayNoBody = await api('POST', readinessPath(C1), undefined)
  const replayByB = await gate(C1, B.who)
  check('T041', 'Same request replays 200', [replay1, replayNoBody, replayByB].every((res) => res.status === 200 && same(res.body, R1.body)) && replayByB.body.recordedByUserId === creatorId, 'the same request (with {}, with no body, and by another Admin): 200 with exactly R1 and its original actor')
  const d41 = delta(before41, await counts())
  check('T042', 'Replay writes zero rows', d41[TABLE] === 0 && d41.source_evidence_classifications === 0 && d41.revenue_source_evidence === 0, 'three replays wrote no result, classification or source')
  check('T043', 'Replay writes zero audits', d41.audit_events === 0 && (await prisma.auditEvent.count({ where: { entityId: R1.body.readinessId } })) === 1, 'three replays wrote no audit; R1 still has exactly one')
  const replaysLeftNothing = await unchanged(before41)
  // A recorded result that disagrees with its derivation cannot be written through any guard, so it is forged in a
  // transaction that is ALWAYS rolled back (row triggers off) and judged by the production replay decision.
  const dQ = await deriveFor((await classified(S2, 'FORGED-RESULT')).classificationId)
  const forgedRecord = async (change: { readiness?: Readiness; fingerprint?: string }) => {
    const out: { agrees?: boolean } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        const value = change.readiness ?? dQ.readiness
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, organization_id, source_evidence_id, classification_id, contract_version, readiness_code, reason_code, classification_fingerprint_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid)`,
          dQ.organizationId, dQ.sourceEvidenceId, dQ.classificationId, CONTRACT, value.readinessCode, value.reasonCode, change.fingerprint ?? dQ.fingerprint, creatorId,
        )
        const recorded = await findReadinessByIdentity(dQ.classificationId, CONTRACT, tx)
        const now = await deriveFor(dQ.classificationId, tx)
        if (recorded) out.agrees = recordedReadinessAgrees(recorded, { ...now.readiness, classificationFingerprintSha256: now.fingerprint, sourceEvidenceId: now.sourceEvidenceId, organizationId: now.organizationId })
        throw new Error(NOT_REFUSED)
      }),
    )
    return { ...out, message }
  }
  const routeCode = committedCode(`${MODULE_DIR}/evidence-gate.route.ts`)
  const conflictWired =
    /if \(!recordedReadinessAgrees\(existing, expected\)\)\s*return refuse\('ADJUDICATION_READINESS_PROVENANCE_CONFLICT'/.test(serviceCode) && /code === 'NOT_FOUND' \? 404 : code === 'VALIDATION_ERROR' \? 400 : 409/.test(routeCode)
  const agreeing = await forgedRecord({})
  const disagreeing = [await forgedRecord({ readiness: UNSUPPORTED }), await forgedRecord({ fingerprint: 'f'.repeat(64) })]
  check(
    'T044',
    'Recorded disagreement is 409',
    accepted(agreeing.message) && agreeing.agrees === true && disagreeing.every((r) => accepted(r.message) && r.agrees === false) && conflictWired,
    'a recorded result with another readiness or fingerprint (forged, rolled back) is a disagreement for the production decision, which the service answers as a 409 and never rewrites; the matching control row agrees',
  )
  const duplicateSql = await directInsert(dC1)
  check('T045', 'Duplicate direct SQL refused', refusedBy(duplicateSql, /evidence_gate_results_identity_key|duplicate key/), `a second, otherwise valid result for C1 inserted directly is refused by the unique identity (${markerOf(duplicateSql)})`)
  const K46 = await classified(S1, 'RACE-2')
  const before46 = await counts()
  const pair = await Promise.all([gate(K46.classificationId), gate(K46.classificationId)])
  const d46 = delta(before46, await counts())
  check('T046', 'Concurrent identical, one row', same(pair.map((r) => r.status).sort(), [200, 201]) && same(pair[0].body, pair[1].body) && d46[TABLE] === 1 && d46.audit_events === 1, `${pair.map((r) => r.status).sort().join('/')}: one result, one audit, one identical body`)
  const K47 = await classified(S1, 'RACE-6')
  const before47 = await counts()
  const six = await Promise.all([gate(K47.classificationId), gate(K47.classificationId), gate(K47.classificationId, B.who), gate(K47.classificationId), gate(K47.classificationId, asAdmin, { readinessCode: 'READY_FOR_ADJUDICATION' }), gate(K47.classificationId, B.who, { reasonCode: 'X' })])
  const d47 = delta(before47, await counts())
  const valid47 = six.slice(0, 4)
  const created47 = valid47.find((r) => r.status === 201)
  check(
    'T047',
    'Concurrent conflicting deterministic',
    valid47.filter((r) => r.status === 201).length === 1 && valid47.filter((r) => r.status === 200).length === 3 && valid47.every((r) => same(r.body, created47?.body)) && six.slice(4).every((r) => r.status === 400) && d47[TABLE] === 1 && d47.audit_events === 1,
    `six at once (two actors, two forged bodies): ${six.map((r) => (r.status >= 300 ? `${r.status} ${errorCode(r.body) ?? ''}`.trim() : r.status)).join('/')}; ${d47[TABLE]} result and ${d47.audit_events} audit, every success the same record`,
  )
  const r1Hash = () => hashOf(`SELECT g.* FROM ${TABLE} g WHERE g.id = $1::uuid`, R1.body.readinessId)
  const r1Before = await r1Hash()
  const rewrites = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET readiness_code = 'SOURCE_UNSUPPORTED', reason_code = 'CLASSIFICATION_UNSUPPORTED' WHERE id = $1::uuid`, R1.body.readinessId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, R1.body.readinessId)),
  ]
  check('T048', 'Originals unchanged', rewrites.every((message) => /is append-only/.test(message)) && (await r1Hash()) === r1Before, 'a rewrite and a delete of R1 are refused and R1 is byte-identical')
  const twice = [await historyOf(C1), await historyOf(C1)]
  const viewerTwice = await historyOf(C1, asViewer)
  const inTx = await withReadSnapshot(undefined, (tx) => getReadinessOf(C1, tx))
  check('T049', 'Read-after-commit stable', same(twice[0], twice[1]) && same(viewerTwice, twice[0]) && same(twice[0], [R1.body]) && inTx.ok && same(inTx.value.items, twice[0]), 'the committed history reads identically twice, for a Viewer, and through getReadinessOf(classificationId, tx) for later owners')
  const classificationReplay = await post(`/api/revenue-source-evidence/${E1}/classifications`, {})
  const afterUpstreamReplay = await gate(C1)
  check('T050', 'Upstream replay changes nothing', classificationReplay.status === 200 && afterUpstreamReplay.status === 200 && same(afterUpstreamReplay.body, R1.body), 'an A7.2 replay of C1 leaves C1 as it was, and the readiness request still replays exactly R1')

  // ---------------------------------------------------------------- direct SQL (T051–T060)
  section('Direct SQL: RESTRICT keys, CHECKs with the guard off and NULL pitfalls, pairing, coherence, linkage, identity, time, immutability')
  const fkRows = await prisma.$queryRaw<{ name: string; del: string }[]>`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = ${TABLE}`
  const removeClassification = await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE source_evidence_classifications DISABLE TRIGGER source_evidence_classifications_append_only_trg')
      await tx.$executeRawUnsafe('DELETE FROM source_evidence_classifications WHERE id = $1::uuid', C1)
      throw new Error(NOT_REFUSED)
    }),
  )
  check(
    'T051',
    'Foreign keys RESTRICT',
    fkRows.length === 4 && fkRows.every((row) => row.del === 'r') && refusedBy(removeClassification, /evidence_gate_results_classification_id_fkey|foreign key/),
    'organization, source, classification and actor keys are all ON DELETE RESTRICT; even with the A7.2 guard switched off (rolled back) a classification with a result cannot be deleted',
  )
  const nullSql = [await directInsert(dU, { readiness: null, guardOff: true }), await directInsert(dU, { reason: null, guardOff: true }), await directInsert(dU, { contract: null, guardOff: true }), await directInsert(dU, { fingerprint: null, guardOff: true })]
  const vocabSql = [await directInsert(dU, { readiness: 'READY_FOR_ADJUDICATION', guardOff: true }), await directInsert(dU, { readiness: 'CONFLICT', guardOff: true }), await directInsert(dU, { reason: 'PROVENANCE_CONFLICT', guardOff: true }), await directInsert(dU, { readiness: 'ADJUDICATED', guardOff: true })]
  const readinessDef = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'evidence_gate_results_readiness_chk'`)[0]?.def ?? ''
  const reasonDef = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'evidence_gate_results_reason_chk'`)[0]?.def ?? ''
  check(
    'T052',
    'Vocabulary CHECKs including NULL',
    // PostgreSQL evaluates CHECKs in name order, so the pairing CHECK (which also admits only the controlled codes)
    // may answer before the vocabulary CHECK does; both vocabulary definitions are verified directly.
    nullSql.every((m) => refusedBy(m, /null value/)) && vocabSql.every((m) => refusedBy(m, /evidence_gate_results_(readiness|reason|pairing)_chk/)) &&
      /readiness_code IS NOT NULL/.test(readinessDef) && !/'(READY_FOR_ADJUDICATION|CONFLICT|ADJUDICATED)'/.test(readinessDef.replace(/NOT_READY_FOR_ADJUDICATION/g, '')) &&
      /reason_code IS NOT NULL/.test(reasonDef) && !reasonDef.includes('PROVENANCE_CONFLICT'),
    `NULL readiness, reason, contract and fingerprint are refused (NOT NULL, and the CHECKs' own IS NOT NULL); READY, CONFLICT, PROVENANCE_CONFLICT and ADJUDICATED are not storable (${vocabSql.map(markerOf).join(', ')})`,
  )
  const pairingSql = [await directInsert(dU, { readiness: 'NOT_READY_FOR_ADJUDICATION', reason: 'CLASSIFICATION_UNSUPPORTED', guardOff: true }), await directInsert(dU, { readiness: 'SOURCE_UNSUPPORTED', reason: 'CLASSIFICATION_REVIEW_REQUIRED', guardOff: true })]
  check('T053', 'Readiness and reason pairing', pairingSql.every((m) => refusedBy(m, /evidence_gate_results_pairing_chk/)), 'a readiness with another readiness\'s reason is refused by the pairing CHECK even with the guard off')
  const badFingerprints = [await directInsert(dU, { fingerprint: 'XYZ', guardOff: true }), await directInsert(dU, { fingerprint: 'A'.repeat(64), guardOff: true }), await directInsert(dU, { fingerprint: 'a'.repeat(63), guardOff: true })]
  check('T054', 'Fingerprint shape CHECK', badFingerprints.every((m) => refusedBy(m, /evidence_gate_results_fingerprint_chk/)), `non-hex, upper-case and short fingerprints are refused (${badFingerprints.map(markerOf).join(', ')})`)
  const dF = await deriveFor(KF.classificationId)
  const coherenceSql = [await directInsert(dC1, { organization: otherOrg }), await directInsert(dF, { organization: org })]
  check('T055', 'Organization coherence', coherenceSql.every((m) => refusedBy(m, /evidence_gate_result_coherence/)), "a result naming another organization than its classification's, or this organization on the other one's classification, is refused")
  check('T056', 'Source linkage', refusedBy(unlinked[0], /evidence_gate_result_linkage/), "a result whose source is not the one its classification belongs to is refused (T035)")
  check('T057', 'Unique identity', refusedBy(duplicateSql, /identity_key|duplicate key/), 'UNIQUE (classification_id, contract_version): one result per classification and contract (T040, T045)')
  const timeSql = [await directInsert(dU, { recordedAt: true }), await directInsert(dU, { createdAt: true })]
  check('T058', 'Database-owned timestamps', timeSql.every((m) => refusedBy(m, /evidence_gate_result_time/)), 'a backdated or future instant is refused; only the transaction time is stored (T025)')
  const noOpUpdate = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET reason_code = reason_code WHERE id = $1::uuid`, R1.body.readinessId))
  check('T059', 'Update blocked, even no-op', /is append-only: UPDATE is not permitted/.test(noOpUpdate) && /is append-only/.test(rewrites[0]), 'a no-op UPDATE and a real one are refused')
  const truncateTrigger = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'evidence_gate_results'::regclass AND tgname = 'evidence_gate_results_no_truncate_trg'`)[0]?.def ?? ''
  const beforeWipe = await resultHash()
  const wipes = [
    await attemptAdversarial(() => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`)
      throw new Error(NOT_REFUSED)
    })),
    await attemptAdversarial(() => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`)
      throw new Error(NOT_REFUSED)
    })),
    await attemptAdversarial(() => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('TRUNCATE source_evidence_classifications CASCADE')
      throw new Error(NOT_REFUSED)
    })),
  ]
  // A later owner's ON DELETE RESTRICT key into this table makes PostgreSQL refuse a plain TRUNCATE before any
  // trigger runs; TRUNCATE … CASCADE still reaches this guard first. Judged on behaviour: every wipe is refused by a
  // real guard, the guard exists, and nothing changed.
  const referencedBy = await prisma.$queryRaw<{ t: string; del: string }[]>`SELECT conrelid::regclass::text AS t, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND confrelid = 'evidence_gate_results'::regclass`
  const plainRefusedByGuard = refusedBy(wipes[0], /evidence_gate_results is append-only: TRUNCATE is not permitted/)
  const plainRefusedByKey = refusedBy(wipes[0], /cannot truncate a table referenced in a foreign key constraint/) && referencedBy.length > 0 && referencedBy.every((row) => row.del === 'r')
  check(
    'T060',
    'Delete, TRUNCATE and CASCADE blocked',
    /is append-only: DELETE is not permitted/.test(rewrites[1]) && (plainRefusedByGuard || plainRefusedByKey) && refusedBy(wipes[1], /evidence_gate_results is append-only: TRUNCATE is not permitted/) && refusedBy(wipes[2], /is append-only: TRUNCATE is not permitted/) &&
      /^CREATE TRIGGER evidence_gate_results_no_truncate_trg BEFORE TRUNCATE ON public\.evidence_gate_results FOR EACH STATEMENT EXECUTE FUNCTION evidence_gate_results_append_only\(\)$/.test(truncateTrigger) &&
      (await resultHash()) === beforeWipe,
    `DELETE, TRUNCATE (refused by ${plainRefusedByGuard ? 'the guard' : `the RESTRICT key of ${referencedBy.map((row) => row.t).join(', ')}`}), TRUNCATE … CASCADE and a CASCADE from the A7.2 table (all bypass row triggers) are refused; every result is byte-identical afterwards`,
  )

  // ---------------------------------------------------------------- forgery and atomicity (T061–T070)
  section('Direct INSERT forgery, crash after row and after audit, atomic rollback, one audit, no false audit')
  const forgedReadiness = [await directInsert(dU, { readiness: 'SOURCE_REQUIRES_REVIEW', reason: 'CLASSIFICATION_REVIEW_REQUIRED' }), await directInsert(dU, { readiness: 'SOURCE_UNSUPPORTED', reason: 'CLASSIFICATION_UNSUPPORTED' })]
  check('T061', 'Forged readiness refused', forgedReadiness.every((m) => refusedBy(m, /evidence_gate_result_derivation/)), 'a review or unsupported result on a synthetic classification is refused by the derivation guard')
  const forgedFingerprint = [await directInsert(dU, { fingerprint: dC1.fingerprint }), await directInsert(dU, { fingerprint: 'f'.repeat(64) })]
  check('T062', 'Forged fingerprint refused', forgedFingerprint.every((m) => refusedBy(m, /evidence_gate_result_fingerprint/)), "another classification's fingerprint, or any other, is refused: only the classification's stored fingerprint is accepted")
  const missingRefs = [await directInsert(dU, { classification: MISSING }), await directInsert(dU, { actor: MISSING })]
  check('T063', 'Missing classification or actor refused', refusedBy(missingRefs[0], /classification_id_fkey|foreign key/) && refusedBy(missingRefs[1], /recorded_by_user_id_fkey|foreign key/), 'a non-existent classification or actor is refused by its key')
  const control = await directInsert(dU)
  check('T064', 'Valid direct insert accepted', accepted(control), 'a correct result for a classification built through the owner routes, inserted directly, is accepted (then rolled back): the refusals around it are the guards, not the setup')
  const KC = await classified(S2, 'CRASH')
  const countsBeforeCrash = await counts()
  const crashAt = async (probe: string) => {
    failAt(probe)
    const message = await attemptAdversarial(() => recordAdjudicationReadiness(KC.classificationId, {}, creatorId))
    clearConcurrencyProbes()
    return { message, unchanged: await unchanged(countsBeforeCrash), visible: (await historyOf(KC.classificationId)).length }
  }
  const crash1 = await crashAt('evidenceGate.inserted')
  const crash2 = await crashAt('evidenceGate.audited')
  check('T065', 'Crash after row rolls back', crash1.message.includes('INJECTED_CRASH') && crash1.unchanged && crash1.visible === 0, 'a failure after the result insert rolls back everything: no row, no audit, nothing to read')
  check('T066', 'Crash after audit rolls back both', crash2.message.includes('INJECTED_CRASH') && crash2.unchanged && crash2.visible === 0, 'a failure after the audit, before commit, rolls back the result and the audit')
  const retry = await gate(KC.classificationId)
  check('T067', 'Safe rerun records once', retry.status === 201 && (await prisma.evidenceGateResult.count({ where: { classificationId: KC.classificationId } })) === 1, 'the same request after both crashes records exactly one result')
  const auditOnce = await prisma.$queryRawUnsafe<{ bad: bigint }[]>(`SELECT count(*) AS bad FROM ${TABLE} g WHERE (SELECT count(*) FROM audit_events a WHERE a.entity_id = g.id AND a.action_code = 'adjudication_readiness.recorded') <> 1`)
  check('T068', 'One audit per result', Number(auditOnce[0].bad) === 0, 'every result in the database has exactly one adjudication_readiness.recorded audit')
  const orphanAudits = async () => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM audit_events a WHERE a.action_code = 'adjudication_readiness.recorded' AND NOT EXISTS (SELECT 1 FROM ${TABLE} g WHERE g.id = a.entity_id)`))[0].n)
  check('T069', 'No orphan audit', (await orphanAudits()) === 0, 'no readiness audit exists without its result')
  check('T070', 'Failed requests write no audit', refusalsLeftNothing && replaysLeftNothing && crash1.unchanged && crash2.unchanged, 'every 400/401/403/404, every replay and both crashes wrote no result and no audit')

  // ---------------------------------------------------------------- concurrency (T071–T080)
  section('Concurrency: Claim lock first, SERIALIZABLE, races with A6.2/A6.8/A6.9/A7.1/A7.2 writers, bounded wait, unique backstop, no blind retry')
  const txBody = serviceCode.slice(serviceCode.indexOf('async function recordOnTransaction'), serviceCode.indexOf('export async function recordAdjudicationReadiness'))
  const linkageBody = serviceCode.slice(serviceCode.indexOf('async function confirmLinkage'), serviceCode.indexOf('async function recordOnTransaction'))
  const L = await home.series('line edit', 1)
  const KL = await classified(L.freezes[0], 'LINE')
  const hold71 = holdAt('claimLine.removed')
  const removal = removeClaimLine(L.lineIds[1], {}, creatorId)
  await Promise.race([hold71.arrived, removal])
  const g71 = recordAdjudicationReadiness(KL.classificationId, {}, creatorId)
  const waited71 = !(await settledWithin(g71, 3000))
  hold71.release()
  const [removed71, r71] = await Promise.all([removal, g71])
  clearConcurrencyProbes()
  check(
    'T071',
    'Claim lock first, waits for A6.2',
    /lockRowForUpdateNowait\(tx, 'claims', owner\.claimId\)/.test(txBody.split('\n').slice(0, 3).join('\n')) && waited71 && removed71.ok && r71.ok && !r71.value.replayed,
    'the Claim row lock (NOWAIT) is the first statement; a readiness request during an uncommitted A6.2 line edit waits for it, then records',
  )
  check('T072', 'SERIALIZABLE, one transaction', /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && !/withReadSnapshot|prisma\./.test(txBody) && !/withReadSnapshot|prisma\./.test(linkageBody), 'one SERIALIZABLE transaction client carries every read, the insert and the audit; nothing reaches the global client inside it')
  const Lc = await home.series('lifecycle race', 1)
  const KLc = await classified(Lc.freezes[0], 'LIFECYCLE')
  const hold73 = holdAt('evidenceGate.claim_locked')
  const g73 = recordAdjudicationReadiness(KLc.classificationId, {}, creatorId)
  await Promise.race([hold73.arrived, g73])
  const event73 = recordLifecycleEvent(Lc.freezes[0], { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }, creatorId)
  const waited73 = !(await settledWithin(event73, 3000))
  hold73.release()
  const [r73, e73] = await Promise.all([g73, event73])
  clearConcurrencyProbes()
  check('T073', 'Serialized with A6.8 events', waited73 && r73.ok && e73.ok && e73.value.lifecycle.state === 'RELEASE_ELIGIBLE', 'an A6.8 event during an in-flight readiness record waits for the Claim lock; both commit; the disposition is the A6.8 owner\'s')
  const Lk = await home.series('link race', 2)
  const KLk = await classified(Lk.freezes[0], 'LINK')
  const hold74 = holdAt('evidenceGate.claim_locked')
  const g74 = recordAdjudicationReadiness(KLk.classificationId, {}, creatorId)
  await Promise.race([hold74.arrived, g74])
  const link74 = recordCorrectionLink(Lk.claimId, { priorSubmissionId: Lk.freezes[0], correctedSubmissionId: Lk.freezes[1], reasonCode: 'CORRECTED_SOURCE' }, creatorId)
  const waited74 = !(await settledWithin(link74, 3000))
  hold74.release()
  const [r74, l74] = await Promise.all([g74, link74])
  clearConcurrencyProbes()
  check('T074', 'Serialized with A6.9 links', waited74 && r74.ok && l74.ok && !l74.value.replayed, 'an A6.9 correction link during an in-flight readiness record waits for the Claim lock; both commit independently')
  const K75 = await classified(S1, 'A7-RACE')
  const sourceForA72 = (await post(`/api/claim-submissions/${S1}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref('A72-DURING') })).body?.revenueSourceEvidenceId as string
  const hold75 = holdAt('evidenceGate.claim_locked')
  const g75 = recordAdjudicationReadiness(K75.classificationId, {}, creatorId)
  await Promise.race([hold75.arrived, g75])
  const reg75 = registerRevenueSourceEvidence(S1, { sourceKind: SYNTHETIC, sourceReference: ref('A71-DURING') }, creatorId)
  const cls75 = classifySourceEvidence(sourceForA72, {}, creatorId)
  const waited75 = !(await settledWithin(Promise.race([reg75, cls75]), 3000))
  hold75.release()
  const [r75, a71r, a72r] = await Promise.all([g75, reg75, cls75])
  clearConcurrencyProbes()
  check('T075', 'Serialized with A7.1 and A7.2', waited75 && r75.ok && a71r.ok && a72r.ok, 'an A7.1 registration and an A7.2 classification during an in-flight readiness record wait for the shared Claim lock; all three commit')
  const K76 = await classified(S2, 'HELD')
  const hold76 = holdAt('evidenceGate.inserted')
  const first76 = recordAdjudicationReadiness(K76.classificationId, {}, creatorId)
  await Promise.race([hold76.arrived, first76])
  const second76 = recordAdjudicationReadiness(K76.classificationId, {}, B.id)
  const waited76 = !(await settledWithin(second76, 3000))
  hold76.release()
  const [r76a, r76b] = await Promise.all([first76, second76])
  clearConcurrencyProbes()
  check(
    'T076',
    'Bounded lock wait, then replay',
    /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode) && /await pauseAfterLockWait\(\)/.test(serviceCode) && /const MAX_READINESS_ATTEMPTS = 3/.test(serviceCode) && /P2034/.test(serviceCode) && /40001/.test(serviceCode) &&
      waited76 && r76a.ok && !r76a.value.replayed && r76b.ok && r76b.value.replayed && same(r76a.value.readiness, r76b.value.readiness),
    'a second request during an uncommitted first waits for the Claim lock (30-second budget, short random pause; serialization and deadlocks retried at most three times), then replays the committed result',
  )
  const K77 = await classified(S2, 'IN-PROCESS')
  const inProcess = await Promise.all([1, 2, 3].map(() => recordAdjudicationReadiness(K77.classificationId, {}, creatorId)))
  check(
    'T077',
    'Unique race backstop',
    /isUniqueViolation\(error\)/.test(serviceCode) && inProcess.every((r) => r.ok) && inProcess.filter((r) => r.ok && !r.value.replayed).length === 1 && (await prisma.evidenceGateResult.count({ where: { classificationId: K77.classificationId } })) === 1,
    'three identical in-process requests: one new, two replays, one row; a unique collision is retried into the replay',
  )
  check(
    'T078',
    'No blind retry on unknown outcome',
    /if \(isUnknownOutcome\(error\)\)\s*return \{ ok: false, code: 'ADJUDICATION_READINESS_CONFLICT'/.test(serviceCode) && /P2028/.test(serviceCode) && crash2.visible === 0 && same((await historyOf(KC.classificationId)).map((i: any) => i.readinessId), [retry.body.readinessId]),
    'a lost connection or transaction is a safe 409 telling the caller to read the history, never a second insert; after a failure the history is empty and after the safe rerun it shows exactly one result',
  )
  const K79 = await classified(S2, 'ISOLATION')
  const hold79 = holdAt('evidenceGate.audited')
  const pending79 = recordAdjudicationReadiness(K79.classificationId, {}, creatorId)
  await Promise.race([hold79.arrived, pending79])
  const during79 = get(readinessPath(K79.classificationId))
  const prompt79 = await settledWithin(during79, 5000)
  const duringItems = (await during79).body?.items ?? null
  hold79.release()
  const r79 = await pending79
  clearConcurrencyProbes()
  check('T079', 'Reads never see partial state', prompt79 && Array.isArray(duringItems) && duringItems.length === 0 && r79.ok && (await historyOf(K79.classificationId)).length === 1, 'a read while a result and its audit are uncommitted answers at once with committed history only (none); after commit, one')
  const duplicates = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM (SELECT 1 FROM ${TABLE} GROUP BY classification_id, contract_version HAVING count(*) > 1) d`)
  const drifted = await prisma.$queryRawUnsafe<{ n: bigint; total: bigint }[]>(
    `SELECT count(*) FILTER (WHERE g.source_evidence_id <> c.source_evidence_id OR g.organization_id <> c.organization_id OR g.classification_fingerprint_sha256 <> c.source_fingerprint_sha256
       OR NOT ((c.normalization_outcome = 'CLASSIFIED' AND g.readiness_code = 'NOT_READY_FOR_ADJUDICATION') OR (c.normalization_outcome = 'NEEDS_REVIEW' AND g.readiness_code = 'SOURCE_REQUIRES_REVIEW') OR (c.normalization_outcome = 'UNSUPPORTED' AND g.readiness_code = 'SOURCE_UNSUPPORTED'))) AS n,
            count(*) AS total
     FROM ${TABLE} g JOIN source_evidence_classifications c ON c.id = g.classification_id`,
  )
  check(
    'T080',
    'No integrity gaps after races',
    (await orphanAudits()) === 0 && Number(duplicates[0].n) === 0 && Number(drifted[0].n) === 0 && Number(drifted[0].total) > 0,
    `after every race no audit lacks its result, no identity is duplicated, and all ${Number(drifted[0].total)} results in the database link, copy the fingerprint and follow the outcome of their classification`,
  )

  // ---------------------------------------------------------------- privacy (T081–T090)
  section('Privacy: safe DTOs and audit, no PHI, fingerprint, money or bytes, organization boundary, no logs or browser storage, safe errors')
  const RF = await gate(KF.classificationId, O.who)
  const dtos = [R1.body, R1b.body, R2.body, readR1.body, ...twice[0], onReleased.body, RF.body]
  const auditR1b = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: R1b.body.readinessId } })
  const exposed = JSON.stringify([dtos, auditR1.afterState, auditR1b.afterState])
  check('T081', 'Safe DTO', RF.status === 201 && dtos.every((dto: any) => same(Object.keys(dto), DTO_KEYS)), 'every response carries exactly the eight DTO fields (the other organization records its own result: 201)')
  check('T082', 'No patient or member data', !exposed.includes(`${runId}-home-P`) && !exposed.includes(`${runId}-away-P`) && !exposed.includes('1990-01-01') && ![...deepKeys(JSON.parse(exposed))].some((k) => /patient|member|name|birth|email|phone|address/i.test(k)), 'no patient name, birth date, member or contact field in any DTO or audit')
  check('T083', 'No fingerprint, bytes or reference', ![...deepKeys(JSON.parse(exposed))].some((k) => /fingerprint|bytes|payload|manifest|seal|digest|sourceReference|raw/i.test(k)) && !exposed.includes(rowR1.classificationFingerprintSha256) && !exposed.includes(ref('E1')), 'no fingerprint (D5), payload bytes, manifest, digest or source reference leaves the server in a DTO or audit')
  check('T084', 'No money, status or payer', !/125\.25|12\.125|200\.01|AED/.test(exposed) && ![...deepKeys(JSON.parse(exposed))].some((k) => /amount|balance|currency|paid|price|tariff|status|payer|denial|adjudicat/i.test(k)), 'no amount, currency, balance, status, payer, denial or adjudication key or value')
  const foreignReads = [await get(resultPath(R1.body.readinessId), O.who), await get(readinessPath(C1), O.who), await get(resultPath(RF.body?.readinessId ?? MISSING))]
  const missingReadAsForeign = await get(resultPath(MISSING), O.who)
  check(
    'T085',
    'Organization boundary on reads',
    foreignReads.every((res) => res.status === 404) && same(foreignReads[0].body?.error?.message, missingReadAsForeign.body?.error?.message),
    "the other organization reads neither this tenant's result nor its history, and this tenant cannot read theirs: 404, exactly like a missing one",
  )
  check('T086', 'Audit metadata minimal', same(Object.keys(auditR1b.afterState as object).sort(), [...AUDIT_KEYS].sort()) && auditR1b.actorUserId === B.id, 'each audit carries exactly ids, the controlled codes, the contract and the database instant, and names its own actor')
  const production = committedProductionCodeOf([MODULE_DIR])
  check('T087', 'No logging', production.files.length === 6 && !/console\.|logger\./.test(production.code), 'the six A7.3 backend files log nothing')
  const frontend = committedCode(`${FE_DIR}/EvidenceGateCheck.tsx`)
  const registry = committedCode('frontend/src/developer/checkRegistry.tsx')
  check(
    'T088',
    'No browser storage, read-only page',
    frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend) && /key: 'evidence-gate'/.test(registry) && /\/adjudication-readiness`\)/.test(frontend) && !/fetch\([^)]*,\s*\{/.test(frontend),
    'the Developer Tools page is registered, makes one plain GET (no request options, so no write) and keeps nothing in browser storage',
  )
  const errorBodies = [...nonObject, ...unknownFields, ...malformed, ...anon, viewerPost, ...foreignOnHome, ...homeOnForeign, ...missingClassification, ...spoofs, ...forgedBodies, ...six.slice(4), ...foreignReads]
  const viewerPostAgain = await gate(C1, asViewer)
  check(
    'T089',
    'Safe deterministic error body',
    errorBodies.every((res) => !rawError(res.body) && typeof res.body?.error?.code === 'string' && typeof res.body?.error?.message === 'string') && same({ ...viewerPostAgain.body.error, requestId: null }, { ...viewerPost.body.error, requestId: null }),
    `all ${errorBodies.length} refusals carry a code, a safe message and a request id only; the same refusal repeats exactly`,
  )
  const queryPost = await post(`${readinessPath(C1)}?classificationId=${K2.classificationId}&token=SYN-SECRET&readinessCode=READY_FOR_ADJUDICATION`, {})
  const queryList = await get(`${readinessPath(C1)}?classificationId=${K2.classificationId}`)
  const queryCollection = await get(`/api/adjudication-evidence-readiness?classificationId=${C1}`)
  check(
    'T090',
    'Query-string identities ignored',
    queryPost.status === 200 && same(queryPost.body, R1.body) && same(queryList.body?.items, [R1.body]) && queryCollection.status === 404 && !/req\.query/.test(routeCode) && same((await get(resultPath(R1.body.readinessId), asViewer)).body, R1.body),
    'a classification id, token or readiness in the query string changes nothing (the path classification is replayed, 200); no route reads req.query; there is no query-driven collection; a Viewer reads the single result',
  )

  // ---------------------------------------------------------------- determinism and no payer truth (T091–T100)
  section('Stable history, determinism across time zone and locale, no payer truth, no money, balances or remittance')
  const sqlOrder = (await prisma.evidenceGateResult.findMany({ where: { classificationId: C1 }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }], select: { id: true } })).map((row) => row.id)
  check('T091', 'History stable ordering', same(twice[0].map((item: any) => item.readinessId), sqlOrder) && same(twice[0], twice[1]), 'the history is the database-recorded order (then id) and reads identically every time')
  const storedC1 = await findClassificationForGate(C1, prisma)
  const repeated = Array.from({ length: 50 }, () => JSON.stringify(deriveReadiness(storedC1!)))
  const synthRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${TABLE} g JOIN source_evidence_classifications c ON c.id = g.classification_id WHERE c.classification_code = 'INTERNAL_DECLARATION' AND (g.readiness_code, g.reason_code) <> ('NOT_READY_FOR_ADJUDICATION', 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT')`)
  check('T092', 'Same input, same result', new Set(repeated).size === 1 && Number(synthRows[0].n) === 0, 'fifty derivations of the same stored classification are identical, and every internal declaration in the database carries the same result')
  const tzProbe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import { deriveReadiness } from './src/modules/evidence-gate/evidence-gate.reducer.ts'; const f = JSON.parse(process.env.A73_FACTS); console.log(JSON.stringify([deriveReadiness(f), Intl.DateTimeFormat().resolvedOptions().timeZone]))"],
    { encoding: 'utf8', cwd: process.cwd(), env: childEnv({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', A73_FACTS: JSON.stringify(storedC1) }) },
  )
  const probed = (() => {
    try {
      return JSON.parse((tzProbe.stdout ?? '').trim().split(/\r?\n/).pop() ?? '')
    } catch {
      return null
    }
  })()
  check(
    'T093',
    'Time zone and locale invariance',
    probed !== null && probed[1] === 'Pacific/Kiritimati' && same(probed[0], { ok: true, value: NOT_READY }) && same(probed[0], deriveReadiness(storedC1!)),
    'a separate process in Pacific/Kiritimati (UTC+14) with a Turkish locale derives the identical result from the same stored classification',
  )
  const checkDefs = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'evidence_gate_results'::regclass AND contype = 'c'`).map((row) => row.def).join(' ')
  const vocabulary = ['INTERNAL_DECLARATION', 'EXTERNAL_SOURCE_UNVERIFIED', 'EXTERNAL_SOURCE_VERIFIED', 'INSUFFICIENT_CONTEXT', 'UNSUPPORTED_SOURCE', 'CLASSIFIED', 'NEEDS_REVIEW', 'UNSUPPORTED', 'SYNTHETIC_INTERNAL_SOURCE', 'EXTERNAL_PROOF_ABSENT', 'SOURCE_CONTEXT_MISSING', 'SOURCE_CONTEXT_CONTRADICTORY', 'SOURCE_KIND_UNSUPPORTED', 'SOURCE_CONTRACT_UNSUPPORTED']
  const reachable = new Set<string>()
  for (const a of vocabulary) for (const b of vocabulary) for (const c of vocabulary) {
    const result = deriveReadiness({ contractVersion: CLASS_CONTRACT, classificationCode: a, normalizationOutcome: b, reasonCode: c, sourceFingerprintSha256: rowC1.sourceFingerprintSha256 })
    if (result.ok) reachable.add(result.value.readinessCode)
  }
  check(
    'T094',
    'No payer truth',
    !/'(READY|READY_FOR_ADJUDICATION|ADJUDICATED|PAID|ALLOWED|DENIED|SETTLED|REMITTED|BALANCE_READY)'/.test(checkDefs) && same([...reachable].sort(), ['NOT_READY_FOR_ADJUDICATION', 'SOURCE_REQUIRES_REVIEW', 'SOURCE_UNSUPPORTED']) && !/ADJUDICATED|PAID|ALLOWED|DENIED|SETTLED|REMITTED/.test(JSON.stringify(dtos)),
    `over all ${vocabulary.length ** 3} classification combinations only NOT_READY, REVIEW and UNSUPPORTED are reachable; no ready, adjudicated, paid, allowed, denied, settled or remitted code exists in the database or any DTO`,
  )
  const moneyIdentifier = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|toFixed\(|[Ss]ettle|[Aa]llocat|[Aa]djust|[Rr]eceivable|[Bb]alance/
  const moneyCode = production.code.replace(/refusedByName = \[[\s\S]*?\] as const/, '')
  const pricingOfW = await prisma.claimPricingRun.findMany({ where: { claimId: W.claimId }, orderBy: { evaluatedAt: 'asc' } })
  check('T095', 'No money arithmetic', !moneyIdentifier.test(moneyCode) && pricingOfW.length === 1 && pricingOfW[0].totalExtendedAmount?.toFixed(2) === '200.01', 'A7.3 code computes no money (refused field names aside), and the Claim keeps its one pricing run and its AED 200.01 total')
  const ledgerTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(receivable|ledger|balance|posting|journal|allocation|settle|payment|cash|receipt|copay|patient_share)'`).map((row) => row.t)
  check('T096', 'No balances or ledger', ledgerTables.length === 0 && !resultColumns.some((c) => /balance|amount|currency|status|state/.test(c)), 'no receivable, ledger, balance, posting, settlement, payment or patient-share table, and no balance, amount or status column')
  const K97 = await classified(S2, 'NO-BALANCE')
  const before97 = await counts()
  await gate(K97.classificationId)
  check('T097', 'Writes only itself and its audit', onlyRecorded(delta(before97, await counts())), 'a readiness record writes no Claim, pricing, review, freeze, lifecycle, correction, source or classification row')
  const upstreamColumns = await prisma.$queryRaw<{ t: string; n: bigint }[]>`SELECT table_name AS t, count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('claims', 'claim_freezes', 'revenue_source_evidence', 'source_evidence_classifications') GROUP BY 1 ORDER BY 1`
  check('T098', 'Upstream tables unchanged', same(upstreamColumns.map((r) => [r.t, Number(r.n)]), [['claim_freezes', 13], ['claims', 7], ['revenue_source_evidence', 10], ['source_evidence_classifications', 11]]), 'claims, claim_freezes, revenue_source_evidence and source_evidence_classifications keep their columns: no reverse pointer or status was added')
  check('T099', 'No external truth', positive === 0 && Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${TABLE} WHERE readiness_code <> 'NOT_READY_FOR_ADJUDICATION'`))[0].n) === 0, 'at the end of the run every result in the database is still NOT_READY_FOR_ADJUDICATION')
  check(
    'T100',
    'No remittance or payer columns',
    resultColumns.length === 11 && resultColumns.every((c) => A73_COLUMNS.includes(c)) && !resultColumns.some((c) => /payer|remit|external|response|service_date|amount|status/.test(c)),
    'the table has exactly its 11 columns: no payer, remittance, external reference, response, date of service, amount or status',
  )

  // ---------------------------------------------------------------- boundaries (T101–T110)
  section('No A6, A7.1 or A7.2 change, no A7.4+/A9 integration, no send, queue, worker, network or payer endpoint')
  const wFreeze = await freezeHash(W.claimId)
  const wLifecycle = await lifecycleHash(W.claimId)
  const K101 = await classified(S1, 'BOUNDARY')
  const sourcesBefore101 = await sourceHash()
  const classificationsBefore101 = await classificationHash()
  const c1ReadBefore101 = (await get(`/api/revenue-evidence-classifications/${C1}`)).body
  await gate(K101.classificationId)
  check('T101', 'No A6 freeze change', (await freezeHash(W.claimId)) === wFreeze && (await freezeHash(Re.claimId)) === reFreezeBefore, 'every byte of the freezes and their sealed manifests is identical after readiness records')
  check('T102', 'No A6 lifecycle or link change', (await lifecycleHash(W.claimId)) === wLifecycle && (await correctionHash(W.claimId)) === chainBefore, 'every lifecycle event and the worked correction link are identical')
  check('T103', 'No A7.1 change', (await sourceHash()) === sourcesBefore101 && same((await get(`/api/revenue-source-evidence/${E1}`)).body?.revenueSourceEvidenceId, E1), "every byte of this run's A7.1 sources is identical after readiness records")
  check('T104', 'No A7.2 change', (await classificationHash()) === classificationsBefore101 && same((await get(`/api/revenue-evidence-classifications/${C1}`)).body, c1ReadBefore101), "every byte of this run's A7.2 classifications and the A7.2 read are identical after readiness records")
  const laterRoutes = [await post(`${resultPath(R1.body.readinessId)}/adjudications`, {}), await post(`/api/claim-submissions/${S1}/adjudications`, {}), await post(`/api/claim-submissions/${S1}/settlements`, {}), await post(`/api/claim-submissions/${S1}/remittances`, {})]
  const laterTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(adjudicat|denial|allowed|remittance|settle|import|inbound|outbox|queue|transmission|acknowledg)'`).map((row) => row.t)
  // Judged on behaviour: no such route answers and no such table exists. A later A7 suite's own files are not a
  // later domain (the start gate, T001, still reads them as later code).
  check('T105', 'No A7.4+ or A9 domain', laterRoutes.every((res) => res.status === 404) && laterTables.length === 0, 'no adjudication, settlement or remittance route or table, and no import, outbox, queue or transmission table')
  const jobsChanged = changedPaths.filter((file) => /^backend\/src\/jobs\//.test(file))
  // Judged on behaviour, not vocabulary: an awaited in-request pause (the lock-wait jitter) is not background work.
  // Any other timer, interval, schedule, worker or jobs-runner wiring is.
  const awaitedPause = /new Promise\(\(resolve\) => setTimeout\(resolve, [^\n]*/g
  const awaitedPauses = production.code.match(awaitedPause) ?? []
  const backgroundWork = production.code.replace(awaitedPause, '')
  const jobsWiring = committedFiles('backend/src/jobs').filter((file) => /\.ts$/.test(file)).some((file) => /gate|readiness|adjudicat/i.test(file) || /evidence-gate|adjudicationReadiness/i.test(committedCode(file)))
  check(
    'T106',
    'No send, queue or worker',
    jobsChanged.length === 0 && !jobsWiring && !/setInterval|setTimeout|setImmediate|worker_threads|\bnew Worker\(|cron|schedule\(|enqueue/i.test(backgroundWork) && awaitedPauses.length === 1,
    `A7.3 registers no job, worker, queue, interval, background timer or schedule; its only timer is the awaited in-request lock-wait pause (${awaitedPauses.length})`,
  )
  check('T107', 'No network calls', !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|<\?xml|\bx12\b|\bhl7\b|\bfhir\b|dhpo|eclaimlink/i.test(production.code), 'no network client, XML/X12/HL7/FHIR or DHPO/eClaimLink in A7.3 code')
  const payerRoutes = [await post(`${resultPath(R1.body.readinessId)}/payer-responses`, {}), await post(`/api/claim-submissions/${S1}/payer-responses`, {}), await post('/api/payer-responses', {}), await post(`${readinessPath(C1)}/send`, {})]
  check('T108', 'No payer endpoint', payerRoutes.every((res) => res.status === 404), 'payer-response, inbound and send routes do not exist (404)')
  check('T109', 'No new patient-balance table', ledgerTables.length === 0, 'no balance, patient-share, copay or statement table exists (T096)')
  check('T110', 'Synthetic only, market-neutral', !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION)\w*|['"`](AE-DU|DHA|AED|US)['"`]/.test(production.code) && positive === 0, 'every result is internal readiness of synthetic evidence; A7.3 holds no UAE/US market literal (future US support stays configuration)')

  const workedRows = async () =>
    (await prisma.evidenceGateResult.findMany({ where: { classificationId: { in: [C1, K2.classificationId] } }, orderBy: { id: 'asc' } })).map((row) => ({ ...row, recordedAt: row.recordedAt.toISOString(), createdAt: row.createdAt.toISOString() }))
  const worked = { rows: await workedRows(), history: twice[0], upstream: await hashOf(`SELECT x.* FROM (SELECT r.id, row_to_json(r)::text AS j FROM revenue_source_evidence r WHERE r.id IN ($1::uuid, $2::uuid) UNION ALL SELECT c.id, row_to_json(c)::text FROM source_evidence_classifications c WHERE c.id IN ($3::uuid, $4::uuid)) x`, E1, K2.sourceId, C1, K2.classificationId) }

  // ---------------------------------------------------------------- regressions (T111–T120)
  section('Regressions — A7.2 invoked, nesting A7.1 -> A6.10 -> A6.9 -> … -> A6.1 -> A5.10 -> A1')
  await apiReady('the A7.2 and backward regression chain')
  const chain = run('npm run test:a7:evidence-classification')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.2')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.2] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.2 asserts facts about its own branch, its own migration and production diff, its nested N/A proofs against its
  // own branch, and its own upstream. On A7.3 those statements are obsolete by design; every other A7.2 check is
  // substantive. T120 below proves each cause independently, never from the id.
  const a72NonApplicable: Record<string, string> = {
    T001: "A7.2 'Start gate' requires the A7.2 feature branch (and reads any other A7 suite as later code); A7.3 is branched from the main that contains the A7.2 merge",
    T004: "A7.2 'Exactly one additive migration' expects its own migration as the branch's only addition; A7.3 adds exactly one different migration (T004 here)",
    T010: "A7.2 'Diff scope' lists the paths A7.2 was allowed to change; A7.3 legitimately changes its own (T010 here)",
    T120: "A7.2 'Historical N/A reasons proved' proves A7.1's branch-only causes against the A7.2 branch (its migration, diff and upstream); on A7.3 those proofs are re-done here (T120)",
    T130: "A7.2 'Exact HEAD, clean tree, repeatable' requires the upstream to be the A7.2 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a72NonApplicable))
  const summary = chain.output.match(/\[A7\.2\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.2\] RUN ABORTED|\[A7\.2\] uncaught error|\[A7\.2\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a72Substantive = rows.filter((row) => !(row.id in a72NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a72Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T111',
    'A7.2 substantive regression',
    ran && reconciled && undocumented.length === 0 && a72Substantive.length === 0 && a72Passing >= 125,
    !ran
      ? 'the A7.2 suite did not complete'
      : !reconciled
        ? `A7.2 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.2 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.2\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.2] automated summary: ', 'A7.2 ')}; all ${a72Passing} substantive checks PASS and every failure is documented`,
  )
  for (const id of Object.keys(a72NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A7.2 ${titleOf(row.line)}`, a72NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T112', 'A7.1 regression', verdictOf('T111') === 'PASS', `A7.2 T111 (A7.1 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A6.10 cumulative regression', verdictOf('T112') === 'PASS', `A7.2 T112 (A6.10) ${verdictOf('T112')}`)
  check('T114', 'A6.9 correction regression', verdictOf('T113') === 'PASS', `A7.2 T113 (A6.9) ${verdictOf('T113')}`)
  check('T115', 'A6.8 lifecycle regression', verdictOf('T114') === 'PASS', `A7.2 T114 (A6.8) ${verdictOf('T114')}`)
  check('T116', 'A6.7 freeze regression', verdictOf('T115') === 'PASS', `A7.2 T115 (A6.7) ${verdictOf('T115')}`)
  check('T117', 'A6.6 to A6.3 regressions', verdictOf('T116') === 'PASS', `A7.2 T116 (A6.6 to A6.3) ${verdictOf('T116')}`)
  check('T118', 'A6.2, A6.1, A5 and A1–A4', verdictOf('T117') === 'PASS' && verdictOf('T118') === 'PASS', `A7.2 T117 (A6.2, A6.1) ${verdictOf('T117')}, T118 (A5 and A1–A4) ${verdictOf('T118')}`)
  check(
    'T119',
    'No substantive nested failures',
    ran && a72Substantive.length === 0 && verdictOf('T119') === 'PASS' && ['T021', 'T031', 'T044', 'T047', 'T048', 'T060', 'T067', 'T068', 'T079', 'T105', 'T107', 'T125', 'T126', 'T129'].every((id) => verdictOf(id) === 'PASS'),
    'every substantive A7.2 check PASSES on this branch — classification, unreachable outcomes, recorded disagreement, races, bulk-wipe guard (T060), crash rollback, integrity, adjudication absence (T105), no job, checksum, outage and worked example — and A7.2 T119 PASSES',
  )
  // Each documented A7.2 failure must fail for its branch-only reason, proved independently on this branch.
  const tracking = git('status -sb').split(/\r?\n/)[0]
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
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file) && !(file === A72_HARNESS && a72HarnessOnlyFixes))
  const a72Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA71 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const causes: Record<string, boolean> = {
    T001: branch === a73Branch && a72Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a72Merge} HEAD`),
    T004: same(migrationStatus, [`A\t${MIGRATION}`]),
    T010: a72Unexpected.length > 0 && a72Unexpected.every((path, index) => changedPaths.includes(path) || (index === a72Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A7.2 re-proves A7.1's branch-only causes against the A7.2 branch; on A7.3 only those tied to the branch (its
    // migration, diff and upstream) can be unproven — re-proved here against this branch.
    T120: unprovenA71.length > 0 && unprovenA71.every((id) => ['T001', 'T004', 'T010', 'T120', 'T130'].includes(id)) && same(migrationStatus, [`A\t${MIGRATION}`]) && outOfScope.length === 0 && tracking.includes(`origin/${a73Branch}`),
    T130: tracking.includes(`origin/${a73Branch}`) && !/origin\/feature\/a7-2/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  check(
    'T120',
    'Historical N/A reasons proved',
    ran && unproven.length === 0,
    unproven.length === 0 ? `each documented A7.2 failure (${failing.filter((id) => id in a72NonApplicable).join(', ') || 'none'}) fails only for its branch-only reason, proved independently on this branch` : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- builds and final evidence (T121–T130)
  section('Units, typecheck, frontend, Prisma checksum, replay, outage and recovery, synthetic fixtures, no 5xx, worked example, exact head')
  const allUnit = run('npm run test:unit')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  check('T121', 'Backend unit tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 15/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 15 A7.3 reducer and strict-request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Backend typecheck', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const appliedChecksum = (await prisma.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM _prisma_migrations WHERE migration_name = ${MIGRATION_NAME} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.checksum
  const blob = spawnSync('git', ['show', `HEAD:${MIGRATION}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checkoutChecksum = sha256Of(readFileSync(`../${MIGRATION}`))
  check(
    'T125',
    'Prisma checksum and replay',
    status.ok && replay.ok && (appliedChecksum === checkoutChecksum || appliedChecksum === sha256Of(blob)),
    `the A7.3 migration is applied with the checksum of its committed file (${(appliedChecksum ?? '').slice(0, 12)}…); status up to date; replay ALL CHECKS PASS (T006)`,
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
  check('T126', 'DB health vs readiness outage', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')
  await waitFor(databaseUp, 60_000)
  const runRows = await prisma.$queryRawUnsafe<{ reference: string; organization_id: string }[]>(`SELECT r.source_reference AS reference, g.organization_id::text AS organization_id FROM ${TABLE} g JOIN revenue_source_evidence r ON r.id = g.source_evidence_id WHERE g.created_at >= $1::timestamptz`, runStartedAt.toISOString())
  check(
    'T127',
    'Synthetic fixtures only',
    runRows.length > 0 && runRows.every((row) => row.reference.includes(runToken) && [org, otherOrg].includes(row.organization_id)),
    `${runRows.length} results recorded since this run started, every source keyed by ${runId}, all in the two synthetic organizations`,
  )
  check('T128', 'No unexpected HTTP 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const afterRows = await workedRows()
  const afterHistory = await historyOf(C1)
  const afterUpstream = await hashOf(`SELECT x.* FROM (SELECT r.id, row_to_json(r)::text AS j FROM revenue_source_evidence r WHERE r.id IN ($1::uuid, $2::uuid) UNION ALL SELECT c.id, row_to_json(c)::text FROM source_evidence_classifications c WHERE c.id IN ($3::uuid, $4::uuid)) x`, E1, K2.sourceId, C1, K2.classificationId)
  console.log(`[${TAG}]      worked example: S1 ${S1} / E1 ${E1} / C1 ${C1} (INTERNAL_DECLARATION/CLASSIFIED) -> R1 ${R1.body.readinessCode} (${R1.body.reasonCode}); identical request -> ${replay1.status} same R1, +${d41.audit_events} audit`)
  console.log(`[${TAG}]      worked example: correction freeze S2 ${S2} (A6.9 link ${linkWorked.status}) / E2 / C2 -> R2 ${R2.body.readinessCode}; S1/E1/C1/R1 unchanged; nothing adjudicated, sent, paid or denied`)
  check(
    'T129',
    'Worked example after restart',
    R1.status === 201 && replay1.status === 200 && d41.audit_events === 0 && R2.status === 201 && R2.body.readinessId !== R1.body.readinessId && same(afterRows, worked.rows) && same(afterHistory, worked.history) && afterUpstream === worked.upstream && worked.rows.length === 2,
    'the §10 scenario is reproduced (R1 NOT_READY for C1/E1, identical request returns R1, correction freeze S2 gets its own R2), and after the nested chain and a database restart R1, R2 and their E1/E2/C1/C2 read back byte-identically',
  )

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a(8|9)|dhpo|eclaimlink/i.test(file))
  check(
    'T010',
    'Diff scope excludes other owners',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A7.3 module, migration and model, harness and check page, two permissions, two error codes, one audit action and wiring${changedPaths.includes(A72_HARNESS) ? ", and the A7.2 suite's T060 and T105 blocks only" : ''}; no A5/A6/A7.1/A7.2 owner changed; no A7.4+/A8/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  check(
    'T130',
    'Exact HEAD, clean tree, repeatable',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a73Branch}`) && !/ahead|behind/.test(tracking) && same(afterHistory, worked.history),
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; after the database restart the worked results read back identically`,
  )

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] ADJUDICATION EVIDENCE READINESS ACCEPTANCE COMPLETE` : `[${TAG}] A7.3 FINAL FAIL`)
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
