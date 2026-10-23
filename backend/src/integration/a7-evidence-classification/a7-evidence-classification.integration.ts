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
import { classifySource, recordedClassificationAgrees, sourceFingerprintSha256, sourceFingerprintText } from '../../modules/evidence-classification/evidence-classification.classifier.ts'
import { findClassificationByIdentity, findSourceForClassification, insertClassification } from '../../modules/evidence-classification/evidence-classification.repository.ts'
import { classifySourceEvidence, getClassificationsOf } from '../../modules/evidence-classification/evidence-classification.service.ts'
import type { Classification, ClassifierResult, SourceFacts } from '../../modules/evidence-classification/evidence-classification.types.ts'

// A7.2 — focused acceptance for Revenue Evidence Classification & Normalization (T001–T130).
//
// Every frozen submission is built through its owners, exactly as the A6.7–A7.1 suites build them (tariff world
// and rates, the A5.7 recorder, readiness, the Claim, lines, diagnoses and pointers, pricing, draft assessments,
// APPROVE/REVOKE by a separate synthetic Admin, and every freeze through the A6.7 route); every source record is
// registered through the A7.1 route. The other organization builds its own frozen submission and source record
// with its own two Admins. Classifications go through the A7.2 route (or, for barrier-controlled races and crash
// injection, its service in-process). ADVERSARIAL writes go in only to prove a database guard; every one of them
// — including the ones that relax an A7.1 CHECK to create a source no owner can register today — runs in a
// transaction that is always rolled back. Synthetic Admins are provisioned per run through Better Auth's own
// server-side creation with a random password that is never printed. Every value is synthetic and keyed by this
// run's id.

const TAG = 'A7.2'
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

