import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordCorrectionLink } from '../../modules/claim-correction/claim-correction.service.ts'
import { getRevenueTimeline } from '../../modules/revenue-timeline/revenue-timeline.service.ts'
import { identityKeyOf, identityPreimage } from '../../modules/exception-intake/exception-intake.identity.ts'
import { getExceptionIntakesOf, recordExceptionIntake, recordExceptionIntakeOn } from '../../modules/exception-intake/exception-intake.service.ts'
import { EXCEPTION_INTAKE_CONTRACT_VERSION, exceptionReasonCodes, sourceKinds } from '../../modules/exception-intake/exception-intake.types.ts'

// A8.1 — focused acceptance for Exception Intake & Provenance Registry (A8-EXCEPTION-INTAKE-1, T001–T130).
//
// Every Claim, freeze, source, classification, readiness, case and assessment is built through its owners exactly as
// the A6.10 and A7.x suites build them. Real exceptions are made only through the owners: a Claim frozen twice without
// an A6.9 link is a genuine history contradiction that the A7.7 owner refuses, and an intake on it is recorded
// through the A8.1 route. Facts no synthetic owner path can produce (a REVIEW_REQUIRED or self-contradicting A7.5
// assessment) are planted only in a transaction that is ALWAYS rolled back, and the production A8.1 service records
// the intake on THAT transaction. Direct SQL writes are adversarial only, run against the live guards, and always
// rolled back. Failure injection uses the existing concurrency probes. Synthetic users are provisioned per run
// through Better Auth's own server-side creation with a random password that is never printed.

const TAG = 'A8.1'
let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []
const printed: string[] = []

const say = (line: string) => {
  printed.push(line)
  console.log(line)
}

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
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

