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
import { getRevenueSourceEvidenceOf, registerRevenueSourceEvidence } from '../../modules/revenue-evidence/revenue-evidence.service.ts'
import { classifySourceEvidence, getClassificationsOf } from '../../modules/evidence-classification/evidence-classification.service.ts'
import { getReadinessOf, recordAdjudicationReadiness } from '../../modules/evidence-gate/evidence-gate.service.ts'
import { assembleCase } from '../../modules/evidence-case/evidence-case.assembler.ts'
import { assembleRevenueEvidenceCase, getCasesOf } from '../../modules/evidence-case/evidence-case.service.ts'
import type { Assembly, SourceLinks } from '../../modules/evidence-case/evidence-case.types.ts'

// A7.4 — focused acceptance for Revenue Evidence Case Assembly & Provenance Snapshot (T001–T130).
//
// Every frozen submission is built through its owners, exactly as the A6.7–A7.3 suites build them (tariff world and
// rates, the A5.7 recorder, readiness, the Claim, lines, diagnoses and pointers, pricing, draft assessments,
// APPROVE/REVOKE by a separate synthetic Admin, every freeze through the A6.7 route and the correction link through
// A6.9); every source is registered through the A7.1 route, classified through the A7.2 route and gated through the
// A7.3 route. The other organization builds its own world with its own two Admins. Cases go through the A7.4 route
// (or, for barrier-controlled races and crash injection, its service in-process). ADVERSARIAL writes go in only to
// prove a database guard; every one of them runs in a transaction that is rolled back, or whose commit the
// commit-time check refuses. Synthetic Admins are provisioned per run through Better Auth's own server-side creation
// with a random password that is never printed. Every value is synthetic and keyed by this run's id.

const TAG = 'A7.4'
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