const runId = `A72-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a72Branch = 'feature/a7-2-evidence-classification'
const a71Branch = 'feature/a7-1-revenue-source-evidence'
const a610Branch = 'feature/a6-10-a6-integration-acceptance'
const correctiveBranch = 'fix/a6-harness-replay-count-head'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/evidence-classification'
const FE_DIR = 'frontend/src/modules/evidence-classification'
const HARNESS_DIR = 'backend/src/integration/a7-evidence-classification'
const MIGRATION_NAME = '20261022090000_a7_2_evidence_classification'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const A71_HARNESS = 'backend/src/integration/a7-revenue-source-evidence/a7-revenue-source-evidence.integration.ts'
const UNIT_TESTS = [`${MODULE_DIR}/evidence-classification.classifier.test.ts`, `${MODULE_DIR}/evidence-classification.validation.test.ts`]
const TABLE = 'source_evidence_classifications'
const CONTRACT = 'A7-EVIDENCE-CLASS-1'
const SOURCE_CONTRACT = 'A7-REVENUE-SOURCE-1'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const INTERNAL: Classification = { classificationCode: 'INTERNAL_DECLARATION', normalizationOutcome: 'CLASSIFIED', reasonCode: 'SYNTHETIC_INTERNAL_SOURCE' }
const DTO_KEYS = ['classificationId', 'sourceEvidenceId', 'contractVersion', 'classificationCode', 'normalizationOutcome', 'reasonCode', 'sourceFingerprintSha256', 'recordedByUserId', 'recordedAt']
const AUDIT_KEYS = ['classificationId', 'sourceEvidenceId', 'contractVersion', 'classificationCode', 'normalizationOutcome', 'reasonCode', 'recordedAt']
const A72_COLUMNS = ['id', 'organization_id', 'source_evidence_id', 'contract_version', 'classification_code', 'normalization_outcome', 'reason_code', 'source_fingerprint_sha256', 'recorded_by_user_id', 'recorded_at', 'created_at']
// The owners A7.2 consumes or must leave untouched: the A5/A6 modules and A7.1 (backend, page and suite).
const OWNER_DIRS = [
  ...['claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction', 'pre-claim-validation', 'pre-claim-readiness', 'validation-run', 'revenue-evidence'].map(
    (name) => `backend/src/modules/${name}`,
  ),
  'frontend/src/modules/revenue-evidence',
  'backend/src/integration/a7-revenue-source-evidence',
]
// The tables whose rows a refusal, a read or a rolled-back write must leave untouched, always read in this fixed
// key order (a UNION ALL may come back in Parallel Append order).
const COUNT_TABLES = [TABLE, 'revenue_source_evidence', 'audit_events', 'claims', 'claim_pricing_runs', 'claim_review_events', 'claim_freezes', 'claim_freeze_evidence_manifests', 'claim_freeze_lifecycle_events', 'claim_correction_links']
// The fingerprint, recomputed independently from the A7.2 contract text (§3) — not through the code under test.
const FINGERPRINT_SQL = `encode(sha256(convert_to('SBN-A7-EVIDENCE-CLASS-1' || chr(10) || 'contract=' || c.contract_version || chr(10) || 'sourceEvidenceId=' || r.id::text || chr(10) || 'sourceKind=' || r.source_kind || chr(10) || 'sourceReference=' || r.source_reference || chr(10) || 'sourceVersion=' || r.source_version || chr(10) || 'claimSubmissionId=' || r.claim_submission_id::text || chr(10) || 'receivedAtMicros=' || (extract(epoch FROM r.received_at) * 1000000)::bigint::text || chr(10), 'UTF8')), 'hex')`

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

  console.log(`[${TAG}] A7.2 revenue evidence classification & normalization — run ${runId}`)
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
  section('Preflight: accepted A7.1, the one A7.2 migration, Prisma, replay, permissions, routes and contracts')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a71Merge = mergeOf(a71Branch)
  const a610Merge = mergeOf(a610Branch)
  const correctiveMerge = mergeOf(correctiveBranch)
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|settlement|receivable|claim-transport|claim-outbox|payer-response|integration\/a(8|9)|integration\/a7-(?!revenue-source-evidence|evidence-classification)|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Start gate after A7.1',
    branch === a72Branch && a71Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a71Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A7.1 merged as ${a71Merge.slice(0, 7) || 'NOT FOUND'} and is an ancestor; contains latest main ${git('rev-parse --short origin/main')}; no A7.3+/A8/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Clean repository tree', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'A6.10 and A7.1 ancestry',
    [a610Merge, correctiveMerge, a71Merge].every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)) && committedText('docs/A6_Phase_Closure.md').includes('A6 Claim Lifecycle — Phase Closure Record'),
    `A6.10 ${a610Merge.slice(0, 7)}, the A6 harness correction ${correctiveMerge.slice(0, 7)} and A7.1 ${a71Merge.slice(0, 7)} are ancestors of HEAD; the A6 closure record is present`,
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
    /PASS {2}the A7\.2 tables are exactly source_evidence_classifications/,
    /PASS {2}source_evidence_classifications_insert_guard_trg is present after a clean replay/,
    /PASS {2}source_evidence_classifications_append_only_trg is present after a clean replay/,
    /PASS {2}source_evidence_classifications_no_truncate_trg is present after a clean replay/,
    /PASS {2}the A7\.2 CHECKs pin A7-EVIDENCE-CLASS-1, the controlled codes, outcomes and reasons, and disable external verification/,
    /PASS {2}one classification per source record and contract is unique/,
    /PASS {2}source_evidence_classifications carries exactly its 11 A7\.2 columns/,
    /PASS {2}the A7\.1 tables are exactly revenue_source_evidence/,
  ]
  check(
    'T006',
    'From-empty migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === headMigrationDirs.length && headMigrationDirs.some((dir) => MIGRATION.startsWith(`${dir}/`)),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — all ${headMigrationDirs.length} committed at HEAD, the A7.2 migration included; every A7.1 and A7.2 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /classif/i.test(code)).sort()
  const invented = allCodes.filter((code) => /classif|revenue/i.test(code) && /(pay|remit|post|settle|adjudicat|denial|receivable|ledger|verif|send|transmit|submit)/i.test(code))
  check(
    'T007',
    'Permission grants precisely scoped',
    same(family, ['evidenceClassification.create', 'evidenceClassification.read']) &&
      (await grantsOf('evidenceClassification.create')) === 'ORG_ADMIN' &&
      (await grantsOf('evidenceClassification.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('revenueEvidence.create')) === 'ORG_ADMIN' &&
      (await grantsOf('revenueEvidence.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      invented.length === 0,
    'evidenceClassification.create (Admin) and .read (Admin, Viewer) only; the A7.1 grants unchanged; no verify, pay, post, settle or send permission',
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
  // Raw database text in a response body: SQL keywords, a stack frame or a physical guard name (lower case —
  // the public error codes are upper case and expected).
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /source_evidence_classification|revenue_source_evidence_[a-z]|claim_freeze/.test(text)
  }
  const markerOf = (message: string) =>
    (message.match(/[a-z_]+_(chk|fkey|key)\b/) ?? message.match(/source_evidence_classification_(time|coherence|derivation|fingerprint)|is append-only|null value/) ?? [message.includes('ROLLED_BACK') ? 'ACCEPTED' : '?'])[0]

  // Synthetic Admins: Better Auth's own server-side user and credential creation, then an ORG_ADMIN
  // membership through the existing tables. The password is random per run and never printed.
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
  // B approves (separation of duties for A6.5) and classifies as a second actor; O and O2 are the two Admins of
  // the OTHER organization, who build its own frozen submission and source record.
  const B = await provisionAdmin('b')
  const O = await provisionAdmin('o', otherOrg)
  const O2 = await provisionAdmin('o2', otherOrg)

  const sourcePath = (id: string) => `/api/revenue-source-evidence/${id}/classifications`
  const classificationPath = (id: string) => `/api/revenue-evidence-classifications/${id}`
  const classify = (sourceId: string, who: Who = asAdmin, body: unknown = {}) => post(sourcePath(sourceId), body, who)
  const historyOf = async (sourceId: string, who: Who = asAdmin) => (await get(sourcePath(sourceId), who)).body?.items ?? []
  const wiring = [await classify(MISSING), await get(sourcePath(MISSING)), await get(classificationPath(MISSING))]
  const absent = [
    await api('PATCH', classificationPath(MISSING), {}),
    await api('PUT', classificationPath(MISSING), {}),
    await api('DELETE', classificationPath(MISSING)),
    await api('DELETE', sourcePath(MISSING)),
    await api('PUT', sourcePath(MISSING), {}),
    await api('PATCH', sourcePath(MISSING), {}),
    await api('POST', '/api/revenue-evidence-classifications', {}),
    await api('GET', '/api/revenue-evidence-classifications'),
    await api('POST', `${classificationPath(MISSING)}/verify`, {}),
    await api('POST', `/api/revenue-source-evidence/${MISSING}/verify`, {}),
    await api('POST', `/api/claim-submissions/${MISSING}/classifications`, {}),
    await api('GET', `/api/claim-submissions/${MISSING}/classifications`),
  ]
  const unauthenticated = [await classify(MISSING, anonymous), await get(sourcePath(MISSING), anonymous), await get(classificationPath(MISSING), anonymous)]
  check(
    'T008',
    'Route registration, missing targets',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && absent.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `three routes answer a missing target with a privacy-safe 404; PATCH/PUT/DELETE, collection, verify and per-submission routes are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
  )
  const constantOf = (path: string, name: string) => (committedText(path).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-pricing/claim-pricing.types.ts', 'PRICING_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-draft/claim-draft.types.ts', 'DRAFT_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-review/claim-review.types.ts', 'REVIEW_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-payload/claim-payload.types.ts', 'PAYLOAD_SCHEMA_VERSION'),
    constantOf('backend/src/modules/claim-submission/claim-submission.types.ts', 'SUBMISSION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-evidence/claim-evidence.types.ts', 'EVIDENCE_MANIFEST_VERSION'),
    constantOf('backend/src/modules/claim-lifecycle/claim-lifecycle.types.ts', 'LIFECYCLE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-correction/claim-correction.types.ts', 'CORRECTION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/revenue-evidence/revenue-evidence.types.ts', 'REVENUE_SOURCE_CONTRACT_VERSION'),
  ]
  // The one owner file A7.2 may change: A7.2's RESTRICT key into revenue_source_evidence makes PostgreSQL refuse a
  // plain TRUNCATE before A7.1's guard runs, so A7.1 T060 now judges that refusal on behaviour. Accepted only when
  // every changed hunk lies inside the A7.1 T060 block, on both sides of the diff.
  const t060Block = (text: string) => {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((line) => line.includes('// TRUNCATE removes rows without firing row-level triggers'))
    const end = lines.findIndex((line) => line.includes('atomicity (T061–T070)'))
    return start >= 0 && end > start ? { start: start + 1, end: end + 1 } : null
  }
  const a71HarnessDiff = gitArgs(['diff', '-U0', 'origin/main...HEAD', '--', `:/${A71_HARNESS}`])
  const a71Hunks = [...a71HarnessDiff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({ oldStart: Number(m[1]), oldCount: Number(m[2] ?? 1), newStart: Number(m[3]), newCount: Number(m[4] ?? 1) }))
  const oldBlock = t060Block(gitArgs(['show', `origin/main:${A71_HARNESS}`]))
  const newBlock = t060Block(committedText(A71_HARNESS))
  const insideBlock = (start: number, count: number, block: { start: number; end: number } | null) => count === 0 || (block !== null && start >= block.start && start + count - 1 < block.end)
  const a71HarnessOnlyT060 =
    a71Hunks.length > 0 && a71Hunks.every((hunk) => insideBlock(hunk.oldStart, hunk.oldCount, oldBlock) && insideBlock(hunk.newStart, hunk.newCount, newBlock))
  const ownerChanged = changedPaths.filter(
    (file) => !(file === A71_HARNESS && a71HarnessOnlyT060) && (OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file)),
  )
  check(
    'T009',
    'Earlier domain contracts preserved',
    same(contracts, ['A6-CLAIM-1', 'A6-PRICE-1', 'A6-DRAFT-1', 'A6-REVIEW-1', 'A6-PAYLOAD-1', 'A6-SUBMISSION-1', 'A6-EVIDENCE-1', 'A6-LIFECYCLE-1', 'A6-CORRECTION-1', SOURCE_CONTRACT]) && ownerChanged.length === 0,
    ownerChanged.length === 0
      ? `A6-CLAIM-1 … A6-CORRECTION-1 and A7-REVENUE-SOURCE-1 unchanged; no A5/A6/A7.1 owner module or page changed${changedPaths.includes(A71_HARNESS) ? `; the A7.1 suite changed only inside its T060 block (${a71Hunks.length} hunk(s))` : ''}`
      : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: frozen submissions and A7.1 source records of this organization and another one')
  // One organization's synthetic world, built by its own Admin (`who`, actor `actorId`) with a separate
  // approver, then Claims with lawfully frozen submissions.
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
    // A Claim with `count` lawfully frozen submissions: each later one after revoking the current approval, on
    // a NEW draft assessment with its own new approval.
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
    return { patientName: `${runId}-${label}-P`, series }
  }
  const home = await tenantWorld('home', org, asAdmin, creatorId, B.who)
  const away = await tenantWorld('away', otherOrg, O.who, O.id, O2.who)
  const W = await home.series('worked', 2)
  const F = await away.series('foreign', 1)
  const [S1, S2] = W.freezes
  const ref = (suffix: string) => `SYN-${runId.replace(/^A72-/, '')}-${suffix}`.toUpperCase()
  // Every source record is registered through the A7.1 route by its own organization's Admin.
  const registerSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref(suffix) }, who)
    if (res.status !== 201) throw new Error(`fixture source ${suffix} could not be registered through A7.1: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.revenueSourceEvidenceId as string
  }
  const E1 = await registerSource(S1, 'E1')
  const E2 = await registerSource(S1, 'E1-V2')
  const E3 = await registerSource(S2, 'E1')
  const EF = await registerSource(F.freezes[0], 'FOREIGN', O.who)
  console.log(`[${TAG}]      fixtures ready: two synthetic AE-DU/DHA worlds (each built by its own Admins), frozen submissions and A7.1 source records registered through the A7.1 route`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const delta = (before: Record<string, number>, after: Record<string, number>) => Object.fromEntries(COUNT_TABLES.map((table) => [table, after[table] - before[table]])) as Record<string, number>
  const onlyClassified = (d: Record<string, number>, rows = 1) => same(d, { ...Object.fromEntries(COUNT_TABLES.map((t) => [t, 0])), [TABLE]: rows, audit_events: rows })
  // Every stored byte of a set of rows, for "nothing changed" proofs.
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const freezeHash = (claimId: string) => hashOf(`SELECT f.*, m.id AS manifest_id, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = $1::uuid`, claimId)
  const lifecycleHash = (claimId: string) => hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = $1::uuid`, claimId)
  const correctionHash = (claimId: string) => hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = $1::uuid`, claimId)
  const sourceHash = () => hashOf(`SELECT r.* FROM revenue_source_evidence r WHERE r.source_reference LIKE $1`, `%${runId.replace(/^A72-/, '')}%`)
  const classificationHash = () => hashOf(`SELECT c.* FROM ${TABLE} c`)
  const NOT_REFUSED = 'ROLLED_BACK'
  const refusedBy = (message: string, marker: RegExp) => message !== '' && !message.includes(NOT_REFUSED) && marker.test(message)
  const accepted = (message: string) => message.includes(NOT_REFUSED)

  // The classification the A7.2 classifier derives for a source, from the facts read on `db`.
  type Derived = { id: string; organizationId: string; facts: SourceFacts; classified: ClassifierResult; classification: Classification; fingerprint: string }
  const derive = async (sourceId: string, db: DbClient = prisma): Promise<Derived> => {
    const located = await findSourceForClassification(sourceId, db)
    if (!located) throw new Error(`fixture: source ${sourceId} not found`)
    const classified = classifySource(located.facts)
    return { id: sourceId, organizationId: located.facts.organizationId as string, facts: located.facts, classified, classification: classified.ok ? classified.value : INTERNAL, fingerprint: sourceFingerprintSha256(located.facts) }
  }
  // A direct INSERT of a classification inside a transaction that is always rolled back. `guardOff` switches the
  // row triggers off (session_replication_role = replica) so a refusal can only come from a CHECK or NOT NULL.
  type Direct = { organization?: string; source?: string; contract?: string | null; code?: string | null; outcome?: string | null; reason?: string | null; fingerprint?: string | null; actor?: string; recordedAt?: boolean; createdAt?: boolean; guardOff?: boolean }
  const directInsert = (d: Derived, v: Direct = {}) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        if (v.guardOff) await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, organization_id, source_evidence_id, contract_version, classification_code, normalization_outcome, reason_code, source_fingerprint_sha256, recorded_by_user_id${v.recordedAt ? ', recorded_at' : ''}${v.createdAt ? ', created_at' : ''})
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid${v.recordedAt ? ", now() - interval '1 day'" : ''}${v.createdAt ? ", now() + interval '1 hour'" : ''})`,
          v.organization ?? d.organizationId,
          v.source ?? d.id,
          'contract' in v ? v.contract : CONTRACT,
          'code' in v ? v.code : d.classification.classificationCode,
          'outcome' in v ? v.outcome : d.classification.normalizationOutcome,
          'reason' in v ? v.reason : d.classification.reasonCode,
          'fingerprint' in v ? v.fingerprint : d.fingerprint,
          v.actor ?? creatorId,
        )
        throw new Error(NOT_REFUSED)
      }),
    )
  // A source that A7.1 cannot register today (its CHECKs admit INTERNAL_SYNTHETIC, the fixed contract, an opaque
  // reference and no digest only), created inside a transaction that is ALWAYS rolled back after relaxing those
  // four CHECKs; the classifier reads it through the A7.2 repository on the same transaction, and the A7.2
  // database guard is asked to accept a classification of it.
  type Relaxed = { kind: string; reference: string; version: string; digest?: string | null }
  const relaxedSource = async (source: Relaxed, insertAs: 'derived' | 'internal' | 'unverified') => {
    const out: { classified?: ClassifierResult } = {}
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
          const d = await derive(row.id, tx)
          out.classified = d.classified
          const value: Classification = insertAs === 'derived' ? d.classification : insertAs === 'internal' ? INTERNAL : { classificationCode: 'EXTERNAL_SOURCE_UNVERIFIED', normalizationOutcome: 'NEEDS_REVIEW', reasonCode: 'EXTERNAL_PROOF_ABSENT' }
          await insertClassification({ organizationId: org, sourceEvidenceId: row.id, contractVersion: CONTRACT, ...value, sourceFingerprintSha256: d.fingerprint, recordedByUserId: creatorId }, tx)
          throw new Error(NOT_REFUSED)
        },
        { maxWait: 10_000, timeout: 30_000 },
      ),
    )
    return { classified: out.classified, message }
  }
  const outcomeOf = (result: ClassifierResult | undefined) => (result === undefined ? 'unread' : result.ok ? `${result.value.classificationCode}/${result.value.normalizationOutcome}/${result.value.reasonCode}` : `refused ${result.refusal}`)

  // ---------------------------------------------------------------- strict request (T011–T020)
  section('Strict request: contract, empty body, unknown fields, UUIDs, session, roles, tenants, actor and organization')
  const countsAtStart = await counts()
  check(
    'T011',
    'Versioned classification contract',
    constantOf(`${MODULE_DIR}/evidence-classification.types.ts`, 'CLASSIFICATION_CONTRACT_VERSION') === CONTRACT && /"contract_version" = 'A7-EVIDENCE-CLASS-1'/.test(readFileSync(`../${MIGRATION}`, 'utf8')),
    'A7-EVIDENCE-CLASS-1 is the literal contract in code and in the database CHECK (and on every row and DTO, T021)',
  )
  const nonObject = [await post(sourcePath(E1), []), await post(sourcePath(E1), [INTERNAL])]
  check('T012', 'Strict request body', nonObject.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR'), 'the body must be absent or {}: an array body is refused (400); every classification value is derived by the server')
  const unknownFields = [await classify(E1, asAdmin, { extra: 1 }), await classify(E1, asAdmin, { format: 'X12' }), await classify(E1, asAdmin, JSON.parse('{"__proto__": {"classificationCode": "EXTERNAL_SOURCE_VERIFIED"}}'))]
  check('T013', 'Unknown body fields rejected', unknownFields.every((res) => res.status === 400 && /unknown field/.test(res.body?.error?.message ?? '')), 'an unknown field (including a parsed __proto__ key) is refused by name: 400')
  const malformed = [
    await post('/api/revenue-source-evidence/not-a-uuid/classifications', {}),
    await get('/api/revenue-source-evidence/1234/classifications'),
    await get('/api/revenue-evidence-classifications/not-a-uuid'),
    await get(`/api/revenue-evidence-classifications/${MISSING.slice(0, 35)}`),
    await post(`/api/revenue-source-evidence/${encodeURIComponent("1' OR '1'='1")}/classifications`, {}),
  ]
  check('T014', 'Malformed UUIDs rejected', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `malformed and injected path ids: ${malformed.map((r) => r.status).join('/')}; no raw database text`)
  const anon = [await classify(E1, anonymous), await get(sourcePath(E1), anonymous), await get(classificationPath(MISSING), anonymous)]
  check('T015', 'Unauthenticated denied 401', anon.every((res) => res.status === 401), 'every A7.2 route requires a session: 401 without one')
  const viewerPost = await classify(E1, asViewer)
  check('T016', 'Viewer cannot classify', viewerPost.status === 403 && errorCode(viewerPost.body) === 'FORBIDDEN', 'a Viewer is refused the classification: 403')
  const viewerList = await get(sourcePath(E1), asViewer)
  check('T017', 'Viewer may read', viewerList.status === 200 && Array.isArray(viewerList.body?.items), 'a Viewer reads the source\'s classifications (200); the single read is shown in T090')
  const foreignOnHome = [await classify(E1, O.who), await get(sourcePath(E1), O.who)]
  const foreignMissing = await get(sourcePath(MISSING), O.who)
  const homeOnForeign = [await classify(EF), await get(sourcePath(EF))]
  check(
    'T018',
    'Foreign tenant refuses 404',
    foreignOnHome.every((res) => res.status === 404 && same(res.body?.error?.message, foreignMissing.body?.error?.message)) && homeOnForeign.every((res) => res.status === 404),
    "the other organization's Admin gets 404 for this tenant's source record — exactly like a missing one — and this tenant's Admin gets 404 for the other one's",
  )
  const missingSource = [await classify(MISSING), await get(sourcePath(MISSING))]
  check('T019', 'Missing evidence refuses 404', missingSource.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND'), 'a non-existent source record: 404')
  const spoofs = await Promise.all([{ recordedByUserId: B.id }, { actorUserId: B.id }, { organizationId: otherOrg }, { sourceEvidenceId: E2 }, { claimSubmissionId: S2 }, { recordedAt: '2020-01-01T00:00:00Z' }, { id: MISSING }].map((body) => classify(E1, asAdmin, body)))
  check('T020', 'Actor and org spoofing refused', spoofs.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')), 'actor, organization, source, submission, instant and id in the body are refused by name: 400 (the session actor is named in T021)')
  const refusalsLeftNothing = await unchanged(countsAtStart)

  // ---------------------------------------------------------------- server-derived classification (T021–T030)
  section('Synthetic classification: server-derived, exact A7.1 source link, kind and version preserved, no external verification')
  const sourceRowsBefore = await sourceHash()
  const a71ReadBefore = (await get(`/api/revenue-source-evidence/${E1}`)).body
  const before21 = await counts()
  const C1 = await classify(E1)
  const after21 = await counts()
  const dE1 = await derive(E1)
  check(
    'T021',
    'Valid internal synthetic classified',
    C1.status === 201 && same(Object.keys(C1.body ?? {}), DTO_KEYS) && same([C1.body.classificationCode, C1.body.normalizationOutcome, C1.body.reasonCode], [INTERNAL.classificationCode, INTERNAL.normalizationOutcome, INTERNAL.reasonCode]) &&
      C1.body.contractVersion === CONTRACT && C1.body.recordedByUserId === creatorId && onlyClassified(delta(before21, after21)),
    '201: INTERNAL_DECLARATION / CLASSIFIED / SYNTHETIC_INTERNAL_SOURCE under A7-EVIDENCE-CLASS-1, by the session Admin; exactly one classification and one audit; the DTO carries exactly its nine fields',
  )
  const forgedBodies = await Promise.all(
    [{ classificationCode: 'EXTERNAL_SOURCE_VERIFIED' }, { classificationCode: 'INTERNAL_DECLARATION' }, { normalizationOutcome: 'CLASSIFIED' }, { reasonCode: 'SYNTHETIC_INTERNAL_SOURCE' }, { contractVersion: CONTRACT }, { sourceFingerprintSha256: dE1.fingerprint }].map((body) => classify(E2, asAdmin, body)),
  )
  check(
    'T022',
    'Server-derived, not client-chosen',
    forgedBodies.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')) && dE1.classified.ok && same(dE1.classification, INTERNAL) && C1.body.sourceFingerprintSha256 === dE1.fingerprint,
    'a supplied code, outcome, reason, contract or fingerprint is refused (400) even when it names the correct value; the stored values are exactly the classifier\'s on the source\'s own facts',
  )
  const rowC1 = await prisma.sourceEvidenceClassification.findUniqueOrThrow({ where: { id: C1.body.classificationId } })
  const sourceE1 = await prisma.revenueSourceEvidence.findUniqueOrThrow({ where: { id: E1 } })
  const sqlFingerprint = (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT ${FINGERPRINT_SQL} AS h FROM ${TABLE} c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE c.id = $1::uuid`, rowC1.id))[0]?.h
  check(
    'T023',
    'Exact A7.1 source record link',
    rowC1.sourceEvidenceId === E1 && rowC1.organizationId === sourceE1.organizationId && sourceE1.organizationId === org && sqlFingerprint === rowC1.sourceFingerprintSha256,
    'the row names exactly the path source record and its organization (derived server-side); the fingerprint, recomputed independently in SQL from that one record, matches',
  )
  const fingerprintText = sourceFingerprintText(dE1.facts)
  check(
    'T024',
    'Source kind preserved',
    sourceE1.sourceKind === SYNTHETIC && fingerprintText.includes(`\nsourceKind=${SYNTHETIC}\n`) && same((await get(`/api/revenue-source-evidence/${E1}`)).body, a71ReadBefore),
    'the A7.1 record still says INTERNAL_SYNTHETIC, the fingerprint binds that kind, and the A7.1 read is identical after classification',
  )
  check(
    'T025',
    'Source version preserved',
    sourceE1.sourceVersion === SOURCE_CONTRACT && fingerprintText.includes(`\nsourceVersion=${SOURCE_CONTRACT}\n`) && (await sourceHash()) === sourceRowsBefore,
    'the A7.1 contract A7-REVENUE-SOURCE-1 is bound into the fingerprint, and every byte of this run\'s A7.1 records is unchanged',
  )
  const payerTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(payer_response|remittance|import|inbound|adjudicat)'`).map((row) => row.t)
  check(
    'T026',
    'No imported payer source fabricated',
    delta(before21, after21).revenue_source_evidence === 0 && payerTables.length === 0 && Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM revenue_source_evidence WHERE source_kind <> 'INTERNAL_SYNTHETIC'`)[0].n) === 0,
    'classification registered no source record, no payer-response, remittance or import table exists, and every A7.1 source in the database is INTERNAL_SYNTHETIC',
  )
  const C2 = await classify(E2, B.who)
  const C3 = await classify(E3)
  check(
    'T027',
    'Distinct evidence stays distinct',
    C2.status === 201 && C3.status === 201 && new Set([C1.body.classificationId, C2.body.classificationId, C3.body.classificationId]).size === 3 && new Set([C1.body.sourceFingerprintSha256, C2.body.sourceFingerprintSha256, C3.body.sourceFingerprintSha256]).size === 3 && C2.body.recordedByUserId === B.id,
    'a second reference on the same submission (classified by the second Admin, who is named) and the same reference on another submission each get their own classification and fingerprint',
  )
  const readC1 = await get(classificationPath(C1.body.classificationId))
  check('T028', 'Exact readback', readC1.status === 200 && same(readC1.body, C1.body) && same(await historyOf(E1), [C1.body]), 'the single read and the history are exactly the create response')
  const verifiedRows = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${TABLE} WHERE classification_code LIKE 'EXTERNAL_%'`))[0].n)
  check('T029', 'No external verification from synthetic', verifiedRows === 0 && C1.body.classificationCode === 'INTERNAL_DECLARATION', 'no classification anywhere in the database claims an external source; synthetic evidence is an internal declaration')
  const dU = await derive(await registerSource(S2, 'DIRECT'))
  const caseSql = [await directInsert(dU, { code: 'internal_declaration', guardOff: true }), await directInsert(dU, { outcome: 'classified', guardOff: true }), await directInsert(dU, { reason: 'Synthetic_Internal_Source', guardOff: true }), await directInsert(dU, { contract: 'a7-evidence-class-1', guardOff: true })]
  check('T030', 'Case-sensitive controlled vocabulary', caseSql.every((message) => refusedBy(message, /_chk/)), `lower- or mixed-case code, outcome, reason and contract are refused by their CHECKs even with the guard switched off (${caseSql.map(markerOf).join(', ')})`)

  // ---------------------------------------------------------------- deterministic semantics (T031–T040)
  section('Deterministic semantics on sources A7.1 cannot register today (always rolled back), versions, removal, latest, A6 release and corrections')
  const countsBefore31 = await counts()
  const a71ConstraintsBefore = await hashOf(`SELECT c.oid::text AS id, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'revenue_source_evidence'::regclass`)
  const declaredSql = await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO revenue_source_evidence (id, organization_id, claim_submission_id, source_kind, source_reference, source_version, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'EXTERNAL_DECLARED', $3, $4, $5::uuid)`, org, S1, ref('DECL'), SOURCE_CONTRACT, creatorId)
      throw new Error(NOT_REFUSED)
    }),
  )
  const declared = await relaxedSource({ kind: 'EXTERNAL_DECLARED', reference: ref('DECLARED'), version: SOURCE_CONTRACT }, 'derived')
  const declaredForged = await relaxedSource({ kind: 'EXTERNAL_DECLARED', reference: ref('DECLARED'), version: SOURCE_CONTRACT }, 'internal')
  check(
    'T031',
    'External declared marked unverified',
    refusedBy(declaredSql, /revenue_source_evidence_kind_chk/) && outcomeOf(declared.classified) === 'EXTERNAL_SOURCE_UNVERIFIED/NEEDS_REVIEW/EXTERNAL_PROOF_ABSENT' && accepted(declared.message) && refusedBy(declaredForged.message, /source_evidence_classification_derivation/),
    `A7.1 cannot register EXTERNAL_DECLARED today (kind CHECK); such a source is classified ${outcomeOf(declared.classified)}, which the database guard accepts, and an INTERNAL_DECLARATION of it is refused — never a payer adjudication`,
  )
  const noOrigin = await relaxedSource({ kind: SYNTHETIC, reference: '', version: SOURCE_CONTRACT }, 'derived')
  const noOriginForged = await relaxedSource({ kind: SYNTHETIC, reference: '', version: SOURCE_CONTRACT }, 'internal')
  check(
    'T032',
    'Missing source origin fails closed',
    outcomeOf(noOrigin.classified) === 'INSUFFICIENT_CONTEXT/NEEDS_REVIEW/SOURCE_CONTEXT_MISSING' && accepted(noOrigin.message) && refusedBy(noOriginForged.message, /source_evidence_classification_derivation/) && same(classifySource({ ...dE1.facts, submissionOrganizationId: null }), { ok: true, value: { classificationCode: 'INSUFFICIENT_CONTEXT', normalizationOutcome: 'NEEDS_REVIEW', reasonCode: 'SOURCE_CONTEXT_MISSING' } }),
    `a source without its reference (or without its submission\'s organization) is ${outcomeOf(noOrigin.classified)}; the database accepts only that and refuses a CLASSIFIED claim of it`,
  )
  const noVersion = await relaxedSource({ kind: SYNTHETIC, reference: ref('NOVERSION'), version: '' }, 'derived')
  const noVersionForged = await relaxedSource({ kind: SYNTHETIC, reference: ref('NOVERSION'), version: '' }, 'internal')
  check(
    'T033',
    'Missing source version fails closed',
    outcomeOf(noVersion.classified) === 'INSUFFICIENT_CONTEXT/NEEDS_REVIEW/SOURCE_CONTEXT_MISSING' && accepted(noVersion.message) && refusedBy(noVersionForged.message, /source_evidence_classification_derivation/),
    `a source without its contract version is ${outcomeOf(noVersion.classified)}; a CLASSIFIED claim of it is refused by the database`,
  )
  const unsupportedKind = await relaxedSource({ kind: 'PAYER_PORTAL', reference: ref('PORTAL'), version: SOURCE_CONTRACT }, 'derived')
  const unsupportedKindForged = await relaxedSource({ kind: 'PAYER_PORTAL', reference: ref('PORTAL'), version: SOURCE_CONTRACT }, 'internal')
  const unsupportedContract = await relaxedSource({ kind: SYNTHETIC, reference: ref('NEXTCONTRACT'), version: 'A7-REVENUE-SOURCE-2' }, 'derived')
  check(
    'T034',
    'Unsupported kind without guessing',
    outcomeOf(unsupportedKind.classified) === 'UNSUPPORTED_SOURCE/UNSUPPORTED/SOURCE_KIND_UNSUPPORTED' && accepted(unsupportedKind.message) && refusedBy(unsupportedKindForged.message, /source_evidence_classification_derivation/) &&
      outcomeOf(unsupportedContract.classified) === 'UNSUPPORTED_SOURCE/UNSUPPORTED/SOURCE_CONTRACT_UNSUPPORTED' && accepted(unsupportedContract.message),
    `an unknown kind is ${outcomeOf(unsupportedKind.classified)} and an unknown A7.1 contract ${outcomeOf(unsupportedContract.classified)}; no guessed mapping is accepted by the database`,
  )
  const contradictory = await relaxedSource({ kind: SYNTHETIC, reference: ref('DIGEST'), version: SOURCE_CONTRACT, digest: 'a'.repeat(64) }, 'derived')
  const contradictoryForged = await relaxedSource({ kind: SYNTHETIC, reference: ref('DIGEST'), version: SOURCE_CONTRACT, digest: 'a'.repeat(64) }, 'internal')
  check(
    'T035',
    'Contradictory source fails closed',
    outcomeOf(contradictory.classified) === 'INSUFFICIENT_CONTEXT/NEEDS_REVIEW/SOURCE_CONTEXT_CONTRADICTORY' && accepted(contradictory.message) && refusedBy(contradictoryForged.message, /source_evidence_classification_derivation/) &&
      outcomeOf(classifySource({ ...dE1.facts, submissionOrganizationId: otherOrg })) === 'INSUFFICIENT_CONTEXT/NEEDS_REVIEW/SOURCE_CONTEXT_CONTRADICTORY',
    `a digest no trusted owner stands behind (or a source whose organization differs from its submission\'s) is ${outcomeOf(contradictory.classified)}; a CLASSIFIED claim of it is refused`,
  )
  const relaxedLeftNothing = (await hashOf(`SELECT c.oid::text AS id, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'revenue_source_evidence'::regclass`)) === a71ConstraintsBefore && (await unchanged(countsBefore31))
  const nextContract = await directInsert(dE1, { contract: 'A7-EVIDENCE-CLASS-2', guardOff: true })
  check(
    'T036',
    'New source version distinct history',
    C2.status === 201 && C2.body.sourceEvidenceId === E2 && same((await get(classificationPath(C1.body.classificationId))).body, C1.body) && refusedBy(nextContract, /source_evidence_classifications_contract_chk/) && relaxedLeftNothing,
    'E1-v2 (a new A7.1 record) took its own classification and E1\'s is byte-identical; a second classification contract is refused until a future owner admits it; every rolled-back A7.1 relaxation left the A7.1 constraints and all rows intact',
  )
  const removeSource = await attemptAdversarial(() => prisma.$executeRawUnsafe('DELETE FROM revenue_source_evidence WHERE id = $1::uuid', E1))
  const removeSourceRestrict = await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE revenue_source_evidence DISABLE TRIGGER revenue_source_evidence_append_only_trg')
      await tx.$executeRawUnsafe('DELETE FROM revenue_source_evidence WHERE id = $1::uuid', E1)
      throw new Error(NOT_REFUSED)
    }),
  )
  const Wd = await home.series('withdrawn', 1)
  const EWd = await registerSource(Wd.freezes[0], 'WITHDRAWN')
  await post(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle-events`, { eventCode: 'WITHDRAW_INTERNAL', reasonCode: 'INTERNAL_OTHER' })
  const onWithdrawn = await classify(EWd)
  check(
    'T037',
    'Source removal handled by owner',
    refusedBy(removeSource, /revenue_source_evidence is append-only/) && refusedBy(removeSourceRestrict, /source_evidence_classifications_source_evidence_id_fkey|foreign key/) && onWithdrawn.status === 201 && (await get(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle`)).body?.state === 'WITHDRAWN_INTERNAL',
    'A7.1 refuses removing a source record, and even with its guard switched off (rolled back) the RESTRICT key keeps a classified one; a WITHDRAWN_INTERNAL disposition is the A6.8 owner\'s and neither gates nor changes',
  )
  const latestRoutes = [await get(`/api/claim-submissions/${S1}/classifications`), await classify(`${S1}`), await get(`/api/claim-submissions/${S1}/revenue-source-evidence/latest`)]
  const classificationColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${TABLE}`).map((row) => row.c)
  check(
    'T038',
    'No automatic latest evidence selection',
    latestRoutes.every((res) => res.status === 404) && !classificationColumns.some((c) => /current|latest|newest|superseded|claim_submission/.test(c)) && same((await historyOf(E1)).map((i: any) => i.classificationId), [C1.body.classificationId]),
    'a classification names one exact source id from the path; a submission id is not a source (404), there is no "latest" route or column, and classifying E1-v2 did not touch E1',
  )
  const Re = await home.series('release eligible', 1)
  const ERe = await registerSource(Re.freezes[0], 'RELEASED')
  await post(`/api/claim-submissions/${Re.freezes[0]}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null })
  const reFreezeBefore = await freezeHash(Re.claimId)
  const reLifecycleBefore = await lifecycleHash(Re.claimId)
  const onReleased = await classify(ERe)
  check(
    'T039',
    'A6 internal release not reinterpreted',
    onReleased.status === 201 && onReleased.body.classificationCode === 'INTERNAL_DECLARATION' && (await get(`/api/claim-submissions/${Re.freezes[0]}/lifecycle`)).body?.state === 'RELEASE_ELIGIBLE' && (await freezeHash(Re.claimId)) === reFreezeBefore && (await lifecycleHash(Re.claimId)) === reLifecycleBefore,
    'evidence on a RELEASE_ELIGIBLE freeze is still an INTERNAL_DECLARATION — never sent, paid or accepted — and the freeze and lifecycle are byte-identical',
  )
  const Cr = await home.series('corrected', 2)
  const ECrPrior = await registerSource(Cr.freezes[0], 'PRIOR')
  const ECrNext = await registerSource(Cr.freezes[1], 'CORRECTED')
  const linked = await post(`/api/claims/${Cr.claimId}/correction-links`, { priorSubmissionId: Cr.freezes[0], correctedSubmissionId: Cr.freezes[1], reasonCode: 'CORRECTED_CODING' })
  const chainBefore = await correctionHash(Cr.claimId)
  const onPrior = await classify(ECrPrior)
  const onCorrected = await classify(ECrNext)
  check(
    'T040',
    'Correction chain not mutated',
    linked.status === 201 && onPrior.status === 201 && onCorrected.status === 201 && same(onPrior.body.classificationCode, onCorrected.body.classificationCode) && (await correctionHash(Cr.claimId)) === chainBefore,
    'sources on a corrected prior and on its successor are classified alike, independently; the A6.9 link is byte-identical and nothing says "newest" or "current"',
  )

  // ---------------------------------------------------------------- idempotency (T041–T050)
  section('Idempotent replay, recorded disagreement, duplicate SQL, identical and conflicting races, read-after-commit')
  const before41 = await counts()
  const replay1 = await classify(E1)
  const replayNoBody = await api('POST', sourcePath(E1), undefined)
  const replayByB = await classify(E1, B.who)
  check('T041', 'Same request replays 200', [replay1, replayNoBody, replayByB].every((res) => res.status === 200 && same(res.body, C1.body)) && replayByB.body.recordedByUserId === creatorId, 'the same request (with {}, with no body, and by another Admin): 200 with exactly the original record and its original actor')
  const d41 = delta(before41, await counts())
  check('T042', 'Replay writes zero rows', d41[TABLE] === 0 && d41.revenue_source_evidence === 0, 'three replays wrote no classification and no source record')
  check('T043', 'Replay writes zero audits', d41.audit_events === 0 && (await prisma.auditEvent.count({ where: { entityId: C1.body.classificationId } })) === 1, 'three replays wrote no audit; the classification still has exactly one')
  const replaysLeftNothing = await unchanged(before41)
  // A recorded row that disagrees with its re-derivation cannot be written through any guard, so it is forged in a
  // transaction that is ALWAYS rolled back (row triggers off) and judged by the production replay decision.
  const dQ = await derive(await registerSource(S2, 'FORGED'))
  const forgedRecord = async (change: { code?: Classification; fingerprint?: string }) => {
    const out: { agrees?: boolean } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        const value = change.code ?? dQ.classification
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, organization_id, source_evidence_id, contract_version, classification_code, normalization_outcome, reason_code, source_fingerprint_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)`,
          dQ.organizationId, dQ.id, CONTRACT, value.classificationCode, value.normalizationOutcome, value.reasonCode, change.fingerprint ?? dQ.fingerprint, creatorId,
        )
        const recorded = await findClassificationByIdentity(dQ.id, CONTRACT, tx)
        const derivedNow = await derive(dQ.id, tx)
        if (recorded) out.agrees = recordedClassificationAgrees(recorded, { ...derivedNow.classification, sourceFingerprintSha256: derivedNow.fingerprint, organizationId: derivedNow.organizationId })
        throw new Error(NOT_REFUSED)
      }),
    )
    return { ...out, message }
  }
  const serviceCode = committedCode(`${MODULE_DIR}/evidence-classification.service.ts`)
  const routeCode = committedCode(`${MODULE_DIR}/evidence-classification.route.ts`)
  const conflictWired =
    /if \(!recordedClassificationAgrees\(existing, derived\)\)\s*return refuse\('EVIDENCE_CLASSIFICATION_CONFLICT'/.test(serviceCode) && /code === 'NOT_FOUND' \? 404 : code === 'VALIDATION_ERROR' \? 400 : 409/.test(routeCode)
  const agreeing = await forgedRecord({})
  const changedCode = await forgedRecord({ code: { classificationCode: 'EXTERNAL_SOURCE_UNVERIFIED', normalizationOutcome: 'NEEDS_REVIEW', reasonCode: 'EXTERNAL_PROOF_ABSENT' } })
  check(
    'T044',
    'Changed classification returns 409',
    accepted(agreeing.message) && agreeing.agrees === true && accepted(changedCode.message) && changedCode.agrees === false && conflictWired,
    'a recorded row with a different classification (forged, rolled back) is judged a disagreement by the production decision, which the service answers as EVIDENCE_CLASSIFICATION_CONFLICT (409) and never rewrites; the matching control row agrees',
  )
  const changedFingerprint = await forgedRecord({ fingerprint: 'f'.repeat(64) })
  const fingerprintSql = await directInsert(dQ, { fingerprint: 'f'.repeat(64) })
  check(
    'T045',
    'Changed fingerprint returns 409',
    accepted(changedFingerprint.message) && changedFingerprint.agrees === false && conflictWired && refusedBy(fingerprintSql, /source_evidence_classification_fingerprint/),
    'a recorded row with another fingerprint is a disagreement (409, never rewritten), and the database refuses to store such a row at all',
  )
  const duplicateSql = await directInsert(dE1)
  check('T046', 'Duplicate direct SQL refused', refusedBy(duplicateSql, /source_evidence_classifications_identity_key|duplicate key/), `a second, otherwise valid row for E1 inserted directly is refused by the unique identity (${markerOf(duplicateSql)})`)
  const R47 = await registerSource(S1, 'RACE-2')
  const before47 = await counts()
  const pair = await Promise.all([classify(R47), classify(R47)])
  const d47 = delta(before47, await counts())
  check('T047', 'Concurrent identical, one row', same(pair.map((r) => r.status).sort(), [200, 201]) && same(pair[0].body, pair[1].body) && d47[TABLE] === 1 && d47.audit_events === 1, `${pair.map((r) => r.status).sort().join('/')}: one classification, one audit, one identical body`)
  const R48 = await registerSource(S1, 'RACE-6')
  const before48 = await counts()
  const six = await Promise.all([classify(R48), classify(R48), classify(R48, B.who), classify(R48), classify(R48, asAdmin, { classificationCode: 'EXTERNAL_SOURCE_VERIFIED' }), classify(R48, B.who, { reasonCode: 'EXTERNAL_PROOF_ABSENT' })])
  const d48 = delta(before48, await counts())
  const valid48 = six.slice(0, 4)
  const created48 = valid48.find((r) => r.status === 201)
  check(
    'T048',
    'Concurrent conflicting deterministic',
    valid48.filter((r) => r.status === 201).length === 1 && valid48.filter((r) => r.status === 200).length === 3 && valid48.every((r) => same(r.body, created48?.body)) && six.slice(4).every((r) => r.status === 400) && d48[TABLE] === 1 && d48.audit_events === 1,
    `six at once (two actors, two forged bodies): ${six.map((r) => (r.status >= 300 ? `${r.status} ${errorCode(r.body) ?? ''}`.trim() : r.status)).join('/')}; ${d48[TABLE]} classification and ${d48.audit_events} audit, every success the same record`,
  )
  const twice = [await historyOf(E1), await historyOf(E1)]
  const viewerTwice = await historyOf(E1, asViewer)
  const inTx = await withReadSnapshot(undefined, (tx) => getClassificationsOf(E1, tx))
  check('T049', 'Read-after-commit stable', same(twice[0], twice[1]) && same(viewerTwice, twice[0]) && same(twice[0], [C1.body]) && inTx.ok && same(inTx.value.items, twice[0]), 'the committed history reads identically twice, for a Viewer, and through getClassificationsOf(sourceId, tx) for later owners')
  const c1Hash = () => hashOf(`SELECT c.* FROM ${TABLE} c WHERE c.id = $1::uuid`, C1.body.classificationId)
  const c1Before = await c1Hash()
  const rewrites = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET classification_code = 'UNSUPPORTED_SOURCE' WHERE id = $1::uuid`, C1.body.classificationId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, C1.body.classificationId)),
  ]
  check('T050', 'No silent rewrite or delete', rewrites.every((message) => /is append-only/.test(message)) && (await c1Hash()) === c1Before, 'a rewrite and a delete are refused and the classification is byte-identical')

  // ---------------------------------------------------------------- direct SQL (T051–T060)
  section('Direct SQL: RESTRICT keys, tenant coherence, CHECKs with the guard off and NULL pitfalls, identity, database time, immutability')
  const fkRows = await prisma.$queryRaw<{ name: string; del: string }[]>`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = ${TABLE}`
  check('T051', 'Foreign keys RESTRICT', fkRows.length === 3 && fkRows.every((row) => row.del === 'r') && refusedBy(removeSourceRestrict, /foreign key|_fkey/), 'organization, source record and actor keys are all ON DELETE RESTRICT (a classified source cannot be deleted, T037); nothing cascades')
  const crossOrg = await directInsert(dU, { organization: otherOrg })
  check('T052', 'Tenant coherence checked by database', refusedBy(crossOrg, /source_evidence_classification_coherence/), 'a classification naming another organization than its source\'s is refused by the database guard')
  const contractSql = [await directInsert(dU, { contract: 'A7-EVIDENCE-CLASS-0', guardOff: true }), await directInsert(dU, { contract: null, guardOff: true }), await directInsert(dU, { contract: 'A7-EVIDENCE-CLASS-0' })]
  check(
    'T053',
    'Contract version CHECK',
    refusedBy(contractSql[0], /source_evidence_classifications_contract_chk/) && refusedBy(contractSql[1], /null value/) && refusedBy(contractSql[2], /source_evidence_classification_fingerprint|contract_chk/),
    `another contract is refused by its CHECK and NULL by NOT NULL (guard off); with the guard on, the contract is bound into the fingerprint and refused there first (${contractSql.map(markerOf).join(', ')})`,
  )
  const codeSql = [await directInsert(dU, { code: 'PAID', guardOff: true }), await directInsert(dU, { code: null, guardOff: true }), await directInsert(dU, { code: 'UNSUPPORTED_SOURCE' })]
  check('T054', 'Classification vocabulary CHECK', refusedBy(codeSql[0], /source_evidence_classifications_code_chk/) && refusedBy(codeSql[1], /null value/) && refusedBy(codeSql[2], /source_evidence_classification_derivation/), `an invented code is refused by the CHECK, NULL by NOT NULL (with the guard off), a valid but underived one by the guard (${codeSql.map(markerOf).join(', ')})`)
  const outcomeSql = [await directInsert(dU, { outcome: 'ACCEPTED', guardOff: true }), await directInsert(dU, { outcome: 'DENIED', guardOff: true }), await directInsert(dU, { outcome: null, guardOff: true }), await directInsert(dU, { outcome: 'NEEDS_REVIEW' })]
  check('T055', 'Outcome vocabulary CHECK', outcomeSql.slice(0, 2).every((m) => refusedBy(m, /source_evidence_classifications_outcome_chk/)) && refusedBy(outcomeSql[2], /null value/) && refusedBy(outcomeSql[3], /derivation/), `ACCEPTED and DENIED are refused by the CHECK, NULL by NOT NULL, an underived outcome by the guard (${outcomeSql.map(markerOf).join(', ')})`)
  const reasonSql = [await directInsert(dU, { reason: 'Patient said so', guardOff: true }), await directInsert(dU, { reason: null, guardOff: true }), await directInsert(dU, { reason: 'EXTERNAL_PROOF_ABSENT' })]
  const reasonDef = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'source_evidence_classifications_reason_chk'`)[0]?.def ?? ''
  check(
    'T056',
    'Reason vocabulary CHECK with NULL',
    refusedBy(reasonSql[0], /source_evidence_classifications_reason_chk/) && refusedBy(reasonSql[1], /null value/) && refusedBy(reasonSql[2], /derivation/) && /reason_code IS NOT NULL/.test(reasonDef),
    `free text is refused by the CHECK, NULL by NOT NULL and by the CHECK's own explicit IS NOT NULL (so UNKNOWN never passes), an underived reason by the guard (${reasonSql.map(markerOf).join(', ')})`,
  )
  const identityIndex = await prisma.$queryRaw<{ def: string }[]>`SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'source_evidence_classifications_identity_key'`
  check('T057', 'Unique identity constraint', /CREATE UNIQUE INDEX source_evidence_classifications_identity_key ON public\.source_evidence_classifications USING btree \(source_evidence_id, contract_version\)/.test(identityIndex[0]?.def ?? '') && refusedBy(duplicateSql, /identity_key|duplicate key/), 'UNIQUE (source_evidence_id, contract_version): one classification per source record and contract (T046)')
  const timeRow = await prisma.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT recorded_at = created_at AND recorded_at <= now() AS ok FROM ${TABLE} WHERE id = $1::uuid`, C1.body.classificationId)
  const timeSql = [await directInsert(dU, { recordedAt: true }), await directInsert(dU, { createdAt: true })]
  check(
    'T058',
    'Database-owned timestamps',
    timeRow[0]?.ok === true && timeSql.every((m) => refusedBy(m, /source_evidence_classification_time/)) && C1.body.recordedAt === rowC1.recordedAt.toISOString(),
    'recorded and created at the database\'s own transaction time; a backdated or future instant is refused; the DTO carries that instant',
  )
  const noOpUpdate = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET reason_code = reason_code WHERE id = $1::uuid`, C1.body.classificationId))
  check('T059', 'Direct update blocked, even no-op', /is append-only: UPDATE is not permitted/.test(noOpUpdate) && /is append-only/.test(rewrites[0]), 'a no-op UPDATE and a real one are refused')
  const truncateTrigger = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'source_evidence_classifications'::regclass AND tgname = 'source_evidence_classifications_no_truncate_trg'`)[0]?.def ?? ''
  const beforeWipe = await classificationHash()
  const wipes = [
    await attemptAdversarial(() => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`)
      throw new Error(NOT_REFUSED)
    })),
    await attemptAdversarial(() => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`)
      throw new Error(NOT_REFUSED)
    })),
  ]
  // A later owner's ON DELETE RESTRICT key into this table (A7.3 readiness results) makes PostgreSQL refuse a plain
  // TRUNCATE before any trigger runs; TRUNCATE … CASCADE still reaches this guard first. Judged on behaviour: both
  // are refused by a real guard, the guard exists, and nothing changed.
  const referencedBy = await prisma.$queryRaw<{ t: string; del: string }[]>`SELECT conrelid::regclass::text AS t, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND confrelid = 'source_evidence_classifications'::regclass`
  const plainRefusedByGuard = refusedBy(wipes[0], /source_evidence_classifications is append-only: TRUNCATE is not permitted/)
  const plainRefusedByKey = refusedBy(wipes[0], /cannot truncate a table referenced in a foreign key constraint/) && referencedBy.length > 0 && referencedBy.every((row) => row.del === 'r')
  check(
    'T060',
    'Direct delete blocked',
    /is append-only: DELETE is not permitted/.test(rewrites[1]) && (plainRefusedByGuard || plainRefusedByKey) && refusedBy(wipes[1], /source_evidence_classifications is append-only: TRUNCATE is not permitted/) &&
      /^CREATE TRIGGER source_evidence_classifications_no_truncate_trg BEFORE TRUNCATE ON public\.source_evidence_classifications FOR EACH STATEMENT EXECUTE FUNCTION source_evidence_classifications_append_only\(\)$/.test(truncateTrigger) &&
      (await classificationHash()) === beforeWipe,
    `DELETE and TRUNCATE … CASCADE are refused by the guard, TRUNCATE by ${plainRefusedByGuard ? 'the guard' : `the RESTRICT key of ${referencedBy.map((row) => row.t).join(', ')}`} (both bypass row triggers); every classification is byte-identical afterwards`,
  )

  // ---------------------------------------------------------------- database backstop and atomicity (T061–T070)
  section('Database backstop (foreign organization, forged source, VERIFIED, fingerprint, reused identity), crash rollback, audits')
  const dEF = await derive(EF)
  const foreignSql = [await directInsert(dEF, { organization: org }), await directInsert(dE1, { organization: otherOrg })]
  check('T061', 'Database rejects foreign organization', foreignSql.every((m) => refusedBy(m, /source_evidence_classification_coherence/)), 'this organization classifying the other one\'s source, or the reverse, is refused by the coherence guard')
  const forgedSourceSql = [await directInsert(dU, { source: MISSING }), await directInsert(dU, { source: E3 }), await directInsert(dU, { actor: MISSING })]
  check(
    'T062',
    'Database rejects forged A7.1 reference',
    refusedBy(forgedSourceSql[0], /source_evidence_id_fkey|foreign key/) && refusedBy(forgedSourceSql[1], /source_evidence_classification_fingerprint/) && refusedBy(forgedSourceSql[2], /recorded_by_user_id_fkey|foreign key/),
    'a non-existent source is refused by its key, a real but different source by the fingerprint (which binds the exact record), a non-existent actor by its key',
  )
  const verifiedSql = [await directInsert(dU, { code: 'EXTERNAL_SOURCE_VERIFIED', guardOff: true }), await directInsert(dU, { code: 'EXTERNAL_SOURCE_VERIFIED' })]
  const verifiedSource = await relaxedSource({ kind: 'EXTERNAL_VERIFIED', reference: ref('VERIFIED'), version: SOURCE_CONTRACT }, 'unverified')
  check(
    'T063',
    'Database refuses forged VERIFIED',
    refusedBy(verifiedSql[0], /source_evidence_classifications_verified_disabled_chk/) && refusedBy(verifiedSql[1], /derivation|verified_disabled_chk/) && refusedBy(verifiedSource.message, /source_evidence_classification_derivation/),
    'EXTERNAL_SOURCE_VERIFIED is refused by its disabling CHECK (guard off) and by the guard; a source claiming EXTERNAL_VERIFIED (rolled back) can carry no classification at all',
  )
  const badFingerprints = [await directInsert(dU, { fingerprint: 'XYZ', guardOff: true }), await directInsert(dU, { fingerprint: 'A'.repeat(64), guardOff: true }), await directInsert(dU, { fingerprint: 'a'.repeat(63), guardOff: true }), await directInsert(dU, { fingerprint: null, guardOff: true })]
  check('T064', 'Database refuses malformed fingerprint', badFingerprints.every((m) => refusedBy(m, /source_evidence_classifications_fingerprint_chk|null value/)), `non-hex, upper-case, short and NULL fingerprints are refused (${badFingerprints.map(markerOf).join(', ')})`)
  const reusedIdentity = [await directInsert(dE1, { code: 'UNSUPPORTED_SOURCE', outcome: 'UNSUPPORTED', reason: 'SOURCE_KIND_UNSUPPORTED' }), await directInsert(dE1, { fingerprint: dU.fingerprint })]
  check('T065', 'Reused identity with changed data refused', reusedIdentity.every((m) => refusedBy(m, /derivation|fingerprint|identity_key|duplicate key/)), `E1 again with another classification or another fingerprint is refused (${reusedIdentity.map(markerOf).join(', ')})`)
  const control = await directInsert(dU)
  check('T066', 'Valid fixture via owner route passes', accepted(control), 'a correct classification of a source registered through the A7.1 route, inserted directly, is accepted (then rolled back): the refusals around it are the guards, not the setup')
  const K = await registerSource(S2, 'CRASH')
  const countsBeforeCrash = await counts()
  const crashAt = async (probe: string) => {
    failAt(probe)
    const message = await attemptAdversarial(() => classifySourceEvidence(K, {}, creatorId))
    clearConcurrencyProbes()
    return { message, unchanged: await unchanged(countsBeforeCrash), visible: (await historyOf(K)).length }
  }
  const crash1 = await crashAt('evidenceClassification.inserted')
  const crash2 = await crashAt('evidenceClassification.audited')
  check('T067', 'Crash after row rolls back', crash1.message.includes('INJECTED_CRASH') && crash1.unchanged && crash1.visible === 0, 'a failure after the classification insert rolls back everything: no row, no audit, nothing to read')
  check('T068', 'Crash after audit rolls back both', crash2.message.includes('INJECTED_CRASH') && crash2.unchanged && crash2.visible === 0, 'a failure after the audit, before commit, rolls back the classification and the audit')
  const retry = await classify(K)
  const auditOnce = await prisma.$queryRawUnsafe<{ bad: bigint }[]>(`SELECT count(*) AS bad FROM ${TABLE} c WHERE (SELECT count(*) FROM audit_events a WHERE a.entity_id = c.id AND a.action_code = 'evidence_classification.recorded') <> 1`)
  const auditC1 = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: C1.body.classificationId } })
  const auditC2 = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: C2.body.classificationId } })
  check(
    'T069',
    'One audit per new classification',
    retry.status === 201 && (await prisma.sourceEvidenceClassification.count({ where: { sourceEvidenceId: K } })) === 1 && Number(auditOnce[0].bad) === 0 &&
      auditC1.actionCode === 'evidence_classification.recorded' && auditC1.entityType === 'EVIDENCE_CLASSIFICATION' && auditC1.actorUserId === creatorId && auditC2.actorUserId === B.id && auditC1.organizationId === org,
    'the safe rerun after both crashes classifies exactly once; every classification in the database has exactly one evidence_classification.recorded audit on EVIDENCE_CLASSIFICATION, naming its actor and organization',
  )
  check('T070', 'Failed requests produce no audit', refusalsLeftNothing && replaysLeftNothing && crash1.unchanged && crash2.unchanged, 'every 400/401/403/404, every replay and both crashes wrote no classification and no audit')

  // ---------------------------------------------------------------- concurrency (T071–T080)
  section('Concurrency: Claim lock first with A6 and A7.1 writers, SERIALIZABLE, bounded retries, unique backstop, unknown outcome, no partial reads')
  const txBody = serviceCode.slice(serviceCode.indexOf('async function classifyOnTransaction'), serviceCode.indexOf('export async function classifySourceEvidence'))
  const L = await home.series('line edit', 1)
  const EL = await registerSource(L.freezes[0], 'LINE')
  const hold71 = holdAt('claimLine.removed')
  const removal = removeClaimLine(L.lineIds[1], {}, creatorId)
  await Promise.race([hold71.arrived, removal])
  const c71 = classifySourceEvidence(EL, {}, creatorId)
  const waited71 = !(await settledWithin(c71, 3000))
  hold71.release()
  const [removed71, r71] = await Promise.all([removal, c71])
  clearConcurrencyProbes()
  const E71 = await registerSource(S1, 'A71-RACE')
  const hold71b = holdAt('evidenceClassification.claim_locked')
  const c71b = classifySourceEvidence(E71, {}, creatorId)
  await Promise.race([hold71b.arrived, c71b])
  const reg71b = registerRevenueSourceEvidence(S1, { sourceKind: SYNTHETIC, sourceReference: ref('DURING-CLASSIFY') }, creatorId)
  const waited71b = !(await settledWithin(reg71b, 3000))
  hold71b.release()
  const [r71b, g71b] = await Promise.all([c71b, reg71b])
  clearConcurrencyProbes()
  check(
    'T071',
    'Claim lock ordering compatible with A6',
    /lockRowForUpdateNowait\(tx, 'claims', owner\.claimId\)/.test(txBody.split('\n').slice(0, 3).join('\n')) && waited71 && removed71.ok && r71.ok && !r71.value.replayed && waited71b && r71b.ok && g71b.ok,
    'the Claim row lock (NOWAIT) is the first statement; a classification during an uncommitted A6.2 line edit waits for it, and an A7.1 registration during an in-flight classification waits too; all commit',
  )
  check('T072', 'SERIALIZABLE isolation', /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && !/withReadSnapshot|prisma\./.test(txBody), 'one SERIALIZABLE transaction client carries every read and write of a classification')
  const Lc = await home.series('lifecycle race', 1)
  const ELc = await registerSource(Lc.freezes[0], 'LIFECYCLE')
  const hold73 = holdAt('evidenceClassification.claim_locked')
  const c73 = classifySourceEvidence(ELc, {}, creatorId)
  await Promise.race([hold73.arrived, c73])
  const event73 = recordLifecycleEvent(Lc.freezes[0], { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }, creatorId)
  const waited73 = !(await settledWithin(event73, 3000))
  hold73.release()
  const [r73, e73] = await Promise.all([c73, event73])
  clearConcurrencyProbes()
  check(
    'T073',
    'Retry after serialization conflict',
    /P2034/.test(serviceCode) && /40001/.test(serviceCode) && /const MAX_CLASSIFICATION_ATTEMPTS = 3/.test(serviceCode) && waited73 && r73.ok && e73.ok && e73.value.lifecycle.state === 'RELEASE_ELIGIBLE' && same(pair.map((r) => r.status).sort(), [200, 201]),
    'serialization failures and deadlocks retry on a fresh transaction (at most three times); an A6.8 event during an in-flight classification waits and both commit; the races above ended in 201/200 without a 409',
  )
  const R74 = await registerSource(S2, 'HELD')
  const hold74 = holdAt('evidenceClassification.inserted')
  const first74 = classifySourceEvidence(R74, {}, creatorId)
  await Promise.race([hold74.arrived, first74])
  const second74 = classifySourceEvidence(R74, {}, B.id)
  const waited74 = !(await settledWithin(second74, 3000))
  hold74.release()
  const [r74a, r74b] = await Promise.all([first74, second74])
  clearConcurrencyProbes()
  check(
    'T074',
    'Bounded lock contention retries',
    /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode) && /await pauseAfterLockWait\(\)/.test(serviceCode) && waited74 && r74a.ok && !r74a.value.replayed && r74b.ok && r74b.value.replayed && same(r74a.value.classification, r74b.value.classification),
    'a second classification during an uncommitted first waits for the Claim lock (within a 30-second budget, with a short random pause), then replays the committed record',
  )
  const R75 = await registerSource(S2, 'IN-PROCESS')
  const inProcess = await Promise.all([1, 2, 3].map(() => classifySourceEvidence(R75, {}, creatorId)))
  check(
    'T075',
    'Unique race backstop',
    /isUniqueViolation\(error\)/.test(serviceCode) && inProcess.every((r) => r.ok) && inProcess.filter((r) => r.ok && !r.value.replayed).length === 1 && (await prisma.sourceEvidenceClassification.count({ where: { sourceEvidenceId: R75 } })) === 1,
    'three identical in-process classifications: one new, two replays, one row; a unique collision is retried into the replay, backed by the identity index (T057)',
  )
  check(
    'T076',
    'No blind retry on unknown outcome',
    /if \(isUnknownOutcome\(error\)\)\s*return \{ ok: false, code: 'EVIDENCE_CLASSIFICATION_CONFLICT'/.test(serviceCode) && /P2028/.test(serviceCode) && /Connection terminated/.test(serviceCode),
    'a lost connection or transaction is a safe 409 telling the caller to read the classifications back, never a second insert',
  )
  check(
    'T077',
    'Read-back after uncertain commit',
    crash2.visible === 0 && same((await historyOf(K)).map((i: any) => i.classificationId), [retry.body.classificationId]) && same((await get(classificationPath(retry.body.classificationId))).body, retry.body),
    'after a failure the caller reads the history (empty: nothing committed); after the safe rerun it shows exactly one classification, readable by id',
  )
  const R78 = await registerSource(S2, 'ISOLATION')
  const hold78 = holdAt('evidenceClassification.audited')
  const pending78 = classifySourceEvidence(R78, {}, creatorId)
  await Promise.race([hold78.arrived, pending78])
  const during78 = get(sourcePath(R78))
  const prompt78 = await settledWithin(during78, 5000)
  const duringItems = (await during78).body?.items ?? null
  hold78.release()
  const r78 = await pending78
  clearConcurrencyProbes()
  check('T078', 'Reads never observe partial state', prompt78 && Array.isArray(duringItems) && duringItems.length === 0 && r78.ok && (await historyOf(R78)).length === 1, 'a read while a classification and its audit are uncommitted answers at once with committed history only (none); after commit, one')
  const orphanAudits = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM audit_events a WHERE a.action_code = 'evidence_classification.recorded' AND NOT EXISTS (SELECT 1 FROM ${TABLE} c WHERE c.id = a.entity_id)`)
  const duplicates = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM (SELECT 1 FROM ${TABLE} GROUP BY source_evidence_id, contract_version HAVING count(*) > 1) d`)
  const drifted = await prisma.$queryRawUnsafe<{ n: bigint; total: bigint }[]>(`SELECT count(*) FILTER (WHERE c.source_fingerprint_sha256 <> ${FINGERPRINT_SQL} OR c.organization_id <> r.organization_id) AS n, count(*) AS total FROM ${TABLE} c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id`)
  check(
    'T079',
    'No integrity gaps after races',
    Number(orphanAudits[0].n) === 0 && Number(duplicates[0].n) === 0 && Number(drifted[0].n) === 0 && Number(drifted[0].total) > 0,
    `after every race no audit lacks its classification, no identity is duplicated, and all ${Number(drifted[0].total)} classifications in the database match the fingerprint recomputed independently from their source`,
  )
  check(
    'T080',
    'No ambient transaction outside owner',
    /getRevenueSourceEvidenceOf\(source\.facts\.claimSubmissionId as string, tx\)/.test(txBody) && /findSourceForClassification\(sourceEvidenceId, tx\)/.test(txBody) && /insertClassification\(\s*\{[\s\S]*?\},\s*tx,?\s*\)/.test(txBody) && /recordAuditEvent\([\s\S]*?\},\s*tx,?\s*\)/.test(txBody) && !/prisma\./.test(txBody),
    'the source re-read, the A7.1 owner read, the insert and the audit all run on the one transaction the classification opened; nothing reaches the global client inside it',
  )

  // ---------------------------------------------------------------- privacy (T081–T090)
  section('Privacy: organization boundary on reads, minimal DTO and audit, no logs or browser storage, safe errors, no query-string identifiers')
  const CF = await classify(EF, O.who)
  const foreignReads = [await get(classificationPath(C1.body.classificationId), O.who), await get(sourcePath(E1), O.who), await get(classificationPath(CF.body?.classificationId ?? MISSING))]
  const missingReadAsForeign = await get(classificationPath(MISSING), O.who)
  check(
    'T081',
    'Organization boundary on reads',
    CF.status === 201 && foreignReads.every((res) => res.status === 404) && same(foreignReads[0].body?.error?.message, missingReadAsForeign.body?.error?.message),
    'the other organization classifies its own source (201) but reads neither this tenant\'s classification nor its history, and this tenant cannot read theirs: 404, exactly like a missing one',
  )
  const dtos = [C1.body, C2.body, C3.body, readC1.body, ...twice[0], onReleased.body, CF.body]
  const exposed = JSON.stringify([dtos, auditC1.afterState, auditC2.afterState])
  check('T082', 'No patient/member data in DTO', !exposed.includes(`${runId}-home-P`) && !exposed.includes(`${runId}-away-P`) && !exposed.includes('1990-01-01') && ![...deepKeys(JSON.parse(exposed))].some((k) => /patient|member|name|birth|email|phone|address/i.test(k)), 'no patient name, birth date, member or contact field in any DTO or audit')
  check('T083', 'No diagnosis/procedure in DTO', !/-DXA|-PA|-XA|-SB|procedure|diagnos/i.test(exposed), 'no diagnosis or procedure code, name or key in any DTO or audit')
  check('T084', 'No amounts or balances in DTO', !/125\.25|12\.125|200\.01|AED/.test(exposed) && ![...deepKeys(JSON.parse(exposed))].some((k) => /amount|balance|currency|paid|price|tariff/i.test(k)), 'no amount, currency, balance, price or paid key or value')
  check('T085', 'No raw evidence bytes over HTTP', ![...deepKeys(JSON.parse(exposed))].some((k) => /bytes|payload|manifest|seal|digest|sourceReference|raw/i.test(k)) && !exposed.includes(ref('E1')), 'no payload bytes, manifest, seal, digest or even the opaque source reference leave the server; only ids, codes, the contract, the fingerprint and instants')
  check(
    'T086',
    'Audit metadata minimal',
    same(Object.keys(auditC1.afterState as object).sort(), [...AUDIT_KEYS].sort()) && auditC1.beforeState === null && (auditC1.afterState as any).recordedAt === rowC1.recordedAt.toISOString(),
    'the audit carries exactly ids, the controlled codes, the contract and the database instant — no fingerprint, reference, PHI or amount',
  )
  const production = committedProductionCodeOf([MODULE_DIR])
  check('T087', 'No logging of evidence', production.files.length === 6 && !/console\.|logger\./.test(production.code), 'the six A7.2 backend files log nothing')
  const frontend = committedCode(`${FE_DIR}/EvidenceClassificationCheck.tsx`)
  const registry = committedCode('frontend/src/developer/checkRegistry.tsx')
  check(
    'T088',
    'No browser local/session storage',
    frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend) && /key: 'evidence-classification'/.test(registry) && /\/classifications`\)/.test(frontend) && !/fetch\([^)]*,\s*\{/.test(frontend),
    'the Developer Tools page is registered, makes one plain GET (no request options, so no write) and keeps nothing in browser storage',
  )
  const errorBodies = [...nonObject, ...unknownFields, ...malformed, ...anon, viewerPost, ...foreignOnHome, ...homeOnForeign, ...missingSource, ...spoofs, ...forgedBodies, ...six.slice(4), ...foreignReads]
  const viewerPostAgain = await classify(E1, asViewer)
  check(
    'T089',
    'Safe deterministic error body',
    errorBodies.every((res) => !rawError(res.body) && typeof res.body?.error?.code === 'string' && typeof res.body?.error?.message === 'string') && same({ ...viewerPostAgain.body.error, requestId: null }, { ...viewerPost.body.error, requestId: null }),
    `all ${errorBodies.length} refusals carry a code, a safe message and a request id only; the same refusal repeats exactly`,
  )
  const queryPost = await post(`${sourcePath(E1)}?sourceEvidenceId=${E2}&token=SYN-SECRET&classificationCode=EXTERNAL_SOURCE_VERIFIED`, {})
  const queryList = await get(`${sourcePath(E1)}?evidenceId=${E2}`)
  const queryCollection = await get(`/api/revenue-evidence-classifications?sourceEvidenceId=${E1}`)
  check(
    'T090',
    'Query-string identifiers ignored',
    queryPost.status === 200 && same(queryPost.body, C1.body) && same(queryList.body?.items, [C1.body]) && queryCollection.status === 404 && !/req\.query/.test(routeCode) && same((await get(classificationPath(C1.body.classificationId), asViewer)).body, C1.body),
    'a source id, token or classification in the query string changes nothing (the path source is replayed, 200); no route reads req.query; there is no query-driven collection; a Viewer reads the single record',
  )

  // ---------------------------------------------------------------- determinism and no fiction (T091–T100)
  section('Stable history, determinism across time zone and locale, no fallback to CLASSIFIED, external proof prerequisite, no money fiction')
  const sqlOrder = (await prisma.sourceEvidenceClassification.findMany({ where: { sourceEvidenceId: { in: [E1, E2, E3] } }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }], select: { id: true, sourceEvidenceId: true } })).filter((row) => row.sourceEvidenceId === E1).map((row) => row.id)
  check('T091', 'History stable ordering', same(twice[0].map((item: any) => item.classificationId), sqlOrder) && same(twice[0], twice[1]), 'the history is the database-recorded order (then id) and reads identically every time')
  const repeated = Array.from({ length: 50 }, () => JSON.stringify([classifySource(dE1.facts), sourceFingerprintSha256(dE1.facts)]))
  const internalRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${TABLE} c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE r.source_kind = 'INTERNAL_SYNTHETIC' AND (c.classification_code, c.normalization_outcome, c.reason_code) <> ('INTERNAL_DECLARATION', 'CLASSIFIED', 'SYNTHETIC_INTERNAL_SOURCE')`)
  check('T092', 'Same input, same outcome', new Set(repeated).size === 1 && Number(internalRows[0].n) === 0, 'fifty evaluations of the same facts are identical, and every INTERNAL_SYNTHETIC source in the database carries the same classification')
  const tzProbe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import { classifySource, sourceFingerprintSha256 } from './src/modules/evidence-classification/evidence-classification.classifier.ts'; const f = JSON.parse(process.env.A72_FACTS); console.log(JSON.stringify([classifySource(f), sourceFingerprintSha256(f), Intl.DateTimeFormat().resolvedOptions().timeZone]))"],
    { encoding: 'utf8', cwd: process.cwd(), env: childEnv({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', A72_FACTS: JSON.stringify(dE1.facts) }) },
  )
  const probed = (() => {
    try {
      return JSON.parse((tzProbe.stdout ?? '').trim().split(/\r?\n/).pop() ?? '')
    } catch {
      return null
    }
  })()
  const zonedFingerprint = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Kiritimati'")
    return (await tx.$queryRawUnsafe<{ h: string }[]>(`SELECT ${FINGERPRINT_SQL} AS h FROM ${TABLE} c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE c.id = $1::uuid`, C1.body.classificationId))[0]?.h
  })
  check(
    'T093',
    'Locale and time zone do not alter it',
    probed !== null && probed[2] === 'Pacific/Kiritimati' && same(probed[0], { ok: true, value: INTERNAL }) && probed[1] === rowC1.sourceFingerprintSha256 && zonedFingerprint === rowC1.sourceFingerprintSha256,
    'a separate process in Pacific/Kiritimati (UTC+14) with a Turkish locale, and a database session in that zone, derive the identical classification and fingerprint',
  )
  const unknownInputs = [{ sourceKind: 'UNKNOWN' }, { sourceKind: 'internal_synthetic' }, { sourceKind: 'INTERNAL_SYNTHETIC ' }, { sourceVersion: 'A7-REVENUE-SOURCE-1 ' }, { sourceKind: '' }, { receivedAtMicros: 'yesterday' }, { sourceEvidenceId: 'E1' }].map((change) => classifySource({ ...dE1.facts, ...change }))
  const classifiedRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${TABLE} WHERE normalization_outcome = 'CLASSIFIED' AND (classification_code, reason_code) <> ('INTERNAL_DECLARATION', 'SYNTHETIC_INTERNAL_SOURCE')`)
  check(
    'T094',
    'No unknown fallback to CLASSIFIED',
    unknownInputs.every((r) => r.ok && r.value.normalizationOutcome !== 'CLASSIFIED') && Number(classifiedRows[0].n) === 0,
    `unknown, mis-cased, padded, empty or malformed facts never become CLASSIFIED (${[...new Set(unknownInputs.map(outcomeOf))].join('; ')}); in the database CLASSIFIED only ever means an internal synthetic declaration`,
  )
  check(
    'T095',
    'External proof prerequisite',
    same(classifySource({ ...dE1.facts, sourceKind: 'EXTERNAL_VERIFIED' }), { ok: false, refusal: 'EXTERNAL_VERIFICATION_UNPROVEN' }) && refusedBy(verifiedSource.message, /derivation/) && /if \(!classified\.ok\) return refuse\('EVIDENCE_CLASSIFICATION_NOT_ALLOWED'/.test(serviceCode) && !/EXTERNAL_SOURCE_VERIFIED/.test(committedCode(`${MODULE_DIR}/evidence-classification.classifier.ts`)),
    'a source claiming external verification without an authenticated proof is refused by the classifier (NOT_ALLOWED, 409, nothing written) and by the database; no code path can produce EXTERNAL_SOURCE_VERIFIED',
  )
  const checkDefs = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'source_evidence_classifications'::regclass AND contype = 'c'`).map((row) => row.def).join(' ')
  check('T096', 'No paid/accepted/denied labels', !/PAID|ACCEPTED|DENIED|SETTLED|REMITTED|ADJUDICATED/.test(checkDefs) && !/PAID|ACCEPTED|DENIED|SETTLED|REMITTED/.test(JSON.stringify(dtos)), 'neither the database vocabulary nor any DTO contains a paid, accepted, denied, settled, remitted or adjudicated label')
  const ledgerTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(receivable|ledger|balance|posting|journal|allocation)'`).map((row) => row.t)
  check('T097', 'No receivables ledger state', ledgerTables.length === 0 && !classificationColumns.some((c) => /receivable|ledger|balance|status|state/.test(c)), 'no receivable, ledger, balance, posting, journal or allocation table, and no status column')
  const R98 = await registerSource(S2, 'NO-BALANCE')
  const before98 = await counts()
  await classify(R98)
  const a6Columns = await prisma.$queryRaw<{ t: string; n: bigint }[]>`SELECT table_name AS t, count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('claims', 'claim_freezes', 'revenue_source_evidence') GROUP BY 1 ORDER BY 1`
  check('T098', 'No claim-balance mutation', onlyClassified(delta(before98, await counts())) && same(a6Columns.map((r) => [r.t, Number(r.n)]), [['claim_freezes', 13], ['claims', 7], ['revenue_source_evidence', 10]]), 'a classification writes only itself and its audit; claims, claim_freezes and revenue_source_evidence keep their columns')
  const pricingOfW = await prisma.claimPricingRun.findMany({ where: { claimId: W.claimId }, orderBy: { evaluatedAt: 'asc' } })
  const moneyCode = production.code.replace(/refusedByName = \[[\s\S]*?\] as const/, '')
  // A money identifier, not a fragment of another word (`concurrencyProbe` is not a currency).
  const moneyIdentifier = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|toFixed\(|[Ss]ettle|[Aa]llocat|[Aa]djust|[Rr]eceivable/
  check('T099', 'No payment or adjustment arithmetic', !moneyIdentifier.test(moneyCode) && pricingOfW.length === 1 && pricingOfW[0].totalExtendedAmount?.toFixed(2) === '200.01', 'A7.2 code computes no money (refused field names aside), and the Claim keeps its one pricing run and its AED 200.01 total')
  check(
    'T100',
    'No fake remittance provenance',
    classificationColumns.length === 11 && classificationColumns.every((c) => A72_COLUMNS.includes(c)) && !classificationColumns.some((c) => /payer|remit|external|received|response|amount/.test(c)) && verifiedRows === 0,
    'the table has exactly its 11 columns: no payer, remittance, external reference, response or amount, and no row claims an external source',
  )

  // ---------------------------------------------------------------- boundaries (T101–T110)
  section('No A6 or A7.1 mutation, no A7.3 adjudication, settlement, transport, payer response or balance; synthetic only')
  const wFreeze = await freezeHash(W.claimId)
  const wLifecycle = await lifecycleHash(W.claimId)
  const R101 = await registerSource(S1, 'BOUNDARY')
  const sourcesBefore101 = await sourceHash()
  await classify(R101)
  check('T101', 'No A6 freeze mutation', (await freezeHash(W.claimId)) === wFreeze && (await freezeHash(Re.claimId)) === reFreezeBefore, 'every byte of the freezes and their sealed manifests is identical after classification')
  check('T102', 'No A6 lifecycle mutation', (await lifecycleHash(W.claimId)) === wLifecycle && (await lifecycleHash(Re.claimId)) === reLifecycleBefore, 'every lifecycle event is identical after classification')
  check('T103', 'No A6 correction-link mutation', (await correctionHash(Cr.claimId)) === chainBefore, 'the correction link is identical after its sources were classified')
  check('T104', 'No A7.1 registration mutation', (await sourceHash()) === sourcesBefore101 && same((await get(`/api/revenue-source-evidence/${E1}`)).body, a71ReadBefore), 'every byte of this run\'s A7.1 records and the A7.1 read are identical after classification')
  const later = [await post(`${classificationPath(C1.body.classificationId)}/adjudications`, {}), await post(`/api/claim-submissions/${S1}/adjudications`, {}), await post(`/api/claim-submissions/${S1}/denials`, {})]
  const adjudicationTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(adjudicat|denial|allowed)'`).map((row) => row.t)
  // Judged on behaviour: no adjudication or denial route answers and no such table exists. A later A7 suite's own
  // files are not an adjudication domain (the start gate, T001, still reads them as later code).
  check('T105', 'No A7.3 adjudication domain', later.every((res) => res.status === 404) && adjudicationTables.length === 0, 'no adjudication or denial route or table exists')
  const settleTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(settle|payment|cash|receipt)'`).map((row) => row.t)
  check('T106', 'No A7 settlement allocation', settleTables.length === 0 && !/settle|allocat/i.test(moneyCode) && (await post(`/api/claim-submissions/${S1}/payments`, {})).status === 404, 'no settlement, payment, cash or receipt table, route or logic')
  const jobsChanged = changedPaths.filter((file) => /^backend\/src\/jobs\//.test(file))
  // Judged on behaviour, not vocabulary: an awaited in-request pause (the lock-wait jitter) is not background
  // work. Any other timer, interval, schedule, worker or jobs-runner wiring is.
  const awaitedPause = /new Promise\(\(resolve\) => setTimeout\(resolve, [^\n]*/g
  const awaitedPauses = production.code.match(awaitedPause) ?? []
  const backgroundWork = production.code.replace(awaitedPause, '')
  const jobsWiring = committedFiles('backend/src/jobs').filter((file) => /\.ts$/.test(file)).some((file) => /classif/i.test(file) || /classif/i.test(committedCode(file)))
  check(
    'T107',
    'No A9 transport or network calls',
    !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|<\?xml|\bx12\b|\bhl7\b|\bfhir\b|enqueue/i.test(production.code) &&
      jobsChanged.length === 0 && !jobsWiring && !/setInterval|setTimeout|setImmediate|worker_threads|\bnew Worker\(|cron|schedule\(/i.test(backgroundWork) && awaitedPauses.length === 1,
    `no network client, XML/X12/HL7/FHIR, queue, job, worker or background timer in A7.2 code; its only timer is the awaited in-request lock-wait pause (${awaitedPauses.length})`,
  )
  const payerResponse = [await post(`/api/revenue-source-evidence/${E1}/payer-responses`, {}), await post(`/api/claim-submissions/${S1}/payer-responses`, {}), await post(`${classificationPath(C1.body.classificationId)}/verify`, {}), await post('/api/payer-responses', {})]
  check('T108', 'No payer response endpoint', payerResponse.every((res) => res.status === 404), 'payer-response, verify and inbound routes do not exist (404)')
  const balanceTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(balance|patient_share|patient_responsibility|copay|statement)'`).map((row) => row.t)
  check('T109', 'No new patient-balance table', balanceTables.length === 0, 'no balance, patient-share, responsibility, copay or statement table')
  const notInternal = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${TABLE} WHERE classification_code <> 'INTERNAL_DECLARATION'`)
  check('T110', 'Synthetic only, no external truth', Number(notInternal[0].n) === 0 && !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION)\w*|['"`](AE-DU|DHA|AED|US)['"`]/.test(production.code), 'every classification in the database is an INTERNAL_DECLARATION of synthetic evidence; A7.2 holds no UAE/US market literal (future US support stays configuration)')

  const workedRows = async () =>
    (await prisma.sourceEvidenceClassification.findMany({ where: { sourceEvidenceId: { in: [E1, E2] } }, orderBy: { id: 'asc' } })).map((row) => ({ ...row, recordedAt: row.recordedAt.toISOString(), createdAt: row.createdAt.toISOString() }))
  const worked = { rows: await workedRows(), history: twice[0] }

  // ---------------------------------------------------------------- regressions (T111–T120)
  section('Regressions — A7.1 invoked, nesting A6.10 -> A6.9 -> … -> A6.1 -> A5.10 -> A1')
  await apiReady('the A7.1 and backward regression chain')
  const chain = run('npm run test:a7:revenue-source-evidence')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.1')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.1] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.1 asserts facts about its own branch, its own migration and production diff, its nested N/A proofs against
  // its own branch, and its own upstream. On A7.2 those statements are obsolete by design; every other A7.1 check
  // is substantive. T120 below proves each cause independently, never from the id.
  const a71NonApplicable: Record<string, string> = {
    T001: "A7.1 'Start gate' requires the A7.1 feature branch (and reads any other A7 suite as later code); A7.2 is branched from the main that contains the A7.1 merge",
    T004: "A7.1 'Exactly one migration' expects its own migration as the branch's only addition; A7.2 adds exactly one different migration (T004 here)",
    T010: "A7.1 'Diff scope' lists the paths A7.1 was allowed to change; A7.2 legitimately changes its own (T010 here)",
    T120: "A7.1 'Nested N/A causes proven' proves A6.10's branch-only causes against the A7.1 branch (its migration, diff and upstream); on A7.2 those proofs are re-done here (T120)",
    T130: "A7.1 'Exact head, repeatability, evidence' requires the upstream to be the A7.1 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a71NonApplicable))
  const summary = chain.output.match(/\[A7\.1\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.1\] RUN ABORTED|\[A7\.1\] uncaught error|\[A7\.1\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a71Substantive = rows.filter((row) => !(row.id in a71NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a71Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T111',
    'A7.1 substantive regression',
    ran && reconciled && undocumented.length === 0 && a71Substantive.length === 0 && a71Passing >= 125,
    !ran
      ? 'the A7.1 suite did not complete'
      : !reconciled
        ? `A7.1 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.1 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.1\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.1] automated summary: ', 'A7.1 ')}; all ${a71Passing} substantive checks PASS and every failure is documented`,
  )
  for (const id of Object.keys(a71NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A7.1 ${titleOf(row.line)}`, a71NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T112', 'A6.10 cumulative regression', verdictOf('T111') === 'PASS', `A7.1 T111 (A6.10 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A6.9 correction regression', verdictOf('T112') === 'PASS', `A7.1 T112 (A6.9) ${verdictOf('T112')}`)
  check('T114', 'A6.8 lifecycle regression', verdictOf('T113') === 'PASS', `A7.1 T113 (A6.8) ${verdictOf('T113')}`)
  check('T115', 'A6.7 freeze regression', verdictOf('T114') === 'PASS', `A7.1 T114 (A6.7) ${verdictOf('T114')}`)
  check('T116', 'A6.6 to A6.3 regressions', verdictOf('T115') === 'PASS' && verdictOf('T116') === 'PASS', `A7.1 T115 (A6.6, A6.5) ${verdictOf('T115')}, T116 (A6.4, A6.3) ${verdictOf('T116')}`)
  check('T117', 'A6.2 and A6.1 regressions', verdictOf('T117') === 'PASS', `A7.1 T117 (A6.2, A6.1) ${verdictOf('T117')}`)
  check('T118', 'A5 and A1–A4 regressions', verdictOf('T118') === 'PASS', `A7.1 T118 (A5.10 → A1) ${verdictOf('T118')}`)
  check(
    'T119',
    'No substantive nested failures',
    ran && a71Substantive.length === 0 && verdictOf('T119') === 'PASS' && ['T021', 'T034', 'T047', 'T048', 'T060', 'T062', 'T063', 'T102', 'T107', 'T125', 'T126', 'T129'].every((id) => verdictOf(id) === 'PASS'),
    'every substantive A7.1 check PASSES on this branch — registration, frozen integrity, races, bulk-wipe guard, crash rollback, one table, no job, checksum, outage and worked example — and A7.1 T119 (the A6 journey) PASSES',
  )
  // Each documented A7.1 failure must fail for its branch-only reason, proved independently on this branch.
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
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file) && !(file === A71_HARNESS && a71HarnessOnlyT060))
  const a71Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA610 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const causes: Record<string, boolean> = {
    T001: branch === a72Branch && a71Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a71Merge} HEAD`),
    T004: same(migrationStatus, [`A\t${MIGRATION}`]),
    T010: a71Unexpected.length > 0 && a71Unexpected.every((path, index) => changedPaths.includes(path) || (index === a71Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A7.1 re-proves A6.10's branch-only causes against the A7.1 branch; on A7.2 only those tied to the branch (its
    // migration, diff and upstream) can be unproven — re-proved here against this branch.
    T120: unprovenA610.length > 0 && unprovenA610.every((id) => ['T001', 'T004', 'T007', 'T010', 'T120', 'T130'].includes(id)) && same(migrationStatus, [`A\t${MIGRATION}`]) && outOfScope.length === 0 && tracking.includes(`origin/${a72Branch}`),
    T130: tracking.includes(`origin/${a72Branch}`) && !/origin\/feature\/a7-1/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  check('T120', 'Historical N/A reasons proved', ran && unproven.length === 0, unproven.length === 0 ? `each documented A7.1 failure (${failing.filter((id) => id in a71NonApplicable).join(', ') || 'none'}) fails only for its branch-only reason, proved independently on this branch` : `cause not proven for: ${unproven.join(', ')}`)

  // ---------------------------------------------------------------- builds and final evidence (T121–T130)
  section('Units, typecheck, frontend, Prisma checksum, replay, outage and recovery, no 5xx, synthetic only, worked example, exact head')
  const allUnit = run('npm run test:unit')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  check('T121', 'Backend unit tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 17/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 17 A7.2 classifier and strict-request tests`)
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
    'All migrations and checksum replay',
    status.ok && replay.ok && (appliedChecksum === checkoutChecksum || appliedChecksum === sha256Of(blob)),
    `the A7.2 migration is applied with the checksum of its committed file (${(appliedChecksum ?? '').slice(0, 12)}…); status up to date; replay ALL CHECKS PASS (T006)`,
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
  check('T127', 'No unexpected HTTP 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runToken = runId.replace(/^A72-/, '')
  const runRows = await prisma.$queryRawUnsafe<{ reference: string; organization_id: string }[]>(`SELECT r.source_reference AS reference, c.organization_id::text AS organization_id FROM ${TABLE} c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE c.created_at >= $1::timestamptz`, runStartedAt.toISOString())
  check(
    'T128',
    'Synthetic data isolation',
    runRows.length > 0 && runRows.every((row) => row.reference.includes(runToken) && [org, otherOrg].includes(row.organization_id)),
    `${runRows.length} classifications created since this run started, every source keyed by ${runId}, all in the two synthetic organizations`,
  )
  const afterRows = await workedRows()
  const afterHistory = await historyOf(E1)
  console.log(`[${TAG}]      worked example: E1 (INTERNAL_SYNTHETIC on frozen S1 ${S1}) -> ${C1.body.classificationCode}/${C1.body.normalizationOutcome}/${C1.body.reasonCode}, fingerprint ${C1.body.sourceFingerprintSha256.slice(0, 12)}…, source ${C1.body.sourceEvidenceId}`)
  console.log(`[${TAG}]      worked example: repeat -> ${replay1.status} same record, +${d41.audit_events} audit; caller VERIFIED -> ${forgedBodies[0].status}; other tenant -> ${foreignOnHome[0].status} and direct SQL ${markerOf(foreignSql[0])}; crash after insert -> rolled back, rerun ${retry.status}; E1-v2 -> its own ${C2.body.classificationCode} ${C2.body.classificationId}`)
  check(
    'T129',
    'Worked example and source trace',
    C1.status === 201 && replay1.status === 200 && d41.audit_events === 0 && forgedBodies[0].status === 400 && foreignOnHome[0].status === 404 && refusedBy(foreignSql[0], /coherence/) && crash1.unchanged && retry.status === 201 && C2.status === 201 &&
      same(afterRows, worked.rows) && same(afterHistory, worked.history) && worked.rows.length === 2,
    'every §10 case reproduced (E1 CLASSIFIED, replay without audit, VERIFIED refused, other tenant 404 and refused in SQL, crash rolled back then one result, E1-v2 classified separately); after the nested chain and a database restart the worked classifications read back byte-identically',
  )

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a(8|9)|dhpo|eclaimlink/i.test(file))
  check(
    'T010',
    'Diff scope excludes other owners',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A7.2 module, migration and model, harness and check page, two permissions, two error codes, one audit action and wiring${changedPaths.includes(A71_HARNESS) ? ', and the A7.1 suite\'s T060 block only' : ''}; no A5/A6/A7.1 owner changed; no A7.3+/A8/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  check(
    'T130',
    'Exact HEAD, clean tree, repeatable',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a72Branch}`) && !/ahead|behind/.test(tracking) && same(afterHistory, worked.history),
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; after the database restart the worked classifications read back identically`,
  )

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] EVIDENCE CLASSIFICATION & NORMALIZATION ACCEPTANCE COMPLETE` : `[${TAG}] A7.2 FINAL FAIL`)
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
