import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { removeClaimLine } from '../../modules/claim-line/claim-line.service.ts'
import { getFrozenSubmission } from '../../modules/claim-submission/claim-submission.service.ts'
import { recordLifecycleEvent } from '../../modules/claim-lifecycle/claim-lifecycle.service.ts'
import { recordCorrectionLink } from '../../modules/claim-correction/claim-correction.service.ts'
import { getRevenueSourceEvidenceOf, registerRevenueSourceEvidence } from '../../modules/revenue-evidence/revenue-evidence.service.ts'

// A7.1 — focused acceptance for Revenue Evidence Intake & Provenance Foundation (T001–T130).
//
// Every frozen submission is built through its owners, exactly as the A6.7–A6.9 suites build them: tariff
// world and rates through REF-01 and the A6.3 rate routes, runs through the A5.7 recorder, readiness through
// the A5.9 route, the Claim, lines, diagnoses and pointers through the A6.1/A6.2 routes, pricing through A6.3,
// draft assessments through A6.4, APPROVE/REVOKE through A6.5 by a separate synthetic Admin, and every freeze
// through the A6.7 route. The other organization builds its own frozen submission the same way with its own
// two Admins. Registrations go through the A7.1 route (or, for barrier-controlled races and crash injection,
// its service in-process). ADVERSARIAL writes go in only to prove a database guard; every one of them runs in
// a transaction that is always rolled back. Synthetic Admins are provisioned per run through Better Auth's own
// server-side creation with a random password that is never printed. Every value is synthetic and keyed by
// this run's id.

const TAG = 'A7.1'
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