const runId = `A74-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a74Branch = 'feature/a7-4-revenue-evidence-case-assembly'
const a73Branch = 'feature/a7-3-adjudication-evidence-readiness'
const a72Branch = 'feature/a7-2-evidence-classification'
const a71Branch = 'feature/a7-1-revenue-source-evidence'
const a610Branch = 'feature/a6-10-a6-integration-acceptance'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/evidence-case'
const FE_DIR = 'frontend/src/modules/evidence-case'
const HARNESS_DIR = 'backend/src/integration/a7-evidence-case'
const MIGRATION_NAME = '20261024090000_a7_4_evidence_case'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const A73_HARNESS = 'backend/src/integration/a7-evidence-gate/a7-evidence-gate.integration.ts'
const UNIT_TESTS = [`${MODULE_DIR}/evidence-case.assembler.test.ts`, `${MODULE_DIR}/evidence-case.validation.test.ts`]
const HEADER = 'evidence_case_snapshots'
const ENTRY = 'evidence_case_entries'
const CONTRACT = 'A7-REVENUE-CASE-1'
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const HEADER_KEYS = ['caseId', 'claimSubmissionId', 'contractVersion', 'assemblyCode', 'sourceCount', 'classifiedCount', 'readinessCount', 'itemCount', 'manifestSha256', 'recordedByUserId', 'recordedAt']
const CASE_KEYS = [...HEADER_KEYS, 'items']
const ITEM_KEYS = ['ordinal', 'sourceEvidenceId', 'classificationId', 'readinessId', 'itemReasonCode']
const AUDIT_KEYS = ['caseId', 'claimSubmissionId', 'contractVersion', 'assemblyCode', 'sourceCount', 'classifiedCount', 'readinessCount', 'itemCount', 'manifestSha256', 'recordedAt']
const HEADER_COLUMNS = ['id', 'organization_id', 'claim_submission_id', 'contract_version', 'assembly_code', 'source_count', 'classified_count', 'readiness_count', 'item_count', 'manifest_sha256', 'recorded_by_user_id', 'recorded_at', 'created_at']
const ENTRY_COLUMNS = ['id', 'assembly_id', 'ordinal', 'source_evidence_id', 'classification_id', 'readiness_id', 'item_reason_code']
// The owners A7.4 consumes or must leave untouched: the A5/A6 modules and A7.1–A7.3 (backend, pages and suites).
const OWNER_DIRS = [
  ...[
    'claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction',
    'pre-claim-validation', 'pre-claim-readiness', 'validation-run', 'revenue-evidence', 'evidence-classification', 'evidence-gate',
  ].map((name) => `backend/src/modules/${name}`),
  'frontend/src/modules/revenue-evidence',
  'frontend/src/modules/evidence-classification',
  'frontend/src/modules/evidence-gate',
  'backend/src/integration/a7-revenue-source-evidence',
  'backend/src/integration/a7-evidence-classification',
  'backend/src/integration/a7-evidence-gate',
]
// The tables whose rows a refusal, a read or a rolled-back write must leave untouched, always read in this fixed
// key order (a UNION ALL may come back in Parallel Append order).
const COUNT_TABLES = [HEADER, ENTRY, 'evidence_gate_results', 'source_evidence_classifications', 'revenue_source_evidence', 'audit_events', 'claims', 'claim_pricing_runs', 'claim_review_events', 'claim_freezes', 'claim_freeze_evidence_manifests', 'claim_freeze_lifecycle_events', 'claim_correction_links']
// The manifest, recomputed independently from the A7.4 contract text (§5) — not through the code under test.
const MANIFEST_SQL = `encode(sha256(convert_to('SBN-A7-REVENUE-CASE-1' || chr(10) || 'contract=' || h.contract_version || chr(10) || 'claimSubmissionId=' || h.claim_submission_id::text || chr(10) || 'organizationId=' || h.organization_id::text || chr(10) || 'assemblyCode=' || h.assembly_code || chr(10) || 'sourceCount=' || h.source_count::text || chr(10) || 'classifiedCount=' || h.classified_count::text || chr(10) || 'readinessCount=' || h.readiness_count::text || chr(10) || 'itemCount=' || h.item_count::text || chr(10) || coalesce((SELECT string_agg('item=' || e.ordinal::text || '|' || e.source_evidence_id::text || '|' || coalesce(e.classification_id::text, 'NULL') || '|' || coalesce(e.readiness_id::text, 'NULL') || '|' || e.item_reason_code || chr(10), '' ORDER BY e.ordinal) FROM evidence_case_entries e WHERE e.assembly_id = h.id), ''), 'UTF8')), 'hex')`

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

  console.log(`[${TAG}] A7.4 revenue evidence case assembly & snapshot — run ${runId}`)
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
  section('Preflight: accepted A7.3, the one A7.4 migration, Prisma, replay, permissions, routes, contracts and ownership')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const a73Merge = mergeOf(a73Branch)
  const a72Merge = mergeOf(a72Branch)
  const a71Merge = mergeOf(a71Branch)
  const a610Merge = mergeOf(a610Branch)
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|settlement|receivable|claim-transport|claim-outbox|payer-response|integration\/a(8|9)|integration\/a7-(?!revenue-source-evidence|evidence-classification|evidence-gate|evidence-case)|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Correct A7.3 merge prerequisite',
    branch === a74Branch && a73Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a73Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A7.3 merged as ${a73Merge.slice(0, 7) || 'NOT FOUND'} and is an ancestor; contains latest main ${git('rev-parse --short origin/main')}; no A7.5+/A8/A9 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean HEAD and origin parity', dirty.length === 0 && tracking.includes(`origin/${a74Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'A7.1–A7.3 ancestry verified',
    [a610Merge, a71Merge, a72Merge, a73Merge].every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)),
    `A6.10 ${a610Merge.slice(0, 7)}, A7.1 ${a71Merge.slice(0, 7)}, A7.2 ${a72Merge.slice(0, 7)} and A7.3 ${a73Merge.slice(0, 7)} are ancestors of HEAD`,
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
    /PASS {2}the A7\.4 tables are exactly evidence_case_entries and evidence_case_snapshots/,
    /PASS {2}evidence_case_snapshots_completeness_trg is present after a clean replay/,
    /PASS {2}evidence_case_snapshots_no_truncate_trg is present after a clean replay/,
    /PASS {2}evidence_case_entries_no_truncate_trg is present after a clean replay/,
    /PASS {2}the A7\.4 CHECKs pin A7-REVENUE-CASE-1, exactly the three assembly codes and entry reasons, with no verdict/,
    /PASS {2}one case per submission and contract, one entry per ordinal and per source are unique/,
    /PASS {2}the A7\.3 tables are exactly evidence_gate_results/,
    /PASS {2}the A7\.2 tables are exactly source_evidence_classifications/,
    /PASS {2}the A7\.1 tables are exactly revenue_source_evidence/,
  ]
  check(
    'T006',
    'From-empty migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === headMigrationDirs.length && headMigrationDirs.some((dir) => MIGRATION.startsWith(`${dir}/`)),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — all ${headMigrationDirs.length} committed at HEAD, the A7.4 migration included; every A7.1–A7.4 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^evidenceCase\./.test(code)).sort()
  const invented = allCodes.filter((code) => /case/i.test(code) && /(pay|remit|post|settle|adjudicat|denial|receivable|ledger|verif|send|transmit|submit|approve|import|balance)/i.test(code))
  check(
    'T007',
    'Exact role/permission catalogue',
    same(family, ['evidenceCase.create', 'evidenceCase.read']) &&
      (await grantsOf('evidenceCase.create')) === 'ORG_ADMIN' &&
      (await grantsOf('evidenceCase.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('adjudicationReadiness.create')) === 'ORG_ADMIN' &&
      (await grantsOf('evidenceClassification.create')) === 'ORG_ADMIN' &&
      (await grantsOf('revenueEvidence.create')) === 'ORG_ADMIN' &&
      same(allCodes.filter((code) => /^revenue/i.test(code)).sort(), ['revenueEvidence.create', 'revenueEvidence.read']) &&
      invented.length === 0,
    'evidenceCase.create (Admin) and .read (Admin, Viewer) only — a scoped alias, since a "revenue" permission would collide with the A7.1 catalogue; the A7.1–A7.3 grants unchanged; no pay, settle, post, send or import permission',
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
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /evidence_case_|evidence_gate_result|source_evidence_classification|revenue_source_evidence_[a-z]|claim_freeze/.test(text)
  }
  const markerOf = (message: string) =>
    (message.match(/[a-z_]+_(chk|fkey|key)\b/) ?? message.match(/evidence_case_(snapshot|entry)_[a-z]+|is append-only|null value|cannot truncate/) ?? [message.includes('ROLLED_BACK') ? 'ACCEPTED' : message === '' ? 'COMMITTED' : '?'])[0]

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
  // B approves (separation of duties for A6.5) and assembles as a second actor; O and O2 are the two Admins of the
  // OTHER organization, who build its own frozen submission and evidence.
  const B = await provisionAdmin('b')
  const O = await provisionAdmin('o', otherOrg)
  const O2 = await provisionAdmin('o2', otherOrg)

  const casesPath = (submissionId: string) => `/api/claim-submissions/${submissionId}/revenue-evidence-cases`
  const casePath = (caseId: string) => `/api/revenue-evidence-cases/${caseId}`
  const assemble = (submissionId: string, who: Who = asAdmin, body: unknown = {}) => post(casesPath(submissionId), body, who)
  const historyOf = async (submissionId: string, who: Who = asAdmin) => (await get(casesPath(submissionId), who)).body?.items ?? []
  const wiring = [await assemble(MISSING), await get(casesPath(MISSING)), await get(casePath(MISSING))]
  const absent = [
    await api('PATCH', casePath(MISSING), {}),
    await api('PUT', casePath(MISSING), {}),
    await api('DELETE', casePath(MISSING)),
    await api('DELETE', casesPath(MISSING)),
    await api('PUT', casesPath(MISSING), {}),
    await api('POST', '/api/revenue-evidence-cases', {}),
    await api('GET', '/api/revenue-evidence-cases'),
    await api('POST', `${casePath(MISSING)}/items`, {}),
    await api('POST', `${casePath(MISSING)}/settle`, {}),
    await api('POST', `${casePath(MISSING)}/submit`, {}),
    await api('GET', `/api/claim-submissions/${MISSING}/balance`),
    await api('GET', `/api/claim-submissions/${MISSING}/revenue-evidence-cases/latest`),
  ]
  const unauthenticated = [await assemble(MISSING, anonymous), await get(casesPath(MISSING), anonymous), await get(casePath(MISSING), anonymous)]
  check(
    'T008',
    'Three routes wired, forbidden absent',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && absent.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `three routes answer a missing target with a privacy-safe 404; PATCH/PUT/DELETE, collection, item append, settle, submit, balance and latest routes are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
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
  ]
  // The one owner file A7.4 may change (user decision, disclosed in the PR): A7.4's RESTRICT key into
  // evidence_gate_results makes PostgreSQL refuse a plain TRUNCATE before A7.3's guard runs, so A7.3 T060 judges that
  // refusal on behaviour. Accepted only when every changed hunk lies inside the A7.3 T060 block, on both sides.
  const blockOf = (text: string, startMarker: string, endMarker: string) => {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((line) => line.includes(startMarker))
    const end = lines.findIndex((line, index) => index > start && line.includes(endMarker))
    return start >= 0 && end > start ? { start: start + 1, end: end + 1 } : null
  }
  const t060Block = (text: string) => blockOf(text, 'const truncateTrigger = ', 'Direct INSERT forgery, crash after row and after audit')
  const a73HarnessDiff = gitArgs(['diff', '-U0', 'origin/main...HEAD', '--', `:/${A73_HARNESS}`])
  const a73Hunks = [...a73HarnessDiff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({ oldStart: Number(m[1]), oldCount: Number(m[2] ?? 1), newStart: Number(m[3]), newCount: Number(m[4] ?? 1) }))
  const oldBlock = t060Block(gitArgs(['show', `origin/main:${A73_HARNESS}`]))
  const newBlock = t060Block(committedText(A73_HARNESS))
  const insideBlock = (start: number, count: number, block: { start: number; end: number } | null) => count === 0 || (block !== null && start >= block.start && start + count - 1 <= block.end)
  const a73HarnessOnlyT060 = a73Hunks.length > 0 && a73Hunks.every((hunk) => insideBlock(hunk.oldStart, hunk.oldCount, oldBlock) && insideBlock(hunk.newStart, hunk.newCount, newBlock))
  const ownerChanged = changedPaths.filter(
    (file) => !(file === A73_HARNESS && a73HarnessOnlyT060) && (OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)) || /^frontend\/src\/modules\/(claim|pre-claim|validation)/.test(file) || /^backend\/src\/integration\/a[1-6]/.test(file)),
  )
  check(
    'T009',
    'All earlier contracts unchanged',
    same(contracts, ['A6-CLAIM-1', 'A6-SUBMISSION-1', 'A6-LIFECYCLE-1', 'A6-CORRECTION-1', 'A7-REVENUE-SOURCE-1', 'A7-EVIDENCE-CLASS-1', 'A7-ADJ-READINESS-1']) && ownerChanged.length === 0,
    ownerChanged.length === 0
      ? `A6-CLAIM-1 … A6-CORRECTION-1 and A7-REVENUE-SOURCE-1, A7-EVIDENCE-CLASS-1, A7-ADJ-READINESS-1 unchanged; no A5/A6/A7.1–A7.3 owner module or page changed${changedPaths.includes(A73_HARNESS) ? `; the A7.3 suite changed only inside its T060 block (${a73Hunks.length} hunk(s))` : ''}`
      : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: frozen submissions, a correction link, A7.1 sources, A7.2 classifications and A7.3 results of two organizations')
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
  // §10 — Claim K holds frozen S1; S2 is its corrected freeze (an A6.9 link). F is the other organization's.
  const W = await home.series('worked', 2)
  const F = await away.series('foreign', 1)
  // A pool of independent frozen submissions on one Claim (each freeze is its own submission and case identity).
  const P = await home.series('pool', 16)
  let poolNext = 0
  const fresh = () => {
    const submission = P.freezes[poolNext]
    poolNext += 1
    if (!submission) throw new Error('fixture: the submission pool is exhausted')
    return submission
  }
  const [S1, S2] = W.freezes
  const ref = (suffix: string) => `SYN-${runId.replace(/^A74-/, '')}-${suffix}`.toUpperCase()
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
  const link = await post(`/api/claims/${W.claimId}/correction-links`, { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'CORRECTED_CODING' })
  if (link.status !== 201) throw new Error(`fixture: the worked correction link was refused with ${link.status}`)
  const K1 = await linkedSource(S1, 'E1')
  const K2 = await linkedSource(S1, 'E2')
  const KS2 = await linkedSource(S2, 'S2-E1')
  const KF = await linkedSource(F.freezes[0], 'FOREIGN', O.who)
  console.log(`[${TAG}]      fixtures ready: two synthetic AE-DU/DHA worlds, a frozen submission and its correction freeze, a pool of ${P.freezes.length} frozen submissions, and linked evidence recorded through the A7.1–A7.3 owner routes`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const delta = (before: Record<string, number>, after: Record<string, number>) => Object.fromEntries(COUNT_TABLES.map((table) => [table, after[table] - before[table]])) as Record<string, number>
  const onlyCase = (d: Record<string, number>, entries: number) => same(d, { ...Object.fromEntries(COUNT_TABLES.map((t) => [t, 0])), [HEADER]: 1, [ENTRY]: entries, audit_events: 1 })
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const runToken = runId.replace(/^A74-/, '')
  const freezeHash = (claimId: string) => hashOf(`SELECT f.*, m.id AS manifest_id, encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = $1::uuid`, claimId)
  const lifecycleHash = (claimId: string) => hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = $1::uuid`, claimId)
  const correctionHash = (claimId: string) => hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = $1::uuid`, claimId)
  const sourceHash = () => hashOf(`SELECT r.* FROM revenue_source_evidence r WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const classificationHash = () => hashOf(`SELECT c.* FROM source_evidence_classifications c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const readinessHash = () => hashOf(`SELECT g.* FROM evidence_gate_results g JOIN revenue_source_evidence r ON r.id = g.source_evidence_id WHERE r.source_reference LIKE $1`, `%${runToken}%`)
  const caseHash = (caseId: string) => hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM ${HEADER} h WHERE h.id = $1::uuid UNION ALL SELECT e.id, row_to_json(e)::text FROM ${ENTRY} e WHERE e.assembly_id = $1::uuid) x`, caseId)
  const allCasesHash = () => hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM ${HEADER} h UNION ALL SELECT e.id, row_to_json(e)::text FROM ${ENTRY} e) x`)
  const NOT_REFUSED = 'ROLLED_BACK'
  const refusedBy = (message: string, marker: RegExp) => message !== '' && !message.includes(NOT_REFUSED) && marker.test(message)
  const accepted = (message: string) => message.includes(NOT_REFUSED)

  // The case the pure assembler derives for a submission from the owners' facts read on `db` — the harness reads the
  // owners itself, exactly as the service does, to judge the service and the database independently.
  const ownerLinks = async (submissionId: string, db: DbClient = prisma): Promise<SourceLinks[]> => {
    const sources = await getRevenueSourceEvidenceOf(submissionId, db)
    if (!sources.ok) throw new Error(`fixture: the sources of ${submissionId} could not be read`)
    const links: SourceLinks[] = []
    for (const source of sources.value.items) {
      const classifications = await getClassificationsOf(source.revenueSourceEvidenceId, db)
      if (!classifications.ok) throw new Error('fixture: classifications could not be read')
      const readiness = []
      for (const c of classifications.value.items) {
        const r = await getReadinessOf(c.classificationId, db)
        if (!r.ok) throw new Error('fixture: readiness could not be read')
        readiness.push(...r.value.items)
      }
      links.push({ sourceEvidenceId: source.revenueSourceEvidenceId, classifications: classifications.value.items, readiness })
    }
    return links
  }
  const orgOf = async (submissionId: string) => (await prisma.claimFreeze.findUniqueOrThrow({ where: { id: submissionId }, select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } } })).claim.encounter.patient.organizationId
  const deriveCase = async (submissionId: string, db: DbClient = prisma) => {
    const result = assembleCase({ claimSubmissionId: submissionId, organizationId: await orgOf(submissionId), sources: await ownerLinks(submissionId, db) })
    if (!result.ok) throw new Error(`fixture: the expected case of ${submissionId} is a conflict (${result.detail})`)
    return { submissionId, organizationId: await orgOf(submissionId), assembly: result.value }
  }
  type Derived = { submissionId: string; organizationId: string; assembly: Assembly }
  type HeaderOverride = { organization?: string; submission?: string; contract?: string | null; code?: string | null; sourceCount?: number | null; classifiedCount?: number | null; readinessCount?: number | null; itemCount?: number | null; manifest?: string | null; actor?: string; recordedAt?: boolean }
  type EntryRow = { ordinal: number | null; source: string; classification: string | null; readiness: string | null; reason: string | null }
  const entriesOf = (d: Derived): EntryRow[] => d.assembly.items.map((i) => ({ ordinal: i.ordinal, source: i.sourceEvidenceId, classification: i.classificationId, readiness: i.readinessId, reason: i.itemReasonCode }))
  // A direct INSERT of a case. Modes: 'rollback' fires the commit-time check immediately and always rolls back;
  // 'commit' really commits, so the commit-time check decides (used only with facts it must refuse); `guardOff`
  // switches row and constraint triggers off so a refusal can only come from a CHECK, NOT NULL or key.
  const directCase = (d: Derived, h: HeaderOverride = {}, entries: EntryRow[] = entriesOf(d), mode: 'rollback' | 'commit' = 'rollback', guardOff = false) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        if (guardOff) await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        const a = d.assembly
        const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
          `INSERT INTO ${HEADER} (id, organization_id, claim_submission_id, contract_version, assembly_code, source_count, classified_count, readiness_count, item_count, manifest_sha256, recorded_by_user_id${h.recordedAt ? ', recorded_at' : ''})
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid${h.recordedAt ? ", now() - interval '1 day'" : ''}) RETURNING id::text AS id`,
          h.organization ?? d.organizationId,
          h.submission ?? d.submissionId,
          'contract' in h ? h.contract : CONTRACT,
          'code' in h ? h.code : a.assemblyCode,
          'sourceCount' in h ? h.sourceCount : a.sourceCount,
          'classifiedCount' in h ? h.classifiedCount : a.classifiedCount,
          'readinessCount' in h ? h.readinessCount : a.readinessCount,
          'itemCount' in h ? h.itemCount : a.itemCount,
          'manifest' in h ? h.manifest : a.manifestSha256,
          h.actor ?? creatorId,
        )
        for (const e of entries)
          await tx.$executeRawUnsafe(
            `INSERT INTO ${ENTRY} (id, assembly_id, ordinal, source_evidence_id, classification_id, readiness_id, item_reason_code) VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6)`,
            row.id, e.ordinal, e.source, e.classification, e.readiness, e.reason,
          )
        if (mode === 'rollback') {
          await tx.$executeRawUnsafe('SET CONSTRAINTS evidence_case_snapshots_completeness_trg IMMEDIATE')
          throw new Error(NOT_REFUSED)
        }
      }),
    )

  // ---------------------------------------------------------------- strict contract and security (T011–T020)
  section('Strict request: contract, empty body, server-owned fields, UUIDs, session, roles, tenants and actor')
  const countsAtStart = await counts()
  check(
    'T011',
    'Exact A7-REVENUE-CASE-1 contract',
    constantOf(`${MODULE_DIR}/evidence-case.types.ts`, 'CASE_CONTRACT_VERSION') === CONTRACT && /"contract_version" = 'A7-REVENUE-CASE-1'/.test(readFileSync(`../${MIGRATION}`, 'utf8')),
    'A7-REVENUE-CASE-1 is the literal contract in code and in the database CHECK (and on every case and DTO, T021)',
  )
  const nonObject = [await post(casesPath(S1), []), await post(casesPath(S1), [{ sourceEvidenceId: K1.E }])]
  check('T012', 'Only absent or empty POST body', nonObject.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR'), 'the body must be absent or {}: an array body is refused (400); every case value is derived by the server')
  const serverOwned = await Promise.all(
    [{ assemblyCode: 'INVENTORY_COMPLETE' }, { items: [] }, { sources: [K1.E] }, { sourceEvidenceIds: [K1.E] }, { classificationIds: [K1.C] }, { readinessIds: [K1.R] }, { sourceCount: 2 }, { itemCount: 2 }, { manifestSha256: 'a'.repeat(64) }, { hash: 'x' }, { caseId: MISSING }, { amount: '1' }, { paid: true }, { balance: 0 }, { status: 'PAID' }].map((body) => assemble(S2, asAdmin, body)),
  )
  const unknownFields = [await assemble(S2, asAdmin, { extra: 1 }), await assemble(S2, asAdmin, JSON.parse('{"__proto__": {"assemblyCode": "INVENTORY_COMPLETE"}}'))]
  check(
    'T013',
    'All server-owned fields rejected',
    serverOwned.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')) && unknownFields.every((res) => res.status === 400 && /unknown field/.test(res.body?.error?.message ?? '')),
    `code, items, source/classification/readiness lists, counts, digest, case id, amounts, paid, balance and status are refused by name (${serverOwned.length} × 400); unknown fields, including a parsed __proto__ key, are refused`,
  )
  const malformed = [
    await post('/api/claim-submissions/not-a-uuid/revenue-evidence-cases', {}),
    await get('/api/claim-submissions/1234/revenue-evidence-cases'),
    await get('/api/revenue-evidence-cases/not-a-uuid'),
    await get(`/api/revenue-evidence-cases/${MISSING.slice(0, 35)}`),
    await post(`/api/claim-submissions/${encodeURIComponent("1' OR '1'='1")}/revenue-evidence-cases`, {}),
  ]
  check('T014', 'Malformed and injected UUID refused', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `malformed and injected path ids: ${malformed.map((r) => r.status).join('/')}; no raw database text`)
  const anon = [await assemble(S1, anonymous), await get(casesPath(S1), anonymous), await get(casePath(MISSING), anonymous)]
  check('T015', 'Anonymous 401 on all routes', anon.every((res) => res.status === 401), 'every A7.4 route requires a session: 401 without one')
  const viewerPost = await assemble(S1, asViewer)
  check('T016', 'Viewer create 403', viewerPost.status === 403 && errorCode(viewerPost.body) === 'FORBIDDEN', 'a Viewer is refused the case assembly: 403')
  const viewerList = await get(casesPath(S1), asViewer)
  check('T017', 'Viewer history 200', viewerList.status === 200 && Array.isArray(viewerList.body?.items), "a Viewer reads the submission's case history (200)")
  const foreignOnHome = [await assemble(S1, O.who), await get(casesPath(S1), O.who)]
  const foreignMissing = await get(casesPath(MISSING), O.who)
  const homeOnForeign = [await assemble(F.freezes[0]), await get(casesPath(F.freezes[0]))]
  check(
    'T018',
    'Foreign tenant 404',
    foreignOnHome.every((res) => res.status === 404 && same(res.body?.error?.message, foreignMissing.body?.error?.message)) && homeOnForeign.every((res) => res.status === 404),
    "the other organization's Admin gets 404 for this tenant's submission — exactly like a missing one — and this tenant's Admin gets 404 for theirs",
  )
  const missingSubmission = [await assemble(MISSING), await get(casesPath(MISSING))]
  check('T019', 'Missing submission 404', missingSubmission.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND'), 'a non-existent frozen submission: 404')
  const spoofs = await Promise.all([{ recordedByUserId: B.id }, { actorUserId: B.id }, { organizationId: otherOrg }, { claimSubmissionId: S2 }, { claimId: W.claimId }, { recordedAt: '2020-01-01T00:00:00Z' }].map((body) => assemble(S1, asAdmin, body)))
  const refusalsLeftNothing = await unchanged(countsAtStart)

  // ---------------------------------------------------------------- creation and inventory (T021–T030)
  section('Case creation: exact submission, Claim and organization, owner reads on one transaction, one ordered item per source, exact manifest')
  const upstreamBefore = { sources: await sourceHash(), classifications: await classificationHash(), readiness: await readinessHash(), freeze: await freezeHash(W.claimId) }
  const before21 = await counts()
  const CASE1 = await assemble(S1)
  const after21 = await counts()
  check('T020', 'Actor from authenticated session', spoofs.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')) && CASE1.body?.recordedByUserId === creatorId, 'actor, organization, submission, Claim and instant in the body are refused (400); the case names the signed-in Admin')
  const expected1 = await deriveCase(S1)
  check(
    'T021',
    'One complete case 201',
    CASE1.status === 201 && same(Object.keys(CASE1.body ?? {}), CASE_KEYS) && CASE1.body.assemblyCode === 'INVENTORY_COMPLETE' && CASE1.body.contractVersion === CONTRACT && CASE1.body.itemCount === 2 && onlyCase(delta(before21, after21), 2),
    '201: INVENTORY_COMPLETE under A7-REVENUE-CASE-1 with two LINKED items; exactly one header, two entries and one audit; the DTO carries exactly its fields',
  )
  const header1 = await prisma.evidenceCaseSnapshot.findUniqueOrThrow({ where: { id: CASE1.body.caseId }, include: { entries: { orderBy: { ordinal: 'asc' } } } })
  const s1Claim = (await prisma.claimFreeze.findUniqueOrThrow({ where: { id: S1 }, select: { claimId: true } })).claimId
  const entrySources = await prisma.revenueSourceEvidence.findMany({ where: { id: { in: header1.entries.map((e) => e.sourceEvidenceId) } }, select: { claimSubmissionId: true } })
  check(
    'T022',
    'Exact submission and Claim identity',
    header1.claimSubmissionId === S1 && s1Claim === W.claimId && entrySources.length === 2 && entrySources.every((s) => s.claimSubmissionId === S1),
    "the case names exactly S1, whose Claim is K; every entry's source belongs to S1",
  )
  check('T023', 'Exact organization derived', header1.organizationId === (await orgOf(S1)) && header1.organizationId === org, 'the organization is the one that owns S1, derived server-side (never from the body)')
  const serviceCode = committedCode(`${MODULE_DIR}/evidence-case.service.ts`)
  const txBody = serviceCode.slice(serviceCode.indexOf('async function assembleOnTransaction'), serviceCode.indexOf('export async function assembleRevenueEvidenceCase'))
  const linksBody = serviceCode.slice(serviceCode.indexOf('async function readLinksThroughOwners'), serviceCode.indexOf('async function assembleOnTransaction'))
  check(
    'T024',
    'Exact owner reads under one tx',
    /readFreezeThroughOwner\(owner\.claimId, submissionId, tx\)/.test(txBody) && /readLinksThroughOwners\(submissionId, tx\)/.test(txBody) &&
      /getRevenueSourceEvidenceOf\(submissionId, tx\)/.test(linksBody) && /getClassificationsOf\(source\.revenueSourceEvidenceId, tx\)/.test(linksBody) && /getReadinessOf\(classification\.classificationId, tx\)/.test(linksBody) &&
      !/prisma\.|withReadSnapshot/.test(txBody) && !/prisma\.|withReadSnapshot/.test(linksBody) && same(CASE1.body.items.map((i: any) => i.sourceEvidenceId), expected1.assembly.items.map((i) => i.sourceEvidenceId)),
    'A6.7 integrity, A7.1 sources, A7.2 classifications and A7.3 readiness are all read on the one transaction the case opened, and the case equals what those owners report',
  )
  check('T025', 'One item per source', header1.entries.length === 2 && new Set(header1.entries.map((e) => e.sourceEvidenceId)).size === 2 && same(header1.entries.map((e) => e.sourceEvidenceId).sort(), [K1.E, K2.E].sort()), 'exactly one entry for each of S1\'s two sources (E1, E2), none repeated')
  const sqlOrder = (await prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM revenue_source_evidence WHERE claim_submission_id = ${S1}::uuid ORDER BY received_at, id`).map((row) => row.id)
  check('T026', 'Correct stable ordinal sort', same(header1.entries.map((e) => e.sourceEvidenceId), sqlOrder) && same(header1.entries.map((e) => e.ordinal), [1, 2]) && sqlOrder[0] === K1.E, 'ordinals 1..2 follow the database order (received_at, then id): E1 then E2')
  const countsRow = (await prisma.$queryRawUnsafe<{ n: bigint; c: bigint; r: bigint }[]>(`SELECT count(*) AS n, count(classification_id) AS c, count(readiness_id) AS r FROM ${ENTRY} WHERE assembly_id = $1::uuid`, header1.id))[0]
  check('T027', 'Count fields exact', [header1.sourceCount, header1.itemCount, header1.classifiedCount, header1.readinessCount].join() === [Number(countsRow.n), Number(countsRow.n), Number(countsRow.c), Number(countsRow.r)].join(), `source/item ${header1.itemCount}, classified ${header1.classifiedCount}, readiness ${header1.readinessCount} — exactly the stored rows`)
  // The canonical bytes, written out here independently of the assembler.
  const expectedText =
    'SBN-A7-REVENUE-CASE-1\n' + `contract=${CONTRACT}\n` + `claimSubmissionId=${S1}\n` + `organizationId=${org}\n` + 'assemblyCode=INVENTORY_COMPLETE\n' + 'sourceCount=2\n' + 'classifiedCount=2\n' + 'readinessCount=2\n' + 'itemCount=2\n' +
    `item=1|${K1.E}|${K1.C}|${K1.R}|LINKED\n` + `item=2|${K2.E}|${K2.C}|${K2.R}|LINKED\n`
  check(
    'T028',
    'Canonical manifest exact bytes',
    expected1.assembly.manifestText === expectedText && createHash('sha256').update(Buffer.from(expectedText, 'utf8')).digest('hex') === header1.manifestSha256,
    'the assembler\'s canonical text equals the bytes written out independently from the contract, and their SHA-256 is the stored digest',
  )
  const sqlDigest = (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT ${MANIFEST_SQL} AS h FROM ${HEADER} h WHERE h.id = $1::uuid`, header1.id))[0]?.h
  check('T029', 'Digest recomputed independently', sqlDigest === header1.manifestSha256 && CASE1.body.manifestSha256 === header1.manifestSha256, 'PostgreSQL recomputes the identical digest from the stored header and entries')
  check(
    'T030',
    'No upstream row modified',
    (await sourceHash()) === upstreamBefore.sources && (await classificationHash()) === upstreamBefore.classifications && (await readinessHash()) === upstreamBefore.readiness && (await freezeHash(W.claimId)) === upstreamBefore.freeze &&
      delta(before21, after21).revenue_source_evidence === 0 && delta(before21, after21).source_evidence_classifications === 0 && delta(before21, after21).evidence_gate_results === 0,
    "every byte of this run's sources, classifications, readiness results and the freezes is identical after the case",
  )

  // ---------------------------------------------------------------- incomplete, empty and adversarial links (T031–T040)
  section('Empty and incomplete cases through the real API, contradictory and foreign links (always rolled back), no latest, correction independence')
  const SE = fresh()
  const emptyCase = await assemble(SE)
  check(
    'T031',
    'No sources creates NO_REVENUE_SOURCES',
    emptyCase.status === 201 && emptyCase.body.assemblyCode === 'NO_REVENUE_SOURCES' && emptyCase.body.itemCount === 0 && emptyCase.body.items.length === 0 && (await prisma.evidenceCaseEntry.count({ where: { assemblyId: emptyCase.body.caseId } })) === 0,
    'a frozen submission with no A7.1 source gets an explicit empty case: zero entries and no sentinel item',
  )
  const SI = fresh()
  const incSourceOnly = await registerSource(SI, 'INC-SOURCE-ONLY')
  const incClassified = await registerSource(SI, 'INC-CLASSIFIED')
  const incClassification = await classifySource(incClassified)
  const incLinked = await linkedSource(SI, 'INC-LINKED')
  const incCase = await assemble(SI)
  const incItems = (incCase.body?.items ?? []) as any[]
  const reasonOf = (sourceId: string) => incItems.find((i) => i.sourceEvidenceId === sourceId)
  check(
    'T032',
    'Missing classification INCOMPLETE',
    incCase.status === 201 && incCase.body.assemblyCode === 'INVENTORY_INCOMPLETE' && reasonOf(incSourceOnly)?.itemReasonCode === 'SOURCE_ONLY' && reasonOf(incSourceOnly)?.classificationId === null && reasonOf(incSourceOnly)?.readinessId === null,
    'a source without an A7.2 classification is recorded exactly as SOURCE_ONLY (both links NULL) and the case is INVENTORY_INCOMPLETE; no row is invented',
  )
  check(
    'T033',
    'Missing readiness INCOMPLETE',
    reasonOf(incClassified)?.itemReasonCode === 'CLASSIFIED_NO_READINESS' && reasonOf(incClassified)?.classificationId === incClassification && reasonOf(incClassified)?.readinessId === null && reasonOf(incLinked.E)?.itemReasonCode === 'LINKED' &&
      incCase.body.sourceCount === 3 && incCase.body.classifiedCount === 2 && incCase.body.readinessCount === 1,
    'a classification without an A7.3 result is CLASSIFIED_NO_READINESS; the counts are 3 sources, 2 classified, 1 linked',
  )
  // A readiness that contradicts its classification cannot be written through any guard, so it is forged in a
  // transaction that is ALWAYS rolled back (row triggers off for the A7.3 row only) and judged twice: by the production
  // assembler on the owners' reads of that transaction, and by the A7.4 entry guard.
  const SC = fresh()
  const contradictedSource = await registerSource(SC, 'CONTRADICTED')
  const contradictedClassification = await classifySource(contradictedSource)
  const contradiction = await (async () => {
    const out: { refusal?: string } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        const fp = (await tx.sourceEvidenceClassification.findUniqueOrThrow({ where: { id: contradictedClassification } })).sourceFingerprintSha256
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        const [gate] = await tx.$queryRawUnsafe<{ id: string }[]>(
          `INSERT INTO evidence_gate_results (id, organization_id, source_evidence_id, classification_id, contract_version, readiness_code, reason_code, classification_fingerprint_sha256, recorded_by_user_id)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'A7-ADJ-READINESS-1', 'SOURCE_UNSUPPORTED', 'CLASSIFICATION_UNSUPPORTED', $4, $5::uuid) RETURNING id::text AS id`,
          org, contradictedSource, contradictedClassification, fp, creatorId,
        )
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
        const assembled = assembleCase({ claimSubmissionId: SC, organizationId: org, sources: await ownerLinks(SC, tx) })
        out.refusal = assembled.ok ? 'assembled' : assembled.detail
        const [h] = await tx.$queryRawUnsafe<{ id: string }[]>(
          `INSERT INTO ${HEADER} (id, organization_id, claim_submission_id, contract_version, assembly_code, source_count, classified_count, readiness_count, item_count, manifest_sha256, recorded_by_user_id)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'INVENTORY_COMPLETE', 1, 1, 1, 1, $4, $5::uuid) RETURNING id::text AS id`,
          org, SC, CONTRACT, 'a'.repeat(64), creatorId,
        )
        await tx.$executeRawUnsafe(`INSERT INTO ${ENTRY} (id, assembly_id, ordinal, source_evidence_id, classification_id, readiness_id, item_reason_code) VALUES (gen_random_uuid(), $1::uuid, 1, $2::uuid, $3::uuid, $4::uuid, 'LINKED')`, h.id, contradictedSource, contradictedClassification, gate.id)
        throw new Error(NOT_REFUSED)
      }),
    )
    return { ...out, message }
  })()
  check(
    'T034',
    'Contradictory upstream 409',
    contradiction.refusal === 'a readiness result contradicts its classification' && refusedBy(contradiction.message, /evidence_case_entry_conflict/) &&
      /if \(!assembled\.ok\) return refuse\('REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT'/.test(serviceCode),
    'a readiness forged to contradict its classification (rolled back) is a provenance conflict for the production assembler — the service answers 409 and records nothing — and the database refuses any entry linking it',
  )
  // SZ carries two linked sources and never receives a case: every direct-insert test below uses it, so a refusal
  // can only come from the guard under test, never from S1's existing identity.
  const SZ = fresh()
  const KZ1 = await linkedSource(SZ, 'Z1')
  const KZ2 = await linkedSource(SZ, 'Z2')
  const dZ = (await deriveCase(SZ)) as Derived
  const dF = (await deriveCase(F.freezes[0])) as Derived
  const foreignSql = [await directCase(dZ, {}, [...entriesOf(dZ), { ordinal: 3, source: KF.E, classification: null, readiness: null, reason: 'SOURCE_ONLY' }]), await directCase(dF, { organization: org })]
  check(
    'T035',
    'Foreign source 409/404',
    homeOnForeign.every((res) => res.status === 404) && refusedBy(foreignSql[0], /evidence_case_entry_linkage/) && refusedBy(foreignSql[1], /evidence_case_snapshot_coherence/),
    "the other organization's submission is 404 over the API; directly, its source in this tenant's case is refused by the linkage guard and this tenant on its submission by the coherence guard",
  )
  const otherSubmission = await directCase(dZ, {}, [{ ordinal: 1, source: KZ1.E, classification: KZ1.C, readiness: KZ1.R, reason: 'LINKED' }, { ordinal: 2, source: KS2.E, classification: KS2.C, readiness: KS2.R, reason: 'LINKED' }])
  check('T036', 'Other submission source rejected', refusedBy(otherSubmission, /evidence_case_entry_linkage/), 'an entry naming a source of the correction freeze S2 inside a case of another submission is refused')
  const wrongClassification = await directCase(dZ, {}, [{ ordinal: 1, source: KZ1.E, classification: KZ2.C, readiness: KZ2.R, reason: 'LINKED' }, { ordinal: 2, source: KZ2.E, classification: KZ2.C, readiness: KZ2.R, reason: 'LINKED' }])
  check('T037', 'Wrong classification for source rejected', refusedBy(wrongClassification, /evidence_case_entry_linkage/), "Z1 with Z2's classification is refused: only the classification recorded for the source")
  const wrongReadiness = await directCase(dZ, {}, [{ ordinal: 1, source: KZ1.E, classification: KZ1.C, readiness: KZ2.R, reason: 'LINKED' }, { ordinal: 2, source: KZ2.E, classification: KZ2.C, readiness: KZ2.R, reason: 'LINKED' }])
  check('T038', 'Wrong readiness for classification rejected', refusedBy(wrongReadiness, /evidence_case_entry_linkage/), "Z1's classification with Z2's readiness result is refused: only the result recorded for the classification")
  const headerColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${HEADER}`).map((row) => row.c)
  const entryColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${ENTRY}`).map((row) => row.c)
  const latestRoutes = [await get(`/api/claim-submissions/${S1}/revenue-evidence-cases/latest`), await get(`/api/claims/${W.claimId}/revenue-evidence-cases`), await get(`/api/revenue-source-evidence/${K1.E}/revenue-evidence-cases`)]
  check(
    'T039',
    'No latest or current inferred',
    latestRoutes.every((res) => res.status === 404) && ![...headerColumns, ...entryColumns].some((c) => /current|latest|newest|superseded|status|state/.test(c)),
    'a case names one exact frozen submission from the path; there is no latest, per-Claim or per-source route, and no current, latest or status column',
  )
  const chainBefore = await correctionHash(W.claimId)
  const CASE_S2 = await assemble(S2)
  check(
    'T040',
    'Correction predecessor independent',
    CASE_S2.status === 201 && CASE_S2.body.caseId !== CASE1.body.caseId && same(CASE_S2.body.items.map((i: any) => i.sourceEvidenceId), [KS2.E]) && same((await get(casePath(CASE1.body.caseId))).body, CASE1.body) && (await correctionHash(W.claimId)) === chainBefore,
    "the corrected freeze S2 (an A6.9 link from S1) gets its own case with only its own source; CASE1 and the link are byte-identical; nothing chooses the newest freeze",
  )

  // ---------------------------------------------------------------- replay, identity and races (T041–T050)
  section('Replay, identity, a later source, direct duplicates and altered digests, concurrent identical requests, read-after-commit')
  const before41 = await counts()
  const replay1 = await assemble(S1)
  const replayNoBody = await api('POST', casesPath(S1), undefined)
  check('T041', 'Identical POST replay 200', [replay1, replayNoBody].every((res) => res.status === 200 && same(res.body, CASE1.body)), 'the identical request (with {} and with no body): 200 with exactly CASE1')
  const replayByB = await assemble(S1, B.who)
  check('T042', 'Replay preserves actor', replayByB.status === 200 && same(replayByB.body, CASE1.body) && replayByB.body.recordedByUserId === creatorId, 'another Admin repeating the request gets CASE1 with its original actor')
  const d41 = delta(before41, await counts())
  check('T043', 'Replay writes zero audits', d41.audit_events === 0 && d41[HEADER] === 0 && d41[ENTRY] === 0 && (await prisma.auditEvent.count({ where: { entityId: CASE1.body.caseId } })) === 1, 'three replays wrote no case, entry or audit; CASE1 still has exactly one audit')
  const replaysLeftNothing = await unchanged(before41)
  const case1Before = await caseHash(CASE1.body.caseId)
  const K3 = await linkedSource(S1, 'E3-LATER')
  const afterLater = await assemble(S1)
  check(
    'T044',
    'Later source does not mutate',
    afterLater.status === 200 && same(afterLater.body, CASE1.body) && !afterLater.body.items.some((i: any) => i.sourceEvidenceId === K3.E) && (await caseHash(CASE1.body.caseId)) === case1Before,
    'after E3 is registered, classified and gated on S1, the request still answers CASE1 exactly as recorded (200); E3 is not appended and every stored byte of CASE1 is unchanged',
  )
  const dS1now = (await deriveCase(S1)) as Derived
  const duplicateIdentity = await directCase(dS1now)
  check('T045', 'Duplicate DB identity rejected', refusedBy(duplicateIdentity, /evidence_case_snapshots_identity_key|duplicate key/), `a second, otherwise valid case for S1 inserted directly is refused by the unique identity (${markerOf(duplicateIdentity)})`)
  const alteredDigest = await directCase(dZ, { manifest: 'a'.repeat(64) }, entriesOf(dZ), 'commit')
  check('T046', 'Altered digest rejected', refusedBy(alteredDigest, /evidence_case_snapshot_manifest/) && (await historyOf(SZ)).length === 0, 'a case with a wrong digest is refused when it tries to commit; nothing is stored')
  const SR2 = fresh()
  await linkedSource(SR2, 'RACE2')
  const before47 = await counts()
  const pair = await Promise.all([assemble(SR2), assemble(SR2)])
  const d47 = delta(before47, await counts())
  check('T047', 'Two simultaneous 201/200', same(pair.map((r) => r.status).sort(), [200, 201]) && same(pair[0].body, pair[1].body) && d47[HEADER] === 1 && d47.audit_events === 1, `${pair.map((r) => r.status).sort().join('/')}: one case, one audit, one identical body`)
  const SR5 = fresh()
  await linkedSource(SR5, 'RACE5')
  const before48 = await counts()
  const five = await Promise.all([assemble(SR5), assemble(SR5), assemble(SR5, B.who), assemble(SR5), assemble(SR5)])
  const d48 = delta(before48, await counts())
  check(
    'T048',
    'Five concurrent: 1×201, rest 200',
    five.filter((r) => r.status === 201).length === 1 && five.filter((r) => r.status === 200).length === 4 && five.every((r) => same(r.body, five[0].body)) && d48[HEADER] === 1 && d48[ENTRY] === 1 && d48.audit_events === 1,
    `five at once (two actors): ${five.map((r) => (r.status >= 300 ? `${r.status} ${errorCode(r.body) ?? ''}`.trim() : r.status)).join('/')}; ${d48[HEADER]} case, ${d48[ENTRY]} entry and ${d48.audit_events} audit`,
  )
  const read1 = await get(casePath(CASE1.body.caseId))
  const historyS1 = await historyOf(S1)
  const inTx = await withReadSnapshot(undefined, (tx) => getCasesOf(S1, tx))
  check(
    'T049',
    'Read-after-commit exact',
    read1.status === 200 && same(read1.body, CASE1.body) && historyS1.length === 1 && same(historyS1[0], Object.fromEntries(Object.entries(CASE1.body).filter(([k]) => k !== 'items'))) && inTx.ok && same(inTx.value.items, historyS1),
    'the single read is exactly the create response; the history lists exactly its header; getCasesOf(submissionId, tx) equals the HTTP read',
  )
  const rewrites = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${HEADER} SET assembly_code = assembly_code WHERE id = $1::uuid`, CASE1.body.caseId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${ENTRY} SET item_reason_code = 'SOURCE_ONLY', classification_id = NULL, readiness_id = NULL WHERE assembly_id = $1::uuid`, CASE1.body.caseId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${ENTRY} WHERE assembly_id = $1::uuid`, CASE1.body.caseId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${HEADER} WHERE id = $1::uuid`, CASE1.body.caseId)),
  ]
  check('T050', 'Historical header and items unchanged', rewrites.every((m) => /is append-only/.test(m)) && (await caseHash(CASE1.body.caseId)) === case1Before, 'no-op and real updates and deletes of the header and its entries are refused; CASE1 is byte-identical')

  // ---------------------------------------------------------------- direct-write protection (T051–T060)
  section('Direct SQL: RESTRICT keys, CHECKs with the guard off and NULL pitfalls, coherence, linkage, ordinals, unique source, time, immutability')
  const fkRows = await prisma.$queryRaw<{ t: string; del: string }[]>`SELECT conrelid::regclass::text AS t, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text IN ('evidence_case_snapshots', 'evidence_case_entries')`
  const removeReadiness = await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE evidence_gate_results DISABLE TRIGGER evidence_gate_results_append_only_trg')
      await tx.$executeRawUnsafe('DELETE FROM evidence_gate_results WHERE id = $1::uuid', K1.R)
      throw new Error(NOT_REFUSED)
    }),
  )
  check(
    'T051',
    'All foreign keys RESTRICT',
    fkRows.length === 7 && fkRows.every((row) => row.del === 'r') && refusedBy(removeReadiness, /evidence_case_entries_readiness_id_fkey|foreign key/),
    'organization, submission and actor on the header, and case, source, classification and readiness on the entries, are all ON DELETE RESTRICT; even with the A7.3 guard off (rolled back) a cased readiness cannot be deleted',
  )
  const dE = (await deriveCase(fresh())) as Derived
  const contractSql = [await directCase(dE, { contract: 'A7-REVENUE-CASE-0' }, [], 'rollback', true), await directCase(dE, { contract: null }, [], 'rollback', true)]
  check('T052', 'Exact header contract CHECK', refusedBy(contractSql[0], /evidence_case_snapshots_contract_chk/) && refusedBy(contractSql[1], /null value/), `another or a NULL contract is refused even with the guards off (${contractSql.map(markerOf).join(', ')})`)
  const outcomeSql = [
    await directCase(dE, { code: 'INVENTORY_READY' }, [], 'rollback', true),
    await directCase(dE, { code: 'INVENTORY_COMPLETE' }, [], 'rollback', true),
    await directCase(dZ, { code: 'INVENTORY_COMPLETE', readinessCount: dZ.assembly.readinessCount - 1 }, [], 'rollback', true),
    await directCase(dZ, {}, [{ ordinal: 1, source: KZ1.E, classification: null, readiness: null, reason: 'SETTLED' }], 'rollback', true),
    await directCase(dZ, {}, [{ ordinal: 1, source: KZ1.E, classification: KZ1.C, readiness: null, reason: 'LINKED' }], 'rollback', true),
  ]
  check(
    'T053',
    'All controlled outcome CHECKs',
    refusedBy(outcomeSql[0], /evidence_case_snapshots_code_chk|code_counts_chk/) && refusedBy(outcomeSql[1], /code_counts_chk/) && refusedBy(outcomeSql[2], /code_counts_chk/) && refusedBy(outcomeSql[3], /evidence_case_entries_reason_chk|shape_chk/) && refusedBy(outcomeSql[4], /evidence_case_entries_shape_chk/),
    `an invented code, a COMPLETE empty case, a COMPLETE case with a missing link, an invented entry reason and a reason that disagrees with its links are refused by CHECKs (${outcomeSql.map(markerOf).join(', ')})`,
  )
  const coherenceSql = [await directCase(dZ, { organization: otherOrg }), await directCase(dF, { organization: org })]
  check('T054', 'Header organization coherence', coherenceSql.every((m) => refusedBy(m, /evidence_case_snapshot_coherence/)), "a case naming another organization than the one owning its frozen submission is refused, in both directions")
  const late = await attemptAdversarial(() => prisma.$executeRawUnsafe(`INSERT INTO ${ENTRY} (id, assembly_id, ordinal, source_evidence_id, item_reason_code) VALUES (gen_random_uuid(), $1::uuid, 3, $2::uuid, 'SOURCE_ONLY')`, CASE1.body.caseId, K3.E))
  const absentClaimed = await directCase(dZ, {}, entriesOf(dZ).map((e, i) => (i === 0 ? { ...e, classification: null, readiness: null, reason: 'SOURCE_ONLY' } : e)))
  check(
    'T055',
    'Item linkage protected',
    refusedBy(otherSubmission, /linkage/) && refusedBy(wrongClassification, /linkage/) && refusedBy(wrongReadiness, /linkage/) && refusedBy(absentClaimed, /evidence_case_entry_derivation/),
    "another submission's source, another source's classification and another classification's readiness are refused (T036–T038), and an entry may not record a link as absent when the owner has it",
  )
  const nullSql = [
    await directCase(dE, { code: null }, [], 'rollback', true),
    await directCase(dE, { sourceCount: null }, [], 'rollback', true),
    await directCase(dE, { manifest: null }, [], 'rollback', true),
    await directCase(dZ, {}, [{ ordinal: null, source: KZ1.E, classification: KZ1.C, readiness: KZ1.R, reason: 'LINKED' }], 'rollback', true),
    await directCase(dZ, {}, [{ ordinal: 1, source: KZ1.E, classification: KZ1.C, readiness: KZ1.R, reason: null }], 'rollback', true),
  ]
  const codeDef = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'evidence_case_snapshots_code_chk'`)[0]?.def ?? ''
  check('T056', 'No NULL bypass on CHECK', nullSql.every((m) => refusedBy(m, /null value|_chk/)) && /assembly_code IS NOT NULL/.test(codeDef), `NULL code, count, digest, ordinal and reason are refused (NOT NULL, and the CHECKs' own IS NOT NULL, so UNKNOWN never passes) (${nullSql.map(markerOf).join(', ')})`)
  const ordinalSql = [
    await directCase(dZ, {}, entriesOf(dZ).map((e) => ({ ...e, ordinal: (e.ordinal ?? 0) - 1 }))),
    await directCase(dZ, {}, entriesOf(dZ).map((e) => ({ ...e, ordinal: (e.ordinal ?? 0) === 1 ? 1 : (e.ordinal ?? 0) + 5 }))),
    await directCase(dZ, {}, entriesOf(dZ).map((e) => ({ ...e, ordinal: 1 }))),
    await directCase(dZ, {}, entriesOf(dZ).map((e, i, all) => ({ ...e, ordinal: all.length - i }))),
  ]
  check(
    'T057',
    'Contiguous positive ordinals',
    refusedBy(ordinalSql[0], /evidence_case_entries_ordinal_chk/) && refusedBy(ordinalSql[1], /evidence_case_snapshot_incomplete/) && refusedBy(ordinalSql[2], /evidence_case_entries_ordinal_key|duplicate key/) && refusedBy(ordinalSql[3], /evidence_case_snapshot_incomplete|manifest/),
    `a zero ordinal, a gap, a repeated ordinal and a reversed order are refused (${ordinalSql.map(markerOf).join(', ')})`,
  )
  const duplicateSource = await directCase(dZ, {}, [...entriesOf(dZ), { ...entriesOf(dZ)[0], ordinal: entriesOf(dZ).length + 1 }])
  check('T058', 'Unique item source per case', refusedBy(duplicateSource, /evidence_case_entries_source_key|duplicate key/), `a second entry for the same source is refused (${markerOf(duplicateSource)})`)
  const timeSql = await directCase(dE, { recordedAt: true }, [])
  const timeRow = await prisma.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT recorded_at = created_at AND recorded_at <= now() AS ok FROM ${HEADER} WHERE id = $1::uuid`, CASE1.body.caseId)
  check('T059', 'Database-owned timestamp', refusedBy(timeSql, /evidence_case_snapshot_time/) && timeRow[0]?.ok === true && CASE1.body.recordedAt === header1.recordedAt.toISOString(), 'a backdated instant is refused; the case is recorded at the transaction time and the DTO carries it')
  const triggers = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname IN ('evidence_case_snapshots_no_truncate_trg', 'evidence_case_entries_no_truncate_trg') ORDER BY tgname`).map((row) => row.def)
  const referencedHeader = await prisma.$queryRaw<{ t: string; del: string }[]>`SELECT conrelid::regclass::text AS t, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND confrelid = 'evidence_case_snapshots'::regclass`
  const beforeWipe = await allCasesHash()
  const wipe = (sql: string) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(sql)
        throw new Error(NOT_REFUSED)
      }),
    )
  const wipes = [await wipe(`TRUNCATE ${HEADER}`), await wipe(`TRUNCATE ${HEADER} CASCADE`), await wipe(`TRUNCATE ${ENTRY}`), await wipe(`TRUNCATE ${ENTRY} CASCADE`), await wipe('TRUNCATE evidence_gate_results CASCADE')]
  // Judged on behaviour: a plain TRUNCATE of the header is refused before any trigger by its entries' RESTRICT key;
  // every other wipe reaches an append-only guard. Nothing changes.
  check(
    'T060',
    'UPDATE, DELETE, TRUNCATE all refused',
    rewrites.every((m) => /is append-only/.test(m)) &&
      (refusedBy(wipes[0], /evidence_case_snapshots is append-only: TRUNCATE/) || (refusedBy(wipes[0], /cannot truncate a table referenced in a foreign key constraint/) && referencedHeader.length > 0 && referencedHeader.every((r) => r.del === 'r'))) &&
      refusedBy(wipes[1], /evidence_case_snapshots is append-only: TRUNCATE/) && refusedBy(wipes[2], /evidence_case_entries is append-only: TRUNCATE/) && refusedBy(wipes[3], /evidence_case_entries is append-only: TRUNCATE/) && refusedBy(wipes[4], /is append-only: TRUNCATE/) &&
      triggers.length === 2 && triggers.every((def) => /BEFORE TRUNCATE ON public\.evidence_case_(snapshots|entries) FOR EACH STATEMENT EXECUTE FUNCTION evidence_case_append_only\(\)/.test(def)) &&
      (await allCasesHash()) === beforeWipe,
    `UPDATE and DELETE (even no-op) are refused on both tables; TRUNCATE of either table, CASCADE from either, and a CASCADE from the A7.3 table are refused (${wipes.map(markerOf).join(', ')}); every case byte is identical afterwards`,
  )

  // ---------------------------------------------------------------- atomic completeness and audits (T061–T070)
  section('Commit-time completeness (missing item, wrong count, wrong digest, late item), crash after header, items and audit, one audit')
  check('T061', 'One header, items and audit', onlyCase(delta(before21, after21), 2), 'the first case wrote exactly one header, its two entries and one audit — no other row anywhere')
  const missingItem = await directCase(dZ, {}, entriesOf(dZ).slice(0, 1), 'commit')
  check('T062', 'Missing item fails commit', refusedBy(missingItem, /evidence_case_snapshot_incomplete/) && (await historyOf(SZ)).length === 0, 'a case whose header promises two entries but carries one is refused at commit; nothing is stored')
  const wrongCount = await directCase(dZ, { code: 'INVENTORY_INCOMPLETE', readinessCount: 1 }, entriesOf(dZ), 'commit')
  check('T063', 'Wrong count fails commit', refusedBy(wrongCount, /evidence_case_snapshot_incomplete/) && (await historyOf(SZ)).length === 0, 'a case whose counts disagree with its entries is refused at commit; nothing is stored')
  const wrongDigest = await directCase(dZ, { manifest: 'b'.repeat(64) }, entriesOf(dZ), 'commit')
  check('T064', 'Wrong digest fails commit', refusedBy(wrongDigest, /evidence_case_snapshot_manifest/) && (await historyOf(SZ)).length === 0, 'a case whose digest is not the recomputed manifest is refused at commit; nothing is stored')
  check('T065', 'Late item rejected', refusedBy(late, /evidence_case_entry_late/) && (await prisma.evidenceCaseEntry.count({ where: { assemblyId: CASE1.body.caseId } })) === 2, 'an entry appended to CASE1 after its commit is refused: entries are written only in the snapshot\'s own transaction')
  const SK = fresh()
  await linkedSource(SK, 'CRASH')
  const countsBeforeCrash = await counts()
  const crashAt = async (probe: string) => {
    failAt(probe)
    const message = await attemptAdversarial(() => assembleRevenueEvidenceCase(SK, {}, creatorId))
    clearConcurrencyProbes()
    return { message, unchanged: await unchanged(countsBeforeCrash), visible: (await historyOf(SK)).length }
  }
  const crash1 = await crashAt('evidenceCase.header_inserted')
  const crash2 = await crashAt('evidenceCase.entries_inserted')
  const crash3 = await crashAt('evidenceCase.audited')
  check('T066', 'Crash after header rollback', crash1.message.includes('INJECTED_CRASH') && crash1.unchanged && crash1.visible === 0, 'a failure after the header insert rolls back everything: no header, entry or audit')
  check('T067', 'Crash after items rollback', crash2.message.includes('INJECTED_CRASH') && crash2.unchanged && crash2.visible === 0, 'a failure after the entries rolls back the header and the entries')
  check('T068', 'Crash after audit rollback', crash3.message.includes('INJECTED_CRASH') && crash3.unchanged && crash3.visible === 0, 'a failure after the audit, before commit, rolls back the header, entries and audit')
  const retry = await assemble(SK)
  const auditOnce = await prisma.$queryRawUnsafe<{ bad: bigint }[]>(`SELECT count(*) AS bad FROM ${HEADER} h WHERE (SELECT count(*) FROM audit_events a WHERE a.entity_id = h.id AND a.action_code = 'revenue_evidence_case.assembled') <> 1`)
  const orphanAudits = async () => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM audit_events a WHERE a.action_code = 'revenue_evidence_case.assembled' AND NOT EXISTS (SELECT 1 FROM ${HEADER} h WHERE h.id = a.entity_id)`))[0].n)
  check('T069', 'Exactly one audit per case', retry.status === 201 && Number(auditOnce[0].bad) === 0 && (await orphanAudits()) === 0, 'the safe rerun after three crashes assembles once; every case in the database has exactly one revenue_evidence_case.assembled audit and no audit lacks its case')
  check('T070', 'No audit for refusals and replays', refusalsLeftNothing && replaysLeftNothing && crash1.unchanged && crash2.unchanged && crash3.unchanged, 'every 400/401/403/404, every replay and the three crashes wrote no case, entry or audit')

  // ---------------------------------------------------------------- locking, retry and read consistency (T071–T080)
  section('Concurrency: Claim lock first, SERIALIZABLE, races with A6 and A7.1–A7.3 writers, bounded wait, retries, no blind retry, no partial reads')
  const L = await home.series('line edit', 1)
  await linkedSource(L.freezes[0], 'LINE')
  const hold71 = holdAt('claimLine.removed')
  const removal = removeClaimLine(L.lineIds[1], {}, creatorId)
  await Promise.race([hold71.arrived, removal])
  const c71 = assembleRevenueEvidenceCase(L.freezes[0], {}, creatorId)
  const waited71 = !(await settledWithin(c71, 3000))
  hold71.release()
  const [removed71, r71] = await Promise.all([removal, c71])
  clearConcurrencyProbes()
  check(
    'T071',
    'Claim lock first, NOWAIT',
    /lockRowForUpdateNowait\(tx, 'claims', owner\.claimId\)/.test(txBody.split('\n').slice(0, 3).join('\n')) && waited71 && removed71.ok && r71.ok && !r71.value.replayed,
    'the Claim row lock (NOWAIT) is the first statement; a case during an uncommitted A6.2 line edit waits for it, then records',
  )
  check('T072', 'SERIALIZABLE, one DbClient', /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && !/withReadSnapshot|prisma\./.test(txBody) && !/withReadSnapshot|prisma\./.test(linksBody), 'one SERIALIZABLE transaction client carries every owner read, the header, the entries and the audit')
  const raceCase = async (probe: string, other: (submission: string) => Promise<{ ok: boolean }>, suffix: string, submission = fresh()) => {
    await linkedSource(submission, suffix)
    const hold = holdAt(probe)
    const c = assembleRevenueEvidenceCase(submission, {}, creatorId)
    await Promise.race([hold.arrived, c])
    const o = other(submission)
    const waited = !(await settledWithin(o, 3000))
    hold.release()
    const [rc, ro] = await Promise.all([c, o])
    clearConcurrencyProbes()
    return { waited, rc, ro, submission }
  }
  const Lc = await home.series('lifecycle race', 1)
  const r73 = await raceCase('evidenceCase.claim_locked', (s) => recordLifecycleEvent(s, { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }, creatorId), 'LIFECYCLE', Lc.freezes[0])
  check('T073', 'Concurrent A6 write serializes', r73.waited && r73.rc.ok && r73.ro.ok, 'an A6.8 lifecycle event during an in-flight case waits for the shared Claim lock; both commit and the case changed no disposition')
  const r74 = await raceCase('evidenceCase.claim_locked', (s) => registerRevenueSourceEvidence(s, { sourceKind: SYNTHETIC, sourceReference: ref('A71-DURING') }, creatorId), 'A71')
  const case74 = r74.rc.ok ? (r74.rc as any).value.case : null
  check('T074', 'Concurrent A7.1 write serializes', r74.waited && r74.rc.ok && r74.ro.ok && case74?.itemCount === 1, 'an A7.1 registration during an in-flight case waits; both commit, and the case holds exactly the one source that existed when it was assembled')
  const r75Pre = fresh()
  const r75Source = await registerSource(r75Pre, 'A72-PRE')
  const hold75 = holdAt('evidenceCase.claim_locked')
  const c75 = assembleRevenueEvidenceCase(r75Pre, {}, creatorId)
  await Promise.race([hold75.arrived, c75])
  const cls75 = classifySourceEvidence(r75Source, {}, creatorId)
  const waited75 = !(await settledWithin(cls75, 3000))
  hold75.release()
  const [rc75, ro75] = await Promise.all([c75, cls75])
  clearConcurrencyProbes()
  check('T075', 'Concurrent A7.2 write serializes', waited75 && rc75.ok && ro75.ok && rc75.ok && rc75.value.case.items[0]?.itemReasonCode === 'SOURCE_ONLY', 'an A7.2 classification during an in-flight case waits; both commit, and the case records the source as it was (SOURCE_ONLY)')
  const r76Pre = fresh()
  const r76Source = await registerSource(r76Pre, 'A73-PRE')
  const r76Classification = await classifySource(r76Source)
  const hold76 = holdAt('evidenceCase.claim_locked')
  const c76 = assembleRevenueEvidenceCase(r76Pre, {}, creatorId)
  await Promise.race([hold76.arrived, c76])
  const gate76 = recordAdjudicationReadiness(r76Classification, {}, creatorId)
  const waited76 = !(await settledWithin(gate76, 3000))
  hold76.release()
  const [rc76, ro76] = await Promise.all([c76, gate76])
  clearConcurrencyProbes()
  check('T076', 'Concurrent A7.3 write serializes', waited76 && rc76.ok && ro76.ok && rc76.ok && rc76.value.case.items[0]?.itemReasonCode === 'CLASSIFIED_NO_READINESS', 'an A7.3 readiness record during an in-flight case waits; both commit, and the case records the classification as it was (no readiness yet)')
  const S77 = fresh()
  await linkedSource(S77, 'HELD')
  const hold77 = holdAt('evidenceCase.entries_inserted')
  const first77 = assembleRevenueEvidenceCase(S77, {}, creatorId)
  await Promise.race([hold77.arrived, first77])
  const second77 = assembleRevenueEvidenceCase(S77, {}, B.id)
  const waited77 = !(await settledWithin(second77, 3000))
  hold77.release()
  const [r77a, r77b] = await Promise.all([first77, second77])
  clearConcurrencyProbes()
  check(
    'T077',
    '30-second bounded wait with jitter',
    /const LOCK_WAIT_BUDGET_MS = 30_000/.test(serviceCode) && /5 \+ Math\.floor\(Math\.random\(\) \* 20\)/.test(serviceCode) && /await pauseAfterLockWait\(\)/.test(serviceCode) &&
      waited77 && r77a.ok && !r77a.value.replayed && r77b.ok && r77b.value.replayed && same(r77a.value.case, r77b.value.case),
    'a second request during an uncommitted first waits for the Claim lock (30-second budget, 5–25 ms random pause), then replays the committed case',
  )
  const S78 = fresh()
  await linkedSource(S78, 'IN-PROCESS')
  const inProcess = await Promise.all([1, 2, 3].map(() => assembleRevenueEvidenceCase(S78, {}, creatorId)))
  check(
    'T078',
    'At most three fresh retries',
    /const MAX_CASE_ATTEMPTS = 3/.test(serviceCode) && /P2034/.test(serviceCode) && /40001/.test(serviceCode) && /isUniqueViolation\(error\)/.test(serviceCode) &&
      inProcess.every((r) => r.ok) && inProcess.filter((r) => r.ok && !r.value.replayed).length === 1 && (await prisma.evidenceCaseSnapshot.count({ where: { claimSubmissionId: S78 } })) === 1,
    'serialization, deadlock and unique races retry at most three times on a fresh transaction; three identical in-process requests give one case and two replays',
  )
  check(
    'T079',
    'Ambiguous outcome never retried blindly',
    /if \(isUnknownOutcome\(error\)\)\s*return \{ ok: false, code: 'REVENUE_EVIDENCE_CASE_CONFLICT'/.test(serviceCode) && /P2028/.test(serviceCode) && crash3.visible === 0 && (await historyOf(SK)).length === 1,
    'a lost connection or ambiguous commit is a safe 409 telling the caller to read the history, never a second insert; after the crashes the history was empty and after the rerun it holds one case',
  )
  const S80 = fresh()
  await linkedSource(S80, 'ISOLATION')
  const hold80 = holdAt('evidenceCase.audited')
  const pending80 = assembleRevenueEvidenceCase(S80, {}, creatorId)
  await Promise.race([hold80.arrived, pending80])
  const during80 = get(casesPath(S80))
  const prompt80 = await settledWithin(during80, 5000)
  const duringItems = (await during80).body?.items ?? null
  hold80.release()
  const r80 = await pending80
  clearConcurrencyProbes()
  check('T080', 'No partial state visible on reads', prompt80 && Array.isArray(duringItems) && duringItems.length === 0 && r80.ok && (await historyOf(S80)).length === 1, 'a read while a header, its entries and audit are uncommitted answers at once with committed history only (none); after commit, one')

  // ---------------------------------------------------------------- privacy and tenant read safety (T081–T090)
  section('Privacy: minimal header and item DTOs, no PHI, money, verdict or bytes, metadata-only audit, no logs or browser storage, safe errors')
  const caseFor = await assemble(F.freezes[0], O.who)
  const cases = [CASE1.body, CASE_S2.body, incCase.body, emptyCase.body, read1.body, caseFor.body]
  const audit1 = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: CASE1.body.caseId } })
  const exposed = JSON.stringify([cases, historyS1, audit1.afterState])
  check('T081', 'Minimal header DTO', historyS1.every((h: any) => same(Object.keys(h), HEADER_KEYS)) && cases.every((c: any) => same(Object.keys(c), CASE_KEYS)), 'every header carries exactly its fields: ids, contract, code, counts, digest, actor and time')
  check('T082', 'Minimal item DTO', cases.every((c: any) => c.items.every((i: any) => same(Object.keys(i), ITEM_KEYS))), 'every item carries exactly ordinal, source, classification, readiness and reason')
  check('T083', 'No PHI anywhere', !exposed.includes(`${runId}-home-P`) && !exposed.includes(`${runId}-away-P`) && !exposed.includes('1990-01-01') && ![...deepKeys(JSON.parse(exposed))].some((k) => /patient|member|name|birth|email|phone|address|diagnos|procedure/i.test(k)), 'no patient, member, contact, diagnosis or procedure value or key in any case DTO, history or audit')
  check('T084', 'No amounts or payer verdict', !/125\.25|12\.125|200\.01|AED/.test(exposed) && ![...deepKeys(JSON.parse(exposed))].some((k) => /amount|balance|currency|paid|price|payer|denial|adjudicat|status|verdict/i.test(k)) && !/PAID|DENIED|SETTLED|ADJUDICATED|READY_FOR/.test(exposed), 'no amount, balance, currency, payer, denial, adjudication, status or verdict key or value')
  check('T085', 'No raw frozen bytes', ![...deepKeys(JSON.parse(exposed))].some((k) => /bytes|payload|seal|fingerprint|sourceReference|raw|^manifest$|manifestText/i.test(k)) && !exposed.includes(ref('E1')), 'no frozen payload or manifest bytes, seal, fingerprint or source reference leaves the server — only the case digest')
  check(
    'T086',
    'Metadata-only audit',
    audit1.actionCode === 'revenue_evidence_case.assembled' && audit1.entityType === 'REVENUE_EVIDENCE_CASE' && audit1.actorUserId === creatorId && audit1.organizationId === org && same(Object.keys(audit1.afterState as object).sort(), [...AUDIT_KEYS].sort()) && audit1.beforeState === null,
    'revenue_evidence_case.assembled on REVENUE_EVIDENCE_CASE, naming the actor and organization, with exactly ids, contract, code, counts, digest and time',
  )
  const production = committedProductionCodeOf([MODULE_DIR])
  check('T087', 'No secrets or logs', production.files.length === 6 && !/console\.|logger\.|process\.env/.test(production.code), 'the six A7.4 backend files log nothing and read no environment or secret')
  const frontend = committedCode(`${FE_DIR}/EvidenceCaseCheck.tsx`)
  const registry = committedCode('frontend/src/developer/checkRegistry.tsx')
  check(
    'T088',
    'No browser storage',
    frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend) && /key: 'evidence-case'/.test(registry) && /\/revenue-evidence-cases`\)/.test(frontend) && !/fetch\([^)]*,\s*\{/.test(frontend),
    'the Developer Tools page is registered, makes one plain GET (no request options, so no write) and keeps nothing in browser storage',
  )
  const errorBodies = [...nonObject, ...serverOwned, ...unknownFields, ...malformed, ...anon, viewerPost, ...foreignOnHome, ...homeOnForeign, ...missingSubmission, ...spoofs]
  const viewerPostAgain = await assemble(S1, asViewer)
  check(
    'T089',
    'Safe deterministic errors',
    errorBodies.every((res) => !rawError(res.body) && typeof res.body?.error?.code === 'string' && typeof res.body?.error?.message === 'string') && same({ ...viewerPostAgain.body.error, requestId: null }, { ...viewerPost.body.error, requestId: null }),
    `all ${errorBodies.length} refusals carry a code, a safe message and a request id only; the same refusal repeats exactly`,
  )
  const foreignReads = [await get(casePath(CASE1.body.caseId), O.who), await get(casePath(caseFor.body?.caseId ?? MISSING))]
  const missingAsForeign = await get(casePath(MISSING), O.who)
  const queryPost = await post(`${casesPath(S1)}?claimSubmissionId=${S2}&token=SYN-SECRET`, {})
  check(
    'T090',
    'Cross-tenant single read 404',
    caseFor.status === 201 && foreignReads.every((res) => res.status === 404) && same(foreignReads[0].body?.error?.message, missingAsForeign.body?.error?.message) && queryPost.status === 200 && same(queryPost.body, CASE1.body) && !/req\.query/.test(committedCode(`${MODULE_DIR}/evidence-case.route.ts`)),
    "the other organization assembles its own case (201) but cannot read this tenant's case, nor this tenant theirs: 404, like a missing one; a submission id or token in the query string changes nothing",
  )

  // ---------------------------------------------------------------- canonical invariance and versioning (T091–T100)
  section('Reproducible bytes, time zone and locale invariance, stable empty digest, no balance or verdict, no latest, future contract blocked')
  const linksS2 = await ownerLinks(S2)
  const repeated = Array.from({ length: 30 }, () => JSON.stringify(assembleCase({ claimSubmissionId: S2, organizationId: org, sources: linksS2 })))
  check('T091', 'Same facts, same bytes', new Set(repeated).size === 1 && JSON.parse(repeated[0]).value.manifestSha256 === CASE_S2.body.manifestSha256, 'thirty assemblies of the same owner facts give identical bytes, equal to the stored digest of the S2 case')
  const tzProbe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import { assembleCase } from './src/modules/evidence-case/evidence-case.assembler.ts'; const input = JSON.parse(process.env.A74_INPUT); const r = assembleCase(input); console.log(JSON.stringify([r.ok ? r.value.manifestSha256 : null, r.ok ? r.value.items.map((i) => i.sourceEvidenceId) : null, Intl.DateTimeFormat().resolvedOptions().timeZone]))"],
    { encoding: 'utf8', cwd: process.cwd(), env: childEnv({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', A74_INPUT: JSON.stringify({ claimSubmissionId: SI, organizationId: org, sources: await ownerLinks(SI) }) }) },
  )
  const probed = (() => {
    try {
      return JSON.parse((tzProbe.stdout ?? '').trim().split(/\r?\n/).pop() ?? '')
    } catch {
      return null
    }
  })()
  const zonedDigest = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Kiritimati'")
    await tx.$executeRawUnsafe("SET LOCAL lc_messages = 'C'")
    return (await tx.$queryRawUnsafe<{ h: string }[]>(`SELECT ${MANIFEST_SQL} AS h FROM ${HEADER} h WHERE h.id = $1::uuid`, incCase.body.caseId))[0]?.h
  })
  check('T092', 'Time zone independent digest', probed !== null && probed[2] === 'Pacific/Kiritimati' && probed[0] === incCase.body.manifestSha256 && zonedDigest === incCase.body.manifestSha256, 'a separate process in Pacific/Kiritimati (UTC+14) and a database session in that zone derive the identical digest')
  const zonedOrder = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Los_Angeles'")
    return (await tx.$queryRawUnsafe<{ id: string }[]>('SELECT id::text AS id FROM revenue_source_evidence WHERE claim_submission_id = $1::uuid ORDER BY received_at, id', SI)).map((row) => row.id)
  })
  check('T093', 'Locale independent ordering', probed !== null && same(probed[1], incItems.map((i: any) => i.sourceEvidenceId)) && same(zonedOrder, incItems.map((i: any) => i.sourceEvidenceId)), 'with a Turkish locale in the assembler process and another database time zone, the order is the same (received instant, then binary id)')
  const emptyAgain = assembleCase({ claimSubmissionId: SE, organizationId: org, sources: [] })
  const emptySql = (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT ${MANIFEST_SQL} AS h FROM ${HEADER} h WHERE h.id = $1::uuid`, emptyCase.body.caseId))[0]?.h
  check('T094', 'Empty case digest stable', emptyAgain.ok && emptyAgain.value.manifestSha256 === emptyCase.body.manifestSha256 && emptySql === emptyCase.body.manifestSha256 && same((await assemble(SE)).body, emptyCase.body), 'the empty case digest is reproduced by the assembler and by SQL, and its replay is identical')
  const ledgerTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(receivable|ledger|balance|posting|journal|allocation|settle|payment|cash|receipt|copay|patient_share)'`).map((row) => row.t)
  check('T095', 'No-source is not zero balance', emptyCase.body.assemblyCode === 'NO_REVENUE_SOURCES' && ledgerTables.length === 0 && ![...headerColumns, ...entryColumns].some((c) => /balance|amount|currency/.test(c)), 'an empty case is only an empty inventory: no balance, amount or currency exists anywhere to be zero')
  const readinessOfCases = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${ENTRY} e JOIN evidence_gate_results g ON g.id = e.readiness_id WHERE g.readiness_code <> 'NOT_READY_FOR_ADJUDICATION'`)
  check('T096', 'Incomplete never adjudicated', Number(readinessOfCases[0].n) === 0 && incCase.body.assemblyCode === 'INVENTORY_INCOMPLETE' && !/ADJUDICATED|READY_FOR_ADJUDICATION'/.test(readFileSync(`../${MIGRATION}`, 'utf8').replace(/NOT_READY_FOR_ADJUDICATION/g, '')), 'every linked readiness in every case is NOT_READY_FOR_ADJUDICATION; no adjudicated or ready code exists in the A7.4 schema')
  const ambiguous = assembleCase({ claimSubmissionId: S1, organizationId: org, sources: [{ ...linksS2[0], classifications: [...linksS2[0].classifications, { ...linksS2[0].classifications[0], classificationId: MISSING }] }] })
  check('T097', 'No silent latest selection', !ambiguous.ok && /more than one accepted classification/.test(ambiguous.ok ? '' : ambiguous.detail) && !/orderBy: \{ recordedAt: 'desc'|\.at\(-1\)|latest|newest/i.test(production.code), 'two accepted classifications for one source are refused rather than the latest chosen; the code never picks a latest or newest record')
  check('T098', 'Old case stays after new source', (await caseHash(CASE1.body.caseId)) === case1Before && (await prisma.evidenceCaseEntry.count({ where: { sourceEvidenceId: K3.E } })) === 0, 'E3 belongs to no case of S1: CASE1 is history, unchanged to the byte')
  const upstreamColumns = await prisma.$queryRaw<{ t: string; n: bigint }[]>`SELECT table_name AS t, count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('claims', 'claim_freezes', 'revenue_source_evidence', 'source_evidence_classifications', 'evidence_gate_results') GROUP BY 1 ORDER BY 1`
  check(
    'T099',
    'No status pointer introduced',
    same(upstreamColumns.map((r) => [r.t, Number(r.n)]), [['claim_freezes', 13], ['claims', 7], ['evidence_gate_results', 11], ['revenue_source_evidence', 10], ['source_evidence_classifications', 11]]) && headerColumns.length === 13 && headerColumns.every((c) => HEADER_COLUMNS.includes(c)) && entryColumns.length === 7 && entryColumns.every((c) => ENTRY_COLUMNS.includes(c)),
    'no upstream table gained a column; the header has exactly its 13 columns and the entry its 7 — no status, current or latest pointer',
  )
  const futureContract = await directCase(dE, { contract: 'A7-REVENUE-CASE-2' }, [], 'rollback', true)
  check('T100', 'Future contract version blocked', refusedBy(futureContract, /evidence_case_snapshots_contract_chk/), 'A7-REVENUE-CASE-2 is refused until a later owner admits it; a revision would be its own row under (submission, contract), never a mutation')

  // ---------------------------------------------------------------- ownership and phase isolation (T101–T110)
  section('No A6 or A7.1–A7.3 change, no A7.5/A9 work, no send, import, network, queue, ledger, payment or adjustment')
  const wFreeze = await freezeHash(W.claimId)
  const pFreeze = await freezeHash(P.claimId)
  const wLifecycle = await lifecycleHash(W.claimId)
  const S101 = fresh()
  await linkedSource(S101, 'BOUNDARY')
  const before101b = { sources: await sourceHash(), classifications: await classificationHash(), readiness: await readinessHash() }
  await assemble(S101)
  check('T101', 'A6.7 frozen bytes untouched', (await freezeHash(W.claimId)) === wFreeze && (await freezeHash(P.claimId)) === pFreeze, 'every byte of the freezes and their sealed manifests is identical after cases are assembled')
  check('T102', 'A6.8 lifecycle untouched', (await lifecycleHash(W.claimId)) === wLifecycle, 'every lifecycle event is identical')
  check('T103', 'A6.9 correction links untouched', (await correctionHash(W.claimId)) === chainBefore, 'the worked correction link is identical')
  check('T104', 'A7.1 sources untouched', (await sourceHash()) === before101b.sources, "every byte of this run's A7.1 sources is identical after a case")
  check('T105', 'A7.2 classifications untouched', (await classificationHash()) === before101b.classifications, "every byte of this run's A7.2 classifications is identical after a case")
  check('T106', 'A7.3 readiness untouched', (await readinessHash()) === before101b.readiness, "every byte of this run's A7.3 readiness results is identical after a case")
  const laterRoutes = [await post(`${casePath(CASE1.body.caseId)}/adjudications`, {}), await post(`/api/claim-submissions/${S1}/settlements`, {}), await post(`/api/claim-submissions/${S1}/remittances`, {}), await post(`/api/claim-submissions/${S1}/payments`, {})]
  const laterTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(adjudicat|denial|allowed|remittance|settle|import|inbound|outbox|queue|transmission|acknowledg|closure)'`).map((row) => row.t)
  // Judged on behaviour: no such route answers and no such table exists. A later A7 suite's own files are not later
  // work (the start gate, T001, still reads them as later code).
  check('T107', 'No A7.5 or A9 work', laterRoutes.every((res) => res.status === 404) && laterTables.length === 0, 'no adjudication, settlement, remittance, payment or closure route or table')
  const jobsChanged = changedPaths.filter((file) => /^backend\/src\/jobs\//.test(file))
  // Judged on behaviour, not vocabulary: an awaited in-request pause (the lock-wait jitter) is not background work.
  const awaitedPause = /new Promise\(\(resolve\) => setTimeout\(resolve, [^\n]*/g
  const awaitedPauses = production.code.match(awaitedPause) ?? []
  const backgroundWork = production.code.replace(awaitedPause, '')
  const jobsWiring = committedFiles('backend/src/jobs').filter((file) => /\.ts$/.test(file)).some((file) => /case/i.test(file) || /evidence-case|evidenceCase/i.test(committedCode(file)))
  check(
    'T108',
    'No send, import, network or queue',
    !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|<\?xml|\bx12\b|\bhl7\b|\bfhir\b|dhpo|eclaimlink|enqueue/i.test(production.code) && jobsChanged.length === 0 && !jobsWiring && !/setInterval|setTimeout|setImmediate|worker_threads|\bnew Worker\(|cron|schedule\(/i.test(backgroundWork) && awaitedPauses.length === 1,
    `no network client, XML/X12/HL7/FHIR, queue, job, worker or background timer in A7.4 code; its only timer is the awaited in-request lock-wait pause (${awaitedPauses.length})`,
  )
  const moneyIdentifier = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|toFixed\(|[Ss]ettle|[Aa]llocat|[Aa]djust|[Rr]eceivable|[Bb]alance|[Ll]edger/
  const moneyCode = production.code.replace(/refusedByName = \[[\s\S]*?\] as const/, '')
  const pricingOfW = await prisma.claimPricingRun.findMany({ where: { claimId: W.claimId }, orderBy: { evaluatedAt: 'asc' } })
  check('T109', 'No ledger, payment or adjustment', !moneyIdentifier.test(moneyCode) && ledgerTables.length === 0 && pricingOfW.length === 1 && pricingOfW[0].totalExtendedAmount?.toFixed(2) === '200.01', 'A7.4 computes no money and creates no ledger, payment or adjustment table; the Claim keeps its one pricing run and its AED 200.01 total')
  const kinds = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${ENTRY} e JOIN revenue_source_evidence r ON r.id = e.source_evidence_id WHERE r.source_kind <> 'INTERNAL_SYNTHETIC'`)
  check('T110', 'Synthetic only, UAE/US neutral', Number(kinds[0].n) === 0 && !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION)\w*|['"`](AE-DU|DHA|AED|US)['"`]/.test(production.code), 'every cased source is INTERNAL_SYNTHETIC; A7.4 holds no UAE/US market literal (future US support stays configuration)')

  const workedRows = async () => {
    const h = await prisma.evidenceCaseSnapshot.findUniqueOrThrow({ where: { id: CASE1.body.caseId }, include: { entries: { orderBy: { ordinal: 'asc' } } } })
    return JSON.stringify({ ...h, recordedAt: h.recordedAt.toISOString(), createdAt: h.createdAt.toISOString() })
  }
  const worked = { row: await workedRows(), read: read1.body }

  // ---------------------------------------------------------------- nested regressions (T111–T120)
  section('Regressions — A7.3 invoked, nesting A7.2 -> A7.1 -> A6.10 -> A6.9 -> … -> A6.1 -> A5.10 -> A1')
  await apiReady('the A7.3 and backward regression chain')
  const chain = run('npm run test:a7:evidence-gate')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.3')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.3] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.3 asserts facts about its own branch, its own migration and production diff, its nested N/A proofs against its
  // own branch, and its own upstream. On A7.4 those statements are obsolete by design; every other A7.3 check is
  // substantive. T120 below proves each cause independently, never from the id.
  const a73NonApplicable: Record<string, string> = {
    T001: "A7.3 'Start gate after A7.2' requires the A7.3 feature branch (and reads any other A7 suite as later code); A7.4 is branched from the main that contains the A7.3 merge",
    T004: "A7.3 'Exactly one additive migration' expects its own migration as the branch's only addition; A7.4 adds exactly one different migration (T004 here)",
    T010: "A7.3 'Diff scope excludes other owners' lists the paths A7.3 was allowed to change; A7.4 legitimately changes its own (T010 here)",
    T120: "A7.3 'Historical N/A reasons proved' proves A7.2's branch-only causes against the A7.3 branch (its migration, diff and upstream); on A7.4 those proofs are re-done here (T120)",
    T130: "A7.3 'Exact HEAD, clean tree, repeatable' requires the upstream to be the A7.3 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a73NonApplicable))
  const summary = chain.output.match(/\[A7\.3\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.3\] RUN ABORTED|\[A7\.3\] uncaught error|\[A7\.3\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a73Substantive = rows.filter((row) => !(row.id in a73NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a73Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T111',
    'A7.3 substantive regression',
    ran && reconciled && undocumented.length === 0 && a73Substantive.length === 0 && a73Passing >= 125 && verdictOf('T060') === 'PASS',
    !ran
      ? 'the A7.3 suite did not complete'
      : !reconciled
        ? `A7.3 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.3 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.3\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.3] automated summary: ', 'A7.3 ')}; all ${a73Passing} substantive checks PASS (T060 against the real A7.4 key) and every failure is documented`,
  )
  for (const id of Object.keys(a73NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A7.3 ${titleOf(row.line)}`, a73NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T112', 'A7.2 substantive regression', verdictOf('T111') === 'PASS', `A7.3 T111 (A7.2 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A7.1 substantive regression', verdictOf('T112') === 'PASS', `A7.3 T112 (A7.1) ${verdictOf('T112')}`)
  check('T114', 'A6.10 cumulative regression', verdictOf('T113') === 'PASS', `A7.3 T113 (A6.10) ${verdictOf('T113')}`)
  check('T115', 'A6.1–A6.9 regression', ['T114', 'T115', 'T116', 'T117', 'T118'].every((id) => verdictOf(id) === 'PASS'), `A7.3 T114 (A6.9), T115 (A6.8), T116 (A6.7), T117 (A6.6–A6.3) and T118 (A6.2, A6.1) ${['T114', 'T115', 'T116', 'T117', 'T118'].map(verdictOf).join('/')}`)
  check('T116', 'A5 substantive regression', verdictOf('T118') === 'PASS', `A7.3 T118 covers A5 through A7.2 T118 (A5.10 → A5.1): ${verdictOf('T118')}`)
  check('T117', 'A1–A4 substantive regression', verdictOf('T118') === 'PASS' && verdictOf('T119') === 'PASS', `A7.3 T118 (A1–A4 through A7.2 T118) ${verdictOf('T118')} and T119 (no substantive nested failure) ${verdictOf('T119')}`)
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A7\.3\] T111\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T118',
    'Historical N/A individually justified',
    ran && failing.every((id) => id in a73NonApplicable) && naLines.length === 5 && naLines.every((line) => line.length > 80),
    `the five A7.3 branch-only items (${Object.keys(a73NonApplicable).join(', ')}) are each printed with an explicit reason here, and A7.3 itself justifies its five A7.2 items (${naLines.length} lines)`,
  )
  check('T119', 'No substantive nested FAIL', ran && a73Substantive.length === 0 && verdictOf('T119') === 'PASS', 'every substantive check of A7.3 and of every package it nests PASSES on this branch')
  // Each documented A7.3 failure must fail for its branch-only reason, proved independently on this branch.
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
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file) && !(file === A73_HARNESS && a73HarnessOnlyT060))
  const a73Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA72 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const causes: Record<string, boolean> = {
    T001: branch === a74Branch && a73Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a73Merge} HEAD`),
    T004: same(migrationStatus, [`A\t${MIGRATION}`]),
    T010: a73Unexpected.length > 0 && a73Unexpected.every((path, index) => changedPaths.includes(path) || (index === a73Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A7.3 re-proves A7.2's branch-only causes against the A7.3 branch; on A7.4 only those tied to the branch (its
    // migration, diff and upstream) can be unproven — re-proved here against this branch.
    T120: unprovenA72.length > 0 && unprovenA72.every((id) => ['T001', 'T004', 'T010', 'T120', 'T130'].includes(id)) && same(migrationStatus, [`A\t${MIGRATION}`]) && outOfScope.length === 0 && tracking.includes(`origin/${a74Branch}`),
    T130: tracking.includes(`origin/${a74Branch}`) && !/origin\/feature\/a7-3/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  check(
    'T120',
    'Exact protected owner diffs only',
    ran && unproven.length === 0 && (changedPaths.includes(A73_HARNESS) ? a73HarnessOnlyT060 : true),
    unproven.length === 0
      ? `each documented A7.3 failure (${failing.filter((id) => id in a73NonApplicable).join(', ') || 'none'}) fails only for its branch-only reason, proved independently; the only owner file changed is the A7.3 suite's T060 block (${a73Hunks.length} hunk(s))`
      : `cause not proven for: ${unproven.join(', ')}`,
  )

  // ---------------------------------------------------------------- build and exact-head acceptance (T121–T130)
  section('Units, typecheck, frontend, Prisma checksum, replay, outage and recovery, no 5xx, synthetic fixtures, golden example, exact head')
  const allUnit = run('npm run test:unit')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  check('T121', 'Unit tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 14/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 14 A7.4 assembler and strict-request tests`)
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
    'Migration checksums and replay',
    status.ok && replay.ok && (appliedChecksum === checkoutChecksum || appliedChecksum === sha256Of(blob)),
    `the A7.4 migration is applied with the checksum of its committed file (${(appliedChecksum ?? '').slice(0, 12)}…); status up to date; replay ALL CHECKS PASS (T006)`,
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
  check('T126', 'Health vs readiness outage', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')
  await waitFor(databaseUp, 60_000)
  check('T127', 'No unexpected 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runCases = await prisma.$queryRawUnsafe<{ id: string; org: string; sub: string }[]>(`SELECT h.id::text AS id, h.organization_id::text AS org, h.claim_submission_id::text AS sub FROM ${HEADER} h WHERE h.created_at >= $1::timestamptz`, runStartedAt.toISOString())
  const runSubmissions = new Set([...W.freezes, ...P.freezes, ...F.freezes, L.freezes[0], Lc.freezes[0]])
  const runEntrySources = await prisma.$queryRawUnsafe<{ reference: string }[]>(`SELECT r.source_reference AS reference FROM ${ENTRY} e JOIN ${HEADER} h ON h.id = e.assembly_id JOIN revenue_source_evidence r ON r.id = e.source_evidence_id WHERE h.created_at >= $1::timestamptz`, runStartedAt.toISOString())
  check(
    'T128',
    'Synthetic tenant fixtures',
    runCases.length > 0 && runCases.every((c) => runSubmissions.has(c.sub) && [org, otherOrg].includes(c.org)) && runEntrySources.every((s) => s.reference.includes(runToken)),
    `${runCases.length} cases assembled since this run started, all on this run's synthetic frozen submissions in the two synthetic organizations; every cased source keyed by ${runId}`,
  )
  const afterRow = await workedRows()
  const afterRead = (await get(casePath(CASE1.body.caseId))).body
  const afterDigest = (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT ${MANIFEST_SQL} AS h FROM ${HEADER} h WHERE h.id = $1::uuid`, CASE1.body.caseId))[0]?.h
  console.log(`[${TAG}]      worked example: Claim K ${W.claimId} / S1 ${S1}: E1/C1/R1 and E2/C2/R2 (both NOT_READY_FOR_ADJUDICATION) -> CASE1 ${CASE1.body.caseId} ${CASE1.body.assemblyCode}, 2 ordered items, digest ${CASE1.body.manifestSha256.slice(0, 12)}…, 1 audit`)
  console.log(`[${TAG}]      worked example: identical POST -> ${replay1.status} CASE1, +${d41.audit_events} audit; later E3 -> CASE1 unchanged; corrected freeze S2 (A6.9 link ${link.status}) -> its own case ${CASE_S2.body.caseId}; all sources INTERNAL_SYNTHETIC, nothing paid or adjudicated`)
  check(
    'T129',
    'Golden worked example after restart',
    CASE1.status === 201 && CASE1.body.assemblyCode === 'INVENTORY_COMPLETE' && replay1.status === 200 && d41.audit_events === 0 && CASE_S2.status === 201 && afterRow === worked.row && same(afterRead, worked.read) && afterDigest === CASE1.body.manifestSha256,
    'the §10 scenario is reproduced, and after the nested chain and a database restart CASE1\'s header and entries read back byte-identically and its digest is recomputed again',
  )

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a(8|9)|dhpo|eclaimlink/i.test(file))
  check(
    'T010',
    'Scope, diff and no later-owner code',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A7.4 module, migration and models, harness and check page, two permissions, two error codes, one audit action and wiring${changedPaths.includes(A73_HARNESS) ? ", and the A7.3 suite's T060 block only" : ''}; no A5/A6/A7.1–A7.3 owner changed; no A7.5+/A8/A9 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  check(
    'T130',
    'Exact HEAD, two full runs',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a74Branch}`) && !/ahead|behind/.test(tracking) && afterRow === worked.row,
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; after the database restart the worked case reads back identically`,
  )

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] REVENUE EVIDENCE CASE ASSEMBLY ACCEPTANCE COMPLETE` : `[${TAG}] A7.4 FINAL FAIL`)
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