const runId = `A81-${Date.now()}`
const runStartedAt = new Date(Number(runId.slice(4)))
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a81Branch = 'feature/a8-1-exception-intake'
const a710Branch = 'feature/a7-10-a7-integration-acceptance'
const a79Branch = 'feature/a7-9-revenue-evidence-continuity'
const a78Branch = 'feature/a7-8-revenue-evidence-delta'
const UPSTREAM_BRANCHES = [
  'feature/a6-10-a6-integration-acceptance', 'feature/a7-1-revenue-source-evidence', 'feature/a7-2-evidence-classification', 'feature/a7-3-adjudication-evidence-readiness',
  'feature/a7-4-revenue-evidence-case-assembly', 'feature/a7-5-case-closure-prerequisite-assessment', 'feature/a7-6-closure-basis-trace', 'feature/a7-7-revenue-evidence-timeline', a78Branch, a79Branch, a710Branch,
]
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/exception-intake'
const FE_DIR = 'frontend/src/modules/exception-intake'
const HARNESS_DIR = 'backend/src/integration/a8-exception-intake'
const REGISTER_DOC = 'docs/A8_Exception_Intake.md'
const MIGRATION_NAME = '20261028090000_a8_1_exception_intake'
const MIGRATION = `backend/prisma/migrations/${MIGRATION_NAME}/migration.sql`
const TABLE = 'operational_intake_records'
const UNIT_TESTS = [`${MODULE_DIR}/exception-intake.identity.test.ts`, `${MODULE_DIR}/exception-intake.validation.test.ts`]
const SYNTHETIC = 'INTERNAL_SYNTHETIC'
const CONTRACT = 'A8-EXCEPTION-INTAKE-1'
const TIMELINE_CONTRACT = 'A7-REVENUE-TIMELINE-1'
const PREREQ_CONTRACT = 'A7-CLOSURE-PREREQ-1'
const DTO_KEYS = ['exceptionIntakeId', 'contractVersion', 'organizationId', 'claimId', 'sourceKind', 'sourceRecordId', 'sourceContractVersion', 'sourceFingerprintSha256', 'exceptionReasonCode', 'identityKey', 'recordedByUserId', 'recordedAt']
const COLUMNS = ['id', 'organization_id', 'claim_id', 'contract_version', 'source_kind', 'source_record_id', 'source_contract_version', 'source_fingerprint_sha256', 'exception_reason_code', 'identity_key', 'recorded_by_user_id', 'recorded_at', 'created_at']
// The earlier suites whose phase-boundary predicates A8.1 corrects (harness only), and the exact allowed vocabulary of
// that correction: an added line must carry the own-scope / A7-owned wording; a removed line must be one of the
// predicate lines it replaces.
const CORRECTED_HARNESSES = ['a7-closure-basis-trace', 'a7-revenue-timeline', 'a7-revenue-delta', 'a7-revenue-continuity', 'a7-phase-closure'].map((s) => `backend/src/integration/${s}/${s}.integration.ts`)
const CORRECTION_ADDED = /ownMerge|ownRange|ownChangedPaths|ownPrismaStatus|ownHeadMigrationDirs|ownBaseMigrationDirs|ownOwnerChanged|own scope|THIS package|later branch|merge$|a7Owned|in the A7 phase|A7 phase's own files|base, permission catalogue, owner code|A later package's changes are that package's to prove/
const CORRECTION_REMOVED = /prismaStatus|migrationStatus|ownerChanged|baseMigrationDirs|authzDiff = gitArgs|appDiff = gitArgs|changedPaths\.some|const tracked = |no exception, work-queue or A8 module|payer adapter file, and no A7 module/
const ALLOWED = [
  'backend/package.json', 'backend/prisma/schema.prisma', MIGRATION, 'backend/src/app.ts', 'backend/src/shared/errors/error.types.ts', 'backend/src/shared/authorization/authorization.types.ts',
  'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'backend/src/modules/audit/audit.types.ts', 'frontend/src/developer/checkRegistry.tsx', REGISTER_DOC, ...CORRECTED_HARNESSES,
]
// Every table an intake could conceivably touch, in a fixed key order. A read or a refusal must leave every one as it was.
const COUNT_TABLES = [TABLE, 'audit_events', 'evidence_prereq_results', 'evidence_case_snapshots', 'evidence_case_entries', 'evidence_gate_results', 'source_evidence_classifications', 'revenue_source_evidence', 'claims', 'claim_freezes', 'claim_freeze_lifecycle_events', 'claim_correction_links']

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

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  const headAtStart = git('rev-parse HEAD')
  say(`[${TAG}] A8.1 exception intake & provenance registry (${CONTRACT}) — run ${runId}`)
  say(`[${TAG}] HEAD ${headAtStart} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- start gates and wiring (T001–T010)
  section('Start gates and wiring: the accepted A7.10 merge, ancestry, one additive migration, Prisma, replay, the narrow permissions, two routes, earlier contracts, diff scope')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}$`, '-n', '1', '--format=%H'])
  const a710Merge = mergeOf(a710Branch)
  const a79Merge = mergeOf(a79Branch)
  const upstreamMerges = UPSTREAM_BRANCHES.map((name) => ({ name, sha: mergeOf(name) }))
  check(
    'T001',
    'A7.10 exact merge ancestor',
    branch === a81Branch && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`) && gitOk('merge-base --is-ancestor origin/main HEAD') && a79Merge.length === 40,
    `branch ${branch}; A7.10 merged as ${a710Merge.slice(0, 7) || 'NOT FOUND'} (A7.9 as ${a79Merge.slice(0, 7)}) and is an ancestor; latest main ${git('rev-parse --short origin/main')} contained; not stacked`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T002', 'Clean tree and origin parity', dirty.length === 0 && tracking.includes(`origin/${a81Branch}`) && !/ahead|behind/.test(tracking), dirty.length === 0 ? `working tree clean; ${tracking}` : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'All A6.10–A7.10 ancestry',
    upstreamMerges.every((m) => m.sha.length === 40 && gitOk(`merge-base --is-ancestor ${m.sha} HEAD`)),
    `A6.10 and A7.1–A7.10 merges (${upstreamMerges.map((m) => m.sha.slice(0, 7)).join(', ')}) are all ancestors of HEAD`,
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const prismaStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma']).split(/\r?\n/).filter(Boolean)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  const baseMigrationDirs = migrationDirsAt('origin/main')
  check(
    'T004',
    'One A8.1 additive migration only',
    same(prismaStatus, [`A\t${MIGRATION}`, 'M\tbackend/prisma/schema.prisma']) && headMigrationDirs.length === baseMigrationDirs.length + 1 && baseMigrationDirs.every((dir) => headMigrationDirs.includes(dir)) && headMigrationDirs[headMigrationDirs.length - 1].endsWith(MIGRATION_NAME),
    `exactly one migration added (${MIGRATION_NAME}, the newest) and the schema extended; all ${baseMigrationDirs.length} applied migrations untouched`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma schema valid, client generated', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'the schema validates and generates; the working database is up to date with every migration (never reset)')
  const replay = run('npm run db:verify:replay')
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check(
    'T006',
    'From-empty replay equals HEAD',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && appliedCount === headMigrationDirs.length && /PASS {2}the A8\.1 tables are exactly operational_intake_records/.test(replay.output) && /PASS {2}operational_intake_records_insert_guard_trg is present/.test(replay.output),
    `${appliedCount} migrations applied cleanly from empty in the scratch database — exactly the ${headMigrationDirs.length} committed at HEAD; every A8.1 CHECK, index, trigger and foreign key survives`,
  )
  const catalogueAt = (ref: string) => [...gitArgs(['show', `${ref}:backend/src/shared/authorization/authorization.types.ts`]).matchAll(/^\s+'([A-Za-z_]+\.[A-Za-z_]+)',/gm)].map((m) => m[1])
  const catalogueHead = catalogueAt('HEAD')
  const catalogueMain = catalogueAt('origin/main')
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  check(
    'T007',
    'Narrow permission catalogue and grants',
    same(catalogueHead.filter((c) => !catalogueMain.includes(c)), ['exceptionIntake.create', 'exceptionIntake.read']) && catalogueMain.every((c) => catalogueHead.includes(c)) &&
      same(allCodes.filter((c) => /^exceptionIntake\./.test(c)).sort(), ['exceptionIntake.create', 'exceptionIntake.read']) && (await grantsOf('exceptionIntake.create')) === 'ORG_ADMIN' && (await grantsOf('exceptionIntake.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      !allCodes.some((c) => /exception/i.test(c) && !/^exceptionIntake\.(create|read)$/.test(c)),
    'the catalogue adds exactly exceptionIntake.create (Admin) and exceptionIntake.read (Admin, Viewer); no permission removed; no assign, resolve, close or export permission exists',
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
  // Raw database text in a response body: SQL keywords, a stack frame or a physical table or guard name.
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /operational_intake|exception_intake_|evidence_prereq|claim_freeze/.test(text)
  }

  const intakePath = (claimId: string) => `/api/claims/${claimId}/exception-intake`
  const routeCode = committedCode(`${MODULE_DIR}/exception-intake.route.ts`)
  const wiring = [await get(intakePath(MISSING)), await post(intakePath(MISSING), { sourceKind: 'REVENUE_TIMELINE', sourceRecordId: MISSING, sourceContractVersion: TIMELINE_CONTRACT, exceptionReasonCode: 'PROVENANCE_CONFLICT' })]
  const absent = [
    await api('PATCH', intakePath(MISSING), {}), await api('PUT', intakePath(MISSING), {}), await api('DELETE', intakePath(MISSING)),
    await get(`${intakePath(MISSING)}/${MISSING}`), await post(`${intakePath(MISSING)}/${MISSING}/assign`, {}), await post(`${intakePath(MISSING)}/${MISSING}/resolve`, {}),
    await get('/api/exception-intakes'), await post(`/api/claims/${MISSING}/exceptions`, {}),
  ]
  check(
    'T008',
    'Strict POST and GET wiring only',
    wiring.every((r) => r.status === 404 && errorCode(r.body) === 'NOT_FOUND') && absent.every((r) => r.status === 404) &&
      (routeCode.match(/exceptionIntakeRouter\.(get|post|put|patch|delete|all|use)\(/g) ?? []).length === 2 && /exceptionIntakeRouter\.post\('\/:claimId\/exception-intake'/.test(routeCode) && /exceptionIntakeRouter\.get\('\/:claimId\/exception-intake'/.test(routeCode),
    `POST and GET answer a missing Claim with a privacy-safe 404; PATCH/PUT/DELETE, /:id, assign, resolve, a collection and a generic exceptions route are absent (${absent.map((r) => r.status).join('/')})`,
  )
  const contractFiles: [string, string][] = [
    ['backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'], ['backend/src/modules/revenue-evidence/revenue-evidence.types.ts', 'REVENUE_SOURCE_CONTRACT_VERSION'],
    ['backend/src/modules/evidence-classification/evidence-classification.types.ts', 'CLASSIFICATION_CONTRACT_VERSION'], ['backend/src/modules/evidence-gate/evidence-gate.types.ts', 'READINESS_CONTRACT_VERSION'],
    ['backend/src/modules/evidence-case/evidence-case.types.ts', 'CASE_CONTRACT_VERSION'], ['backend/src/modules/case-prerequisite/case-prerequisite.types.ts', 'PREREQ_CONTRACT_VERSION'],
    ['backend/src/modules/closure-basis-trace/closure-basis-trace.types.ts', 'TRACE_CONTRACT_VERSION'], ['backend/src/modules/revenue-timeline/revenue-timeline.types.ts', 'TIMELINE_CONTRACT_VERSION'],
    ['backend/src/modules/revenue-delta/revenue-delta.types.ts', 'DELTA_CONTRACT_VERSION'], ['backend/src/modules/revenue-continuity/revenue-continuity.types.ts', 'CONTINUITY_CONTRACT_VERSION'],
  ]
  const constantAt = (ref: string, path: string, name: string) => (gitArgs(['show', `${ref}:${path}`]).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1] ?? 'ABSENT'
  const contractsHead = contractFiles.map(([p, n]) => constantAt('HEAD', p, n))
  const contractsMain = contractFiles.map(([p, n]) => constantAt('origin/main', p, n))
  const productDiff = changedPaths.filter((p) => /^backend\/src\/modules\//.test(p) && !p.startsWith(`${MODULE_DIR}/`) && p !== 'backend/src/modules/audit/audit.types.ts')
  check(
    'T009',
    'Earlier contracts and migrations unchanged',
    same(contractsHead, contractsMain) && !contractsHead.includes('ABSENT') && productDiff.length === 0 && prismaStatus.every((s) => !/^M\tbackend\/prisma\/migrations\//.test(s)),
    `${contractsHead.filter((c) => c !== 'ABSENT').length} earlier owner contracts identical to main (${contractsHead.slice(-4).join(', ')}, …); no earlier module's code and no applied migration changed`,
  )
  const outOfScope = changedPaths.filter((file) => !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith(`${FE_DIR}/`) && !file.startsWith(`${HARNESS_DIR}/`) && !ALLOWED.includes(file))
  const correctionLines = CORRECTED_HARNESSES.flatMap((path) => gitArgs(['diff', 'origin/main...HEAD', '--', `:/${path}`]).split(/\r?\n/).filter((line) => /^[+-][^+-]/.test(line)).map((line) => ({ path, line })))
  const strayCorrection = correctionLines.filter(({ line }) => (line.startsWith('+') ? !CORRECTION_ADDED.test(line) : !CORRECTION_REMOVED.test(line)))
  const laterDomain = changedPaths.filter((file) => /remittance|payment|posting|settlement|ledger|receivable|adjudicat|denial|payer-response|integration\/a9|dhpo|eclaimlink|assign|resolution|export/i.test(file))
  check(
    'T010',
    'Changed-file allowlist, no A8.2+/A9 code',
    changedPaths.length > 0 && outOfScope.length === 0 && strayCorrection.length === 0 && correctionLines.length > 0 && laterDomain.length === 0,
    outOfScope.length + strayCorrection.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A8.1 module, page, harness, migration and register, the narrow shared additions, and only the own-scope predicate lines of the five corrected A7.6–A7.10 suites (${correctionLines.length} lines); no A8.2+ or A9 domain`
      : `unexpected: ${[...outOfScope, ...strayCorrection.map((s) => `${s.path}: ${s.line.slice(0, 80)}`), ...laterDomain].join(' | ').slice(0, 300)}`,
  )

  // Synthetic users: Better Auth's own server-side user and credential creation, then a membership (with the ORG_ADMIN
  // role, or with no role at all). The password is random per run and never printed.
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
    return { id: user.id as string, membershipId: membership.id as string, who: as(signed.cookie), cookie: signed.cookie }
  }
  const B = await provisionMember('b')
  const O = await provisionMember('o', otherOrg)
  const O2 = await provisionMember('o2', otherOrg)
  const NR = await provisionMember('norole', org, false)
  const RV = await provisionMember('revoked')

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: two organizations; Claims frozen twice without a link (genuine history contradictions) and a normal linked Claim; evidence, cases and assessments')
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
  const runToken = runId.replace(/^A81-/, '')
  const ref = (suffix: string) => `SYN-${runToken}-${suffix}`.toUpperCase()
  const registerSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-source-evidence`, { sourceKind: SYNTHETIC, sourceReference: ref(suffix) }, who)
    if (res.status !== 201) throw new Error(`fixture source ${suffix} could not be registered through A7.1: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.revenueSourceEvidenceId as string
  }
  const linkedSource = async (submissionId: string, suffix: string, who: Who = asAdmin) => {
    const E = await registerSource(submissionId, suffix, who)
    const Cl = (await post(`/api/revenue-source-evidence/${E}/classifications`, {}, who)).body.classificationId as string
    const R = (await post(`/api/revenue-evidence-classifications/${Cl}/adjudication-readiness`, {}, who)).body.readinessId as string
    if (!Cl || !R) throw new Error(`fixture ${suffix}: classification or readiness refused`)
    return { E, C: Cl, R }
  }
  const caseOf = async (submissionId: string, who: Who = asAdmin) => {
    const res = await post(`/api/claim-submissions/${submissionId}/revenue-evidence-cases`, {}, who)
    if (res.status !== 201) throw new Error(`fixture case could not be assembled through A7.4: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { caseId: string; assemblyCode: string; manifestSha256: string }
  }
  const assessmentOf = async (caseId: string, who: Who = asAdmin) => {
    const res = await post(`/api/revenue-evidence-cases/${caseId}/closure-prerequisite-assessments`, {}, who)
    if (res.status !== 201) throw new Error(`fixture assessment could not be recorded through A7.5: ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body as { assessmentId: string; caseId: string; assessmentCode: string; basisCode: string; caseManifestSha256: string }
  }
  const chainOf = async (claimId: string, freezes: string[], who: Who = asAdmin) => {
    for (let i = 1; i < freezes.length; i += 1) {
      const res = await post(`/api/claims/${claimId}/correction-links`, { priorSubmissionId: freezes[i - 1], correctedSubmissionId: freezes[i], reasonCode: 'CORRECTED_CODING' }, who)
      if (res.status !== 201) throw new Error(`fixture: the A6.9 link was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    }
  }
  // §9 — Claim C of Org A: two independently approved freezes and NO A6.9 link, a genuine history contradiction the
  // A7.7 owner refuses. S1 carries a case and its EXTERNAL_FINANCIAL_EVIDENCE_ABSENT assessment; S2 a case, unassessed.
  const C = await home.series('worked', 2)
  await linkedSource(C.freezes[0], 'C1-E1')
  const CASE_C1 = await caseOf(C.freezes[0])
  const ASSESS_C1 = await assessmentOf(CASE_C1.caseId)
  await linkedSource(C.freezes[1], 'C2-E1')
  const CASE_C2 = await caseOf(C.freezes[1])
  // Claim N: a normal linked history with an EXTERNAL_FINANCIAL_EVIDENCE_ABSENT assessment — no exception exists.
  const N = await home.series('normal', 2)
  await chainOf(N.claimId, N.freezes)
  await linkedSource(N.freezes[0], 'N1-E1')
  const CASE_N = await caseOf(N.freezes[0])
  const ASSESS_N = await assessmentOf(CASE_N.caseId)
  // Further contradicted Claims, one per concern, so each check owns a fresh source: D (a second independent source),
  // X (concurrent duplicates), Y1 (failure injection), Y2 (lock order and retry), Z (the immutability batch) and V
  // (a revoked member's attempt).
  const D = await home.series('second', 2)
  const X = await home.series('race', 2)
  const Y1 = await home.series('inject', 2)
  const Y2 = await home.series('lock', 2)
  const Z = await home.series('batch', 2)
  const V = await home.series('revoked', 2)
  // Org B: its own contradicted Claim, with a case and an assessment.
  const F = await away.series('foreign', 2)
  await linkedSource(F.freezes[0], 'F1-E1', O.who)
  const CASE_F = await caseOf(F.freezes[0], O.who)
  const ASSESS_F = await assessmentOf(CASE_F.caseId, O.who)
  progress(`fixtures ready: two synthetic AE-DU/DHA worlds; ${[C, D, X, Y1, Y2, Z, V].length} contradicted Claims and one normal Claim in Org A, one contradicted Claim in Org B; cases ${CASE_C1.assemblyCode}/${CASE_C2.assemblyCode}, assessments ${ASSESS_C1.assessmentCode}/${ASSESS_N.assessmentCode}`)

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const hashOf = async (sql: string, ...params: unknown[]) =>
    (await prisma.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(row_to_json(x)::text, '|' ORDER BY x.id) FROM (${sql}) x), ''), 'UTF8')), 'hex') AS h`, ...params))[0].h
  const intakeRowsHash = (claimIds: string[]) => hashOf(`SELECT r.* FROM ${TABLE} r WHERE r.claim_id = ANY($1::uuid[])`, claimIds)
  const intakesOfClaim = (claimId: string) => prisma.exceptionIntakeRecord.findMany({ where: { claimId }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
  const auditsOfIntake = (intakeId: string) => prisma.auditEvent.findMany({ where: { entityType: 'EXCEPTION_INTAKE', entityId: intakeId } })
  const timelineBody = (claimId: string) => ({ sourceKind: 'REVENUE_TIMELINE', sourceRecordId: claimId, sourceContractVersion: TIMELINE_CONTRACT, exceptionReasonCode: 'PROVENANCE_CONFLICT' })
  const assessmentBody = (assessmentId: string, reason: string) => ({ sourceKind: 'CLOSURE_PREREQUISITE_ASSESSMENT', sourceRecordId: assessmentId, sourceContractVersion: PREREQ_CONTRACT, exceptionReasonCode: reason })
  const NOT_COMMITTED = 'ROLLED_BACK'
  // A rolled-back transaction: the mutation runs (guards ON unless it relaxes them itself), its outcome is captured,
  // then everything is undone. Every table must read back exactly.
  const rolledBack = async <T>(work: (tx: DbClient) => Promise<T>): Promise<{ value?: T; message: string; clean: boolean }> => {
    const before = await counts()
    const out: { value?: T } = {}
    const message = await attemptAdversarial(() =>
      prisma.$transaction(
        async (tx) => {
          out.value = await work(tx)
          throw new Error(NOT_COMMITTED)
        },
        { timeout: 60_000 },
      ),
    )
    return { ...out, message, clean: await unchanged(before) }
  }
  // One direct INSERT into the intake table, against the live guards, always rolled back; answers the refusal.
  const directInsert = async (o: Partial<Record<string, string | null>>) => {
    const row = {
      organization_id: org, claim_id: C.claimId, contract_version: CONTRACT, source_kind: 'REVENUE_TIMELINE', source_record_id: C.claimId, source_contract_version: TIMELINE_CONTRACT,
      source_fingerprint_sha256: null as string | null, exception_reason_code: 'PROVENANCE_CONFLICT', recorded_by_user_id: creatorId, identity_key: '' as string | null, ...o,
    }
    if (row.identity_key === '')
      row.identity_key = identityKeyOf({ organizationId: String(row.organization_id), claimId: String(row.claim_id), sourceKind: String(row.source_kind), sourceRecordId: String(row.source_record_id), sourceContractVersion: String(row.source_contract_version), exceptionReasonCode: String(row.exception_reason_code) })
    const attempt = await rolledBack((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO ${TABLE} (id, organization_id, claim_id, contract_version, source_kind, source_record_id, source_contract_version, source_fingerprint_sha256, exception_reason_code, identity_key, recorded_by_user_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9, $10::uuid)`,
        row.organization_id, row.claim_id, row.contract_version, row.source_kind, row.source_record_id, row.source_contract_version, row.source_fingerprint_sha256, row.exception_reason_code, row.identity_key, row.recorded_by_user_id,
      ),
    )
    return { refused: !attempt.message.includes(NOT_COMMITTED), message: attempt.message, clean: attempt.clean }
  }

  // ---------------------------------------------------------------- contracts and validation (T011–T020)
  section('Contracts and validation: the v1 literal and record, strict keys, client-owned fields, malformed ids, unknown kinds, contracts, reasons and context, injection')
  const countsAtStart = await counts()
  const auditsAtStart = await prisma.auditEvent.count()
  const E1res = await post(intakePath(C.claimId), timelineBody(C.claimId))
  const E1 = E1res.body
  const contractCheck = (await prisma.$queryRawUnsafe<{ d: string }[]>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = '${TABLE}_contract_chk'`))[0]?.d ?? ''
  check(
    'T011',
    'Literal v1 DTO and DB CHECK',
    E1res.status === 201 && E1.contractVersion === CONTRACT && same(Object.keys(E1), DTO_KEYS) && EXCEPTION_INTAKE_CONTRACT_VERSION === CONTRACT && contractCheck.includes(`'${CONTRACT}'`) && /IS NOT NULL/.test(contractCheck),
    `the first intake on Claim C carries ${CONTRACT} and exactly the ${DTO_KEYS.length} DTO keys; the database CHECK pins the literal`,
  )
  const extraKeys = await Promise.all(['contextCode', 'description', 'narrative', 'amount', 'payload', 'status', 'resolution'].map((k) => post(intakePath(C.claimId), { ...timelineBody(C.claimId), [k]: 'x' })))
  const missingKey = await post(intakePath(C.claimId), { sourceKind: 'REVENUE_TIMELINE', sourceRecordId: C.claimId, sourceContractVersion: TIMELINE_CONTRACT })
  check('T012', 'Strict request keys', [...extraKeys, missingKey].every((r) => r.status === 400 && errorCode(r.body) === 'VALIDATION_ERROR'), 'any extra field and any missing field is a 400; exactly sourceKind, sourceRecordId, sourceContractVersion and exceptionReasonCode are accepted')
  const clientOwned = await Promise.all(['id', 'exceptionIntakeId', 'identityKey', 'organizationId', 'claimId', 'recordedByUserId', 'recordedAt'].map((k) => post(intakePath(C.claimId), { ...timelineBody(C.claimId), [k]: k === 'recordedAt' ? '2020-01-01T00:00:00.000Z' : MISSING })))
  check('T013', 'Client actor/tenant/record id refused', clientOwned.every((r) => r.status === 400 && /unsupported field/.test(r.body?.error?.message ?? '')), 'an id, identity key, organization, Claim, actor or time in the body is refused (400): the server owns them')
  const malformedClaim = await Promise.all(['not-a-uuid', MISSING.replace(/-/g, ''), `${MISSING}0`, encodeURIComponent("1' OR '1'='1")].map((id) => post(intakePath(id), timelineBody(C.claimId))))
  check('T014', 'Malformed Claim UUID 400', malformedClaim.every((r) => r.status === 400 && !rawError(r.body)), `malformed and SQL-shaped Claim ids: ${malformedClaim.map((r) => r.status).join('/')}`)
  const malformedSource = await Promise.all(['not-a-uuid', '../../claims', "1' OR '1'='1", 42].map((v) => post(intakePath(C.claimId), { ...timelineBody(C.claimId), sourceRecordId: v })))
  check('T015', 'Malformed source UUID 400', malformedSource.every((r) => r.status === 400 && /invalid source record id/.test(r.body?.error?.message ?? '')), 'a malformed, traversal- or SQL-shaped or non-string source id is a 400')
  const unknownKind = await Promise.all(['PAYER_RESPONSE', 'revenue_timeline', '', 'CLAIM'].map((v) => post(intakePath(C.claimId), { ...timelineBody(C.claimId), sourceKind: v })))
  check('T016', 'Unknown source kind 400', unknownKind.every((r) => r.status === 400 && /unknown source kind/.test(r.body?.error?.message ?? '')), `only ${sourceKinds.join(' and ')} are accepted`)
  const badContract = await Promise.all([TIMELINE_CONTRACT.replace('-1', '-2'), PREREQ_CONTRACT, 'A7-REVENUE-TIMELINE'].map((v) => post(intakePath(C.claimId), { ...timelineBody(C.claimId), sourceContractVersion: v })))
  check('T017', 'Unsupported source contract 400', badContract.every((r) => r.status === 400 && /unsupported source contract/.test(r.body?.error?.message ?? '')), 'a future, another kind\'s or a truncated source contract is refused (version fence)')
  const badReason = await Promise.all(['PAYER_DENIED', 'PAID', 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'provenance_conflict'].map((v) => post(intakePath(C.claimId), { ...timelineBody(C.claimId), exceptionReasonCode: v })))
  check('T018', 'Unknown exception reason 400', badReason.every((r) => r.status === 400 && /unknown exception reason/.test(r.body?.error?.message ?? '')), `only the ${exceptionReasonCodes.length} controlled reasons are accepted; a payer verdict or the A7.5 absence code is not a reason`)
  const contextCodes = await Promise.all(['PAYER_FOLLOW_UP', 'URGENT', ''].map((v) => post(intakePath(C.claimId), { ...timelineBody(C.claimId), contextCode: v })))
  check('T019', 'Unknown context code 400', contextCodes.every((r) => r.status === 400 && /unsupported field\(s\): contextCode/.test(r.body?.error?.message ?? '')), 'v1 has no context vocabulary, so any contextCode is refused (400)')
  const injection = [
    await post(intakePath(C.claimId), { ...timelineBody(C.claimId), exceptionReasonCode: "PROVENANCE_CONFLICT'; DROP TABLE claims; --" }),
    await post(intakePath(C.claimId), { ...timelineBody(C.claimId), sourceKind: { $ne: null } }),
    await post(intakePath(C.claimId), JSON.parse('{"__proto__": {"exceptionReasonCode": "PROVENANCE_CONFLICT"}, "sourceKind": "REVENUE_TIMELINE"}')),
    await post(intakePath(C.claimId), { ...timelineBody(C.claimId), patientName: `${runId}-home-P`, dateOfBirth: '1990-01-01' }),
  ]
  check('T020', 'No PHI/body injection or raw SQL', injection.every((r) => r.status === 400 && !rawError(r.body)) && (await intakesOfClaim(C.claimId)).length === 1, 'SQL-, operator- and prototype-shaped values and PHI fields are refused with a safe body; only the one valid intake exists on C')

  // ---------------------------------------------------------------- authentication and tenant boundary (T021–T030)
  section('Authentication and tenant boundary: 401, Viewer 403, Admin and Viewer reads, foreign Claim and source = missing, other-Claim source, revoked membership')
  check('T021', 'Anonymous POST 401', (await post(intakePath(C.claimId), timelineBody(C.claimId), anonymous)).status === 401, 'no session: 401 before any lookup')
  check('T022', 'Anonymous GET 401', (await get(intakePath(C.claimId), anonymous)).status === 401, 'no session: 401')
  const viewerPost = await post(intakePath(D.claimId), timelineBody(D.claimId), asViewer)
  check('T023', 'Viewer POST 403', viewerPost.status === 403 && (await intakesOfClaim(D.claimId)).length === 0, 'a Viewer (exceptionIntake.read only) is refused 403 and nothing is recorded')
  check('T024', 'Admin authorized POST', E1res.status === 201 && E1.recordedByUserId === creatorId && E1.claimId === C.claimId && E1.organizationId === org, 'an Admin records the intake on Claim C (201), as itself, in its own organization')
  const adminList = await get(intakePath(C.claimId))
  check('T025', 'Admin authorized GET', adminList.status === 200 && same(adminList.body.items, [E1]), "an Admin reads Claim C's intakes: exactly E1")
  const viewerList = await get(intakePath(C.claimId), asViewer)
  check('T026', 'Viewer authorized GET', viewerList.status === 200 && same(viewerList.body, adminList.body), 'a Viewer reads exactly the same list')
  const foreignClaim = await post(intakePath(F.claimId), timelineBody(F.claimId))
  const missingClaim = await post(intakePath(MISSING), timelineBody(MISSING))
  check('T027', 'Foreign Claim 404 same as missing', foreignClaim.status === 404 && same({ ...foreignClaim.body?.error, requestId: null }, { ...missingClaim.body?.error, requestId: null }), "another organization's Claim gets exactly the missing-Claim envelope")
  const foreignSource = await post(intakePath(C.claimId), assessmentBody(ASSESS_F.assessmentId, 'OPERATOR_REVIEW_REQUIRED'))
  const missingSource = await post(intakePath(C.claimId), assessmentBody(MISSING, 'OPERATOR_REVIEW_REQUIRED'))
  check('T028', 'Foreign source 404 same as missing', foreignSource.status === 404 && same({ ...foreignSource.body?.error, requestId: null }, { ...missingSource.body?.error, requestId: null }), "another organization's assessment named on this Claim gets exactly the missing-source envelope")
  const otherClaimAssessment = await post(intakePath(C.claimId), assessmentBody(ASSESS_N.assessmentId, 'OPERATOR_REVIEW_REQUIRED'))
  const otherClaimTimeline = await post(intakePath(C.claimId), timelineBody(D.claimId))
  check('T029', 'Same-org other-Claim source refused', otherClaimAssessment.status === 404 && otherClaimTimeline.status === 404 && (await intakesOfClaim(C.claimId)).length === 1, "an assessment of another Claim, or another Claim's timeline, named on C is the same 404; nothing recorded")
  const rvBefore = await counts()
  await prisma.membershipRole.deleteMany({ where: { membershipId: RV.membershipId } })
  await prisma.organizationMembership.delete({ where: { id: RV.membershipId } })
  const revokedHttp = await post(intakePath(V.claimId), timelineBody(V.claimId), RV.who)
  const revokedService = await recordExceptionIntake(V.claimId, timelineBody(V.claimId), RV.id)
  check(
    'T030',
    'Revoked membership refused at action time',
    [403, 404].includes(revokedHttp.status) && revokedService.ok === false && revokedService.code === 'EXCEPTION_INTAKE_CONFLICT' && (await intakesOfClaim(V.claimId)).length === 0 && (await unchanged(rvBefore)),
    `a member removed after signing in is refused by the route (${revokedHttp.status}) and, called directly, by the database membership guard (${revokedService.ok ? 'recorded!' : revokedService.code}); nothing recorded`,
  )

  // ---------------------------------------------------------------- source provenance and reason truth (T031–T040)
  section('Source provenance and reason truth: exact owner records, Claim and organization links, contracts, owner proof, the A7.7/A7.6/A7.5 verdicts, absence is not an exception')
  const E1row = await prisma.exceptionIntakeRecord.findUniqueOrThrow({ where: { id: E1.exceptionIntakeId } })
  const timelineC = await getRevenueTimeline(C.claimId)
  check('T031', 'Exact owner record exists', E1row.sourceRecordId === C.claimId && (await prisma.claim.count({ where: { id: C.claimId } })) === 1 && !timelineC.ok && timelineC.code === 'REVENUE_TIMELINE_PROVENANCE_CONFLICT', "E1 names Claim C's revenue timeline, which exists and which the A7.7 owner itself refuses (409)")
  const owningOrg = (await prisma.claim.findUniqueOrThrow({ where: { id: C.claimId }, select: { encounter: { select: { patient: { select: { organizationId: true } } } } } })).encounter.patient.organizationId
  check('T032', 'Exact owner Claim and org link', E1row.claimId === C.claimId && E1row.organizationId === owningOrg && owningOrg === org, 'E1 belongs to exactly Claim C and the organization that owns it (Claim → Encounter → Patient)')
  check('T033', 'Source version matches', E1row.sourceContractVersion === TIMELINE_CONTRACT && constantAt('HEAD', 'backend/src/modules/revenue-timeline/revenue-timeline.types.ts', 'TIMELINE_CONTRACT_VERSION') === TIMELINE_CONTRACT, `E1 is recorded under the A7.7 owner's own contract ${TIMELINE_CONTRACT}`)
  const unproven = await post(intakePath(N.claimId), timelineBody(N.claimId))
  check('T034', 'Owner proof required', unproven.status === 409 && errorCode(unproven.body) === 'INTAKE_BASIS_NOT_ESTABLISHED' && (await intakesOfClaim(N.claimId)).length === 0, "on Claim N, whose history the A7.7 owner accepts, PROVENANCE_CONFLICT is refused 409 INTAKE_BASIS_NOT_ESTABLISHED: the caller's assertion alone proves nothing")
  const unprovenReview = await post(intakePath(C.claimId), assessmentBody(ASSESS_C1.assessmentId, 'OPERATOR_REVIEW_REQUIRED'))
  const unprovenHistory = await post(intakePath(C.claimId), assessmentBody(ASSESS_C1.assessmentId, 'HISTORICAL_RECORD_INCONSISTENT'))
  check('T035', 'Unproven reason refused', [unprovenReview, unprovenHistory].every((r) => r.status === 409 && errorCode(r.body) === 'INTAKE_BASIS_NOT_ESTABLISHED') && (await intakesOfClaim(C.claimId)).length === 1, "C's assessment is EXTERNAL_FINANCIAL_EVIDENCE_ABSENT with a consistent A7.6 trace: neither review nor inconsistency is established; nothing recorded")
  // A REVIEW_REQUIRED assessment of S2's case (no synthetic owner path produces one) — planted and rolled back; its
  // A7.6 trace re-derives EXTERNAL_FINANCIAL_EVIDENCE_ABSENT from the same case, so the owner also proves the
  // inconsistency. The production service records both intakes on THAT transaction.
  const plant = await rolledBack(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
    const [planted] = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO evidence_prereq_results (id, organization_id, evidence_case_id, contract_version, assessment_code, basis_code, case_manifest_sha256, recorded_by_user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'REVIEW_REQUIRED', 'EVIDENCE_REVIEW_REQUIRED', $4, $5::uuid) RETURNING id::text AS id`,
      org, CASE_C2.caseId, PREREQ_CONTRACT, CASE_C2.manifestSha256, creatorId,
    )
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin')
    const review = await recordExceptionIntakeOn(C.claimId, assessmentBody(planted.id, 'OPERATOR_REVIEW_REQUIRED'), creatorId, tx)
    const reviewAgain = await recordExceptionIntakeOn(C.claimId, assessmentBody(planted.id, 'OPERATOR_REVIEW_REQUIRED'), creatorId, tx)
    const history = await recordExceptionIntakeOn(C.claimId, assessmentBody(planted.id, 'HISTORICAL_RECORD_INCONSISTENT'), creatorId, tx)
    const notEstablished = await recordExceptionIntakeOn(C.claimId, assessmentBody(planted.id, 'CONTRACT_VERSION_UNSUPPORTED'), creatorId, tx)
    const list = await getExceptionIntakesOf(C.claimId, tx)
    const e1After = await tx.exceptionIntakeRecord.findUnique({ where: { id: E1.exceptionIntakeId } })
    const audits = await tx.auditEvent.count({ where: { entityType: 'EXCEPTION_INTAKE', entityId: { in: [review.ok ? review.value.intake.exceptionIntakeId : MISSING, history.ok ? history.value.intake.exceptionIntakeId : MISSING] } } })
    return { assessmentId: planted.id, review, reviewAgain, history, notEstablished, list, e1After, audits }
  })
  const pv = plant.value
  check(
    'T036',
    'Controlled owner conflict admitted',
    E1res.status === 201 && E1.exceptionReasonCode === 'PROVENANCE_CONFLICT' && pv?.history.ok === true && pv.history.value.intake.exceptionReasonCode === 'HISTORICAL_RECORD_INCONSISTENT' && plant.message.includes(NOT_COMMITTED) && plant.clean,
    "the A7.7 owner's real refusal of C's history admits PROVENANCE_CONFLICT (E1, 201); the A7.6 owner's refusal of a self-contradicting assessment (planted, rolled back) admits HISTORICAL_RECORD_INCONSISTENT",
  )
  const unavailable = await post(intakePath(C.claimId), { ...timelineBody(C.claimId), exceptionReasonCode: 'SOURCE_REFERENCE_UNAVAILABLE' })
  check('T037', 'Source reference missing truth check', unavailable.status === 409 && errorCode(unavailable.body) === 'INTAKE_BASIS_NOT_ESTABLISHED' && missingSource.status === 404, 'SOURCE_REFERENCE_UNAVAILABLE on an existing record is not established (409); a reference that truly does not exist is a 404, never an intake')
  const unsupported = [await post(intakePath(C.claimId), { ...timelineBody(C.claimId), exceptionReasonCode: 'CONTRACT_VERSION_UNSUPPORTED' }), await post(intakePath(C.claimId), assessmentBody(ASSESS_C1.assessmentId, 'CONTRACT_VERSION_UNSUPPORTED'))]
  check('T038', 'Unsupported contract truth check', unsupported.every((r) => r.status === 409 && errorCode(r.body) === 'INTAKE_BASIS_NOT_ESTABLISHED') && pv?.notEstablished.ok === false && pv.notEstablished.code === 'INTAKE_BASIS_NOT_ESTABLISHED', 'no accepted owner reports an unsupported contract distinctly, so CONTRACT_VERSION_UNSUPPORTED is never established (409), on either kind')
  check(
    'T039',
    'Operator review backed by accepted code',
    pv?.review.ok === true && pv.review.value.replayed === false && pv.review.value.intake.exceptionReasonCode === 'OPERATOR_REVIEW_REQUIRED' && pv.review.value.intake.sourceRecordId === pv.assessmentId,
    'a stored A7.5 REVIEW_REQUIRED assessment (planted, rolled back) admits OPERATOR_REVIEW_REQUIRED through the production service',
  )
  const absence = await Promise.all(exceptionReasonCodes.map((reason) => post(intakePath(N.claimId), assessmentBody(ASSESS_N.assessmentId, reason))))
  check('T040', 'Financial-evidence absence not auto-exception', absence.every((r) => r.status === 409 || r.status === 400) && (await intakesOfClaim(N.claimId)).length === 0 && ASSESS_N.assessmentCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', "Claim N's EXTERNAL_FINANCIAL_EVIDENCE_ABSENT assessment establishes no reason at all; N has no intake and none was created for it")

  // ---------------------------------------------------------------- immutable record and database constraints (T041–T050)
  section('Immutable record and database constraints: columns, server-owned id and time, RESTRICT keys, the guard, CHECKs, identity, append-only (direct SQL, always rolled back)')
  const columns = (await prisma.$queryRawUnsafe<{ c: string }[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${TABLE}' ORDER BY ordinal_position`)).map((r) => r.c)
  check('T041', 'Record v1 exact columns', same(columns, COLUMNS), `${TABLE} carries exactly its ${COLUMNS.length} columns`)
  const times = (await prisma.$queryRawUnsafe<{ ok: boolean; started: boolean }[]>(`SELECT recorded_at = created_at AS ok, recorded_at >= $2::timestamptz AS started FROM ${TABLE} WHERE id = $1::uuid`, E1.exceptionIntakeId, runStartedAt.toISOString()))[0]
  const backdated = await rolledBack((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO ${TABLE} (id, organization_id, claim_id, contract_version, source_kind, source_record_id, source_contract_version, source_fingerprint_sha256, exception_reason_code, identity_key, recorded_by_user_id, recorded_at, created_at)
       SELECT gen_random_uuid(), organization_id, claim_id, contract_version, source_kind, source_record_id, source_contract_version, source_fingerprint_sha256, exception_reason_code, identity_key, recorded_by_user_id, now() - interval '1 day', now() - interval '1 day' FROM ${TABLE} WHERE id = $1::uuid`,
      E1.exceptionIntakeId,
    ),
  )
  check(
    'T042',
    'Server-owned id and time',
    times?.ok === true && times.started && clientOwned.every((r) => r.status === 400) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(E1.exceptionIntakeId) && /exception_intake_time/.test(backdated.message) && backdated.clean,
    'the id is server-generated and recorded_at = created_at = the transaction time; a client id or time is refused (T013) and a backdated direct row is refused by the guard',
  )
  const fks = await prisma.$queryRawUnsafe<{ name: string; del: string }[]>(`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid = '${TABLE}'::regclass ORDER BY conname`)
  const deleteUser = await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id = $1::uuid`, creatorId))
  check('T043', 'RESTRICT foreign keys', fks.length === 3 && fks.every((fk) => fk.del === 'r') && !deleteUser.message.includes(NOT_COMMITTED) && deleteUser.clean, `${fks.map((f) => f.name).join(', ')}: all ON DELETE RESTRICT; deleting the recording user is refused`)
  const foreignOrgRow = await directInsert({ organization_id: otherOrg })
  check('T044', 'Same org/Claim DB guard', foreignOrgRow.refused && /exception_intake_coherence/.test(foreignOrgRow.message) && foreignOrgRow.clean, 'a direct row for Claim C under the other organization is refused by the insert guard')
  const badKind = await directInsert({ source_kind: 'PAYER_RESPONSE' })
  check('T045', 'Controlled source CHECK', badKind.refused && /source_kind_chk|23514/.test(badKind.message) && badKind.clean, 'a direct row with an uncontrolled source kind is refused by the CHECK')
  const badReasonRow = await directInsert({ exception_reason_code: 'PAYER_DENIED' })
  const badPairRow = await directInsert({ exception_reason_code: 'OPERATOR_REVIEW_REQUIRED' })
  check('T046', 'Controlled reason CHECK', badReasonRow.refused && /reason_chk|23514/.test(badReasonRow.message) && badPairRow.refused && /pairing_chk|23514/.test(badPairRow.message), 'an uncontrolled reason, and a controlled reason no owner establishes for that kind, are refused by the CHECKs')
  const digestOnTimeline = await directInsert({ source_fingerprint_sha256: 'a'.repeat(64) })
  const nullOnAssessment = await directInsert({ source_kind: 'CLOSURE_PREREQUISITE_ASSESSMENT', source_record_id: ASSESS_C1.assessmentId, source_contract_version: PREREQ_CONTRACT, exception_reason_code: 'OPERATOR_REVIEW_REQUIRED', source_fingerprint_sha256: null })
  check('T047', 'Fingerprint null or valid', digestOnTimeline.refused && nullOnAssessment.refused && E1.sourceFingerprintSha256 === null && pv?.review.ok === true && pv.review.value.intake.sourceFingerprintSha256 === CASE_C2.manifestSha256, "a timeline carries no digest (one is refused), an assessment carries its case's stored digest (none is refused)")
  const duplicate = await directInsert({})
  const wrongIdentity = await directInsert({ identity_key: 'f'.repeat(64) })
  check('T048', 'Identity key uniqueness', duplicate.refused && /exception_intake_records_identity_key|operational_intake_records_identity_key|23505|unique/i.test(duplicate.message) && wrongIdentity.refused && /exception_intake_identity/.test(wrongIdentity.message), "a second row with E1's identity is refused by the UNIQUE index; a row whose key is not the digest of its own preimage is refused by the guard")
  const noopUpdate = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE ${TABLE} SET identity_key = identity_key WHERE id = $1::uuid`, E1.exceptionIntakeId))
  check('T049', 'UPDATE even no-op refused', !noopUpdate.message.includes(NOT_COMMITTED) && /append-only/.test(noopUpdate.message) && noopUpdate.clean, 'even a no-op UPDATE of E1 is refused (append-only)')
  const deletion = await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE id = $1::uuid`, E1.exceptionIntakeId))
  const truncation = await rolledBack((tx) => tx.$executeRawUnsafe(`TRUNCATE ${TABLE}`))
  check('T050', 'DELETE refused', /append-only/.test(deletion.message) && /append-only/.test(truncation.message) && deletion.clean && truncation.clean, 'DELETE and TRUNCATE of intakes are refused')

  // ---------------------------------------------------------------- dedupe and historical semantics (T051–T060)
  section('Dedupe and history: 201 then identical 200, no second audit, another reason never overwrites, independent sources, stable order, no status, readable after the source changes')
  check('T051', 'New request creates 201', E1res.status === 201 && (await auditsOfIntake(E1.exceptionIntakeId)).length === 1, 'the first request records E1 (201) with exactly one audit')
  const auditsBeforeReplay = await prisma.auditEvent.count()
  const replayE1 = await post(intakePath(C.claimId), timelineBody(C.claimId))
  check('T052', 'Same request identical 200', replayE1.status === 200 && JSON.stringify(replayE1.body) === JSON.stringify(E1), 'the identical request returns 200 with the byte-identical stored DTO')
  check('T053', 'No second audit on replay', (await prisma.auditEvent.count()) === auditsBeforeReplay && (await auditsOfIntake(E1.exceptionIntakeId)).length === 1 && (await intakesOfClaim(C.claimId)).length === 1, 'the replay wrote no audit and no row')
  const e1Bytes = await intakeRowsHash([C.claimId])
  check(
    'T054',
    'Changed reason not overwritten',
    unavailable.status === 409 && (await intakeRowsHash([C.claimId])) === e1Bytes && pv?.history.ok === true && pv.review.ok === true && pv.history.value.intake.identityKey !== pv.review.value.intake.identityKey && same(pv.e1After, E1row),
    "a different reason on C's timeline is refused and E1 is byte-identical; two different established reasons on one source are two separate intakes (planted), E1 untouched",
  )
  const E2res = await post(intakePath(D.claimId), timelineBody(D.claimId))
  check('T055', 'Independent second valid source', E2res.status === 201 && E2res.body.identityKey !== E1.identityKey && (await intakeRowsHash([C.claimId])) === e1Bytes, "Claim D's own contradicted timeline records a separate intake (201) with its own identity; C's is unchanged")
  const plantedList = pv?.list.ok ? pv.list.value.items : []
  const ordered = [...plantedList].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.exceptionIntakeId < b.exceptionIntakeId ? -1 : 1))
  check('T056', 'History in recorded stable order', plantedList.length === 3 && plantedList[0].exceptionIntakeId === E1.exceptionIntakeId && same(plantedList.map((i) => i.exceptionIntakeId), ordered.map((i) => i.exceptionIntakeId)) && /orderBy: \[\{ recordedAt: 'asc' \}, \{ id: 'asc' \}\]/.test(committedCode(`${MODULE_DIR}/exception-intake.repository.ts`)), "C's intakes list in database-recorded order, then id (documented ordering, not evidence causality)")
  check('T057', 'Historical byte identity on new record', (await intakeRowsHash([C.claimId])) === e1Bytes && same(pv?.e1After, E1row), 'recording D, and two planted intakes on C, left every byte of E1 unchanged')
  const dtoKeys = [...deepKeys([E1, E2res.body, adminList.body])]
  check('T058', 'No current status field', !dtoKeys.some((k) => /status|state|open|closed|current|latest|active/i.test(k)) && !COLUMNS.some((c) => /status|state|open|closed|current/.test(c)), 'no status, state, open/closed, current or latest field or column')
  check('T059', 'No closure/assignment implied', !dtoKeys.some((k) => /assign|owner|severity|priority|sla|resolution|resolved|closure|close/i.test(k)) && !COLUMNS.some((c) => /assign|severity|priority|sla|resolution/.test(c)), 'no assignment, owner, severity, priority, SLA, resolution or closure field or column')
  const linkCS = await recordCorrectionLink(C.claimId, { priorSubmissionId: C.freezes[0], correctedSubmissionId: C.freezes[1], reasonCode: 'CORRECTED_CODING' }, creatorId)
  const timelineFixed = await getRevenueTimeline(C.claimId)
  const afterFix = await get(intakePath(C.claimId))
  const replayAfterFix = await post(intakePath(C.claimId), timelineBody(C.claimId))
  check(
    'T060',
    'Past intake readable after source changes',
    linkCS.ok && timelineFixed.ok && afterFix.status === 200 && same(afterFix.body.items, [E1]) && replayAfterFix.status === 200 && same(replayAfterFix.body, E1),
    "after S1→S2 is linked through A6.9, C's history is accepted again; E1 still reads back byte-identically and its exact repeat still answers E1 (a historical fact), never rewritten",
  )

  // ---------------------------------------------------------------- transactions and failure injection (T061–T070)
  section('Transactions and failure injection: Claim lock first, SERIALIZABLE, owner reads on one client, atomic intake+audit, injected failures, retries, concurrent duplicates, unknown outcomes')
  const serviceCode = committedCode(`${MODULE_DIR}/exception-intake.service.ts`)
  const onTx = serviceCode.slice(serviceCode.indexOf('async function recordOnTransaction'), serviceCode.indexOf('export async function recordExceptionIntake('))
  const firstStatement = onTx.split('\n').slice(1).find((line) => line.trim().length > 0) ?? ''
  const holdLock = holdAt('exceptionIntake.claim_locked')
  const firstY2 = recordExceptionIntake(Y2.claimId, timelineBody(Y2.claimId), creatorId)
  await Promise.race([holdLock.arrived, firstY2])
  const secondY2 = recordExceptionIntake(Y2.claimId, timelineBody(Y2.claimId), creatorId)
  const secondWaited = !(await settledWithin(secondY2, 1500))
  holdLock.release()
  const [y2a, y2b] = await Promise.all([firstY2, secondY2])
  clearConcurrencyProbes()
  check('T061', 'Claim lock first', /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(firstStatement) && secondWaited && y2a.ok && y2b.ok, 'the Claim row lock is the first statement; while one intake holds it, a second request on the same Claim waits')
  check('T062', 'SERIALIZABLE on one tx', /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && (serviceCode.match(/prisma\.\$transaction\(\(tx\) => recordOnTransaction/g) ?? []).length === 1, 'the source resolution, owner verdict, identity read, insert and audit run in one SERIALIZABLE transaction')
  const resolveCode = serviceCode.slice(serviceCode.indexOf('async function resolveSource'), serviceCode.indexOf('async function recordOnTransaction'))
  check(
    'T063',
    'Owner reads same DbClient',
    ['getRevenueTimelineOf(claimId, tx)', 'findAssessmentById(request.sourceRecordId, tx)', 'findCaseForPrerequisite(assessment.evidenceCaseId, tx)', 'getClosureBasisTraceOf(assessment.id, tx)'].every((call) => resolveCode.includes(call)) && /findClaimForFreeze\(claimId, tx\)/.test(onTx) && !/prisma\./.test(resolveCode + onTx),
    'the A6.7, A7.5, A7.6 and A7.7 owners are read on the one caller transaction; nothing uses a second connection',
  )
  check('T067', 'Retries re-read on new transaction', y2a.ok && y2b.ok && y2a.value.replayed === false && y2b.value.replayed === true && same(y2a.value.intake, y2b.value.intake), 'the waiting request retried on a fresh transaction, re-read and answered the committed intake as its replay — never a second row')
  const injectThrow = (probe: string, message: string) => {
    clearConcurrencyProbes()
    setConcurrencyProbe(probe, async () => {
      throw new Error(message)
    })
  }
  injectThrow('exceptionIntake.inserted', 'injected failure after the intake insert')
  const failInsert = await attemptAdversarial(() => recordExceptionIntake(Y1.claimId, timelineBody(Y1.claimId), creatorId))
  const afterInsertFail = { rows: (await intakesOfClaim(Y1.claimId)).length, audits: await prisma.auditEvent.count({ where: { entityType: 'EXCEPTION_INTAKE', afterState: { path: ['claimId'], equals: Y1.claimId } } }) }
  check('T065', 'Fail after insert rolls back', /injected failure after the intake insert/.test(failInsert) && afterInsertFail.rows === 0 && afterInsertFail.audits === 0, 'a failure right after the insert rolled back the whole transaction: no intake, no audit')
  injectThrow('exceptionIntake.audited', 'injected failure after the audit')
  const failAudit = await attemptAdversarial(() => recordExceptionIntake(Y1.claimId, timelineBody(Y1.claimId), creatorId))
  const afterAuditFail = { rows: (await intakesOfClaim(Y1.claimId)).length, audits: await prisma.auditEvent.count({ where: { entityType: 'EXCEPTION_INTAKE', afterState: { path: ['claimId'], equals: Y1.claimId } } }) }
  check('T066', 'Fail after audit rolls back', /injected failure after the audit/.test(failAudit) && afterAuditFail.rows === 0 && afterAuditFail.audits === 0, 'a failure after the audit rolled back both: no intake, no audit')
  injectThrow('exceptionIntake.audited', 'Connection terminated unexpectedly')
  const ambiguous = await recordExceptionIntake(Y1.claimId, timelineBody(Y1.claimId), creatorId)
  clearConcurrencyProbes()
  check('T069', 'Ambiguous commit never blind retry', ambiguous.ok === false && ambiguous.code === 'EXCEPTION_INTAKE_CONFLICT' && /could not be established/.test(ambiguous.message) && (await intakesOfClaim(Y1.claimId)).length === 0, 'an unknown commit outcome was answered by re-reading the exact identity (absent) — a safe 409, never a second attempt (which would have committed)')
  const holdInsert = holdAt('exceptionIntake.inserted')
  const committing = recordExceptionIntake(Y1.claimId, timelineBody(Y1.claimId), creatorId)
  await Promise.race([holdInsert.arrived, committing])
  const during = { rows: (await intakesOfClaim(Y1.claimId)).length, audits: await prisma.auditEvent.count({ where: { entityType: 'EXCEPTION_INTAKE', afterState: { path: ['claimId'], equals: Y1.claimId } } }) }
  holdInsert.release()
  const committed = await committing
  clearConcurrencyProbes()
  const after = { rows: (await intakesOfClaim(Y1.claimId)).length, audits: committed.ok ? (await auditsOfIntake(committed.value.intake.exceptionIntakeId)).length : -1 }
  check('T064', 'Intake and audit atomic', during.rows === 0 && during.audits === 0 && committed.ok && after.rows === 1 && after.audits === 1, 'while the inserted intake was uncommitted no other connection saw it or its audit; after commit, exactly one of each')
  const raceResults = await Promise.all(Array.from({ length: 5 }, () => post(intakePath(X.claimId), timelineBody(X.claimId))))
  const raceRows = await intakesOfClaim(X.claimId)
  check('T068', 'Concurrent duplicate one row', raceResults.filter((r) => r.status === 201).length === 1 && raceResults.filter((r) => r.status === 200).length === 4 && raceRows.length === 1 && raceResults.every((r) => r.body?.exceptionIntakeId === raceRows[0].id) && (await auditsOfIntake(raceRows[0].id)).length === 1, 'five identical requests at once: one 201, four 200, one row, one audit')
  const runIntakes = await prisma.exceptionIntakeRecord.findMany({ where: { recordedAt: { gte: runStartedAt } }, select: { id: true } })
  const runAudits = await prisma.auditEvent.findMany({ where: { actionCode: 'exception_intake.recorded', occurredAt: { gte: runStartedAt } }, select: { entityId: true } })
  check('T070', 'No orphan audit or partial record', runIntakes.length > 0 && runIntakes.every((r) => runAudits.filter((a) => a.entityId === r.id).length === 1) && runAudits.every((a) => runIntakes.some((r) => r.id === a.entityId)), `${runIntakes.length} intakes and ${runAudits.length} audits this run pair one to one: no orphan audit and no intake without its audit`)

  // ---------------------------------------------------------------- tenant and privacy adversaries (T071–T080)
  section('Tenant and privacy adversaries: foreign actor, wrong-Claim source, unknown ids, malformed digest, unknown contract, roles, no PHI, no bytes or money, safe refusals, no cross-org disclosure')
  const foreignActor = await directInsert({ recorded_by_user_id: O.id })
  check('T071', 'Direct foreign org ID rejected', foreignActor.refused && /exception_intake_member/.test(foreignActor.message) && foreignOrgRow.refused && clientOwned.find((r) => r.status === 400) !== undefined, "a direct row recorded by the other organization's member, or carrying its organization, is refused; the API never takes an organization from the client")
  const wrongClaimRow = await directInsert({ source_kind: 'CLOSURE_PREREQUISITE_ASSESSMENT', source_record_id: ASSESS_N.assessmentId, source_contract_version: PREREQ_CONTRACT, exception_reason_code: 'OPERATOR_REVIEW_REQUIRED', source_fingerprint_sha256: ASSESS_N.caseManifestSha256 })
  check('T072', 'Direct wrong-Claim source rejected', wrongClaimRow.refused && /exception_intake_source/.test(wrongClaimRow.message) && otherClaimAssessment.status === 404, "a direct row naming Claim N's assessment on Claim C is refused by the guard (the API answers 404, T029)")
  const unknownIds = [await post(intakePath(C.claimId), assessmentBody(randomUUID(), 'OPERATOR_REVIEW_REQUIRED')), await post(intakePath(C.claimId), { ...timelineBody(C.claimId), sourceRecordId: randomUUID() })]
  check('T073', 'Unknown source ID refused', unknownIds.every((r) => r.status === 404 && errorCode(r.body) === 'NOT_FOUND'), 'an unknown assessment id and a timeline id that is not this Claim are the same 404')
  const malformedDigest = await directInsert({ source_kind: 'CLOSURE_PREREQUISITE_ASSESSMENT', source_record_id: ASSESS_C1.assessmentId, source_contract_version: PREREQ_CONTRACT, exception_reason_code: 'OPERATOR_REVIEW_REQUIRED', source_fingerprint_sha256: 'ABC' })
  check('T074', 'Malformed digest refused', malformedDigest.refused && malformedDigest.clean, 'a direct row with a malformed digest is refused (the API never accepts a digest from the client)')
  const futureContract = await directInsert({ contract_version: 'A8-EXCEPTION-INTAKE-2' })
  check('T075', 'Unknown contract literal refused', futureContract.refused && /contract_chk|23514/.test(futureContract.message) && badContract.every((r) => r.status === 400), 'a future intake contract is refused by the CHECK, and an unknown source contract by the API (T017)')
  const noRole = [await post(intakePath(D.claimId), timelineBody(D.claimId), NR.who), await get(intakePath(D.claimId), NR.who)]
  check('T076', 'Unauthorized role refused', noRole.every((r) => r.status === 403) && viewerPost.status === 403, 'a member without any grant is refused 403 on POST and GET; a Viewer is refused 403 on POST')
  const storedRows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM ${TABLE} WHERE claim_id = ANY($1::uuid[])`, [C.claimId, D.claimId, X.claimId, Y1.claimId, Y2.claimId])
  const storedText = JSON.stringify(storedRows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  check('T077', 'No PHI field persisted', !COLUMNS.some((c) => /patient|member|name|birth|email|phone|address|gender|diagnos|clinician/.test(c)) && !storedText.includes(`${runId}-home-P`) && !storedText.includes('1990-01-01'), 'no patient, member or clinical column, and no such value in any stored intake')
  check('T078', 'No source bytes or money persisted', !COLUMNS.some((c) => /amount|currency|price|balance|payload|bytes|reference|narrative|description/.test(c)) && !/AED|200\.01|125\.25/.test(storedText) && !storedText.includes(ref('C1-E1')), 'no amount, currency, payload, source reference or narrative column or value')
  const envelopes = [malformedClaim[0], badReason[0], (await post(intakePath(C.claimId), timelineBody(C.claimId), anonymous)), viewerPost, foreignClaim, unproven]
  check('T079', 'Refusal has safe envelope', envelopes.every((r) => same(Object.keys(r.body?.error ?? {}).sort(), ['code', 'message', 'requestId']) && !rawError(r.body)), `400, 401, 403, 404 and 409 refusals all carry only code, message and requestId (${envelopes.map((r) => r.status).join('/')}); no SQL, stack, table or guard name`)
  const Fres = await post(intakePath(F.claimId), timelineBody(F.claimId), O.who)
  const homeOnF = await get(intakePath(F.claimId))
  const foreignOnC = await get(intakePath(C.claimId), O.who)
  const ownC = await get(intakePath(C.claimId))
  check('T080', 'No cross-org disclosure on GET', Fres.status === 201 && homeOnF.status === 404 && foreignOnC.status === 404 && !JSON.stringify(ownC.body).includes(Fres.body.exceptionIntakeId) && (await get(intakePath(F.claimId), O2.who)).body?.items?.length === 1, "each organization reads only its own Claim's intakes; the other's Claim is 404 and never listed")

  // ---------------------------------------------------------------- determinism and integrity (T081–T090)
  section('Determinism and integrity: identity determinism and canonical preimage, read-only GET, audits per insert, database time and actor, restart, locale, independent keys, audit organization')
  const e1Parts = { organizationId: org, claimId: C.claimId, sourceKind: 'REVENUE_TIMELINE', sourceRecordId: C.claimId, sourceContractVersion: TIMELINE_CONTRACT, exceptionReasonCode: 'PROVENANCE_CONFLICT' }
  check('T081', 'Stable identity key determinism', new Set(Array.from({ length: 100 }, () => identityKeyOf(e1Parts))).size === 1 && identityKeyOf(e1Parts) === E1.identityKey && sha256Of(Buffer.from(identityPreimage(e1Parts), 'utf8')) === E1.identityKey, "one hundred derivations of E1's identity are identical and equal the stored key and the SHA-256 of its canonical preimage")
  const shifted = await directInsert({ identity_key: identityKeyOf({ ...e1Parts, exceptionReasonCode: 'HISTORICAL_RECORD_INCONSISTENT' }) })
  const ambiguousParts = [() => identityPreimage({ ...e1Parts, sourceKind: 'REVENUE_TIMELINE\nreason=X' }), () => identityPreimage({ ...e1Parts, claimId: C.claimId.toUpperCase() })]
  check('T082', 'Collision-safe identical preimage', shifted.refused && /exception_intake_identity/.test(shifted.message) && ambiguousParts.every((f) => attemptSync(f)), "a row carrying the digest of another reason's preimage is refused by the database (it recomputes the preimage); a part with a line break, '=' or another case is refused, so two inputs never share a preimage")
  const countsBeforeGet = await counts()
  const auditsBeforeGet = await prisma.auditEvent.count()
  for (const who of [asAdmin, asViewer, B.who]) await get(intakePath(C.claimId), who)
  check('T083', 'Read only on GET', (await unchanged(countsBeforeGet)) && /withReadSnapshot\(undefined, \(tx\) => getExceptionIntakesOf\(claimId, tx\)\)/.test(serviceCode), 'reads by three users changed no row; the list reads one READ ONLY snapshot')
  check('T084', 'No audit on GET', (await prisma.auditEvent.count()) === auditsBeforeGet, 'no read wrote an audit')
  const runRows = await prisma.exceptionIntakeRecord.findMany({ where: { recordedAt: { gte: runStartedAt }, organizationId: org } })
  const auditPairs = await Promise.all(runRows.map(async (r) => (await auditsOfIntake(r.id)).length))
  check('T085', 'One audit per committed INSERT', runRows.length >= 5 && auditPairs.every((n) => n === 1), `each of the ${runRows.length} intakes this run committed in this organization has exactly one audit`)
  const dbNow = (await prisma.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`)[0].t
  const e1Audit = (await auditsOfIntake(E1.exceptionIntakeId))[0]
  check('T086', 'Database time and actor', E1row.recordedAt >= runStartedAt && E1row.recordedAt <= dbNow && E1row.recordedByUserId === creatorId && e1Audit?.actorUserId === creatorId, 'E1 was recorded at database time within this run, by the authenticated Admin, and its audit names the same actor')
  const rowsBeforeRestart = await intakeRowsHash([C.claimId, D.claimId, X.claimId, Y1.claimId, Y2.claimId])
  const restartedOnce = spawnSync('docker', ['restart', dbContainer], { encoding: 'utf8' }).status === 0
  await waitFor(databaseUp, 90_000)
  await apiReady('reading after the database restart')
  check('T087', 'Restart identical stored rows', restartedOnce && (await intakeRowsHash([C.claimId, D.claimId, X.claimId, Y1.claimId, Y2.claimId])) === rowsBeforeRestart && same((await get(intakePath(C.claimId))).body.items, [E1]), 'after the database container restarts every stored intake reads back byte-identically')
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { identityKeyOf } from './src/modules/exception-intake/exception-intake.identity.ts'; console.log(JSON.stringify([identityKeyOf(${JSON.stringify(e1Parts)}), 'i'.toUpperCase(), Intl.DateTimeFormat().resolvedOptions().locale]))`],
    { encoding: 'utf8', cwd: process.cwd(), env: childEnv({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }) },
  )
  const probed = (() => {
    try {
      return JSON.parse((probe.stdout ?? '').trim().split(/\r?\n/).pop() ?? '')
    } catch {
      return null
    }
  })()
  const moduleCode = committedProductionCodeOf([MODULE_DIR]).code
  check('T088', 'Locale-independent canonicalization', probed !== null && probed[0] === E1.identityKey && !/toLocale|localeCompare|Intl\.|toUpperCase|\.sort\(/.test(moduleCode), `a ${probed?.[2] ?? '?'} process in Pacific/Kiritimati derives the identical key; the module never changes case, sorts or compares by locale`)
  check('T089', 'Different source keys independent', new Set([E1.identityKey, E2res.body.identityKey, raceRows[0].identityKey]).size === 3 && (await intakeRowsHash([C.claimId])) === e1Bytes, "C, D and X carry three distinct identities; recording D and X left C's intake byte-identical")
  const auditOrgs = await prisma.auditEvent.findMany({ where: { entityType: 'EXCEPTION_INTAKE', entityId: { in: [E1.exceptionIntakeId, E2res.body.exceptionIntakeId, Fres.body.exceptionIntakeId] } }, select: { entityId: true, organizationId: true } })
  check('T090', 'Audit org matches owning Claim', auditOrgs.length === 3 && auditOrgs.every((a) => (a.entityId === Fres.body.exceptionIntakeId ? a.organizationId === otherOrg : a.organizationId === org)), "every intake audit carries exactly the organization that owns the intake's Claim")

  // ---------------------------------------------------------------- no duplication and later ownership (T091–T100)
  section('No duplication and later ownership: a batch of intakes, replays, refusals and reads leaves every A6/A7 record and A7.6–A7.9 read byte-identical')
  const runClaims = [C, N, D, X, Y1, Y2, Z, V].map((c) => c.claimId)
  const snap = async () => ({
    freezes: await hashOf(`SELECT f.*, m.id AS manifest FROM claim_freezes f LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    lifecycle: await hashOf(`SELECT e.* FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    links: await hashOf(`SELECT l.* FROM claim_correction_links l WHERE l.claim_id = ANY($1::uuid[])`, runClaims),
    sources: await hashOf(`SELECT r.* FROM revenue_source_evidence r JOIN claim_freezes f ON f.id = r.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    classifications: await hashOf(`SELECT c.* FROM source_evidence_classifications c JOIN revenue_source_evidence r ON r.id = c.source_evidence_id JOIN claim_freezes f ON f.id = r.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    readiness: await hashOf(`SELECT g.* FROM evidence_gate_results g JOIN revenue_source_evidence r ON r.id = g.source_evidence_id JOIN claim_freezes f ON f.id = r.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
    cases: await hashOf(`SELECT x.id, x.j FROM (SELECT h.id, row_to_json(h)::text AS j FROM evidence_case_snapshots h JOIN claim_freezes f ON f.id = h.claim_submission_id WHERE f.claim_id = ANY($1::uuid[]) UNION ALL SELECT e.id, row_to_json(e)::text FROM evidence_case_entries e JOIN evidence_case_snapshots h ON h.id = e.assembly_id JOIN claim_freezes f ON f.id = h.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])) x`, runClaims),
    assessments: await hashOf(`SELECT a.* FROM evidence_prereq_results a JOIN evidence_case_snapshots h ON h.id = a.evidence_case_id JOIN claim_freezes f ON f.id = h.claim_submission_id WHERE f.claim_id = ANY($1::uuid[])`, runClaims),
  })
  const reads = async () => ({
    trace: (await get(`/api/closure-prerequisite-assessments/${ASSESS_N.assessmentId}/basis-trace`)).body,
    timeline: (await get(`/api/claims/${N.claimId}/revenue-evidence-timeline`)).body,
    delta: (await get(`/api/claims/${N.claimId}/revenue-evidence-delta`)).body,
    continuity: (await get(`/api/claims/${N.claimId}/revenue-evidence-continuity`)).body,
  })
  const stableReads = (r: Awaited<ReturnType<typeof reads>>) => JSON.stringify(r, (k, v) => (k === 'evaluatedAt' ? undefined : v))
  const before91 = await snap()
  const readsBefore = await reads()
  const batch = [
    await post(intakePath(Z.claimId), timelineBody(Z.claimId)), await post(intakePath(Z.claimId), timelineBody(Z.claimId)), await post(intakePath(Z.claimId), { ...timelineBody(Z.claimId), exceptionReasonCode: 'SOURCE_REFERENCE_UNAVAILABLE' }),
    await post(intakePath(Z.claimId), assessmentBody(ASSESS_N.assessmentId, 'OPERATOR_REVIEW_REQUIRED')), await post(intakePath(N.claimId), assessmentBody(ASSESS_N.assessmentId, 'HISTORICAL_RECORD_INCONSISTENT')), await get(intakePath(Z.claimId)),
  ]
  const after91 = await snap()
  const readsAfter = await reads()
  progress(`batch on Claim Z and N: ${batch.map((r) => r.status).join('/')}`)
  check('T091', 'A6.7 freeze immutable', batch[0].status === 201 && batch[1].status === 200 && after91.freezes === before91.freezes, 'after a batch of intakes, replays, refusals and reads every freeze and sealed manifest of eight Claims is byte-identical')
  check('T092', 'A6.8 lifecycle immutable', after91.lifecycle === before91.lifecycle, 'every lifecycle event is byte-identical')
  check('T093', 'A6.9 correction history immutable', after91.links === before91.links, 'every correction link is byte-identical')
  check('T094', 'A7.1 source facts unchanged', after91.sources === before91.sources, 'every A7.1 source is byte-identical')
  check('T095', 'A7.2 classification unchanged', after91.classifications === before91.classifications, 'every A7.2 classification and fingerprint is byte-identical')
  check('T096', 'A7.3 readiness unchanged', after91.readiness === before91.readiness, 'every A7.3 readiness result is byte-identical')
  check('T097', 'A7.4–A7.5 snapshots unchanged', after91.cases === before91.cases && after91.assessments === before91.assessments, 'every A7.4 case header and entry and every A7.5 assessment is byte-identical')
  check('T098', 'A7.6–A7.9 read outputs unchanged', stableReads(readsAfter) === stableReads(readsBefore) && readsBefore.trace?.assessmentId === ASSESS_N.assessmentId && readsBefore.continuity?.continuityCode !== undefined, "Claim N's A7.6 trace, A7.7 timeline, A7.8 delta and A7.9 continuity read back identically (all but evaluatedAt)")
  check('T099', 'A7.10 closure record untouched', gitArgs(['diff', 'origin/main...HEAD', '--', ':/docs/A7_Phase_Closure.md']) === '' && committedText('docs/A7_Phase_Closure.md') === gitArgs(['show', 'origin/main:docs/A7_Phase_Closure.md']), 'docs/A7_Phase_Closure.md is byte-identical to main')
  // Tables that existed on main belong to earlier phases (A4 has clinician assignments, for example); only what this
  // branch adds is judged, and the A8.1 migration must create exactly its one table.
  const mainTables = new Set(migrationDirsAt('origin/main').flatMap((dir) => [...gitArgs(['show', `origin/main:${dir}/migration.sql`]).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])))
  const a81Tables = [...committedText(MIGRATION).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])
  const newTablesLike = async (pattern: string) => (await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`, pattern)).map((r) => r.t).filter((t) => !mainTables.has(t))
  const laterTables = await newTablesLike('(assign|work_queue|sla|severity|resolution|export|outbox|transmission|acknowledg|remittance|payment|ledger|receivable|settle|reconcil)')
  const laterRoutes = [await post(`${intakePath(C.claimId)}/${E1.exceptionIntakeId}/assign`, {}), await post(`${intakePath(C.claimId)}/${E1.exceptionIntakeId}/close`, {}), await post(`/api/claims/${C.claimId}/exception-exports`, {}), await post(`/api/claims/${C.claimId}/payments`, {})]
  const moneyOrTransport = /\bDecimal\b|[Aa]mount|\b[Cc]urrency|[a-z]Currency|[Bb]alance|[Ll]edger|[Pp]ayment|[Rr]emittance|from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|enqueue|setInterval|worker_threads|cron|[Aa]ssign|[Ss]everity|[Pp]riority|\bsla\b/
  check('T100', 'No A8 workflow/A9 transport/A7 finance engine', same(a81Tables, [TABLE]) && mainTables.size > 50 && laterTables.length === 0 && laterRoutes.every((r) => r.status === 404) && !moneyOrTransport.test(moduleCode), `the A8.1 migration creates exactly ${TABLE}; no new assignment, queue, SLA, resolution, export, transport or finance table or route; the A8.1 code holds no money, network, queue, job or workflow logic`)

  const goldenBefore = { list: (await get(intakePath(C.claimId))).body, audit: JSON.stringify((await auditsOfIntake(E1.exceptionIntakeId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))) }

  // ---------------------------------------------------------------- nested cumulative acceptance (T101–T110)
  section('Nested cumulative acceptance — A7.10 invoked, nesting A7.9 -> A7.8 -> … -> A7.1 -> A6.10 -> … -> A1')
  await apiReady('the A7.10 and backward regression chain')
  // Rows written from here on belong to the nested suites' own fixtures (each proves its own); T128 judges this run's.
  const chainStartedAt = (await prisma.$queryRaw<{ ts: Date }[]>`SELECT clock_timestamp() AS ts`)[0].ts
  const chain = run('npm run test:a7:phase-closure')
  const nestedLog = `a81-nested-${runId}.log`
  writeFileSync(nestedLog, chain.output)
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A7.10')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A7.10] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A7.10 asserts facts about its own branch (name, tracking, pushed HEAD, allowed paths, run identity) and re-proves
  // A7.9's branch-only causes against its own branch. On A8.1 those statements are obsolete by design; every other
  // A7.10 check is substantive. T110 below proves each cause independently.
  const a710NonApplicable: Record<string, string> = {
    T001: "A7.10 'A7.9 exact merge ancestor confirmed' requires the A7.10 feature branch; A8.1 is branched from the main that contains the A7.10 merge",
    T002: "A7.10 'Clean synchronized HEAD, origin parity' requires tracking origin/feature/a7-10-…, deleted when it merged; THIS branch's clean tree and parity are proved by T002 here",
    T010: "A7.10 'Allowed diff, migrations unchanged' lists the paths A7.10 was allowed to change; A8.1 legitimately changes its own (T010 here)",
    T111: "A7.10 'All prior branch-only N/A justified' proves A7.9's branch-only causes against the A7.10 branch (its name, tracking, diff and pushed HEAD); on A8.1 those proofs are re-done here (T110)",
    T122: "A7.10 'Git tree clean, branch matches origin' compares HEAD with origin/feature/a7-10-…, deleted when it merged; THIS branch's are proved by T002 and T130 here",
    T123: "A7.10 'Independent run ID at exact HEAD' compares HEAD with origin/feature/a7-10-…, deleted when it merged; THIS run's identity and pushed HEAD are proved by T130 here",
    T130: "A7.10 'Final summary 130/130; no hidden failures' holds only when none of its own checks failed; on A8.1 exactly the branch-only items above fail, so it fails by construction (proved by count in T110)",
  }
  const undocumented = failing.filter((id) => !(id in a710NonApplicable))
  const summary = chain.output.match(/\[A7\.10\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A7\.10\] RUN ABORTED|\[A7\.10\] uncaught error|\[A7\.10\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a710Substantive = rows.filter((row) => !(row.id in a710NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a710Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) progress(`nested: ${text.slice(0, 400)}`)
  check(
    'T101',
    'A7.10 substantive regression PASS',
    ran && reconciled && undocumented.length === 0 && a710Substantive.length === 0 && a710Passing >= 123 &&
      ['T004', 'T007', 'T008', 'T009', 'T020', 'T041', 'T060', 'T063', 'T080', 'T099', 'T100', 'T116', 'T118', 'T119', 'T120', 'T127', 'T128', 'T129'].every((id) => verdictOf(id) === 'PASS'),
    !ran
      ? 'the A7.10 suite did not complete'
      : !reconciled
        ? `A7.10 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A7.10 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A7\.10\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A7.10] automated summary: ', 'A7.10 ')}; all ${a710Passing} substantive checks PASS (its own-scope T004/T007/T008 and A7-owned T099 included) and every failure is documented`,
  )
  for (const id of Object.keys(a710NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T101/${id}`, `A7.10 ${titleOf(row.line)}`, a710NonApplicable[id])
  }
  check('T102', 'A7.9 substantive regression PASS', verdictOf('T101') === 'PASS', `A7.10 T101 (A7.9 with its own justified N/A) ${verdictOf('T101')}`)
  check('T103', 'A7.8 substantive regression PASS', verdictOf('T102') === 'PASS', `A7.10 T102 (A7.8) ${verdictOf('T102')}`)
  check('T104', 'A7.7 substantive regression PASS', verdictOf('T103') === 'PASS', `A7.10 T103 (A7.7) ${verdictOf('T103')}`)
  check('T105', 'A7.6 substantive regression PASS', verdictOf('T104') === 'PASS', `A7.10 T104 (A7.6) ${verdictOf('T104')}`)
  check('T106', 'A7.5–A7.4 substantive PASS', verdictOf('T105') === 'PASS' && verdictOf('T106') === 'PASS', `A7.10 T105 (A7.5) ${verdictOf('T105')} and T106 (A7.4) ${verdictOf('T106')}`)
  check('T107', 'A7.3–A7.1 substantive PASS', ['T107', 'T108', 'T109'].every((id) => verdictOf(id) === 'PASS'), `A7.10 T107 (A7.3) ${verdictOf('T107')}, T108 (A7.2) ${verdictOf('T108')}, T109 (A7.1) ${verdictOf('T109')}`)
  check('T108', 'A6.10/A6.1–A6.9 substantive PASS', verdictOf('T110') === 'PASS', `A7.10 T110 (A6.10, which nests A6.9 → A6.1) ${verdictOf('T110')}`)
  check('T109', 'A5 and A1–A4 substantive PASS', verdictOf('T110') === 'PASS' && verdictOf('T112') === 'PASS', `A7.10 T110 (the A6.10 → A1 chain, which reaches A5.10 → A1) ${verdictOf('T110')}; A7.10 T112 (every A1–A7 unit suite) ${verdictOf('T112')}`)
  // Each documented A7.10 failure must fail for its branch-only reason, proved independently on this branch.
  const a710Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const unprovenA79 = (lineOfRow('T111').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const originA710 = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a710Branch}`])
  const originA79 = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a79Branch}`])
  const originA78 = gitArgs(['rev-parse', '--verify', '--quiet', `origin/${a78Branch}`])
  const originA81 = gitArgs(['rev-parse', `origin/${a81Branch}`])
  const a710SelfCount = Number((lineOfRow('T130').match(/(\d+) of the 129 checks before this one PASS/) ?? [])[1] ?? -1)
  const causes: Record<string, boolean> = {
    T001: branch === a81Branch && a710Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a710Merge} HEAD`),
    T002: dirty.length === 0 && tracking.includes(`origin/${a81Branch}`) && !/ahead|behind/.test(tracking),
    // A7.10 lists its unexpected paths and, when package.json carries more than its one script, says so in words.
    T010: a710Unexpected.length > 0 && a710Unexpected.every((path, index) => changedPaths.includes(path) || (path === 'package.json beyond the one script' && changedPaths.includes('backend/package.json')) || (index === a710Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    T111: unprovenA79.length > 0 && unprovenA79.every((id) => ['T001', 'T002', 'T010', 'T120', 'T130'].includes(id)) && originA79 === '' && originA78 === '' && tracking.includes(`origin/${a81Branch}`) && outOfScope.length === 0,
    T122: originA710 === '' && originA81 === headAtStart && headAtStart.length === 40,
    T123: originA710 === '' && originA81 === headAtStart,
    T130: a710SelfCount === 129 - (failing.length - 1) && failing.every((id) => id in a710NonApplicable),
  }
  const unprovenHere = failing.filter((id) => id in causes && !causes[id])
  const naLines = chain.output.split(/\r?\n/).filter((line) => /^\[A7\.10\] T101\/T\d+ .* N\/A {2}- \S/.test(line))
  check(
    'T110',
    'All historical branch N/A causes justified',
    ran && failing.every((id) => id in a710NonApplicable) && unprovenHere.length === 0 && naLines.length === 5 && naLines.every((line) => line.length > 80),
    unprovenHere.length === 0
      ? `each documented A7.10 failure (${failing.join(', ') || 'none'}) is printed with its reason and fails only for its branch-only cause, proved independently here; A7.10 itself justifies its five A7.9 items (${naLines.length} lines)`
      : `cause not proven for: ${unprovenHere.join(', ')}`,
  )

  // ---------------------------------------------------------------- operational intake boundary (T111–T120)
  section('Operational intake boundary: no automatic scan or default ticket, predictable second reasons, later contradictions, metadata-only audit, null digests, no narrative, no impersonation, no A8.2 tables, owner sign-off')
  const jobsAndCron = committedProductionCodeOf(['backend/src/jobs', 'backend/src/scripts']).code
  const claimsWithIntake = (await prisma.exceptionIntakeRecord.findMany({ where: { recordedAt: { gte: runStartedAt, lt: chainStartedAt }, organizationId: org }, select: { claimId: true } })).map((r) => r.claimId)
  check('T111', 'No automatic scan of A7 missing evidence', !/exception-intake|recordExceptionIntake/.test(jobsAndCron) && (await intakesOfClaim(N.claimId)).length === 0 && claimsWithIntake.every((id) => [C.claimId, D.claimId, X.claimId, Y1.claimId, Y2.claimId, Z.claimId].includes(id)), 'no job or script records intakes; only the Claims this run explicitly asked about carry one — Claim N, read many times, has none')
  check('T112', 'No default ticket for synthetic-only source', (await intakesOfClaim(N.claimId)).length === 0 && batch[4].status === 409 && ASSESS_N.assessmentCode === 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', "a synthetic-only Claim whose assessment states only the absence of external evidence gets no intake, even when one is asked for (409)")
  check('T113', 'Second identity reason handled predictably', pv?.review.ok === true && pv.reviewAgain.ok === true && pv.reviewAgain.value.replayed === true && same(pv.reviewAgain.value.intake, pv.review.value.intake) && pv.history.ok === true && pv.history.value.intake.identityKey !== pv.review.value.intake.identityKey && pv.audits === 2, 'on one source a second established reason is its own intake with its own identity; repeating either is its replay; two intakes, two audits (planted, rolled back)')
  const S3 = await C.extend()
  const contradictionAgain = await getRevenueTimeline(C.claimId)
  const replayAfterContradiction = await post(intakePath(C.claimId), timelineBody(C.claimId))
  check('T114', 'Later contradiction does not rewrite intake', S3.length === 36 && !contradictionAgain.ok && replayAfterContradiction.status === 200 && same(replayAfterContradiction.body, E1) && (await intakesOfClaim(C.claimId)).length === 1 && (await intakeRowsHash([C.claimId])) === e1Bytes, "a third freeze left unlinked contradicts C's history again: the same request answers E1 unchanged — no new row, no rewrite")
  check('T115', 'Existing AuditEvent metadata only', same(Object.keys((e1Audit?.afterState ?? {}) as object).sort(), ['claimId', 'contractVersion', 'exceptionIntakeId', 'exceptionReasonCode', 'recordedAt', 'sourceContractVersion', 'sourceKind', 'sourceRecordId']) && e1Audit?.actionCode === 'exception_intake.recorded' && e1Audit?.beforeState === null, "E1's audit is the existing Business AuditEvent exception_intake.recorded with identifiers, contracts, codes and time only — no digest, PHI, payload or amount")
  check('T116', 'Source digest omission remains NULL', E1row.sourceFingerprintSha256 === null && E2res.body.sourceFingerprintSha256 === null, 'a revenue timeline supplies no trustworthy digest, so its intakes store NULL — never a made-up one')
  const narrative = await Promise.all(['narrative', 'description', 'note', 'comment'].map((k) => post(intakePath(D.claimId), { ...timelineBody(D.claimId), [k]: 'free text about the payer' })))
  check('T117', 'No free-text narrative accepted', narrative.every((r) => r.status === 400) && !COLUMNS.some((c) => /note|comment|narrative|description|text/.test(c)), 'any narrative field is refused (400) and no free-text column exists')
  const impersonation = await directInsert({ source_kind: 'CLOSURE_PREREQUISITE_ASSESSMENT', source_record_id: randomUUID(), source_contract_version: PREREQ_CONTRACT, exception_reason_code: 'OPERATOR_REVIEW_REQUIRED', source_fingerprint_sha256: 'a'.repeat(64) })
  check('T118', 'Missing source cannot be impersonated', unknownIds.every((r) => r.status === 404) && impersonation.refused && /exception_intake_source/.test(impersonation.message), 'a made-up source UUID is a 404 through the API and is refused by the database guard when written directly')
  const a82Tables = await newTablesLike('(assign|status|export|triage|escalat|work_item|investigat)')
  check('T119', 'No A8.2 assignment/status/export table', a82Tables.length === 0 && laterRoutes.slice(0, 3).every((r) => r.status === 404), 'no new assignment, status, triage, escalation, investigation or export table (earlier phases own theirs), and no such route')
  const registerDoc = committedText(REGISTER_DOC)
  const approval = registerDoc.match(/^Architecture-owner approval: approved on (\d{4}-\d{2}-\d{2})/m)
  check(
    'T120',
    'Proposed contract requires owner sign-off',
    approval !== null && registerDoc.includes(CONTRACT) && sourceKinds.every((k) => registerDoc.includes(`\`${k}\``)) && exceptionReasonCodes.every((r) => registerDoc.includes(`\`${r}\``)) && registerDoc.includes(TABLE),
    approval ? `the committed register records the architecture owner's approval on ${approval[1]} and names exactly the contract, both source kinds and all five reasons the code uses` : `the committed register does not record the architecture owner's approval (${REGISTER_DOC})`,
  )

  // ---------------------------------------------------------------- final reproducibility gates (T121–T130)
  section('Final reproducibility gates: units, typecheck, frontend, checksums and replay, outage and recovery, no 5xx, synthetic fixtures, the golden intake after restart and the nested chain, exact head')
  const allUnit = run('npm run test:unit')
  const ownUnit = run(`node --test ${UNIT_TESTS.map((file) => file.replace('backend/', '')).join(' ')}`)
  check('T121', 'Backend unit tests PASS', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && ownUnit.ok && /ℹ pass 10/.test(ownUnit.output) && /ℹ fail 0/.test(ownUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the 10 A8.1 identity, basis and request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Backend typecheck PASS', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint PASS', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build PASS', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumMismatch = applied.filter((row) => {
    const blob = committedBlob(`backend/prisma/migrations/${row.name}/migration.sql`)
    const onDisk = `prisma/migrations/${row.name}/migration.sql`
    return !((blob.length > 0 && sha256Of(blob) === row.checksum) || (existsSync(onDisk) && sha256Of(readFileSync(onDisk)) === row.checksum))
  })
  check(
    'T125',
    'Prisma checksum and scratch replay PASS',
    status.ok && replay.ok && applied.length === headMigrationDirs.length && same(applied.map((r) => r.name), headMigrationDirs.map((d) => d.split('/').pop())) && checksumMismatch.length === 0,
    checksumMismatch.length === 0 ? `all ${applied.length} committed migrations applied in order, each with the checksum of its committed file (A8.1's included); scratch replay ALL CHECKS PASS (T006)` : `checksum differs: ${checksumMismatch.map((r) => r.name).join(', ')}`,
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
  check('T126', 'Health 200 / ready 503 / recovery 200', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database stopped health stayed 200 and ready reported 503; recovery 200')
  check('T127', 'Zero unexpected HTTP 5xx', serverErrors === 0 && connectionResets === 0, `${serverErrors} HTTP 5xx answers and ${connectionResets} connection resets in this run`)
  const runFreezes = await prisma.$queryRawUnsafe<{ org: string }[]>(
    `SELECT p.organization_id::text AS org FROM claim_freezes f JOIN claims k ON k.id = f.claim_id JOIN encounters e ON e.id = k.encounter_id JOIN patients p ON p.id = e.patient_id WHERE f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz`,
    runStartedAt.toISOString(),
    chainStartedAt.toISOString(),
  )
  const runSources = await prisma.$queryRawUnsafe<{ kind: string; reference: string }[]>(`SELECT source_kind AS kind, source_reference AS reference FROM revenue_source_evidence WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, runStartedAt.toISOString(), chainStartedAt.toISOString())
  const secrets = [adminPassword, viewerPassword, admin.cookie, viewer.cookie].filter((s) => s.length > 8)
  check(
    'T128',
    'Synthetic fixtures only',
    runFreezes.length > 0 && runFreezes.every((f) => [org, otherOrg].includes(f.org)) && runSources.length > 0 && runSources.every((s) => s.kind === SYNTHETIC && s.reference.includes(runId.slice(4))) && secrets.every((s) => !printed.join('\n').includes(s) && !chain.output.includes(s)),
    `the ${runFreezes.length} freezes and ${runSources.length} sources this run recorded (before the nested chain) belong to the two synthetic organizations, every source INTERNAL_SYNTHETIC keyed by ${runId}; no password or cookie appears in any output`,
  )
  const goldenAfter = { list: (await get(intakePath(C.claimId))).body, audit: JSON.stringify((await auditsOfIntake(E1.exceptionIntakeId)).map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() }))) }
  progress(`golden intake: Claim C ${C.claimId} (two freezes, no A6.9 link: A7.7 refuses its history) -> E1 ${E1.exceptionIntakeId} PROVENANCE_CONFLICT, identity ${E1.identityKey.slice(0, 16)}…, one audit; Org B's Admin gets 404; Claim N (EXTERNAL_FINANCIAL_EVIDENCE_ABSENT) gets no intake`)
  check('T129', 'Golden intake/audit after restart', same(goldenAfter, goldenBefore) && same(goldenAfter.list.items, [E1]), "after the nested chain, a database restart and an outage, Claim C's intake list and E1's single audit read back identically")
  const headNow = git('rev-parse HEAD')
  check(
    'T130',
    'Exact HEAD, clean origin, independent run',
    headNow === headAtStart && headNow === originA81 && headNow.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a81Branch}`) && !/ahead|behind/.test(tracking) && outOfScope.length === 0 && /^A81-\d{13}$/.test(runId) && existsSync(nestedLog),
    `all evidence corresponds to ${headNow} (= origin/${a81Branch}); ${tracking}; fresh runId ${runId}; nested output kept in backend/${nestedLog} (SHA-256 ${sha256Of(Buffer.from(chain.output)).slice(0, 16)}…); the two submitted runs must both state this HEAD`,
  )

  say(`\n[${TAG}] run ${runId} — HEAD ${headNow}`)
  if (failures.length > 0) {
    say(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) say(`          ${failure}`)
  }
  if (notApplicable > 0) say(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) say(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  say(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  say(failed === 0 ? `[${TAG}] EXCEPTION INTAKE ACCEPTANCE COMPLETE` : `[${TAG}] A8.1 FINAL FAIL`)
  if (failed > 0) process.exitCode = 1
}

function attemptSync(work: () => unknown): boolean {
  try {
    work()
    return false
  } catch {
    return true
  }
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