const runId = `A71-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a71Branch = 'feature/a7-1-revenue-source-evidence'
const a610Branch = 'feature/a6-10-a6-integration-acceptance'
const correctiveBranch = 'fix/a6-harness-replay-count-head'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/revenue-evidence'
const FE_DIR = 'frontend/src/modules/revenue-evidence'
const HARNESS_DIR = 'backend/src/integration/a7-revenue-source-evidence'
const MIGRATION = 'backend/prisma/migrations/20261020090000_a7_1_revenue_source_evidence/migration.sql'
const VALIDATION_TEST = `${MODULE_DIR}/revenue-evidence.validation.test.ts`
const TABLE = 'revenue_source_evidence'
const CONTRACT = 'A7-REVENUE-SOURCE-1'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const DTO_KEYS = ['revenueSourceEvidenceId', 'claimSubmissionId', 'sourceKind', 'sourceReference', 'sourceVersion', 'sourceDigestSha256', 'receivedAt', 'recordedByUserId']
const AUDIT_KEYS = ['revenueSourceEvidenceId', 'claimSubmissionId', 'sourceKind', 'sourceReference', 'sourceVersion', 'receivedAt']
const A71_COLUMNS = ['id', 'organization_id', 'claim_submission_id', 'source_kind', 'source_reference', 'source_version', 'source_digest_sha256', 'received_at', 'recorded_by_user_id', 'created_at']
// The A5/A6 owners A7.1 consumes or must leave untouched (backend modules and their frontend pages).
const A6_OWNER_DIRS = [
  'claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction',
  'pre-claim-validation', 'pre-claim-readiness', 'validation-run',
].map((name) => `backend/src/modules/${name}`)
// The tables whose rows a refusal, a read or a rolled-back write must leave untouched, always read in this fixed
// key order (a UNION ALL may come back in Parallel Append order).
const COUNT_TABLES = ['revenue_source_evidence', 'audit_events', 'claims', 'claim_pricing_runs', 'claim_review_events', 'claim_freezes', 'claim_freeze_evidence_manifests', 'claim_freeze_lifecycle_events', 'claim_correction_links']

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

  console.log(`[${TAG}] A7.1 revenue evidence intake & provenance foundation — run ${runId}`)
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
  section('Preflight: accepted A6 closure, the one A7.1 migration, Prisma, replay, permissions, routes and contracts')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a610Merge = mergeOf(a610Branch)
  const correctiveMerge = mergeOf(correctiveBranch)
  const a69Merge = mergeOf('feature/a6-9-correction-resubmission-lineage')
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|settlement|receivable|claim-transport|claim-outbox|integration\/a(8|9)|integration\/a7-(?!revenue-source-evidence)|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Start gate',
    branch === a71Branch && a610Merge.length === 40 && correctiveMerge.length === 40 && gitOk('merge-base --is-ancestor origin/main HEAD') && committedText('docs/A6_Phase_Closure.md').includes('A6 Claim Lifecycle — Phase Closure Record') && laterCode.length === 0,
    `branch ${branch}; A6.10 merged as ${a610Merge.slice(0, 7) || 'NOT FOUND'}, A6 harness correction as ${correctiveMerge.slice(0, 7) || 'NOT FOUND'}; the A6 closure record is on main; contains latest main ${git('rev-parse --short origin/main')}; no A7.2+/A8/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'A6.9, A6.10 and correction ancestry',
    [a69Merge, a610Merge, correctiveMerge].every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)),
    `A6.9 ${a69Merge.slice(0, 7)}, A6.10 ${a610Merge.slice(0, 7)} and the correction ${correctiveMerge.slice(0, 7)} are ancestors of HEAD`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma/migrations']).split(/\r?\n/).filter(Boolean)
  check(
    'T004',
    'Exactly one migration',
    same(migrationStatus, [`A\t${MIGRATION}`]),
    migrationStatus.length === 1 ? `one added migration, no applied migration modified: ${MIGRATION.split('/').slice(-2, -1)[0]}` : `migration changes: ${migrationStatus.join(' | ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, the working database is up to date (never reset)')
  const replay = run('npm run db:verify:replay')
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  const replayExpected = [
    /PASS {2}the A7\.1 tables are exactly revenue_source_evidence/,
    /PASS {2}revenue_source_evidence_insert_guard_trg is present after a clean replay/,
    /PASS {2}revenue_source_evidence_append_only_trg is present after a clean replay/,
    /PASS {2}revenue_source_evidence_no_truncate_trg is present after a clean replay/,
    /PASS {2}the A7\.1 CHECKs pin A7-REVENUE-SOURCE-1, INTERNAL_SYNTHETIC only and no source digest/,
    /PASS {2}one registration per submission, kind, reference and contract is unique/,
    /PASS {2}the A6\.9 tables are exactly claim_correction_links/,
  ]
  check(
    'T006',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === headMigrationDirs.length && headMigrationDirs.some((dir) => MIGRATION.startsWith(`${dir}/`)),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — all ${headMigrationDirs.length} committed at HEAD, the A7.1 migration included; every A6 and A7.1 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^revenue/i.test(code)).sort()
  const invented = allCodes.filter((code) => /(pay|remit|post|settle|adjudicat|denial|receivable|ledger|verif|send|transmit|submit)/i.test(code) && /revenue/i.test(code))
  check(
    'T007',
    'Permission catalogue',
    same(family, ['revenueEvidence.create', 'revenueEvidence.read']) &&
      (await grantsOf('revenueEvidence.create')) === 'ORG_ADMIN' &&
      (await grantsOf('revenueEvidence.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('claimFreeze.create')) === 'ORG_ADMIN' &&
      (await grantsOf('claimCorrection.link')) === 'ORG_ADMIN' &&
      invented.length === 0,
    'create (Admin) and read (Admin, Viewer) only; A6 grants unchanged; no pay, post, settle, verify or send permission',
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
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /revenue_source_evidence_[a-z]|claim_freeze/.test(text)
  }
  const markerOf = (message: string) => (message.match(/[a-z_]+_(chk|fkey|key)\b/) ?? message.match(/revenue_source_evidence_(time|coherence)|is append-only|null value/) ?? [message.includes('ROLLED_BACK') ? 'ACCEPTED' : '?'])[0]

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
  // B approves (separation of duties for A6.5) and registers as a second actor; O and O2 are the two Admins
  // of the OTHER organization, who build its own frozen submission.
  const B = await provisionAdmin('b')
  const O = await provisionAdmin('o', otherOrg)
  const O2 = await provisionAdmin('o2', otherOrg)

  const evidencePath = (submissionId: string) => `/api/claim-submissions/${submissionId}/revenue-source-evidence`
  const evidenceIdPath = (id: string) => `/api/revenue-source-evidence/${id}`
  const register = (submissionId: string, sourceReference: string, who: Who = asAdmin, extra: Record<string, unknown> = {}) => post(evidencePath(submissionId), { sourceKind: SYNTHETIC, sourceReference, ...extra }, who)
  const historyOf = async (submissionId: string, who: Who = asAdmin) => (await get(evidencePath(submissionId), who)).body?.items ?? []
  const wiring = [await register(MISSING, 'SYN-WIRING'), await get(evidencePath(MISSING)), await get(evidenceIdPath(MISSING))]
  const absent = [
    await api('PATCH', evidenceIdPath(MISSING), {}),
    await api('PUT', evidenceIdPath(MISSING), {}),
    await api('DELETE', evidenceIdPath(MISSING)),
    await api('DELETE', evidencePath(MISSING)),
    await api('PUT', evidencePath(MISSING), {}),
    await api('POST', '/api/revenue-source-evidence', {}),
    await api('POST', `${evidenceIdPath(MISSING)}/verify`, {}),
    await api('POST', `/api/claim-submissions/${MISSING}/payments`, {}),
    await api('POST', `/api/claim-submissions/${MISSING}/remittances`, {}),
    await api('POST', `/api/claim-submissions/${MISSING}/postings`, {}),
    await api('GET', `/api/claim-submissions/${MISSING}/balance`),
  ]
  const unauthenticated = [await register(MISSING, 'SYN-WIRING', anonymous), await get(evidencePath(MISSING), anonymous), await get(evidenceIdPath(MISSING), anonymous)]
  check(
    'T008',
    'Route wiring',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && absent.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `three routes answer a missing target with a privacy-safe 404; PATCH/PUT/DELETE, collection POST, verify, payment, remittance, posting and balance routes are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
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
  ]
  const ownerChanged = changedPaths.filter((file) => A6_OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file))
  check(
    'T009',
    'Protected contracts',
    same(contracts, ['A6-CLAIM-1', 'A6-PRICE-1', 'A6-DRAFT-1', 'A6-REVIEW-1', 'A6-PAYLOAD-1', 'A6-SUBMISSION-1', 'A6-EVIDENCE-1', 'A6-LIFECYCLE-1', 'A6-CORRECTION-1']) && ownerChanged.length === 0,
    ownerChanged.length === 0 ? 'A6-CLAIM-1 … A6-CORRECTION-1 unchanged; no A5/A6 owner module, page or suite changed' : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: frozen submissions of this organization and of another one')
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
  const X = await home.series('second claim', 1)
  const F = await away.series('foreign', 1)
  const [S1, S2] = W.freezes
  console.log(`[${TAG}]      fixtures ready: two synthetic AE-DU/DHA worlds (this organization and another one, each built by its own Admins) and Claims with lawfully frozen submissions`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const delta = (before: Record<string, number>, after: Record<string, number>) => Object.fromEntries(COUNT_TABLES.map((table) => [table, after[table] - before[table]])) as Record<string, number>
  // Every stored byte of a Claim's freezes, packages, lifecycle events, correction links and review history.
  const claimHash = async (claimId: string) =>
    (
      await prisma.$queryRaw<{ h: string }[]>`SELECT encode(sha256(convert_to(
        coalesce((SELECT string_agg(row_to_json(f)::text, '|' ORDER BY f.id) FROM claim_freezes f WHERE f.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(m)::text, '|' ORDER BY m.id) FROM claim_freeze_evidence_manifests m JOIN claim_freezes f ON f.id = m.claim_submission_id WHERE f.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(e)::text, '|' ORDER BY e.id) FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(l)::text, '|' ORDER BY l.id) FROM claim_correction_links l WHERE l.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(r)::text, '|' ORDER BY r.sequence) FROM claim_review_events r WHERE r.claim_id = ${claimId}::uuid), ''),
        'UTF8')), 'hex') AS h`
    )[0].h
  const NOT_REFUSED = 'ROLLED_BACK'
  const refusedBy = (message: string, marker: RegExp) => message !== '' && !message.includes(NOT_REFUSED) && marker.test(message)
  // A direct INSERT of a registration inside a transaction that is always rolled back.
  const directInsert = (values: { submission: string; organization?: string; kind?: string | null; reference?: string | null; version?: string | null; digest?: string | null; actor?: string; receivedAt?: boolean }) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, organization_id, claim_submission_id, source_kind, source_reference, source_version, source_digest_sha256, recorded_by_user_id${values.receivedAt ? ', received_at' : ''})
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid${values.receivedAt ? ", now() - interval '1 day'" : ''})`,
          values.organization ?? org,
          values.submission,
          values.kind === undefined ? SYNTHETIC : values.kind,
          values.reference === undefined ? key('SQL').toUpperCase() : values.reference,
          values.version === undefined ? CONTRACT : values.version,
          values.digest ?? null,
          values.actor ?? creatorId,
        )
        throw new Error(NOT_REFUSED)
      }),
    )
  const ref = (suffix: string) => `SYN-${runId.replace(/^A71-/, '')}-${suffix}`.toUpperCase()

  // ---------------------------------------------------------------- strict request (T011–T020)
  section('Strict request: contract, unknown and server-owned fields, verdict fields, UUIDs, session, roles, tenants, actor')
  const countsAtStart = await counts()
  check(
    'T011',
    'Contract version',
    constantOf(`${MODULE_DIR}/revenue-evidence.types.ts`, 'REVENUE_SOURCE_CONTRACT_VERSION') === CONTRACT && /'A7-REVENUE-SOURCE-1'/.test(readFileSync(`../${MIGRATION}`, 'utf8')),
    'A7-REVENUE-SOURCE-1 is the literal contract in code and in the database CHECK (and on every row and DTO, T021)',
  )
  const unknownFields = [await register(S1, ref('U1'), asAdmin, { extra: 1 }), await register(S1, ref('U2'), asAdmin, { format: 'X12' })]
  check('T012', 'Strict body', unknownFields.every((res) => res.status === 400 && /unknown field/.test(res.body?.error?.message ?? '')), 'an unknown field is refused by name: 400')
  const serverOwned = await Promise.all(
    ['organizationId', 'claimSubmissionId', 'claimId', 'sourceVersion', 'sourceDigestSha256', 'receivedAt', 'createdAt', 'recordedByUserId', 'actorUserId', 'id'].map((field) => register(S1, ref('SO'), asAdmin, { [field]: field === 'sourceDigestSha256' ? 'a'.repeat(64) : MISSING })),
  )
  check('T013', 'Server-owned fields', serverOwned.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')), 'organization, submission, Claim, contract, digest, instants, actor and id are refused by name: 400')
  const verdicts = await Promise.all(
    [
      { verified: true }, { verificationStatus: 'VERIFIED' }, { status: 'PAID' }, { paid: true }, { paidAmount: '200.01' }, { amount: '200.01' }, { currency: 'AED' }, { allowedAmount: '1' }, { patientShare: '1' },
      { denied: true }, { denialReason: 'X' }, { denialCode: 'X' }, { adjudication: {} }, { remittance: {} }, { payment: {} }, { settlement: {} }, { externalTimestamp: '2026-06-20T00:00:00Z' },
      { externalReference: 'X' }, { payer: 'X' }, { payerId: MISSING }, { payerResponse: {} }, { payload: {} }, { rawMessage: 'X' }, { url: 'https://x' }, { note: 'X' }, { comment: 'X' },
    ].map((extra) => register(S1, ref('VD'), asAdmin, extra)),
  )
  check('T014', 'Verdict, money and status refused', verdicts.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')), `a fake VERIFIED result, paid/allowed amount, currency, denial, remittance, payment, settlement, external time, payer content, payload or free text: ${verdicts.length} × 400`)
  const malformed = [
    await post('/api/claim-submissions/not-a-uuid/revenue-source-evidence', { sourceKind: SYNTHETIC, sourceReference: ref('M1') }),
    await get('/api/claim-submissions/1234/revenue-source-evidence'),
    await get('/api/revenue-source-evidence/not-a-uuid'),
    await post(evidencePath(S1), []),
    await post(evidencePath(S1), { sourceKind: SYNTHETIC }),
  ]
  check('T015', 'Malformed ids and bodies', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `malformed path ids, an array body and a missing reference: ${malformed.map((r) => r.status).join('/')}; no raw database text`)
  const anon = [await register(S1, ref('A1'), anonymous), await get(evidencePath(S1), anonymous), await get(evidenceIdPath(MISSING), anonymous)]
  check('T016', 'Session required', anon.every((res) => res.status === 401), 'every A7.1 route requires a session: 401 without one')
  const viewerPost = await register(S1, ref('V1'), asViewer)
  const viewerList = await get(evidencePath(S1), asViewer)
  check('T017', 'Viewer limits', viewerPost.status === 403 && errorCode(viewerPost.body) === 'FORBIDDEN' && viewerList.status === 200, 'a Viewer reads (200) but cannot register (403)')
  const foreignOnHome = [await register(S1, ref('F1'), O.who), await get(evidencePath(S1), O.who)]
  const foreignMissing = await get(evidencePath(MISSING), O.who)
  check(
    'T018',
    'Another tenant on this submission',
    foreignOnHome.every((res) => res.status === 404) && same(foreignOnHome[1].body?.error?.message, foreignMissing.body?.error?.message),
    "the other organization's Admin gets 404 for this tenant's submission — exactly like a missing one",
  )
  const homeOnForeign = [await register(F.freezes[0], ref('F2')), await get(evidencePath(F.freezes[0]))]
  check('T019', 'This tenant on another submission', homeOnForeign.every((res) => res.status === 404), "this tenant's Admin gets 404 for the other organization's frozen submission")
  const refusalsLeftNothing = await unchanged(countsAtStart)

  // ---------------------------------------------------------------- synthetic registration (T021–T030)
  section('Synthetic registration: exact frozen-submission binding, database time, safe reference, EXTERNAL_VERIFIED disabled')
  const hashWBefore = await claimHash(W.claimId)
  const freezeReadBefore = (await get(`/api/claim-submissions/${S1}`)).body
  const before21 = await counts()
  const R1 = await register(S1, ref('WORKED-1'))
  const after21 = await counts()
  check('T020', 'Actor from the session', R1.body?.recordedByUserId === creatorId, 'the registration names the signed-in Admin; no request field can name an actor (a second actor in T028)')
  check(
    'T021',
    'Registration recorded',
    R1.status === 201 && same(Object.keys(R1.body ?? {}), DTO_KEYS) && R1.body.sourceKind === SYNTHETIC && R1.body.sourceVersion === CONTRACT && R1.body.sourceDigestSha256 === null &&
      delta(before21, after21).revenue_source_evidence === 1 && delta(before21, after21).audit_events === 1,
    '201: one immutable INTERNAL_SYNTHETIC registration and one audit; the bounded DTO carries exactly its eight fields and no digest',
  )
  const rowR1 = await prisma.revenueSourceEvidence.findUniqueOrThrow({ where: { id: R1.body.revenueSourceEvidenceId } })
  const owningOrg = (await prisma.claimFreeze.findUniqueOrThrow({ where: { id: S1 }, select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } } })).claim.encounter.patient.organizationId
  check(
    'T022',
    'Exact frozen-submission binding',
    rowR1.claimSubmissionId === S1 && rowR1.organizationId === owningOrg && owningOrg === org && rowR1.sourceReference === ref('WORKED-1'),
    'the stored row names exactly the path submission and the organization that owns it (derived server-side, never from the body)',
  )
  const timeRow = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT received_at = created_at AND received_at <= now() AS ok FROM revenue_source_evidence WHERE id = ${rowR1.id}::uuid`
  const auditR1 = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: rowR1.id } })
  check('T023', 'Database time', timeRow[0]?.ok === true && (auditR1.afterState as any)?.receivedAt === rowR1.receivedAt.toISOString() && R1.body.receivedAt === rowR1.receivedAt.toISOString(), 'received and created at the database\'s own transaction time; the DTO and audit carry that instant')
  const before24 = await counts()
  const badRefs = await Promise.all(['https://payer.example/x?token=abc', 'syn-lower', 'SYN REF', 'a@b.c', 'AB', '-SYN', 'X'.repeat(65), 'SYN/REF', 'SYN:REF', ''].map((sourceReference) => register(S1, sourceReference)))
  check('T024', 'Opaque reference only', badRefs.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR') && (await unchanged(before24)), 'a URL with a token, lower case, space, e-mail, too short/long, a leading "-", "/" or ":" and empty: 400, nothing written')
  const external = await post(evidencePath(S1), { sourceKind: 'EXTERNAL_VERIFIED', sourceReference: ref('EXT') })
  check('T025', 'EXTERNAL_VERIFIED disabled (API)', external.status === 400 && /EXTERNAL_VERIFIED is not available/.test(external.body?.error?.message ?? '') && (await unchanged(before24)), 'a registration claiming payer verification is refused: 400, nothing written')
  const externalSql = await directInsert({ submission: S1, kind: 'EXTERNAL_VERIFIED' })
  check('T026', 'EXTERNAL_VERIFIED disabled (database)', refusedBy(externalSql, /revenue_source_evidence_kind_chk/), 'even a direct INSERT cannot claim EXTERNAL_VERIFIED: refused by CHECK')
  const readR1 = await get(evidenceIdPath(rowR1.id))
  check('T027', 'Registration read', readR1.status === 200 && same(readR1.body, R1.body), 'the single read is exactly the recorded DTO')
  const R2 = await register(S1, ref('WORKED-2'), B.who)
  const listS1 = await historyOf(S1)
  check(
    'T028',
    'Several references, one submission',
    R2.status === 201 && R2.body?.recordedByUserId === B.id && same(listS1.map((item: any) => item.revenueSourceEvidenceId), [R1.body.revenueSourceEvidenceId, R2.body.revenueSourceEvidenceId]),
    'a second reference (by the second Admin, who is named) is a second registration, listed after the first in recorded order',
  )
  const sameRefOtherSubmission = await register(S2, ref('WORKED-1'))
  check(
    'T029',
    'Identity is per submission',
    sameRefOtherSubmission.status === 201 && sameRefOtherSubmission.body?.claimSubmissionId === S2 && sameRefOtherSubmission.body?.revenueSourceEvidenceId !== R1.body.revenueSourceEvidenceId,
    'the same reference on another frozen submission of the Claim is a separate registration: identity is (submission, kind, reference, contract)',
  )
  check(
    'T030',
    'Freeze untouched',
    (await claimHash(W.claimId)) === hashWBefore && same((await get(`/api/claim-submissions/${S1}`)).body, freezeReadBefore),
    'every byte of the freezes, packages, lifecycle events, correction links and approvals is identical after three registrations',
  )

  // ---------------------------------------------------------------- linkage and identity (T031–T040)
  section('Same-Claim linkage, foreign identity, missing or fake source, digest claims, repeatable reads')
  const before31 = await counts()
  const missing = await register(MISSING, ref('MISS'))
  check('T031', 'Missing submission', missing.status === 404 && errorCode(missing.body) === 'NOT_FOUND' && (await unchanged(before31)), 'a non-existent frozen submission: 404, nothing written')
  const Wd = await home.series('withdrawn', 1)
  await post(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle-events`, { eventCode: 'WITHDRAW_INTERNAL', reasonCode: 'INTERNAL_OTHER' })
  const onWithdrawn = await register(Wd.freezes[0], ref('WD'))
  check(
    'T032',
    'Disposition does not gate',
    onWithdrawn.status === 201 && (await get(`/api/claim-submissions/${Wd.freezes[0]}/lifecycle`)).body?.state === 'WITHDRAWN_INTERNAL',
    'evidence may be registered against a WITHDRAWN_INTERNAL freeze; it stays WITHDRAWN_INTERNAL (a registration neither reopens nor gates on it)',
  )
  const Cr = await home.series('corrected', 2)
  const linked = await post(`/api/claims/${Cr.claimId}/correction-links`, { priorSubmissionId: Cr.freezes[0], correctedSubmissionId: Cr.freezes[1], reasonCode: 'CORRECTED_CODING' })
  const chainBefore = (await get(`/api/claims/${Cr.claimId}/correction-links`)).body
  const onPrior = await register(Cr.freezes[0], ref('PRIOR'))
  const onCorrected = await register(Cr.freezes[1], ref('CORRECTED'))
  check(
    'T033',
    'Correction lineage untouched',
    linked.status === 201 && onPrior.status === 201 && onCorrected.status === 201 && same((await get(`/api/claims/${Cr.claimId}/correction-links`)).body, chainBefore) && same(Object.keys(onCorrected.body), DTO_KEYS),
    'a corrected prior and its successor each take their own registration; the chain is unchanged and neither record says "newest" or "current"',
  )
  let corruption = 'NOT_RUN'
  await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await tx.$executeRawUnsafe(`UPDATE claim_freezes SET canonical_payload_bytes = canonical_payload_bytes || '\\x20'::bytea WHERE id = $1::uuid`, S2)
      corruption = await attemptAdversarial(() => getFrozenSubmission(W.claimId, S2, tx))
      throw new Error(NOT_REFUSED)
    }),
  )
  const serviceCode = committedCode(`${MODULE_DIR}/revenue-evidence.service.ts`)
  const txBody = serviceCode.slice(serviceCode.indexOf('async function registerOnTransaction'), serviceCode.indexOf('export async function registerRevenueSourceEvidence'))
  check(
    'T034',
    'Frozen integrity verified first',
    /do not match their stored digests/.test(corruption) && txBody.indexOf('readFreezeThroughOwner(') > 0 && txBody.indexOf('readFreezeThroughOwner(') < txBody.indexOf('insertRevenueSourceEvidence(') && /REVENUE_EVIDENCE_CONFLICT/.test(serviceCode),
    'on its own transaction the registration reads the freeze through A6.7, which detects bytes altered behind the guards (shown rolled back) before anything is inserted; a mismatch is a 409, never repaired',
  )
  const digestSql = await directInsert({ submission: S1, digest: 'a'.repeat(64) })
  check('T035', 'No digest claim', serverOwned.some((res) => /sourceDigestSha256/.test(res.body?.error?.message ?? '')) && refusedBy(digestSql, /revenue_source_evidence_digest_chk/), 'a client digest is refused (400) and a direct INSERT with any digest is refused by CHECK: no digest is ever fabricated')
  const fakeRefSql = [await directInsert({ submission: S1, reference: 'https://payer.example/?t=1' }), await directInsert({ submission: S1, reference: 'lower-case' })]
  check('T036', 'Fake source refused (database)', fakeRefSql.every((message) => refusedBy(message, /revenue_source_evidence_reference_chk/)), `a URL or free-text reference inserted directly is refused by CHECK (${fakeRefSql.map(markerOf).join(', ')})`)
  const crossOrgSql = [await directInsert({ submission: S1, organization: otherOrg }), await directInsert({ submission: F.freezes[0], organization: org })]
  check('T037', 'Cross-tenant linkage refused (database)', crossOrgSql.every((message) => refusedBy(message, /revenue_source_evidence_coherence/)), 'naming another organization, or another organization\'s freeze, is refused by the database guard')
  const missingSql = [await directInsert({ submission: MISSING }), await directInsert({ submission: S1, actor: MISSING })]
  check('T038', 'Missing freeze or actor refused', refusedBy(missingSql[0], /claim_submission_id_fkey|foreign key/) && refusedBy(missingSql[1], /recorded_by_user_id_fkey|foreign key/), 'a registration of a non-existent freeze or by a non-existent user is refused by its foreign key')
  const twice = [await historyOf(S1), await historyOf(S1)]
  const viewerTwice = await historyOf(S1, asViewer)
  check('T039', 'Repeatable reads', same(twice[0], twice[1]) && same(viewerTwice, twice[0]) && twice[0].length === 2, 'the same history reads identically twice, and for a Viewer')
  const before40 = await counts()
  for (const id of [S1, S2, Wd.freezes[0]]) await historyOf(id)
  await get(evidenceIdPath(rowR1.id))
  const readsLeftNothing = await unchanged(before40)
  check('T040', 'Reads write nothing', readsLeftNothing, 'history and single reads wrote no row and no audit')

  // ---------------------------------------------------------------- idempotency (T041–T050)
  section('Idempotent replay, changed metadata, duplicate SQL refusal, unique identity under race')
  const before41 = await counts()
  const replay1 = await register(S1, ref('WORKED-1'))
  check('T041', 'Exact replay', replay1.status === 200 && same(replay1.body, R1.body) && (await unchanged(before41)), 'the identical request again: 200 with exactly the original DTO, no row and no audit')
  const replayByB = await register(S1, ref('WORKED-1'), B.who)
  check('T042', 'Replay by another actor', replayByB.status === 200 && same(replayByB.body, R1.body) && replayByB.body.recordedByUserId === creatorId && (await unchanged(before41)), 'another Admin repeating the registration gets the original record (its original actor), never a second one')
  const replayLater = await register(S1, ref('WORKED-1'))
  check('T043', 'Replay after growth', replayLater.status === 200 && same(replayLater.body, R1.body), 'the first registration still replays exactly after more registrations exist')
  const replaysLeftNothing = await unchanged(before41)
  const changedMeta = [await register(S1, ref('WORKED-1'), asAdmin, { note: 'changed' }), await register(S1, ref('WORKED-1'), asAdmin, { sourceDigestSha256: 'b'.repeat(64) })]
  check(
    'T044',
    'Changed metadata never overwrites',
    changedMeta.every((res) => res.status === 400) && same((await get(evidenceIdPath(rowR1.id))).body, R1.body) && (await unchanged(before41)),
    'the same identity with extra metadata (a note, a digest) is refused (400) and the stored record is unchanged; the API carries no metadata beyond the identity, so an identity conflict is impossible to express (the service refuses a stored row that disagrees with its freeze as 409)',
  )
  const duplicateSql = await directInsert({ submission: S1, reference: ref('WORKED-1') })
  check('T045', 'Duplicate identity refused (database)', refusedBy(duplicateSql, /revenue_source_evidence_identity_key|duplicate key/), `a second row with the same identity inserted directly is refused by the unique key (${markerOf(duplicateSql)})`)
  const identityIndex = await prisma.$queryRaw<{ def: string }[]>`SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'revenue_source_evidence_identity_key'`
  check('T046', 'Identity definition', /CREATE UNIQUE INDEX revenue_source_evidence_identity_key ON public\.revenue_source_evidence USING btree \(claim_submission_id, source_kind, source_reference, source_version\)/.test(identityIndex[0]?.def ?? ''), 'UNIQUE (claim_submission_id, source_kind, source_reference, source_version)')
  const Q = await home.series('races', 2)
  const before47 = await counts()
  const pair = await Promise.all([register(Q.freezes[0], ref('RACE-2')), register(Q.freezes[0], ref('RACE-2'))])
  const d47 = delta(before47, await counts())
  check('T047', 'Simultaneous duplicates', same(pair.map((r) => r.status).sort(), [200, 201]) && same(pair[0].body, pair[1].body) && d47.revenue_source_evidence === 1 && d47.audit_events === 1, `${pair.map((r) => r.status).sort().join('/')}: one record, one audit, one identical body`)
  const before48 = await counts()
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => register(Q.freezes[0], ref('RACE-5'))))
  const d48 = delta(before48, await counts())
  check('T048', 'Five at once', five.filter((r) => r.status === 201).length === 1 && five.filter((r) => r.status === 200).length === 4 && five.every((r) => same(r.body, five[0].body)) && d48.revenue_source_evidence === 1 && d48.audit_events === 1, `five simultaneous identical registrations: one 201, four 200, one record and one audit`)
  const hold49 = holdAt('revenueEvidence.inserted')
  const first49 = registerRevenueSourceEvidence(Q.freezes[1], { sourceKind: SYNTHETIC, sourceReference: ref('HELD') }, creatorId)
  await Promise.race([hold49.arrived, first49])
  const second49 = registerRevenueSourceEvidence(Q.freezes[1], { sourceKind: SYNTHETIC, sourceReference: ref('HELD') }, B.id)
  const waited49 = !(await settledWithin(second49, 3000))
  hold49.release()
  const [r49a, r49b] = await Promise.all([first49, second49])
  clearConcurrencyProbes()
  check(
    'T049',
    'Unique identity under a held race',
    waited49 && r49a.ok && !r49a.value.replayed && r49b.ok && r49b.value.replayed && same(r49a.value.evidence, r49b.value.evidence),
    'a second registration during an uncommitted first waits for the Claim lock, then replays the committed record',
  )
  const duplicates = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT 1 FROM revenue_source_evidence GROUP BY claim_submission_id, source_kind, source_reference, source_version HAVING count(*) > 1) d`
  check('T050', 'No duplicate identity anywhere', Number(duplicates[0].n) === 0, 'no identity is registered twice anywhere in the database')

  // ---------------------------------------------------------------- direct SQL (T051–T060)
  section('Direct SQL: RESTRICT foreign keys, CHECKs and NULL pitfalls, database time, coherence and immutability')
  const fkRows = await prisma.$queryRaw<{ name: string; del: string }[]>`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = ${TABLE}`
  check('T051', 'RESTRICT foreign keys', fkRows.length === 3 && fkRows.every((row) => row.del === 'r'), 'organization, frozen submission and actor foreign keys are all ON DELETE RESTRICT; nothing cascades')
  const control = await directInsert({ submission: S1 })
  check('T052', 'Valid direct insert accepted', control.includes(NOT_REFUSED), 'a legal registration inserted directly is accepted (then rolled back): the refusals around it are the guards, not the setup')
  const versionSql = [await directInsert({ submission: S1, version: 'A7-REVENUE-SOURCE-2' }), await directInsert({ submission: S1, version: null })]
  check('T053', 'Contract CHECK', versionSql.every((message) => refusedBy(message, /revenue_source_evidence_version_chk|null value/)), `another or a NULL contract is refused (${versionSql.map(markerOf).join(', ')})`)
  const kindSql = [await directInsert({ submission: S1, kind: null }), await directInsert({ submission: S1, kind: 'internal_synthetic' }), await directInsert({ submission: S1, kind: 'PAYER_CONFIRMED' })]
  check('T054', 'Kind CHECK and NULL pitfall', kindSql.every((message) => refusedBy(message, /revenue_source_evidence_kind_chk|null value/)), `a NULL, lower-case or invented kind is refused (${kindSql.map(markerOf).join(', ')})`)
  const referenceSql = [await directInsert({ submission: S1, reference: null }), await directInsert({ submission: S1, reference: 'SYN REF' }), await directInsert({ submission: S1, reference: 'X'.repeat(65) })]
  check('T055', 'Reference CHECK and NULL pitfall', referenceSql.every((message) => refusedBy(message, /revenue_source_evidence_reference_chk|null value/)), `a NULL, spaced or over-long reference is refused (${referenceSql.map(markerOf).join(', ')})`)
  check('T056', 'Digest CHECK', refusedBy(digestSql, /revenue_source_evidence_digest_chk/) && refusedBy(await directInsert({ submission: S1, digest: '0'.repeat(64) }), /revenue_source_evidence_digest_chk/), 'no digest of any value can be stored in A7.1')
  const timeSql = await directInsert({ submission: S1, receivedAt: true })
  check('T057', 'Database time only', refusedBy(timeSql, /revenue_source_evidence_time/), 'a supplied (backdated) instant is refused')
  check('T058', 'Organization coherence', crossOrgSql.every((message) => refusedBy(message, /revenue_source_evidence_coherence/)), 'the row\'s organization must be exactly the one that owns its frozen submission')
  const updates = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET source_reference = source_reference WHERE id = $1::uuid`, rowR1.id)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, rowR1.id)),
  ]
  check('T059', 'No update or delete', updates.every((message) => /is append-only/.test(message)), 'UPDATE (even a no-op) and DELETE are refused')
  // TRUNCATE removes rows without firing row-level triggers; it has its own statement-level guard. The whole
  // table is hashed before and after, so "refused" also means "nothing changed".
  const tableHash = async () => {
    const row = (await prisma.$queryRaw<{ n: bigint; h: string }[]>`SELECT count(*) AS n, encode(sha256(convert_to(coalesce(string_agg(row_to_json(r)::text, '|' ORDER BY r.id), ''), 'UTF8')), 'hex') AS h FROM revenue_source_evidence r`)[0]
    return { n: Number(row.n), h: row.h }
  }
  const truncateTrigger = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'revenue_source_evidence'::regclass AND tgname = 'revenue_source_evidence_no_truncate_trg'`)[0]?.def ?? ''
  const beforeTruncate = await tableHash()
  const truncate = await attemptAdversarial(() => prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`)
    throw new Error(NOT_REFUSED)
  }))
  const truncateCascade = await attemptAdversarial(() => prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`TRUNCATE ${TABLE} CASCADE`)
    throw new Error(NOT_REFUSED)
  }))
  const afterTruncate = await tableHash()
  check(
    'T060',
    'No bulk wipe',
    refusedBy(truncate, /revenue_source_evidence is append-only: TRUNCATE is not permitted/) && refusedBy(truncateCascade, /is append-only: TRUNCATE/) &&
      /^CREATE TRIGGER revenue_source_evidence_no_truncate_trg BEFORE TRUNCATE ON public\.revenue_source_evidence FOR EACH STATEMENT EXECUTE FUNCTION revenue_source_evidence_append_only\(\)$/.test(truncateTrigger) &&
      beforeTruncate.n > 0 && same(afterTruncate, beforeTruncate),
    `TRUNCATE and TRUNCATE … CASCADE (which bypass row triggers) are refused by the statement-level BEFORE TRUNCATE guard; all ${beforeTruncate.n} rows are byte-identical afterwards`,
  )

  // ---------------------------------------------------------------- atomicity (T061–T070)
  section('Atomicity: one row and one audit, crash after row, crash after audit, retry, confirmed replay')
  check(
    'T061',
    'One-shot registration',
    same(delta(before21, after21), { ...Object.fromEntries(COUNT_TABLES.map((t) => [t, 0])), revenue_source_evidence: 1, audit_events: 1 }),
    'exactly one registration and one audit; no freeze, lifecycle, correction, pricing or review row',
  )
  const K = await home.series('crash injection', 1)
  const countsBeforeCrash = await counts()
  const crashAt = async (probe: string) => {
    failAt(probe)
    const message = await attemptAdversarial(() => registerRevenueSourceEvidence(K.freezes[0], { sourceKind: SYNTHETIC, sourceReference: ref('CRASH') }, creatorId))
    clearConcurrencyProbes()
    return { message, unchanged: await unchanged(countsBeforeCrash) }
  }
  const crash1 = await crashAt('revenueEvidence.inserted')
  const crash2 = await crashAt('revenueEvidence.audited')
  check('T062', 'Crash after the row', crash1.message.includes('INJECTED_CRASH') && crash1.unchanged, 'a failure after the row insert rolls back everything: no row, no audit')
  check('T063', 'Crash after the audit', crash2.message.includes('INJECTED_CRASH') && crash2.unchanged, 'a failure after the audit, before commit, rolls back the row and the audit')
  const retry = await register(K.freezes[0], ref('CRASH'))
  check('T064', 'Retry after a crash', retry.status === 201 && (await prisma.revenueSourceEvidence.count({ where: { claimSubmissionId: K.freezes[0] } })) === 1, 'the same request after the failures registers exactly once')
  const before65 = await counts()
  const replays = [await register(K.freezes[0], ref('CRASH')), await register(K.freezes[0], ref('CRASH')), await register(K.freezes[0], ref('CRASH'))]
  check('T065', 'Confirmed replay never doubles', replays.every((res) => res.status === 200 && same(res.body, retry.body)) && (await unchanged(before65)), 'three replays of a committed registration: 200 each, the same record, no row and no audit')
  const auditOnce = await prisma.$queryRaw<{ bad: bigint }[]>`SELECT count(*) AS bad FROM revenue_source_evidence r WHERE (SELECT count(*) FROM audit_events a WHERE a.entity_id = r.id AND a.action_code = 'revenue_source_evidence.registered') <> 1`
  check('T066', 'Audit exactly once', Number(auditOnce[0].bad) === 0, 'every registration in the database has exactly one audit event')
  check(
    'T067',
    'Audit action and keys',
    auditR1.actionCode === 'revenue_source_evidence.registered' && auditR1.entityType === 'REVENUE_SOURCE_EVIDENCE' && same(Object.keys(auditR1.afterState as object).sort(), [...AUDIT_KEYS].sort()) && auditR1.beforeState === null,
    'revenue_source_evidence.registered on REVENUE_SOURCE_EVIDENCE with exactly ids, kind, reference, contract and time',
  )
  const auditR2 = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: R2.body.revenueSourceEvidenceId } })
  check('T068', 'Audit actor, tenant and time', auditR1.actorUserId === creatorId && auditR2.actorUserId === B.id && auditR1.organizationId === org && (auditR1.afterState as any).receivedAt === rowR1.receivedAt.toISOString(), "each audit names its actor, the submission's organization and the registration's database instant")
  check('T069', 'No audit on replay or read', replaysLeftNothing && readsLeftNothing && (await prisma.auditEvent.count({ where: { entityId: rowR1.id } })) === 1, 'replays (T041–T043, T065) and reads (T040) wrote no row and no audit; the first registration still has exactly one')
  check('T070', 'Refusals wrote nothing', refusalsLeftNothing && (await unchanged(before65)), 'every 400/401/403/404 above wrote no row and no audit')

  // ---------------------------------------------------------------- concurrency (T071–T080)
  section('Concurrency: Claim lock first, ordering with A6.2/A6.8/A6.9 writers, reads, bounded retry, unknown outcome')
  check(
    'T071',
    'Claim lock first, SERIALIZABLE',
    /lockRowForUpdateNowait\(tx, 'claims', owner\.claimId\)/.test(txBody.split('\n').slice(0, 3).join('\n')) && /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && !/withReadSnapshot|prisma\./.test(txBody),
    'the Claim row lock (NOWAIT) is the first statement; every read and write uses the one SERIALIZABLE transaction client',
  )
  const L = await home.series('line edit', 1)
  const hold72 = holdAt('claimLine.removed')
  const removal = removeClaimLine(L.lineIds[1], {}, creatorId)
  await Promise.race([hold72.arrived, removal])
  const reg72 = registerRevenueSourceEvidence(L.freezes[0], { sourceKind: SYNTHETIC, sourceReference: ref('AFTER-EDIT') }, creatorId)
  const waited72 = !(await settledWithin(reg72, 3000))
  hold72.release()
  const [removed72, r72] = await Promise.all([removal, reg72])
  clearConcurrencyProbes()
  check('T072', 'Ordered after Claim writers', waited72 && removed72.ok && r72.ok && !r72.value.replayed, 'a registration during an uncommitted A6.2 line edit waits for the shared Claim lock, then records')
  const Lc = await home.series('lifecycle race', 1)
  const hold73 = holdAt('revenueEvidence.claim_locked')
  const reg73 = registerRevenueSourceEvidence(Lc.freezes[0], { sourceKind: SYNTHETIC, sourceReference: ref('LIFECYCLE') }, creatorId)
  await Promise.race([hold73.arrived, reg73])
  const event73 = recordLifecycleEvent(Lc.freezes[0], { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }, creatorId)
  const waited73 = !(await settledWithin(event73, 3000))
  hold73.release()
  const [r73, e73] = await Promise.all([reg73, event73])
  clearConcurrencyProbes()
  check('T073', 'Serialized with A6.8 decisions', waited73 && r73.ok && e73.ok && e73.value.lifecycle.state === 'RELEASE_ELIGIBLE', 'an A6.8 event during an in-flight registration waits for the Claim lock; both commit; the registration changed no disposition')
  const Lk = await home.series('link race', 2)
  const hold74 = holdAt('revenueEvidence.claim_locked')
  const reg74 = registerRevenueSourceEvidence(Lk.freezes[0], { sourceKind: SYNTHETIC, sourceReference: ref('LINK') }, creatorId)
  await Promise.race([hold74.arrived, reg74])
  const link74 = recordCorrectionLink(Lk.claimId, { priorSubmissionId: Lk.freezes[0], correctedSubmissionId: Lk.freezes[1], reasonCode: 'CORRECTED_SOURCE' }, creatorId)
  const waited74 = !(await settledWithin(link74, 3000))
  hold74.release()
  const [r74, l74] = await Promise.all([reg74, link74])
  clearConcurrencyProbes()
  check('T074', 'Serialized with A6.9 links', waited74 && r74.ok && l74.ok && !l74.value.replayed, 'an A6.9 correction link during an in-flight registration waits for the Claim lock; both commit independently')
  const Rd = await home.series('isolation', 1)
  const hold75 = holdAt('revenueEvidence.inserted')
  const pending75 = registerRevenueSourceEvidence(Rd.freezes[0], { sourceKind: SYNTHETIC, sourceReference: ref('ISOLATION') }, creatorId)
  await Promise.race([hold75.arrived, pending75])
  const during75 = get(evidencePath(Rd.freezes[0]))
  const prompt75 = await settledWithin(during75, 5000)
  const duringItems = (await during75).body?.items ?? null
  hold75.release()
  const r75 = await pending75
  clearConcurrencyProbes()
  check('T075', 'Reads see committed history', prompt75 && Array.isArray(duringItems) && duringItems.length === 0 && r75.ok && (await historyOf(Rd.freezes[0])).length === 1, 'a read during an uncommitted registration answers at once from committed history; after the commit it shows the record')
  check(
    'T076',
    'Bounded retry',
    /const MAX_REGISTRATION_ATTEMPTS = 3/.test(serviceCode) && /const MAX_LOCK_WAITS = 5/.test(serviceCode) && /P2034/.test(serviceCode) && /40001/.test(serviceCode) && /isUniqueViolation\(error\)/.test(serviceCode),
    'serialization, deadlock and unique races retry at most three times on a fresh transaction (re-reading the replay); a busy Claim is waited for at most five times',
  )
  check(
    'T077',
    'Unknown outcome never re-inserted',
    /if \(isUnknownOutcome\(error\)\)\s*return \{ ok: false, code: 'REVENUE_EVIDENCE_CONFLICT'/.test(serviceCode) && /P2028/.test(serviceCode),
    'a lost connection or transaction is a safe 409 telling the caller to re-read the history, never a blind second insert',
  )
  const Ip = await home.series('in-process race', 1)
  const inProcess = await Promise.all([1, 2].map(() => registerRevenueSourceEvidence(Ip.freezes[0], { sourceKind: SYNTHETIC, sourceReference: ref('IN-PROCESS') }, creatorId)))
  check(
    'T078',
    'Same request in process',
    inProcess.every((r) => r.ok) && same(inProcess.map((r) => (r.ok ? r.value.replayed : null)).sort(), [false, true]) && (await prisma.revenueSourceEvidence.count({ where: { claimSubmissionId: Ip.freezes[0] } })) === 1,
    'two identical in-process registrations: one new, one replay, one record',
  )
  const before79 = await counts()
  const distinct = await Promise.all([register(Ip.freezes[0], ref('DISTINCT-A')), register(Ip.freezes[0], ref('DISTINCT-B'))])
  check('T079', 'Different references at once', distinct.every((r) => r.status === 201) && delta(before79, await counts()).revenue_source_evidence === 2, 'two different references registered at once on one submission: two records, neither lost')
  const orphanAudits = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM audit_events a WHERE a.action_code = 'revenue_source_evidence.registered' AND NOT EXISTS (SELECT 1 FROM revenue_source_evidence r WHERE r.id = a.entity_id)`
  check('T080', 'No orphan after the races', Number(orphanAudits[0].n) === 0 && Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT 1 FROM revenue_source_evidence GROUP BY claim_submission_id, source_kind, source_reference, source_version HAVING count(*) > 1) d`)[0].n) === 0, 'after every race no audit lacks its registration and no identity is duplicated')

  // ---------------------------------------------------------------- privacy (T081–T090)
  section('Privacy: minimal DTO, no PHI or payload, safe errors, read-only page, no logs or browser storage')
  check('T081', 'Minimal DTO', [R1.body, R2.body, ...twice[0], readR1.body].every((dto: any) => same(Object.keys(dto), DTO_KEYS)), 'every response carries exactly the eight DTO fields')
  const exposed = JSON.stringify([R1.body, R2.body, twice[0], auditR1.afterState, auditR2.afterState])
  check('T082', 'No PHI', !exposed.includes(`${runId}-home-P`) && !exposed.includes('1990-01-01') && !exposed.includes('-DXA') && !/125\.25|12\.125|200\.01/.test(exposed), 'no patient name, birth date, diagnosis code or amount in any DTO or audit')
  check('T083', 'No bytes, manifest or seal', ![...deepKeys(JSON.parse(exposed))].some((k) => /bytes|manifest|payload|seal|hash|amount|status|payer|paid|denial/i.test(k)), 'DTOs and audits carry no payload bytes, manifest, seal, hash, amount, status, payer, paid or denial key')
  check(
    'T084',
    'Safe error bodies',
    [...unknownFields, ...serverOwned, ...verdicts, ...malformed, viewerPost, ...foreignOnHome, ...homeOnForeign, ...badRefs, external, missing, ...changedMeta].every((res) => !rawError(res.body) && typeof res.body?.error?.code === 'string'),
    'every 400/403/404 carries a code and a safe message only',
  )
  const frontend = committedCode(`${FE_DIR}/RevenueEvidenceCheck.tsx`)
  check('T085', 'Read-only page, no storage', frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|console\.|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend), 'the Developer Tools page only reads; nothing is logged or kept in browser storage')
  const production = committedProductionCodeOf([MODULE_DIR])
  check('T086', 'No logs', production.files.length === 5 && !/console\.|logger\./.test(production.code), 'the A7.1 backend code logs nothing')
  const registry = committedCode('frontend/src/developer/checkRegistry.tsx')
  check('T087', 'Registered read-only check', /key: 'revenue-evidence'/.test(registry) && /revenue-source-evidence`\)/.test(frontend) && !/fetch\([^)]*,\s*\{/.test(frontend), 'the page is registered in Developer Tools and makes one plain GET (no request options, so no write)')
  const foreignRead = await get(evidenceIdPath(rowR1.id), O.who)
  const foreignMissingRead = await get(evidenceIdPath(MISSING), O.who)
  check('T088', 'Cross-tenant single read', foreignRead.status === 404 && same(foreignRead.body?.error?.message, foreignMissingRead.body?.error?.message), "another organization's Admin gets 404 for this registration, exactly like a missing one")
  const missingRead = await get(evidenceIdPath(MISSING))
  check('T089', 'Missing registration', missingRead.status === 404 && errorCode(missingRead.body) === 'NOT_FOUND', 'a missing registration: 404')
  check('T090', 'Viewer sees the same', same(viewerTwice, twice[0]) && same((await get(evidenceIdPath(rowR1.id), asViewer)).body, R1.body), 'a Viewer reads exactly what an Admin reads')

  // ---------------------------------------------------------------- no fiction (T091–T100)
  section('Deterministic history, no paid/accepted fiction, no patient or payer content, no balance mutation')
  const sqlOrder = (await prisma.revenueSourceEvidence.findMany({ where: { claimSubmissionId: S1 }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], select: { id: true } })).map((row) => row.id)
  check('T091', 'Deterministic history', same(twice[0].map((item: any) => item.revenueSourceEvidenceId), sqlOrder), 'the history is the database-recorded order (then id) and reads identically every time')
  const Re = await home.series('release eligible', 1)
  await post(`/api/claim-submissions/${Re.freezes[0]}/lifecycle-events`, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null })
  const onReleased = await register(Re.freezes[0], ref('RELEASED'))
  check(
    'T092',
    'RELEASE_ELIGIBLE is not paid or sent',
    onReleased.status === 201 && same(Object.keys(onReleased.body), DTO_KEYS) && onReleased.body.sourceKind === SYNTHETIC && (await get(`/api/claim-submissions/${Re.freezes[0]}/lifecycle`)).body?.state === 'RELEASE_ELIGIBLE',
    'a registration on a RELEASE_ELIGIBLE freeze is still only INTERNAL_SYNTHETIC evidence: no paid, sent or accepted state appears, and the disposition is unchanged',
  )
  const columns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${TABLE}`).map((row) => row.c)
  check(
    'T093',
    'No newest or current',
    columns.length === 10 && columns.every((c) => A71_COLUMNS.includes(c)) && !columns.some((c) => /current|latest|newest|superseded|status|state/.test(c)),
    'the table has exactly its 10 columns: no current, latest, newest, superseded, status or state; a correction never makes a registration "newest" (T033)',
  )
  check('T094', 'No money or verdict', !columns.some((c) => /amount|currency|paid|denial|adjudicat|remit|balance|allowed|share|verified/.test(c)) && !/PAID|ACCEPTED|DENIED|SETTLED|REMITTED/.test(JSON.stringify(twice[0])), 'no amount, currency, paid, denial, adjudication, remittance, balance or verified column, and no such value in any DTO')
  check('T095', 'No patient or payer content', !columns.some((c) => /patient|member|payer|diagnos|name|birth|address|phone|email/.test(c)), 'no patient, member, payer, diagnosis or personal column')
  const before96 = await counts()
  await register(Re.freezes[0], ref('NO-BALANCE'))
  const d96 = delta(before96, await counts())
  check('T096', 'No balance mutation', same(d96, { ...Object.fromEntries(COUNT_TABLES.map((t) => [t, 0])), revenue_source_evidence: 1, audit_events: 1 }), 'a registration writes no Claim, pricing, review, freeze, lifecycle or correction row: it changes no balance anywhere')
  check('T097', 'A6.7 reads unchanged', same((await get(`/api/claim-submissions/${S1}`)).body, freezeReadBefore), 'the frozen submission read is identical before and after its registrations')
  const pricingOfW = await prisma.claimPricingRun.findMany({ where: { claimId: W.claimId }, orderBy: { evaluatedAt: 'asc' } })
  check('T098', 'Pricing unchanged', pricingOfW.length === 1 && pricingOfW[0].totalExtendedAmount?.toFixed(2) === '200.01', 'the Claim keeps its one immutable pricing run and its AED 200.01 total')
  const rowsAtEnd = await prisma.revenueSourceEvidence.findMany({ where: { claimSubmissionId: S1 }, orderBy: { id: 'asc' } })
  const inTx = await withReadSnapshot(undefined, (tx) => getRevenueSourceEvidenceOf(S1, tx))
  check('T100', 'Transaction-aware read', inTx.ok && same(inTx.value.items, twice[0]), 'getRevenueSourceEvidenceOf(submissionId, tx) for later A7 owners equals the HTTP read')

  // ---------------------------------------------------------------- boundaries (T101–T110)
  section('Zero A6 changes, no A7.2/A9 leakage, no outbound calls, no settlement or real-evidence fiction')
  check('T101', 'Zero A6 changes', ownerChanged.length === 0, 'no A5/A6 owner module, frontend page or harness changed (T009)')
  const newTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(revenue|remittance|payment|receivable|adjudicat|denial|settlement|posting|ledger|outbox|queue|transmission|acknowledg)'`).map((row) => row.t)
  check('T102', 'One new table', same(newTables, [TABLE]), 'exactly one A7.1 table; no remittance, payment, receivable, adjudication, denial, settlement, posting, ledger, outbox, queue or transmission table')
  check('T103', 'No outbound call', !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|<\?xml|\bx12\b|\bhl7\b|\bfhir\b|enqueue/i.test(production.code), 'no network client, XML/X12/HL7/FHIR or queue in A7.1 code')
  check('T104', 'No settlement logic', !/settle|posting|ledger|receivable|allocat|Decimal|amount/i.test(production.code.replace(/refusedByName = \[[\s\S]*?\] as const/, '')), 'A7.1 code computes no money and has no settlement, posting, ledger, receivable or allocation logic (refused field names aside)')
  const validationCode = committedCode(`${MODULE_DIR}/revenue-evidence.validation.ts`)
  check('T105', 'No verified path', /return \{ ok: true, value: \{ sourceKind: REVENUE_SOURCE_KIND_SYNTHETIC/.test(validationCode) && /acceptedRevenueSourceKinds = \[REVENUE_SOURCE_KIND_SYNTHETIC\] as const/.test(committedCode(`${MODULE_DIR}/revenue-evidence.types.ts`)), 'the only accepted kind in code is INTERNAL_SYNTHETIC; EXTERNAL_VERIFIED has no acceptance path')
  check('T106', 'No later-phase routes', absent.every((res) => res.status === 404), 'verify, payment, remittance, posting and balance routes do not exist (T008)')
  const jobsChanged = changedPaths.filter((file) => /^backend\/src\/jobs\//.test(file))
  check('T107', 'No job or worker', jobsChanged.length === 0 && !/setInterval|setTimeout|worker|cron/i.test(production.code), 'A7.1 registers no job, worker, timer or schedule')
  const fiction = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM revenue_source_evidence WHERE source_kind <> 'INTERNAL_SYNTHETIC' OR source_digest_sha256 IS NOT NULL`
  check('T108', 'No real-evidence fiction', Number(fiction[0].n) === 0, 'every registration in the database is INTERNAL_SYNTHETIC with no digest: nothing pretends to be verified payer evidence')
  const a6Columns = await prisma.$queryRaw<{ t: string; n: bigint }[]>`SELECT table_name AS t, count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('claims', 'claim_freezes') GROUP BY 1 ORDER BY 1`
  check('T109', 'A6 tables unchanged', same(a6Columns.map((r) => [r.t, Number(r.n)]), [['claim_freezes', 13], ['claims', 7]]), 'claims keep 7 columns and claim_freezes 13: no reverse pointer or status was added')
  check('T110', 'No market switch', !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION)\w*|['"`](AE-DU|DHA|AED|US)['"`]/.test(production.code), 'A7.1 holds no UAE/US market branch or literal; future US support stays configuration')

  const worked = { S1, rows: rowsAtEnd.map((row) => ({ ...row, receivedAt: row.receivedAt.toISOString(), createdAt: row.createdAt.toISOString() })), history: twice[0] }

  // ---------------------------------------------------------------- regressions (T111–T120)
  section('Regressions — A6.10 invoked, nesting A6.9 -> A6.8 -> … -> A6.1 -> A5.10 -> A1')
  await apiReady('the A6.10 and backward regression chain')
  const chain = run('npm run test:a6:integration')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A6.10')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.10] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.10 asserts facts about its own branch, its own (absent) migration and production diff, its nested N/A
  // proofs against its own branch, and its own upstream. On A7.1 those statements are obsolete by design; every
  // other A6.10 check is substantive. T120 below proves each cause independently, never from the id.
  const a610NonApplicable: Record<string, string> = {
    T001: "A6.10 'Start gate' requires the A6.10 feature branch; A7.1 is branched from the main that contains the A6.10 merge and the A6 harness correction",
    T004: "A6.10 'No migration or schema change' judges its own branch, which added none; A7.1 adds exactly one migration (T004 here)",
    T007: "A6.10 'No route, permission or vocabulary' judges its own branch, which added none; A7.1 adds its module, two permissions, one audit action and one error code (T007/T010 here)",
    T010: "A6.10 'Diff scope' lists the paths A6.10 was allowed to change; A7.1 legitimately changes different ones (T010 here)",
    T120: "A6.10 'Nested N/A causes proven' proves A6.9's causes against the A6.10 branch (its migration, diff and upstream); on A7.1 those proofs are re-done here (T120)",
    T130: "A6.10 'Exact head and repeatability' requires the upstream to be the A6.10 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a610NonApplicable))
  const summary = chain.output.match(/\[A6\.10\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A6\.10\] RUN ABORTED|\[A6\.10\] uncaught error|\[A6\.10\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a610Substantive = rows.filter((row) => !(row.id in a610NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a610Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T111',
    'A6.10 regression',
    ran && reconciled && undocumented.length === 0 && a610Substantive.length === 0 && a610Passing >= 124,
    !ran
      ? 'the A6.10 suite did not complete'
      : !reconciled
        ? `A6.10 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A6.10 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A6\.10\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.10] automated summary: ', 'A6.10 ')}; all ${a610Passing} substantive checks PASS and every failure is documented`,
  )
  for (const id of Object.keys(a610NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A6.10 ${titleOf(row.line)}`, a610NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T112', 'A6.9 regression', verdictOf('T111') === 'PASS', `A6.10 T111 (A6.9 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A6.8 regression', verdictOf('T112') === 'PASS', `A6.10 T112 (A6.8) ${verdictOf('T112')}`)
  check('T114', 'A6.7 regression', verdictOf('T113') === 'PASS', `A6.10 T113 (A6.7) ${verdictOf('T113')}`)
  check('T115', 'A6.6 and A6.5 regression', verdictOf('T114') === 'PASS' && verdictOf('T115') === 'PASS', `A6.10 T114 (A6.6) ${verdictOf('T114')}, T115 (A6.5) ${verdictOf('T115')}`)
  check('T116', 'A6.4 and A6.3 regression', verdictOf('T116') === 'PASS' && verdictOf('T117') === 'PASS', `A6.10 T116 (A6.4) ${verdictOf('T116')}, T117 (A6.3) ${verdictOf('T117')}`)
  check('T117', 'A6.2 and A6.1 regression', verdictOf('T118') === 'PASS', `A6.10 T118 (A6.2, A6.1) ${verdictOf('T118')}`)
  check('T118', 'A5.10 → A1 regression', verdictOf('T119') === 'PASS', `A6.10 T119 (A5.8–A5.10 and A1–A4) ${verdictOf('T119')}`)
  check('T119', 'A6 journey and closure checks', ['T011', 'T013', 'T076', 'T082', 'T091', 'T109', 'T125', 'T126', 'T129'].every((id) => verdictOf(id) === 'PASS'), 'the A6.10 real-engine journey, manifest lineage, lifecycle walk, correction, provenance, checksums, replay and golden reconstruction all PASS on this branch')
  // Each documented A6.10 failure must fail for its branch-only reason, proved independently on this branch.
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
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const a610Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA69 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const productionChanged = changedPaths.filter((p) => /^(backend\/src\/(modules|shared|scripts|jobs|app\.ts|server\.ts)|frontend\/src\/)/.test(p))
  const causes: Record<string, boolean> = {
    T001: branch === a71Branch && a610Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a610Merge} HEAD`) && correctiveMerge.length === 40,
    T004: same(migrationStatus, [`A\t${MIGRATION}`]),
    T007: productionChanged.length > 0 && productionChanged.every((file) => ownDirs.some((dir) => file.startsWith(`${dir}/`)) || allowed.includes(file)) && outOfScope.length === 0,
    T010: a610Unexpected.length > 0 && a610Unexpected.every((path, index) => changedPaths.includes(path) || (index === a610Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A6.10 re-proves A6.9's branch-only causes against the A6.10 branch; on A7.1 only those tied to the branch
    // (its migration, diff and upstream) can be unproven — re-proved here against this branch.
    T120: unprovenA69.length > 0 && unprovenA69.every((id) => ['T001', 'T004', 'T010', 'T120', 'T130'].includes(id)) && same(migrationStatus, [`A\t${MIGRATION}`]) && outOfScope.length === 0 && tracking.includes(`origin/${a71Branch}`),
    T130: tracking.includes(`origin/${a71Branch}`) && !/origin\/feature\/a6-10/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  check('T120', 'Nested N/A causes proven', ran && unproven.length === 0, unproven.length === 0 ? `each documented A6.10 failure (${failing.join(', ') || 'none'}) fails only for its branch-only reason, proved independently on this branch` : `cause not proven for: ${unproven.join(', ')}`)

  // ---------------------------------------------------------------- builds and final evidence (T121–T130)
  section('Units, typecheck, frontend, Prisma checksum, replay, outage and recovery, synthetic only, exact head')
  const allUnit = run('npm run test:unit')
  const validationUnit = run(`node --test ${VALIDATION_TEST.replace('backend/', '')}`)
  check('T121', 'Unit tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && validationUnit.ok && /ℹ pass 6/.test(validationUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 6 A7.1 strict-request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Typecheck', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const appliedChecksum = (await prisma.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM _prisma_migrations WHERE migration_name = '20261020090000_a7_1_revenue_source_evidence' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.checksum
  const blob = spawnSync('git', ['show', `HEAD:${MIGRATION}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checkoutChecksum = sha256Of(readFileSync(`../${MIGRATION}`))
  check(
    'T125',
    'Prisma status and checksum',
    status.ok && replay.ok && (appliedChecksum === checkoutChecksum || appliedChecksum === sha256Of(blob)),
    `the A7.1 migration is applied with the checksum of its committed file (${(appliedChecksum ?? '').slice(0, 12)}…); status up to date`,
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
  check('T126', 'DB outage truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')
  await waitFor(databaseUp, 60_000)
  const afterOutageRows = (await prisma.revenueSourceEvidence.findMany({ where: { claimSubmissionId: S1 }, orderBy: { id: 'asc' } })).map((row) => ({ ...row, receivedAt: row.receivedAt.toISOString(), createdAt: row.createdAt.toISOString() }))
  const afterOutageHistory = await historyOf(S1)
  const runRows = await prisma.revenueSourceEvidence.findMany({ where: { createdAt: { gte: runStartedAt } }, select: { sourceReference: true, organizationId: true } })
  const runToken = runId.replace(/^A71-/, '')
  check(
    'T127',
    'Synthetic data only',
    runRows.length > 0 && runRows.every((row) => row.sourceReference.includes(runToken) && row.organizationId === org),
    `${runRows.length} registrations created since this run started, every reference keyed by ${runId}`,
  )
  check('T128', 'No unexpected 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  console.log(`[${TAG}]      worked example: frozen submission ${S1} — ${worked.history.map((item: any) => `${item.sourceKind} ${item.sourceReference} at ${item.receivedAt}`).join('; ')}`)
  check(
    'T129',
    'Worked example after restart',
    same(afterOutageRows, worked.rows) && same(afterOutageHistory, worked.history) && worked.history.length === 2,
    'after the 2-hour nested chain and a database restart the worked registrations read back identically (rows and history)',
  )
  check('T099', 'History immutable to the end', same(afterOutageRows, worked.rows), 'the worked registrations are byte-identical at the end of the run')

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|integration\/a(8|9)|dhpo|eclaimlink/i.test(file))
  check(
    'T010',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A7.1 module, migration and model, harness and check page, two permissions, one error code, one audit action and wiring; no A5/A6 owner changed; no A7.2+/A8/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  check(
    'T130',
    'Exact head, repeatability, evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a71Branch}`) && !/ahead|behind/.test(tracking) && same(afterOutageHistory, worked.history),
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; after the database restart the worked registrations read back identically`,
  )

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] REVENUE EVIDENCE INTAKE & PROVENANCE ACCEPTANCE COMPLETE` : `[${TAG}] A7.1 FINAL FAIL`)
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
