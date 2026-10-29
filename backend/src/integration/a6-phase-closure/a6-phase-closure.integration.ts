import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { prisma } from '../../shared/database/prisma.ts'
import { auth } from '../../shared/auth/auth.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { apiFixtures } from '../a3-governance/a3-governance.fixtures.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { removeClaimLine } from '../../modules/claim-line/claim-line.service.ts'
import { recordReviewDecision } from '../../modules/claim-review/claim-review.service.ts'
import { composeCanonicalClaimPayload } from '../../modules/claim-payload/claim-payload.composer.ts'
import { encodeCanonicalPayload, payloadSchema } from '../../modules/claim-payload/claim-payload.serializer.ts'
import { encodeEvidenceManifest } from '../../modules/claim-evidence/claim-evidence.manifest.ts'
import { freezeClaimSubmission, getFrozenSubmission } from '../../modules/claim-submission/claim-submission.service.ts'
import { recordLifecycleEvent } from '../../modules/claim-lifecycle/claim-lifecycle.service.ts'
import { lifecycleTransitions } from '../../modules/claim-lifecycle/claim-lifecycle.types.ts'
import { getCorrectionChain, recordCorrectionLink } from '../../modules/claim-correction/claim-correction.service.ts'

// A6.10 — cumulative acceptance and phase closure for the A6 Claim Lifecycle (T001–T130).
//
// One synthetic UAE (Dubai) organization carries a Claim through every A6 owner, in order, exactly as a
// user would: A4 Encounter facts -> A5.8 validation (the real engine, through its route) -> A5.9 readiness
// and handoff -> A6.1 Claim -> A6.2 lines, diagnoses and pointers -> A6.3 pricing under the verified tariff
// version -> A6.4 draft assessment -> A6.5 human APPROVE by a separate reviewer -> A6.6 canonical preview ->
// A6.7 freeze with its evidence package -> A6.8 internal lifecycle events -> A6.9 correction lineage to an
// independently approved and frozen successor. Every decision is the owner's: this runner creates fixtures
// through owner routes, calls owner endpoints and compares observable results. It copies no owner
// algorithm, adds no schema, route, permission, audit or error vocabulary, and adds no A7–A10 behaviour.
//
// Owner functions are called in-process only where the behaviour is internal by design: barrier-controlled
// races and crash injection (concurrency probes exist only in-process), the transaction-aware readers later
// owners use, and the owner encoders for byte comparison. Direct database writes are ADVERSARIAL only — to
// prove a guard refuses them, or to create a state no owner path can create (a second validation run at the
// same instant, as the A6.1/A6.3 suites do). Every guard probe runs in a transaction that is always rolled
// back. The second organization is built by its own synthetic Admin through the same owner routes. Synthetic
// Admins are provisioned per run through Better Auth's own server-side creation with a random password that
// is never printed. Every value is synthetic and keyed by this run's id.

const TAG = 'A6.10'
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
const progress = (text: string) => console.log(`[${TAG}]      ${text}`)

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

const runId = `A610-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const a610Branch = 'feature/a6-10-a6-integration-acceptance'
// The nine accepted A6 packages, in order; each merge is found on origin/main by its feature branch name.
const A6_BRANCHES = [
  ['A6.1', 'feature/a6-1-claim-foundation-a5-handoff-binding'],
  ['A6.2', 'feature/a6-2-claim-line-diagnosis-source-traceability'],
  ['A6.3', 'feature/a6-3-tariff-rate-claim-pricing'],
  ['A6.4', 'feature/a6-4-claim-draft-integrity'],
  ['A6.5', 'feature/a6-5-human-review-submission-approval'],
  ['A6.6', 'feature/a6-6-canonical-claim-payload'],
  ['A6.7', 'feature/a6-7-immutable-claim-submission-evidence'],
  ['A6.8', 'feature/a6-8-claim-lifecycle-transition-governance'],
  ['A6.9', 'feature/a6-9-correction-resubmission-lineage'],
] as const
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const FRESH_UNTIL = '2030-12-31T00:00:00.000Z'
const DOC = 'DOCUMENTATION_REQUIREMENT_EFFECT'
const REPORT = `SYNTHETIC_REPORT_${Date.now().toString(36).toUpperCase()}`
const HARNESS_DIR = 'backend/src/integration/a6-phase-closure'
const HARNESS_FILE = `${HARNESS_DIR}/a6-phase-closure.integration.ts`
const CLOSURE_DOC = 'docs/A6_Phase_Closure.md'
const SCRIPT = 'node --env-file=.env src/integration/a6-phase-closure/a6-phase-closure.integration.ts'
// The one owner-harness correction A6.10 carries: the A6.7/A6.8/A6.9 T006 replay count assumed the package's own
// migration is never on main ("main + 1"), true only before its merge. A6.10 is the first package with no
// migration, so it exposed it; each T006 now expects "main + 1" before its merge and "main" after it.
const OWNER_HARNESS_CORRECTIONS = ['a6-claim-submission', 'a6-claim-lifecycle', 'a6-claim-correction'].map((name) => `backend/src/integration/${name}/${name}.integration.ts`)
const A6_MODULES = ['claim', 'claim-line', 'claim-diagnosis', 'tariff-rate', 'claim-pricing', 'claim-draft', 'claim-review', 'claim-payload', 'claim-evidence', 'claim-submission', 'claim-lifecycle', 'claim-correction'].map((m) => `backend/src/modules/${m}`)
const A6_OWNER_SCRIPTS = ['test:a6:claim-foundation', 'test:a6:claim-line-diagnosis', 'test:a6:claim-pricing', 'test:a6:claim-draft', 'test:a6:claim-review', 'test:a6:canonical-payload', 'test:a6:claim-submission', 'test:a6:claim-lifecycle', 'test:a6:claim-correction']
// The A6 tables whose rows a refusal, a read or a rolled-back write must leave untouched. Always read in this
// fixed key order (a UNION ALL may come back in Parallel Append order).
const COUNT_TABLES = [
  'claims', 'claim_lines', 'claim_diagnoses', 'claim_line_diagnosis_pointers', 'claim_pricing_runs', 'claim_draft_assessments', 'claim_review_events',
  'claim_freezes', 'claim_freeze_evidence_manifests', 'claim_freeze_evidence_entries', 'claim_freeze_lifecycle_events', 'claim_correction_links',
  'audit_events', 'validation_runs', 'pre_claim_readiness_assessments',
]
const LIFECYCLE_STATES = ['FROZEN', 'HELD', 'RELEASE_ELIGIBLE', 'WITHDRAWN_INTERNAL'] as const
const LIFECYCLE_EVENTS = ['PLACE_HOLD', 'RELEASE_HOLD', 'AUTHORIZE_RELEASE', 'WITHDRAW_INTERNAL'] as const

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
const uuid16 = (value: string) => Buffer.from(value.replaceAll('-', ''), 'hex')
const sortedSet = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => typeof id === 'string'))].sort()
const schemaKeys = (schema: unknown) => (schema as [string, unknown][]).map(([key]) => key)
const schemaOf = (key: string) => ((payloadSchema as unknown as [string, { object?: unknown; array?: { object?: unknown } }][]).find(([name]) => name === key)?.[1] ?? {}) as { object?: unknown; array?: { object?: unknown } }

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[${TAG}] A6 integration acceptance & phase closure — run ${runId}`)
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

  // ---------------------------------------------------------------- start gate (T001–T009; T010 at the end)
  section('Start gate: accepted A6.1–A6.9 merges, clean tree, no schema, toolchain, contracts and wiring')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const merges = A6_BRANCHES.map(([pkg, name]) => ({ pkg, sha: mergeOf(name) }))
  const a69Merge = merges[8].sha
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /remittance|adjudicat|denial|payment-posting|claim-transport|claim-outbox|integration\/a(7|8|9)|dhpo|eclaimlink|exception-queue/i.test(file))
  check(
    'T001',
    'Start gate',
    branch === a610Branch && merges.every((m) => m.sha.length === 40) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A6.9 accepted merge ${a69Merge || 'NOT FOUND'}; contains latest main ${git('rev-parse --short origin/main')}; no A7–A10 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check(
    'T003',
    'A6.1–A6.9 ancestry',
    merges.every((m) => m.sha.length === 40 && gitOk(`merge-base --is-ancestor ${m.sha} HEAD`)),
    merges.map((m) => `${m.pkg} ${m.sha.slice(0, 7) || 'NOT FOUND'}`).join(', '),
  )
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const prismaChanged = changedPaths.filter((p) => p.startsWith('backend/prisma/'))
  const migrationDirs = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrations = migrationDirs('HEAD')
  const mainMigrations = migrationDirs('origin/main')
  check(
    'T004',
    'No migration or schema change',
    prismaChanged.length === 0 && same(headMigrations, mainMigrations) && headMigrations.length > 0,
    prismaChanged.length === 0 ? `schema and all ${headMigrations.length} migrations are exactly main's; A6.10 adds no persistent state` : `changed: ${prismaChanged.join(', ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, the working database is up to date (never reset)')
  const versions = {
    node: process.version,
    npm: run('npm --version').output.trim(),
    prisma: (run('npx prisma --version').output.match(/^prisma\s*:\s*(\S+)/m) ?? [])[1] ?? 'unknown',
  }
  const backendTree = run('npm ls --depth=0')
  const frontendTree = run('npm ls --depth=0 --prefix ../frontend')
  const lockChanged = changedPaths.filter((p) => /package-lock\.json$/.test(p))
  check(
    'T006',
    'Toolchain and lockfiles',
    backendTree.ok && frontendTree.ok && lockChanged.length === 0 && /^v\d+/.test(versions.node) && versions.prisma !== 'unknown',
    `node ${versions.node}, npm ${versions.npm}, prisma ${versions.prisma}; the installed backend and frontend trees match their lockfiles, and no lockfile changed`,
  )
  const productionChanged = changedPaths.filter((p) => /^(backend\/src\/(modules|shared|scripts|jobs|app\.ts|server\.ts)|frontend\/src\/)/.test(p))
  const vocabularyFiles = ['backend/src/shared/authorization/authorization.types.ts', 'backend/src/modules/audit/audit.types.ts', 'backend/src/shared/errors/error.types.ts']
  const declaredPermissions = committedText('backend/src/shared/authorization/authorization.types.ts')
  const dbPermissions = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const undeclared = dbPermissions.filter((code) => !declaredPermissions.includes(`'${code}'`))
  check(
    'T007',
    'No route, permission or vocabulary',
    productionChanged.length === 0 && vocabularyFiles.every((file) => !changedPaths.includes(file)) && undeclared.length === 0,
    productionChanged.length === 0 ? `no module, route, wiring, script or frontend file changed; every one of ${dbPermissions.length} permissions is a declared accepted one` : `changed: ${productionChanged.join(', ')}`,
  )
  const constantOf = (path: string, name: string) => (committedText(path).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = {
    validator: constantOf('backend/src/modules/pre-claim-validation/pre-claim-validation.types.ts', 'VALIDATOR_VERSION'),
    readiness: constantOf('backend/src/modules/pre-claim-readiness/pre-claim-readiness.types.ts', 'READINESS_POLICY_VERSION'),
    handoff: constantOf('backend/src/modules/pre-claim-readiness/pre-claim-readiness.types.ts', 'HANDOFF_SCHEMA_VERSION'),
    claim: constantOf('backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'),
    line: constantOf('backend/src/modules/claim-line/claim-line.types.ts', 'CLAIM_LINE_CONTRACT_VERSION'),
    diagnosis: constantOf('backend/src/modules/claim-diagnosis/claim-diagnosis.types.ts', 'CLAIM_DIAGNOSIS_CONTRACT_VERSION'),
    pricing: constantOf('backend/src/modules/claim-pricing/claim-pricing.types.ts', 'PRICING_CONTRACT_VERSION'),
    draft: constantOf('backend/src/modules/claim-draft/claim-draft.types.ts', 'DRAFT_CONTRACT_VERSION'),
    review: constantOf('backend/src/modules/claim-review/claim-review.types.ts', 'REVIEW_CONTRACT_VERSION'),
    payload: constantOf('backend/src/modules/claim-payload/claim-payload.types.ts', 'PAYLOAD_SCHEMA_VERSION'),
    submission: constantOf('backend/src/modules/claim-submission/claim-submission.types.ts', 'SUBMISSION_CONTRACT_VERSION'),
    evidence: constantOf('backend/src/modules/claim-evidence/claim-evidence.types.ts', 'EVIDENCE_MANIFEST_VERSION'),
    lifecycle: constantOf('backend/src/modules/claim-lifecycle/claim-lifecycle.types.ts', 'LIFECYCLE_CONTRACT_VERSION'),
    correction: constantOf('backend/src/modules/claim-correction/claim-correction.types.ts', 'CORRECTION_CONTRACT_VERSION'),
  }
  const expectedContracts = {
    validator: 'A5-VAL-1', readiness: 'A5-READY-1', handoff: 'PreClaimA6HandoffV1', claim: 'A6-CLAIM-1', line: 'A6-LINE-1', diagnosis: 'A6-DX-1', pricing: 'A6-PRICE-1',
    draft: 'A6-DRAFT-1', review: 'A6-REVIEW-1', payload: 'A6-PAYLOAD-1', submission: 'A6-SUBMISSION-1', evidence: 'A6-EVIDENCE-1', lifecycle: 'A6-LIFECYCLE-1', correction: 'A6-CORRECTION-1',
  }
  check('T008', 'Exact accepted contracts', same(contracts, expectedContracts), Object.values(contracts).join(', '))
  const packageJson = JSON.parse(committedText('backend/package.json') || '{}') as { scripts?: Record<string, string> }
  const scripts = packageJson.scripts ?? {}
  const harnessCode = committedCode(HARNESS_FILE)
  const closureDoc = committedText(CLOSURE_DOC)
  const a69Documented = ['T001', 'T004', 'T010', 'T120', 'T130']
  check(
    'T009',
    'Harness, owner suites and closure record',
    scripts['test:a6:integration'] === SCRIPT &&
      A6_OWNER_SCRIPTS.every((name) => typeof scripts[name] === 'string' && scripts[name].includes('src/integration/')) &&
      /run\('npm run test:a6:claim-correction'\)/.test(harnessCode) &&
      merges.every((m) => m.sha.length === 40 && closureDoc.includes(m.sha.slice(0, 7))) &&
      a69Documented.every((id) => closureDoc.includes(`A6.9 ${id}`)),
    'test:a6:integration is this one runner; all nine A6 owner suites exist and A6.9 (which nests A6.8 → A1) is invoked, not reimplemented; the committed closure record names every accepted merge and every documented N/A',
  )

  // ---------------------------------------------------------------- sessions and synthetic actors
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
  const responses: unknown[] = []
  const api = async (method: string, path: string, body?: unknown, who: Who = asAdmin) => {
    const res = await httpCall(path, who(body === undefined ? { method } : { method, body: JSON.stringify(body) }))
    if (res.status >= 500) serverErrors += 1
    responses.push(res.body)
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
  let serial = 0
  const key = (prefix: string) => `${runId}-${prefix}-${++serial}`
  // Raw database text in a response body: SQL keywords, a stack frame or a physical table/guard name.
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /claim_[a-z_]+_(chk|key|fkey|guard)|claim_freeze/.test(text)
  }

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
  // A creates every Claim and assessment (the env Admin); B and C are independent reviewers of the same
  // organization; V is the env Viewer; O is an Admin of the OTHER organization and builds its tenant itself.
  const B = await provisionAdmin('b')
  const C = await provisionAdmin('c')
  const O = await provisionAdmin('o', otherOrg)

  // ---------------------------------------------------------------- the synthetic UAE world
  section('Synthetic UAE world through owner routes: facility, masters, verified tariff, governed documentation rule')
  const fx = apiFixtures(baseUrl, admin.cookie, org, runId)
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const procA = must('procedure A', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PA'), displayName: `${runId} procedure A`, codeSystem: 'SYNTHETIC', externalCode: key('XA') })).body)
  const procB = must('procedure B', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PB'), displayName: `${runId} procedure B`, codeSystem: 'SYNTHETIC', externalCode: key('XB') })).body)
  const svcA = must('service A', (await post(`/api/organizations/${org}/services`, { internalCode: key('SA'), displayName: `${runId} service A` })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: `${runId} service B` })).body)
  const dxA = must('diagnosis A', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DXA'), displayName: `${runId} diagnosis A` })).body)
  const dxB = must('diagnosis B', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DXB'), displayName: `${runId} diagnosis B` })).body)
  const evidenceArtifact = async (organizationId: string, documentType: string, sourceDate: string | null, who: Who = asAdmin) => {
    const artifact = must('evidence', (await post(`/api/organizations/${organizationId}/evidence-artifacts`, { storageRef: `synthetic://evidence/${key('E')}`, contentHash: 'f'.repeat(64), documentType, sourceDate, receivedAt: '2026-06-15T09:30:00.000Z' }, who)).body) as any
    return { artifactId: artifact.id as string, versionId: artifact.latestVersion.id as string }
  }
  const report = await evidenceArtifact(org, REPORT, '2026-06-01')
  const response = await evidenceArtifact(org, 'SYNTHETIC_RESPONSE', '2026-06-10')
  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const memberIdentifier = `MEM-${key('M')}`
  const membership = must('membership', (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier, coverageFrom: '2025-01-01', coverageTo: null })).body)
  const contract = must('contract', (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  must('contract facility', (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
  const schedule = must('schedule', (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
  const version = must('tariff version', (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  const rate = (versionId: string, body: Record<string, unknown>) => post(`/api/tariff-schedule-versions/${versionId}/rates`, { modifierCodes: [], currencyCode: 'AED', ...body })
  const rateProcA = must('rate procedure A', (await rate(version.id, { selectorKind: 'PROCEDURE_CODE', procedureCodeId: procA.id, unitTariffAmount: '125.2500' })).body)
  const rateSvcB = must('rate service B', (await rate(version.id, { selectorKind: 'SERVICE', serviceId: svcB.id, unitTariffAmount: '12.1250' })).body)
  must('rate service A', (await rate(version.id, { selectorKind: 'SERVICE', serviceId: svcA.id, unitTariffAmount: '125.2500' })).body)
  if ((await post(`/api/tariff-schedule-versions/${version.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error('fixture: the tariff version could not be verified')
  const governing = await fx.verifiedSource('a610 governing', { activateOn: '2025-01-01' })
  const rule = await fx.ruleDefinition('a610 documentation')
  const ruleVersion = await fx.draftRuleVersion(rule.id, '1', { effectType: DOC })
  await fx.applicability(ruleVersion.id, { payerId: payer.id })
  await fx.bind(ruleVersion.id, governing.interpretation.id)
  const requirement = await post(`/api/rule-versions/${ruleVersion.id}/evidence-requirement`, { documentTypes: [REPORT], minimumCount: 1, sourceDateRequired: true, maxSourceAgeDays: 30 })
  if (requirement.status !== 201) throw new Error(`fixture evidence requirement returned ${requirement.status}: ${JSON.stringify(requirement.body).slice(0, 200)}`)
  await fx.verifyRuleVersion(ruleVersion.id)

  // ---- the owner chain, step by step
  type ActivitySpec = { procedureCodeId?: string; serviceId?: string; quantity: string; modifierCodes?: string[] }
  const MAIN: ActivitySpec[] = [{ procedureCodeId: procA.id, quantity: '1.5' }, { serviceId: svcB.id, quantity: '1' }]
  const encounterOf = async (label: string, activities: ActivitySpec[], eligibilityOverrides: Record<string, unknown>) => {
    const encounter = must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membership.id })).body)
    const activityIds: string[] = []
    for (const spec of activities) activityIds.push(must(`${label} activity`, (await post(`/api/encounters/${encounter.id}/activities`, spec)).body).id)
    const encounterDiagnosisIds: string[] = []
    for (const code of [dxA, dxB]) encounterDiagnosisIds.push(must(`${label} diagnosis`, (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: code.id })).body).id)
    if ((await post(`/api/encounters/${encounter.id}/evidence-links`, { evidenceArtifactVersionId: report.versionId })).status !== 201) throw new Error(`fixture ${label}: evidence link refused`)
    const eligibility = must(
      `${label} eligibility`,
      (await post(`/api/encounters/${encounter.id}/eligibility-verifications`, {
        verificationMethod: 'PORTAL', status: 'ELIGIBLE', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z', validThrough: FRESH_UNTIL, authorizationRequired: false, referralRequired: null,
        requestEvidenceVersionId: null, responseEvidenceVersionId: response.versionId, ...eligibilityOverrides,
      })).body,
    )
    return { label, encounterId: encounter.id as string, activityIds, encounterDiagnosisIds, eligibilityId: eligibility.id as string }
  }
  const execute = async (encounterId: string, who: Who = asAdmin) => {
    const res = await post(`/api/encounters/${encounterId}/pre-claim-validation/execute`, {}, who)
    if (res.status !== 201) throw new Error(`fixture: the A5.8 execution was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body.validationRunId as string
  }
  const readinessOf = async (validationRunId: string, who: Who = asAdmin) => {
    const res = await post(`/api/validation-runs/${validationRunId}/readiness-assessments`, {}, who)
    if (res.status !== 201) throw new Error(`fixture: the A5.9 assessment was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as { id: string; state: string; readinessPolicyVersion: string; validationRunId: string }
  }
  const chainOf = async (label: string, activities: ActivitySpec[] = MAIN, eligibilityOverrides: Record<string, unknown> = {}) => {
    const encounter = await encounterOf(label, activities, eligibilityOverrides)
    const validationRunId = await execute(encounter.encounterId)
    const readiness = await readinessOf(validationRunId)
    return { ...encounter, validationRunId, readiness, readinessId: readiness.id }
  }
  type Chain = Awaited<ReturnType<typeof chainOf>>
  const claimHttp = (readinessId: string, who: Who = asAdmin) => post(`/api/pre-claim-readiness-assessments/${readinessId}/claims`, {}, who)
  const createdClaimIds: string[] = []
  const claimFrom = async (chain: Chain) => {
    if (chain.readiness.state !== 'READY_FOR_REVIEW') throw new Error(`fixture ${chain.label}: readiness ${chain.readiness.state}, expected READY_FOR_REVIEW`)
    const res = await claimHttp(chain.readinessId)
    const claim = must(`${chain.label} claim`, res.body)
    createdClaimIds.push(claim.id)
    return claim
  }
  const setPointers = (lineId: string, claimDiagnosisIds: string[], who: Who = asAdmin) => api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds }, who)
  const structureOf = async (claimId: string, chain: Chain) => {
    const lineIds: string[] = []
    for (const activityId of chain.activityIds) lineIds.push(must(`${chain.label} line`, (await post(`/api/claims/${claimId}/lines`, { encounterActivityId: activityId })).body).id)
    const primary = must(`${chain.label} primary`, (await post(`/api/claims/${claimId}/diagnoses`, { encounterDiagnosisId: chain.encounterDiagnosisIds[0], roleCode: 'PRIMARY' })).body).id as string
    const secondary = must(`${chain.label} secondary`, (await post(`/api/claims/${claimId}/diagnoses`, { encounterDiagnosisId: chain.encounterDiagnosisIds[1], roleCode: 'SECONDARY' })).body).id as string
    for (const lineId of lineIds) if ((await setPointers(lineId, [primary])).status !== 200) throw new Error(`fixture ${chain.label}: pointers refused`)
    return { lineIds, claimDiagnosisIds: [primary, secondary] }
  }
  const priceHttp = (claimId: string, who: Who = asAdmin) => post(`/api/claims/${claimId}/pricing-runs`, {}, who)
  const price = async (claimId: string) => {
    const res = await priceHttp(claimId)
    if (res.status !== 201) throw new Error(`fixture: pricing refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body
  }
  const assessHttp = (claimId: string, pricingRunId: string, who: Who = asAdmin) => post(`/api/claims/${claimId}/draft-assessments`, { pricingRunId }, who)
  const assess = async (claimId: string, pricingRunId: string, outcome = 'REVIEWABLE') => {
    const res = await assessHttp(claimId, pricingRunId)
    if (res.status !== 201 || res.body?.outcome !== outcome) throw new Error(`fixture: expected a ${outcome} assessment, got ${res.status} ${res.body?.outcome ?? errorCode(res.body)}`)
    return res.body
  }
  type Assessed = { id: string; assemblyFingerprint: string }
  const decide = (claimId: string, body: unknown, who: Who = B.who) => post(`/api/claims/${claimId}/review-decisions`, body, who)
  const approveBody = (a: Assessed) => ({ draftAssessmentId: a.id, assemblyFingerprint: a.assemblyFingerprint, decisionCode: 'APPROVE' })
  const revokeBody = (a: Assessed, approvalId: string) => ({ draftAssessmentId: a.id, assemblyFingerprint: a.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: approvalId })
  const approve = async (claimId: string, a: Assessed, who: Who = B.who) => {
    const res = await decide(claimId, approveBody(a), who)
    if (res.status !== 201) throw new Error(`fixture: approval refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.decision.id as string
  }
  const freezeHttp = (claimId: string, draftAssessmentId: string, approvalDecisionId: string, who: Who = asAdmin) => post(`/api/claims/${claimId}/submissions`, { draftAssessmentId, approvalDecisionId }, who)
  const freeze = async (claimId: string, draftAssessmentId: string, approvalDecisionId: string) => {
    const res = await freezeHttp(claimId, draftAssessmentId, approvalDecisionId)
    if (res.status !== 201) throw new Error(`fixture: the A6.7 freeze was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body
  }
  const subjectOf = async (label: string, activities: ActivitySpec[] = MAIN) => {
    const chain = await chainOf(label, activities)
    const claim = await claimFrom(chain)
    const structure = await structureOf(claim.id, chain)
    return { ...chain, claimId: claim.id as string, ...structure }
  }
  const reviewableOf = async (label: string) => {
    const subject = await subjectOf(label)
    const pricing = await price(subject.claimId)
    const assessment = await assess(subject.claimId, pricing.id)
    return { ...subject, pricing, assessment }
  }
  const approvedOf = async (label: string) => {
    const subject = await reviewableOf(label)
    return { ...subject, approvalId: await approve(subject.claimId, subject.assessment) }
  }
  const frozenOf = async (label: string) => {
    const subject = await approvedOf(label)
    const first = await freeze(subject.claimId, subject.assessment.id, subject.approvalId)
    return { ...subject, freezes: [first.submissionId as string] }
  }
  type Frozen = Awaited<ReturnType<typeof frozenOf>>
  // Another lawful freeze of the same Claim: the current approval is revoked, the draft optionally corrected,
  // re-priced and re-assessed, approved by the other reviewer and frozen.
  const nextFreeze = async (subject: Frozen, correction?: () => Promise<unknown>) => {
    const revoked = await decide(subject.claimId, revokeBody(subject.assessment, subject.approvalId))
    if (revoked.status !== 201) throw new Error(`fixture: revocation refused with ${revoked.status}`)
    if (correction) await correction()
    subject.pricing = await price(subject.claimId)
    subject.assessment = await assess(subject.claimId, subject.pricing.id)
    subject.approvalId = await approve(subject.claimId, subject.assessment, C.who)
    const next = await freeze(subject.claimId, subject.assessment.id, subject.approvalId)
    subject.freezes.push(next.submissionId)
    return next
  }

  const counts = async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(COUNT_TABLES.map((table) => `SELECT '${table}' AS t, count(*) AS n FROM ${table}`).join(' UNION ALL '))
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(COUNT_TABLES.map((table) => [table, byName.get(table) ?? -1])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  const delta = (before: Record<string, number>, after: Record<string, number>) => Object.fromEntries(COUNT_TABLES.map((table) => [table, after[table] - before[table]])) as Record<string, number>
  // Every stored byte of a Claim's freezes, evidence packages and entries and its review history, as one digest.
  const freezeHash = async (claimId: string) =>
    (
      await prisma.$queryRaw<{ h: string }[]>`SELECT encode(sha256(convert_to(
        coalesce((SELECT string_agg(row_to_json(f)::text, '|' ORDER BY f.id) FROM claim_freezes f WHERE f.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(m)::text, '|' ORDER BY m.id) FROM claim_freeze_evidence_manifests m JOIN claim_freezes f ON f.id = m.claim_submission_id WHERE f.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(e)::text, '|' ORDER BY e.id) FROM claim_freeze_evidence_entries e JOIN claim_freeze_evidence_manifests m ON m.id = e.evidence_package_id JOIN claim_freezes f ON f.id = m.claim_submission_id WHERE f.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(r)::text, '|' ORDER BY r.sequence) FROM claim_review_events r WHERE r.claim_id = ${claimId}::uuid), ''),
        'UTF8')), 'hex') AS h`
    )[0].h
  const NOT_REFUSED = 'ROLLED_BACK'
  const refusedBy = (message: string, marker: RegExp) => message !== '' && !message.includes(NOT_REFUSED) && marker.test(message)
  const rolledBack = (write: (tx: any) => Promise<unknown>) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await write(tx)
        throw new Error(NOT_REFUSED)
      }),
    )
  // A second validation run at exactly the same instant cannot come from any owner path: it is copied from
  // the first, with the same evaluation and creation time and one finding, in one transaction (as A6.1/A6.3).
  const copyRunAtSameInstant = async (sourceRunId: string) => {
    const newRunId = (await prisma.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid()::text AS id`)[0].id
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO validation_runs (id, encounter_id, service_date, facility_id, facility_regulatory_profile_id, insurance_membership_id, payer_id, tpa_id, network_id, insurance_product_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at)
         SELECT $1::uuid, encounter_id, service_date, facility_id, facility_regulatory_profile_id, insurance_membership_id, payer_id, tpa_id, network_id, insurance_product_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at
         FROM validation_runs WHERE id = $2::uuid`,
        newRunId,
        sourceRunId,
      )
      await tx.$executeRawUnsafe(`INSERT INTO validation_findings (id, validation_run_id, sequence, layer, outcome, finding_code, message) VALUES (gen_random_uuid(), $1::uuid, 1, 'TECHNICAL', 'PASS', 'SYNTHETIC_COPY', 'Synthetic copy.')`, newRunId)
    })
    return newRunId
  }

  // ---- the other organization, built by its own Admin through the same owner routes
  const foreign = await (async () => {
    const at = (path: string, body: unknown) => post(path, body, O.who)
    const fPatient = must('foreign patient', (await at(`/api/organizations/${otherOrg}/patients`, { givenName: 'Synthetic', familyName: `${runId}-FP`, dateOfBirth: '1991-02-02' })).body)
    const fFacility = must('foreign facility', (await at(`/api/organizations/${otherOrg}/facilities`, { name: `${runId} foreign facility` })).body)
    const fProfile = must('foreign profile', (await at(`/api/facilities/${fFacility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    if ((await at(`/api/facility-regulatory-profiles/${fProfile.id}/activate`, {})).status !== 200) throw new Error('fixture foreign profile activation failed')
    const fClinician = must('foreign clinician', (await at(`/api/organizations/${otherOrg}/clinicians`, { displayName: `${runId} foreign clinician` })).body)
    must('foreign assignment', (await at(`/api/clinicians/${fClinician.id}/facility-assignments`, { facilityId: fFacility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    const fService = must('foreign service', (await at(`/api/organizations/${otherOrg}/services`, { internalCode: key('FS'), displayName: `${runId} foreign service` })).body)
    const fDx = must('foreign diagnosis', (await at(`/api/organizations/${otherOrg}/diagnosis-codes`, { code: key('FDX'), displayName: `${runId} foreign diagnosis` })).body)
    const fResponse = await evidenceArtifact(otherOrg, 'SYNTHETIC_RESPONSE', '2026-06-10', O.who)
    const fPayer = must('foreign payer', (await at(`/api/organizations/${otherOrg}/payers`, { displayName: `${runId} foreign payer` })).body)
    const fMembership = must('foreign membership', (await at(`/api/patients/${fPatient.id}/insurance-memberships`, { payerId: fPayer.id, memberIdentifier: `MEM-${key('FM')}`, coverageFrom: '2025-01-01', coverageTo: null })).body)
    const fContract = must('foreign contract', (await at(`/api/organizations/${otherOrg}/provider-contracts`, { contractKey: key('FC'), displayName: `${runId} foreign contract`, payerId: fPayer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    must('foreign contract facility', (await at(`/api/provider-contracts/${fContract.id}/contract-facilities`, { facilityId: fFacility.id })).body)
    const fSchedule = must('foreign schedule', (await at(`/api/provider-contracts/${fContract.id}/tariff-schedules`, { tariffKey: key('FT'), displayName: `${runId} foreign tariff` })).body)
    const fVersion = must('foreign version', (await at(`/api/tariff-schedules/${fSchedule.id}/versions`, { version: key('FV'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
    if ((await at(`/api/tariff-schedule-versions/${fVersion.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error('fixture foreign tariff verification failed')
    const fEncounter = must('foreign encounter', (await at(`/api/patients/${fPatient.id}/encounters`, { facilityId: fFacility.id, clinicianId: fClinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: fMembership.id })).body)
    must('foreign activity', (await at(`/api/encounters/${fEncounter.id}/activities`, { serviceId: fService.id, quantity: '1' })).body)
    must('foreign encounter diagnosis', (await at(`/api/encounters/${fEncounter.id}/diagnoses`, { diagnosisCodeId: fDx.id })).body)
    must(
      'foreign eligibility',
      (await at(`/api/encounters/${fEncounter.id}/eligibility-verifications`, {
        verificationMethod: 'PORTAL', status: 'ELIGIBLE', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z', validThrough: FRESH_UNTIL, authorizationRequired: false, referralRequired: null,
        requestEvidenceVersionId: null, responseEvidenceVersionId: fResponse.versionId,
      })).body,
    )
    const fRunId = await execute(fEncounter.id, O.who)
    const fReadiness = await readinessOf(fRunId, O.who)
    const fClaim = fReadiness.state === 'READY_FOR_REVIEW' ? (await claimHttp(fReadiness.id, O.who)).body : null
    if (!fClaim?.id) throw new Error(`fixture: the other organization's Claim could not be created (${fReadiness.state})`)
    return { encounterId: fEncounter.id as string, readinessId: fReadiness.id, claimId: fClaim.id as string }
  })()
  progress(`world ready: AE-DU/DHA facility, verified AED tariff ${version.id}, governed documentation rule ${ruleVersion.id}, reviewers B and C, and the other organization's own Claim`)

  // ---------------------------------------------------------------- A5.8 / A5.9 (T011–T020)
  section('A5.8 validation and A5.9 readiness: currentness, exact handoff, tenancy, supersession and ambiguity')
  const W = await chainOf('worked journey')
  const runW = await prisma.validationRun.findUniqueOrThrow({ where: { id: W.validationRunId } })
  const findingsW = await prisma.validationFinding.findMany({ where: { validationRunId: W.validationRunId }, orderBy: { sequence: 'asc' } })
  check(
    'T011',
    'Real A5.8 validation',
    runW.validatorVersion === 'A5-VAL-1' && runW.encounterId === W.encounterId && findingsW.length > 0 && findingsW.every((f) => f.outcome === 'PASS' || f.outcome === 'WARNING') &&
      findingsW.some((f) => f.findingCode === 'CONTRACT_CONTEXT_RESOLVED' && f.outcome === 'PASS') &&
      runW.providerContractId === contract.id && runW.tariffScheduleId === schedule.id && runW.tariffScheduleVersionId === version.id && runW.payerId === payer.id,
    `the A5.8 engine (its own route) recorded ${findingsW.length} PASS/WARNING findings and resolved exactly this contract, schedule and verified tariff version`,
  )
  check(
    'T012',
    'A5.9 READY_FOR_REVIEW',
    W.readiness.state === 'READY_FOR_REVIEW' && W.readiness.readinessPolicyVersion === 'A5-READY-1' && W.readiness.validationRunId === W.validationRunId,
    'an immutable READY_FOR_REVIEW assessment under A5-READY-1 of exactly this run',
  )
  const handoffW = await get(`/api/pre-claim-readiness-assessments/${W.readinessId}/a6-handoff`)
  const refs = handoffW.body?.exactReferences ?? {}
  check(
    'T013',
    'Exact handoff references',
    handoffW.status === 200 && handoffW.body?.schemaVersion === 'PreClaimA6HandoffV1' && handoffW.body?.validationRun?.id === W.validationRunId &&
      handoffW.body?.validationRun?.context?.tariffScheduleVersionId === version.id &&
      W.activityIds.every((id) => refs.encounterActivityIds?.includes(id)) && W.encounterDiagnosisIds.every((id) => refs.encounterDiagnosisIds?.includes(id)) &&
      refs.eligibilityVerificationIds?.includes(W.eligibilityId) && refs.ruleVersionIds?.includes(ruleVersion.id) && refs.evidenceRequirementIds?.includes(requirement.body?.id) &&
      refs.governingSourceVersionIds?.includes(governing.sourceVersion.id),
    'PreClaimA6HandoffV1 names both activities, both diagnoses, the eligibility, the governed rule version, its governing source version and the satisfied evidence requirement',
  )
  const runBeforeW = JSON.stringify(runW)
  const findingsBeforeW = JSON.stringify(findingsW)
  const readinessBeforeW = JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: W.readinessId } }))
  const claimW = await claimFrom(W)
  const claimAuditW = await prisma.auditEvent.findMany({ where: { entityId: claimW.id }, select: { actionCode: true, organizationId: true } })
  check(
    'T014',
    'Exact handoff binding',
    claimW.preClaimReadinessAssessmentId === W.readinessId && claimW.encounterId === W.encounterId && claimW.claimContractVersion === 'A6-CLAIM-1' && claimW.handoffSchemaVersion === 'PreClaimA6HandoffV1' &&
      claimW.createdByUserId === creatorId && claimAuditW.length === 1 && claimAuditW[0].actionCode === 'claim.created' && claimAuditW[0].organizationId === org,
    `Claim ${claimW.id} binds exactly the READY assessment and its Encounter under A6-CLAIM-1; one claim.created audit`,
  )
  const SUP = await chainOf('superseded handoff')
  const supNewer = await readinessOf(await execute(SUP.encounterId))
  const supClaim = await claimHttp(SUP.readinessId)
  const supHandoff = await get(`/api/pre-claim-readiness-assessments/${SUP.readinessId}/a6-handoff`)
  check(
    'T015',
    'Superseded handoff refused',
    supNewer.state === 'READY_FOR_REVIEW' && supClaim.status === 409 && errorCode(supClaim.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION' && supHandoff.status === 409 &&
      (await prisma.claim.count({ where: { preClaimReadinessAssessmentId: SUP.readinessId } })) === 0,
    'a newer A5.8 run of the same Encounter supersedes the older READY assessment: its handoff and Claim are refused (409 READINESS_SUPERSEDED_BY_NEWER_VALIDATION)',
  )
  const TIE = await chainOf('recency tie')
  await copyRunAtSameInstant(TIE.validationRunId)
  const tieClaim = await claimHttp(TIE.readinessId)
  check(
    'T016',
    'Recency ambiguity refused',
    tieClaim.status === 409 && errorCode(tieClaim.body) === 'VALIDATION_RUN_RECENCY_AMBIGUOUS' && (await prisma.claim.count({ where: { preClaimReadinessAssessmentId: TIE.readinessId } })) === 0,
    'two runs at one instant: 409 VALIDATION_RUN_RECENCY_AMBIGUOUS; no identifier wins',
  )
  const BLK = await chainOf('blocked', MAIN, { status: 'INELIGIBLE' })
  const blkHandoff = await get(`/api/pre-claim-readiness-assessments/${BLK.readinessId}/a6-handoff`)
  const blkClaim = await claimHttp(BLK.readinessId)
  check(
    'T017',
    'Not READY refused',
    BLK.readiness.state === 'BLOCKED' && blkHandoff.status === 409 && errorCode(blkHandoff.body) === 'PRECLAIM_NOT_READY_FOR_HANDOFF' && blkClaim.status === 409 && errorCode(blkClaim.body) === 'PRECLAIM_NOT_READY_FOR_CLAIM',
    'an INELIGIBLE Encounter is BLOCKED: no handoff contract and no Claim (409)',
  )
  const MT = await chainOf('tenant binding')
  const leaks = (body: unknown) => /READY_FOR_REVIEW|exactReferences|findingCode|validationRunId|encounterId|facilityId/.test(JSON.stringify(body ?? {}))
  const tenantAttempts = [await claimHttp(MT.readinessId, O.who), await claimHttp(foreign.readinessId), await get(`/api/pre-claim-readiness-assessments/${MT.readinessId}/a6-handoff`, O.who), await get(`/api/pre-claim-readiness-assessments/${foreign.readinessId}/a6-handoff`)]
  check(
    'T018',
    'Multi-tenant binding',
    tenantAttempts.every((res) => (res.status === 403 || res.status === 404) && !leaks(res.body)) &&
      (await prisma.claim.count({ where: { preClaimReadinessAssessmentId: MT.readinessId } })) === 0 && (await prisma.claim.count({ where: { preClaimReadinessAssessmentId: foreign.readinessId } })) === 1,
    `another organization can neither read nor bind this READY assessment, nor this tenant the other's (${tenantAttempts.map((r) => r.status).join('/')}); nothing disclosed or written`,
  )
  const duplicateClaim = await claimHttp(W.readinessId)
  check('T019', 'One Claim per assessment', duplicateClaim.status === 409 && errorCode(duplicateClaim.body) === 'CLAIM_ALREADY_EXISTS' && (await prisma.claim.count({ where: { preClaimReadinessAssessmentId: W.readinessId } })) === 1, '409 CLAIM_ALREADY_EXISTS; the first Claim is unchanged')
  const a5Unchanged = async () =>
    JSON.stringify(await prisma.validationRun.findUniqueOrThrow({ where: { id: W.validationRunId } })) === runBeforeW &&
    JSON.stringify(await prisma.validationFinding.findMany({ where: { validationRunId: W.validationRunId }, orderBy: { sequence: 'asc' } })) === findingsBeforeW &&
    JSON.stringify(await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: W.readinessId } })) === readinessBeforeW
  check('T020', 'A5 history immutable', await a5Unchanged(), 'the bound run, its findings and the READY assessment are byte-identical after the Claim (and again at the end, T129)')

  // ---------------------------------------------------------------- A6.1 / A6.2 (T021–T030)
  section('A6.1 identity and A6.2 lines, diagnoses and pointers: traceability and prohibited edits')
  const readClaimW = await get(`/api/claims/${claimW.id}`)
  const claimColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims'`).map((row) => row.c)
  check(
    'T021',
    'Claim identity',
    readClaimW.status === 200 && readClaimW.body?.id === claimW.id && readClaimW.body?.source?.validationRunId === W.validationRunId && readClaimW.body?.source?.readinessState === 'READY_FOR_REVIEW' &&
      claimColumns.length === 7 && !claimColumns.some((c) => /status|state|current|latest|price|amount|approv|submi|payload/i.test(c)),
    'the read names exactly the bound run; the Claim row keeps its seven columns with no status, pointer, price, approval or payload',
  )
  const structW = await structureOf(claimW.id, W)
  const lineRowsW = await prisma.claimLine.findMany({ where: { claimId: claimW.id }, orderBy: { sequence: 'asc' }, include: { sources: true } })
  check(
    'T022',
    'Lines trace their sources',
    same(lineRowsW.map((l) => [l.id, l.sequence, l.claimLineContractVersion, l.removedAt, l.sources.map((s: any) => s.encounterActivityId)]), structW.lineIds.map((id, i) => [id, i + 1, 'A6-LINE-1', null, [W.activityIds[i]]])),
    'two active A6-LINE-1 lines at positions 1..2, each traced to exactly its handoff activity',
  )
  const dxRowsW = await prisma.claimDiagnosis.findMany({ where: { claimId: claimW.id }, orderBy: { sequence: 'asc' } })
  check(
    'T023',
    'Diagnoses trace their sources',
    same(dxRowsW.map((d) => [d.id, d.sequence, d.roleCode, d.encounterDiagnosisId, d.claimDiagnosisContractVersion]), [[structW.claimDiagnosisIds[0], 1, 'PRIMARY', W.encounterDiagnosisIds[0], 'A6-DX-1'], [structW.claimDiagnosisIds[1], 2, 'SECONDARY', W.encounterDiagnosisIds[1], 'A6-DX-1']]),
    'PRIMARY then SECONDARY, each traced to exactly its handoff diagnosis (A6-DX-1)',
  )
  const pointerRowsW = await prisma.$queryRaw<{ line: string; dx: string }[]>`SELECT claim_line_id::text AS line, claim_diagnosis_id::text AS dx FROM claim_line_diagnosis_pointers WHERE claim_line_id IN (${structW.lineIds[0]}::uuid, ${structW.lineIds[1]}::uuid) ORDER BY claim_line_id`
  check('T024', 'Pointers', pointerRowsW.length === 2 && pointerRowsW.every((row) => row.dx === structW.claimDiagnosisIds[0]) && same(sortedSet(pointerRowsW.map((r) => r.line)), sortedSet(structW.lineIds)), 'each line points to the PRIMARY diagnosis of the same Claim')
  const X = await subjectOf('structure refusals')
  const lateActivity = must('late activity', (await post(`/api/encounters/${X.encounterId}/activities`, { serviceId: svcB.id, quantity: '1' })).body)
  const before25 = await counts()
  const notInHandoff = await post(`/api/claims/${X.claimId}/lines`, { encounterActivityId: lateActivity.id })
  check('T025', 'Activity outside the handoff', notInHandoff.status === 409 && errorCode(notInHandoff.body) === 'CLAIM_SOURCE_NOT_IN_HANDOFF', 'an activity added after validation was never validated: 409 CLAIM_SOURCE_NOT_IN_HANDOFF')
  const wrongEncounter = await post(`/api/claims/${X.claimId}/lines`, { encounterActivityId: W.activityIds[0] })
  check('T026', 'Cross-Claim source', wrongEncounter.status === 409 && errorCode(wrongEncounter.body) === 'CLAIM_SOURCE_ENCOUNTER_MISMATCH', "another Claim's Encounter activity: 409 CLAIM_SOURCE_ENCOUNTER_MISMATCH")
  const duplicateLine = await post(`/api/claims/${X.claimId}/lines`, { encounterActivityId: X.activityIds[0] })
  check('T027', 'Duplicate active line', duplicateLine.status === 409 && errorCode(duplicateLine.body) === 'CLAIM_LINE_SOURCE_ALREADY_ACTIVE', 'the same activity twice: 409 CLAIM_LINE_SOURCE_ALREADY_ACTIVE')
  const crossPointer = await setPointers(X.lineIds[0], [structW.claimDiagnosisIds[0]])
  check('T028', 'Cross-Claim pointer', crossPointer.status === 409 && errorCode(crossPointer.body) === 'CLAIM_DIAGNOSIS_POINTER_MISMATCH', "a pointer to another Claim's diagnosis: 409 CLAIM_DIAGNOSIS_POINTER_MISMATCH")
  const refusals25 = await unchanged(before25)
  const removedDx = await post(`/api/claim-diagnoses/${X.claimDiagnosisIds[1]}/remove`, {})
  const toRemoved = await setPointers(X.lineIds[0], [X.claimDiagnosisIds[0], X.claimDiagnosisIds[1]])
  const removedLine = await post(`/api/claim-lines/${X.lineIds[1]}/remove`, {})
  const removeAgain = await post(`/api/claim-lines/${X.lineIds[1]}/remove`, {})
  check(
    'T029',
    'Removed structure is inactive',
    removedDx.status === 200 && toRemoved.status === 409 && errorCode(toRemoved.body) === 'CLAIM_STRUCTURE_INACTIVE' && removedLine.status === 200 && removeAgain.status === 409 && errorCode(removeAgain.body) === 'CLAIM_STRUCTURE_INACTIVE',
    'a removed diagnosis cannot be pointed to and a removed line cannot be removed again (409 CLAIM_STRUCTURE_INACTIVE); nothing is hard-deleted',
  )
  const before30 = await counts()
  const foreignEdits = [
    await post(`/api/claims/${X.claimId}/lines`, { encounterActivityId: lateActivity.id }, asViewer),
    await post(`/api/claims/${X.claimId}/lines`, { encounterActivityId: lateActivity.id }, O.who),
    await post(`/api/claims/${foreign.claimId}/lines`, { encounterActivityId: X.activityIds[0] }),
    await setPointers(X.lineIds[0], [X.claimDiagnosisIds[0]], O.who),
  ]
  check(
    'T030',
    'Viewer and foreign edits refused',
    foreignEdits[0].status === 403 && foreignEdits.slice(1).every((res) => res.status === 403 || res.status === 404) && refusals25 && (await unchanged(before30)),
    `a Viewer (403) and the other organization (${foreignEdits.slice(1).map((r) => r.status).join('/')}) change nothing; T025–T028 refusals wrote no row or audit`,
  )

  // ---------------------------------------------------------------- A6.3 (T031–T040)
  section('A6.3 pricing: exact verified version, decimal totals, missing/ambiguous/mismatched/stale fail closed, immutable runs')
  const pricingW = await price(claimW.id)
  const lineOf = (pricingRun: any, claimLineId: string) => (pricingRun?.lines ?? []).find((line: any) => line.claimLineId === claimLineId)
  check(
    'T031',
    'Exact bound tariff version',
    pricingW.pricingContractVersion === 'A6-PRICE-1' && pricingW.tariffScheduleVersionId === version.id && pricingW.providerContractId === contract.id && pricingW.tariffScheduleId === schedule.id,
    'A6-PRICE-1 against exactly the contract, schedule and verified version the A5.8 run resolved',
  )
  const storedRunW = await prisma.claimPricingRun.findUniqueOrThrow({ where: { id: pricingW.id } })
  check(
    'T032',
    'Decimal worked example',
    lineOf(pricingW, structW.lineIds[0])?.extendedTariffAmount === '187.88' && lineOf(pricingW, structW.lineIds[0])?.unitTariffAmount === '125.2500' && lineOf(pricingW, structW.lineIds[0])?.tariffRateId === rateProcA.id &&
      lineOf(pricingW, structW.lineIds[1])?.extendedTariffAmount === '12.13' && lineOf(pricingW, structW.lineIds[1])?.tariffRateId === rateSvcB.id &&
      pricingW.overallResult === 'PRICED' && pricingW.totalExtendedTariffAmount === '200.01' && pricingW.currencyCode === 'AED' && storedRunW.totalExtendedAmount?.toFixed(4) === '200.0100',
    '1.5 × AED 125.2500 = 187.875 → 187.88; 1 × AED 12.1250 → 12.13 (half-up); PRICED total AED 200.01 stored as exact NUMERIC',
  )
  const pricedOutcome = async (label: string, activities: ActivitySpec[]) => {
    const subject = await subjectOf(label, activities)
    const pricing = await price(subject.claimId)
    return { subject, pricing, line: lineOf(pricing, subject.lineIds[0]) }
  }
  const MR = await pricedOutcome('missing rate', [{ procedureCodeId: procB.id, quantity: '1' }])
  check('T033', 'Missing rate fails closed', MR.line?.outcome === 'UNPRICED_RATE_MISSING' && MR.line?.extendedTariffAmount === null && MR.pricing.overallResult === 'INCOMPLETE' && MR.pricing.totalExtendedTariffAmount === null, 'no rate for the activity: UNPRICED_RATE_MISSING; INCOMPLETE run with no total')
  const AMB = await pricedOutcome('ambiguous rate', [{ serviceId: svcA.id, procedureCodeId: procA.id, quantity: '1' }])
  check('T034', 'Ambiguous rate fails closed', AMB.line?.outcome === 'UNPRICED_RATE_AMBIGUOUS' && AMB.line?.extendedTariffAmount === null && AMB.pricing.overallResult === 'INCOMPLETE', 'a Service rate and a Procedure rate both match: UNPRICED_RATE_AMBIGUOUS, never a priority')
  const MM = await pricedOutcome('mismatched signature', [{ procedureCodeId: procA.id, quantity: '1', modifierCodes: ['M1'] }])
  check('T035', 'Mismatched selector fails closed', MM.line?.outcome === 'UNPRICED_RATE_MISSING' && MM.line?.tariffRateId === null && MM.pricing.overallResult === 'INCOMPLETE', 'an [M1] activity does not match the empty-modifier rate: UNPRICED_RATE_MISSING, no nearest price')
  const ST = await subjectOf('stale basis')
  const pricingST = await price(ST.claimId)
  await execute(ST.encounterId)
  const stalePrice = await priceHttp(ST.claimId)
  check(
    'T036',
    'Stale basis fails closed',
    stalePrice.status === 409 && errorCode(stalePrice.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION' && (await prisma.claimPricingRun.count({ where: { claimId: ST.claimId } })) === 1,
    'after a newer A5.8 run of the Encounter, pricing the old Claim is refused (409); the earlier run stays the only one',
  )
  const runAttacks = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_pricing_runs SET overall_result = 'INCOMPLETE' WHERE id = $1::uuid`, pricingW.id)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_pricing_runs WHERE id = $1::uuid`, pricingW.id)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_pricing_line_results SET extended_amount = 1 WHERE pricing_run_id = $1::uuid`, pricingW.id)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_pricing_line_results WHERE pricing_run_id = $1::uuid`, pricingW.id)),
  ]
  check('T037', 'Pricing runs append-only', runAttacks.every((message) => /append-only/.test(message)), 'UPDATE and DELETE of a run or a line result are refused by the database')
  const run1Read = JSON.stringify((await get(`/api/claim-pricing-runs/${pricingW.id}`)).body)
  const repeatA = await price(claimW.id)
  const repeatB = await price(claimW.id)
  check(
    'T038',
    'Immutable runs compare exactly',
    repeatA.id !== repeatB.id && repeatA.id !== pricingW.id && repeatA.inputStructureFingerprint === pricingW.inputStructureFingerprint && repeatB.inputStructureFingerprint === pricingW.inputStructureFingerprint &&
      repeatA.totalExtendedTariffAmount === '200.01' && repeatB.totalExtendedTariffAmount === '200.01' && JSON.stringify((await get(`/api/claim-pricing-runs/${pricingW.id}`)).body) === run1Read,
    'two later runs of the unchanged Claim are new immutable runs with the identical fingerprint and total; the first reads back byte-identical',
  )
  // A newer VERIFIED version of the same schedule, effective only after the service date, with a different
  // price: the bound version is still the only one priced, and no run can name another version.
  const newerVersion = must('newer version', (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V2'), effectiveFrom: '2026-06-16', effectiveTo: null })).body)
  must('newer rate', (await rate(newerVersion.id, { selectorKind: 'PROCEDURE_CODE', procedureCodeId: procA.id, unitTariffAmount: '999.0000' })).body)
  await post(`/api/tariff-schedule-versions/${newerVersion.id}/verification`, { verificationStatus: 'VERIFIED' })
  const afterNewer = await price(claimW.id)
  const forgedRun = await rolledBack((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO claim_pricing_runs (id, claim_id, pricing_contract_version, tariff_schedule_version_id, provider_contract_id, tariff_schedule_id, evaluated_at, created_by_user_id, input_structure_fingerprint, overall_result, line_count, priced_count, currency_code, total_extended_amount) VALUES (gen_random_uuid(), $1::uuid, 'A6-PRICE-1', $2::uuid, $3::uuid, $4::uuid, now(), $5::uuid, repeat('a', 64), 'INCOMPLETE', 0, 0, NULL, NULL)`,
      claimW.id,
      newerVersion.id,
      contract.id,
      schedule.id,
      creatorId,
    ),
  )
  check(
    'T039',
    'No version substitution',
    afterNewer.tariffScheduleVersionId === version.id && lineOf(afterNewer, structW.lineIds[0])?.extendedTariffAmount === '187.88' && refusedBy(forgedRun, /pricing_commercial_context_unresolved/),
    'a newer verified version (AED 999) exists; pricing still uses the bound version (187.88), and a run naming another version is refused by the database',
  )
  const RS = await subjectOf('removed source')
  await post(`/api/encounter-activities/${RS.activityIds[0]}/remove`, {})
  const pricingRS = await price(RS.claimId)
  check('T040', 'Removed source fails closed', lineOf(pricingRS, RS.lineIds[0])?.outcome === 'UNPRICED_SOURCE_INVALID' && pricingRS.overallResult === 'INCOMPLETE', 'a line whose source activity was removed is UNPRICED_SOURCE_INVALID, never priced')

  // ---------------------------------------------------------------- A6.4 (T041–T050)
  section('A6.4 draft assessment: REVIEWABLE only when complete and current, drift, fingerprint repeatability, precedence')
  const assessmentW = await assess(claimW.id, pricingW.id)
  check(
    'T041',
    'REVIEWABLE worked draft',
    assessmentW.outcome === 'REVIEWABLE' && assessmentW.draftContractVersion === 'A6-DRAFT-1' && assessmentW.pricingRunId === pricingW.id && assessmentW.handoffAssessmentId === W.readinessId &&
      assessmentW.activeLineCount === 2 && assessmentW.activeDiagnosisCount === 2 && /^[0-9a-f]{64}$/.test(assessmentW.assemblyFingerprint),
    `REVIEWABLE under A6-DRAFT-1 for exactly this pricing run and handoff; fingerprint ${assessmentW.assemblyFingerprint.slice(0, 12)}…`,
  )
  const assessmentW2 = await assess(claimW.id, pricingW.id)
  const draftReads = [await get(`/api/claims/${claimW.id}/draft?pricingRunId=${pricingW.id}`), await get(`/api/claims/${claimW.id}/draft?pricingRunId=${pricingW.id}`)]
  check(
    'T042',
    'Fingerprint repeatability',
    assessmentW2.id !== assessmentW.id && assessmentW2.assemblyFingerprint === assessmentW.assemblyFingerprint && assessmentW2.pricingInputFingerprint === assessmentW.pricingInputFingerprint &&
      draftReads.every((res) => res.status === 200 && res.body?.assemblyFingerprint === assessmentW.assemblyFingerprint),
    'a second assessment and two draft previews of the unchanged draft give the identical fingerprint',
  )
  const assessedMR = await assess(MR.subject.claimId, MR.pricing.id, 'INCOMPLETE')
  check('T043', 'INCOMPLETE pricing is not reviewable', assessedMR.outcome === 'INCOMPLETE', 'an INCOMPLETE pricing run gives an INCOMPLETE draft, never REVIEWABLE')
  const LR = await subjectOf('line removed after pricing')
  const pricingLR = await price(LR.claimId)
  await post(`/api/claim-lines/${LR.lineIds[1]}/remove`, {})
  const assessedLR = await assess(LR.claimId, pricingLR.id, 'STALE')
  check('T044', 'Mutation stales the draft', assessedLR.outcome === 'STALE', 'a line removed after pricing: the old run no longer matches the draft — STALE')
  const assessedST = await assess(ST.claimId, pricingST.id, 'INVALID')
  check('T045', 'Superseded handoff is INVALID', assessedST.outcome === 'INVALID', 'after a newer A5.8 run the bound handoff is no longer current: INVALID')
  await execute(LR.encounterId)
  const assessedLR2 = await assess(LR.claimId, pricingLR.id, 'INVALID')
  check('T046', 'Failure precedence', assessedLR2.outcome === 'INVALID' && assessedLR.outcome === 'STALE', 'stale pricing AND a superseded handoff: INVALID takes precedence over STALE')
  const PD = await subjectOf('pointer drift')
  const pricingPD = await price(PD.claimId)
  const assessedPD = await assess(PD.claimId, pricingPD.id)
  await setPointers(PD.lineIds[0], PD.claimDiagnosisIds)
  const assessedPD2 = await assess(PD.claimId, pricingPD.id)
  check('T047', 'Draft drift changes the fingerprint', assessedPD2.outcome === 'REVIEWABLE' && assessedPD2.assemblyFingerprint !== assessedPD.assemblyFingerprint, 'a pointer change with the same prices gives a new fingerprint; the old one no longer describes the draft')
  const assessmentAttacks = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_draft_assessments SET outcome = 'REVIEWABLE' WHERE id = $1::uuid`, assessedMR.id)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_draft_assessments WHERE id = $1::uuid`, assessedMR.id)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_draft_findings WHERE draft_assessment_id = $1::uuid`, assessedMR.id)),
  ]
  check('T048', 'Assessments append-only', assessmentAttacks.every((message) => /append-only/.test(message)), 'an assessment and its findings cannot be updated or deleted')
  const before49 = await counts()
  const crossRun = [await assessHttp(claimW.id, MR.pricing.id), await assessHttp(claimW.id, MISSING)]
  check('T049', "Another Claim's pricing run", crossRun.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && (await unchanged(before49)), "another Claim's run is answered like a missing one (404); never substituted, nothing written")
  const viewerAssess = await assessHttp(claimW.id, pricingW.id, asViewer)
  const viewerReadAssessment = await get(`/api/claim-draft-assessments/${assessmentW.id}`, asViewer)
  check('T050', 'Viewer reads, never assesses', viewerAssess.status === 403 && viewerReadAssessment.status === 200 && viewerReadAssessment.body?.assemblyFingerprint === assessmentW.assemblyFingerprint && (await unchanged(before49)), 'a Viewer cannot assess (403) and reads the same assessment (200)')

  // ---------------------------------------------------------------- A6.5 (T051–T060)
  section('A6.5 human review: separation of duties, exact fingerprint, RETURN/REJECT/REVOKE grant nothing, stale authority')
  const before51 = await counts()
  const selfApprove = await decide(claimW.id, approveBody(assessmentW), asAdmin)
  check('T051', 'Creator cannot approve', selfApprove.status === 409 && errorCode(selfApprove.body) === 'CLAIM_REVIEW_SEPARATION_REQUIRED' && (await unchanged(before51)), 'the Admin who created the Claim and its assessment: 409 CLAIM_REVIEW_SEPARATION_REQUIRED; no decision and no audit')
  const approvedW = await decide(claimW.id, approveBody(assessmentW))
  const approvalW = approvedW.body?.decision?.id as string
  const authorityW = await get(`/api/claims/${claimW.id}/review-authority`)
  check(
    'T052',
    'Separate reviewer approves',
    approvedW.status === 201 && approvedW.body?.decision?.decisionCode === 'APPROVE' && approvedW.body?.decision?.approvalFingerprint === assessmentW.assemblyFingerprint && approvedW.body?.decision?.reviewContractVersion === 'A6-REVIEW-1' &&
      approvedW.body?.authority?.state === 'APPROVED_CURRENT' && authorityW.body?.state === 'APPROVED_CURRENT' && authorityW.body?.decisionId === approvalW,
    'reviewer B approves the exact draft and fingerprint: APPROVED_CURRENT under A6-REVIEW-1',
  )
  const RT = await subjectOf('review outcomes')
  const pricingRT = await price(RT.claimId)
  const assessmentRT = await assess(RT.claimId, pricingRT.id)
  const before53 = await counts()
  const wrongFingerprint = await decide(RT.claimId, { ...approveBody(assessmentRT), assemblyFingerprint: assessmentRT.assemblyFingerprint === 'c'.repeat(64) ? 'd'.repeat(64) : 'c'.repeat(64) })
  check('T053', 'Exact fingerprint only', wrongFingerprint.status === 409 && errorCode(wrongFingerprint.body) === 'CLAIM_REVIEW_STALE' && (await unchanged(before53)), "a well-formed fingerprint that is not the assessment's own: 409 CLAIM_REVIEW_STALE")
  const notReviewable = await decide(MR.subject.claimId, approveBody(assessedMR))
  check('T054', 'Only REVIEWABLE is approvable', notReviewable.status === 409 && errorCode(notReviewable.body) === 'CLAIM_REVIEW_NOT_REVIEWABLE' && (await unchanged(before53)), 'an INCOMPLETE draft: 409 CLAIM_REVIEW_NOT_REVIEWABLE; no hidden override')
  const returned = await decide(RT.claimId, { draftAssessmentId: assessmentRT.id, assemblyFingerprint: assessmentRT.assemblyFingerprint, decisionCode: 'RETURN', reasonCode: 'REVIEW_DOCUMENTATION_REQUIRED' }, asAdmin)
  const freezeReturned = await freezeHttp(RT.claimId, assessmentRT.id, returned.body?.decision?.id ?? MISSING)
  check(
    'T055',
    'RETURN grants nothing',
    returned.status === 201 && returned.body?.authority?.state === 'NOT_APPROVED' && freezeReturned.status === 409 && errorCode(freezeReturned.body) === 'CLAIM_SUBMISSION_NOT_APPROVED',
    'a RETURN (the creator may send a draft back) leaves NOT_APPROVED; naming it as an approval freezes nothing (CLAIM_SUBMISSION_NOT_APPROVED)',
  )
  const rejected = await decide(RT.claimId, { draftAssessmentId: assessmentRT.id, assemblyFingerprint: assessmentRT.assemblyFingerprint, decisionCode: 'REJECT', reasonCode: 'REVIEW_INTEGRITY_CONCERN' })
  const freezeRejected = await freezeHttp(RT.claimId, assessmentRT.id, rejected.body?.decision?.id ?? MISSING)
  check(
    'T056',
    'REJECT grants nothing',
    rejected.status === 201 && rejected.body?.authority?.state === 'NOT_APPROVED' && freezeRejected.status === 409 && errorCode(freezeRejected.body) === 'CLAIM_SUBMISSION_NOT_APPROVED',
    'a REJECT leaves NOT_APPROVED and freezes nothing',
  )
  const assessmentRT1 = await assess(RT.claimId, pricingRT.id)
  const approvalRT = await approve(RT.claimId, assessmentRT1)
  const currentRT1 = (await get(`/api/claims/${RT.claimId}/review-authority`)).body?.state
  const revokedRT = await decide(RT.claimId, revokeBody(assessmentRT1, approvalRT))
  const freezeRevoked = await freezeHttp(RT.claimId, assessmentRT1.id, approvalRT)
  check(
    'T057',
    'REVOKE withdraws authority',
    currentRT1 === 'APPROVED_CURRENT' && revokedRT.status === 201 && revokedRT.body?.authority?.state === 'NOT_APPROVED' && freezeRevoked.status === 409 && errorCode(freezeRevoked.body) === 'CLAIM_SUBMISSION_NOT_APPROVED',
    'APPROVED_CURRENT, then REVOKE: NOT_APPROVED; the withdrawn approval authorizes no freeze',
  )
  const previewRevoked = await post(`/api/claims/${RT.claimId}/canonical-payload/preview`, { draftAssessmentId: assessmentRT1.id, approvalDecisionId: approvalRT })
  const assessmentRT2 = await assess(RT.claimId, pricingRT.id)
  const approvalRT2 = await approve(RT.claimId, assessmentRT2, C.who)
  const currentRT2 = (await get(`/api/claims/${RT.claimId}/review-authority`)).body?.state
  await post(`/api/claim-lines/${RT.lineIds[1]}/remove`, {})
  const staleRT2 = (await get(`/api/claims/${RT.claimId}/review-authority`)).body?.state
  const freezeStale = await freezeHttp(RT.claimId, assessmentRT2.id, approvalRT2)
  const previewStale = await post(`/api/claims/${RT.claimId}/canonical-payload/preview`, { draftAssessmentId: assessmentRT2.id, approvalDecisionId: approvalRT2 })
  check(
    'T058',
    'Stale authority',
    currentRT2 === 'APPROVED_CURRENT' && staleRT2 === 'APPROVAL_STALE' && freezeStale.status === 409 && errorCode(freezeStale.body) === 'CLAIM_SUBMISSION_STALE' && (await prisma.claimFreeze.count({ where: { claimId: RT.claimId } })) === 0,
    'a fresh approval becomes APPROVAL_STALE after a line removal; the freeze is refused (CLAIM_SUBMISSION_STALE) and nothing is frozen',
  )
  const before59 = await counts()
  const outsiders = [await decide(RT.claimId, approveBody(assessmentRT2), asViewer), await decide(RT.claimId, approveBody(assessmentRT2), O.who), await decide(foreign.claimId, approveBody(assessmentRT2))]
  check('T059', 'Viewer and foreign reviewers refused', outsiders[0].status === 403 && outsiders.slice(1).every((res) => res.status === 403 || res.status === 404) && (await unchanged(before59)), `a Viewer (403) and the other organization (${outsiders.slice(1).map((r) => r.status).join('/')}) record no decision`)
  const insertDecisionSql = `INSERT INTO claim_review_events (id, claim_id, draft_assessment_id, reviewer_user_id, decision_code, sequence, approval_fingerprint, reason_code, referenced_approval_id, review_contract_version, reviewed_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'APPROVE', $4::int, $5, NULL, NULL, 'A6-REVIEW-1', now())`
  const PS = await reviewableOf('separation in the database')
  const dbSelf = await rolledBack((tx) => tx.$executeRawUnsafe(insertDecisionSql, PS.claimId, PS.assessment.id, creatorId, 1, PS.assessment.assemblyFingerprint))
  const dbSeparate = await rolledBack((tx) => tx.$executeRawUnsafe(insertDecisionSql, PS.claimId, PS.assessment.id, B.id, 1, PS.assessment.assemblyFingerprint))
  check('T060', 'Separation in the database', /claim_review_separation/.test(dbSelf) && dbSeparate.includes(NOT_REFUSED), 'a direct APPROVE by the creator is refused by the database; by a separate reviewer it is accepted (then rolled back)')

  // ---------------------------------------------------------------- A6.6 (T061–T070)
  section('A6.6 canonical payload: keys, UTF-8 bytes, digest consistency, read-only preview')
  const previewBodyW = { draftAssessmentId: assessmentW.id, approvalDecisionId: approvalW }
  const before61 = await counts()
  const previewW = await post(`/api/claims/${claimW.id}/canonical-payload/preview`, previewBodyW)
  const previewW2 = await post(`/api/claims/${claimW.id}/canonical-payload/preview`, previewBodyW)
  const payloadW = previewW.body?.payload
  check(
    'T061',
    'Preview contract',
    previewW.status === 200 && same(Object.keys(previewW.body ?? {}), ['schemaVersion', 'previewDigestSha256', 'byteLength', 'payload']) && previewW.body.schemaVersion === 'A6-PAYLOAD-1' && /^[0-9a-f]{64}$/.test(previewW.body.previewDigestSha256),
    `200 A6-PAYLOAD-1: digest ${previewW.body?.previewDigestSha256?.slice(0, 12)}…, ${previewW.body?.byteLength} bytes; the bytes themselves are never returned`,
  )
  check('T062', 'Two compositions agree', previewW2.status === 200 && same(previewW2.body, previewW.body), 'composing the same approved snapshot twice gives the identical payload, digest and byte length')
  const reencoded = encodeCanonicalPayload(payloadW, 2)
  const composedW = await withReadSnapshot(undefined, (tx) => composeCanonicalClaimPayload(claimW.id, assessmentW.id, approvalW, tx))
  check(
    'T063',
    'Owner encoder and composer agree',
    reencoded.sha256 === previewW.body.previewDigestSha256 && reencoded.bytes.length === previewW.body.byteLength && composedW.ok && composedW.sha256 === previewW.body.previewDigestSha256 && Buffer.compare(composedW.bytes, reencoded.bytes) === 0,
    'the HTTP preview, the in-process composer and a re-encoding of the returned payload give the same bytes and SHA-256',
  )
  const textW = composedW.ok ? composedW.bytes.toString('utf8') : ''
  const parsedW = textW ? JSON.parse(textW) : {}
  const keyOrderOk =
    same(Object.keys(parsedW), schemaKeys(payloadSchema)) &&
    ['header', 'commercial', 'financial', 'evidence', 'approval'].every((segment) => same(Object.keys(parsedW[segment] ?? {}), schemaKeys(schemaOf(segment).object))) &&
    ['lines', 'diagnoses'].every((segment) => (parsedW[segment] ?? []).every((item: object) => same(Object.keys(item), schemaKeys(schemaOf(segment).array?.object))))
  check('T064', 'Canonical key order', textW.length > 0 && keyOrderOk, 'every segment, line and diagnosis carries exactly the A6-PAYLOAD-1 keys in contract order')
  const bytesW = composedW.ok ? composedW.bytes : Buffer.alloc(0)
  check(
    'T065',
    'Exact UTF-8 bytes',
    bytesW.length === previewW.body.byteLength && bytesW[0] !== 0xef && bytesW.at(-1) === 0x7d && Buffer.compare(Buffer.from(textW, 'utf8'), bytesW) === 0 && JSON.stringify(parsedW) === textW,
    'compact UTF-8 JSON with no BOM, whitespace or trailing newline; the byte length is exact',
  )
  check('T066', 'Preview writes nothing', (await unchanged(before61)) && (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* 'payload'`)[0].n === 0n, 'two previews wrote no row and no audit; there is no payload table — nothing is persisted')
  check('T067', 'Revoked approval composes nothing', previewRevoked.status === 409 && errorCode(previewRevoked.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED' && !('previewDigestSha256' in (previewRevoked.body ?? {})), 'after REVOKE: CLAIM_PAYLOAD_NOT_AUTHORIZED and no digest')
  check('T068', 'Stale draft composes nothing', previewStale.status === 409 && errorCode(previewStale.body) === 'CLAIM_PAYLOAD_STALE', 'after a line removal the reviewed fingerprint no longer recomposes: CLAIM_PAYLOAD_STALE')
  check(
    'T069',
    'Exact lineage in the payload',
    payloadW?.header?.claimId === claimW.id && payloadW?.header?.draftAssessmentId === assessmentW.id && payloadW?.header?.approvalDecisionId === approvalW && payloadW?.header?.pricingRunId === pricingW.id &&
      payloadW?.header?.assessedValidationRunId === W.validationRunId && payloadW?.header?.readinessAssessmentId === W.readinessId && payloadW?.header?.jurisdictionCode === 'AE-DU' &&
      same((payloadW?.lines ?? []).map((l: any) => l.encounterActivityId), W.activityIds) && same((payloadW?.diagnoses ?? []).map((d: any) => d.encounterDiagnosisId), W.encounterDiagnosisIds) &&
      payloadW?.financial?.totalExtendedAmount === '200.01' && payloadW?.financial?.currencyCode === 'AED' && payloadW?.approval?.reviewerUserId === B.id,
    'header, lines, diagnoses, AED 200.01 and the reviewer are exactly the approved lineage of this Claim',
  )
  const outsidePreviews = [await post(`/api/claims/${claimW.id}/canonical-payload/preview`, previewBodyW, asViewer), await post(`/api/claims/${claimW.id}/canonical-payload/preview`, previewBodyW, O.who)]
  check(
    'T070',
    'Preview access and PHI',
    outsidePreviews[0].status === 403 && outsidePreviews[1].status === 404 && !textW.includes(`${runId}-P`) && !textW.includes('1990-01-01') && !textW.includes(memberIdentifier),
    'a Viewer (403) and the other organization (404) get no preview; the bytes carry no patient name, birth date or member identifier',
  )

  // ---------------------------------------------------------------- A6.7 (T071–T080)
  section('A6.7 freeze: one transaction, stored bytes, independent digests and seal, manifest lineage, idempotency, crash')
  const before71 = await counts()
  const frozenW = await freezeHttp(claimW.id, assessmentW.id, approvalW)
  const S1 = frozenW.body?.submissionId as string
  const after71 = await counts()
  const freezeAudit = await prisma.auditEvent.findMany({ where: { entityId: S1 }, select: { actionCode: true } })
  check(
    'T071',
    'Freeze',
    frozenW.status === 201 && frozenW.body?.submissionContractVersion === 'A6-SUBMISSION-1' && frozenW.body?.payloadSchemaVersion === 'A6-PAYLOAD-1' && frozenW.body?.approvedAssemblyFingerprint === assessmentW.assemblyFingerprint &&
      frozenW.body?.draftAssessmentId === assessmentW.id && frozenW.body?.approvalDecisionId === approvalW && frozenW.body?.pricingRunId === pricingW.id &&
      delta(before71, after71).claim_freezes === 1 && delta(before71, after71).claim_freeze_evidence_manifests === 1 && delta(before71, after71).audit_events === 1 && same(freezeAudit.map((a) => a.actionCode), ['claim_submission.frozen']),
    `201 A6-SUBMISSION-1 ${S1}: one freeze, one evidence package and one claim_submission.frozen audit`,
  )
  check('T072', 'Preview and freeze agree', frozenW.body?.payloadSha256 === previewW.body.previewDigestSha256 && frozenW.body?.payloadByteLength === previewW.body.byteLength, 'the approved A6.6 preview and the frozen bytes have the same SHA-256 and length')
  const rowS1 = await prisma.claimFreeze.findUniqueOrThrow({ where: { id: S1 }, include: { evidenceManifest: true } })
  const storedBytesS1 = Buffer.from(rowS1.canonicalPayloadBytes)
  const dbDigests = (await prisma.$queryRaw<{ p: string; m: string; seal: string }[]>`
    SELECT encode(sha256(f.canonical_payload_bytes), 'hex') AS p, encode(sha256(m.manifest_bytes), 'hex') AS m,
      encode(sha256(convert_to('SBN-A6-SUBMISSION-1' || chr(10), 'UTF8') || decode(f.payload_sha256, 'hex') || decode(m.manifest_sha256, 'hex')
        || uuid_send(f.claim_id) || uuid_send(f.draft_assessment_id) || uuid_send(f.approval_review_event_id) || uuid_send(f.pricing_run_id)), 'hex') AS seal
    FROM claim_freezes f JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.id = ${S1}::uuid`)[0]
  check(
    'T073',
    'Payload digest from stored bytes',
    sha256Of(storedBytesS1) === rowS1.payloadSha256 && dbDigests.p === rowS1.payloadSha256 && frozenW.body?.payloadSha256 === rowS1.payloadSha256 && Buffer.compare(storedBytesS1, bytesW) === 0,
    'SHA-256 of the stored bytes (this runner and PostgreSQL) is the stored and returned digest; the bytes are exactly the approved composition',
  )
  const manifestBytesS1 = Buffer.from(rowS1.evidenceManifest!.manifestBytes)
  const manifestS1 = JSON.parse(manifestBytesS1.toString('utf8'))
  check(
    'T074',
    'Manifest digest from stored bytes',
    sha256Of(manifestBytesS1) === rowS1.evidenceManifest!.manifestSha256 && dbDigests.m === rowS1.evidenceManifest!.manifestSha256 && encodeEvidenceManifest(manifestS1).text === manifestBytesS1.toString('utf8') &&
      manifestS1.schemaVersion === 'A6-EVIDENCE-1' && manifestS1.payloadSha256 === rowS1.payloadSha256 && manifestS1.claimId === claimW.id && manifestS1.approvalReviewEventId === approvalW,
    'SHA-256 of the stored manifest bytes (runner and PostgreSQL) is the stored digest; the bytes are already canonical and name the freeze identity and payload digest',
  )
  const sealS1 = sha256Of(
    Buffer.concat([Buffer.from('SBN-A6-SUBMISSION-1\n', 'utf8'), Buffer.from(rowS1.payloadSha256, 'hex'), Buffer.from(rowS1.evidenceManifest!.manifestSha256, 'hex'), uuid16(rowS1.claimId), uuid16(rowS1.draftAssessmentId), uuid16(rowS1.approvalReviewEventId), uuid16(rowS1.pricingRunId)]),
  )
  check('T075', 'Independent seal', sealS1 === rowS1.evidenceManifest!.packageSealSha256 && dbDigests.seal === rowS1.evidenceManifest!.packageSealSha256 && frozenW.body?.evidencePackage?.packageSealSha256 === sealS1, 'the domain-separated seal recomputed by this runner (byte concatenation) and by PostgreSQL equals the stored seal')
  const entries = manifestS1.entries as { ordinal: number; referenceKind: string; referenceId: string; referenceVersionId: string | null; contentHash: string | null }[]
  const idsOf = (kind: string) => sortedSet(entries.filter((e) => e.referenceKind === kind).map((e) => e.referenceId))
  const versionIdsOf = (kind: string) => sortedSet(entries.filter((e) => e.referenceKind === kind).map((e) => e.referenceVersionId))
  const pricingLineIds = sortedSet((await prisma.claimPricingLineResult.findMany({ where: { pricingRunId: pricingW.id }, select: { id: true } })).map((row) => row.id))
  const manifestApi = await get(`/api/claim-submissions/${S1}/evidence-manifest`)
  check(
    'T076',
    'Manifest source and version lineage',
    entries.every((e, i) => e.ordinal === i + 1) &&
      same(idsOf('VALIDATION_RUN'), [W.validationRunId]) && same(idsOf('READINESS_ASSESSMENT'), [W.readinessId]) && same(idsOf('VALIDATION_FINDING'), sortedSet(findingsW.map((f) => f.id).filter((id) => (handoffW.body?.findingRefs ?? []).some((r: any) => r.id === id)))) &&
      same(idsOf('ENCOUNTER_ACTIVITY'), sortedSet(W.activityIds)) && same(idsOf('ENCOUNTER_DIAGNOSIS'), sortedSet(W.encounterDiagnosisIds)) && same(idsOf('ELIGIBILITY_VERIFICATION'), [W.eligibilityId]) &&
      same(idsOf('EVIDENCE_REQUIREMENT'), sortedSet(refs.evidenceRequirementIds ?? [])) && idsOf('EVIDENCE_REQUIREMENT').includes(requirement.body?.id) &&
      same(versionIdsOf('EVIDENCE_ARTIFACT_VERSION'), sortedSet(refs.evidenceArtifactVersionIds ?? [])) && entries.filter((e) => e.referenceKind === 'EVIDENCE_ARTIFACT_VERSION').every((e) => /^[0-9a-f]{64}$/.test(e.contentHash ?? '')) &&
      same(versionIdsOf('RULE_VERSION'), sortedSet(refs.ruleVersionIds ?? [])) && entries.some((e) => e.referenceKind === 'RULE_VERSION' && e.referenceId === rule.id && e.referenceVersionId === ruleVersion.id) &&
      same(versionIdsOf('RULE_SOURCE_VERSION'), sortedSet(refs.governingSourceVersionIds ?? [])) &&
      same(idsOf('PRICING_RUN'), [pricingW.id]) && pricingLineIds.length === 2 && same(idsOf('PRICING_LINE_RESULT'), pricingLineIds) && same(idsOf('DRAFT_ASSESSMENT'), [assessmentW.id]) && same(idsOf('REVIEW_EVENT'), [approvalW]) &&
      manifestApi.status === 200 && same(manifestApi.body?.manifest, manifestS1),
    `${entries.length} ordered entries name exactly the handoff's run, findings, sources, eligibility, evidence requirement and rule/source versions, the pricing run and results, the assessment and the approval; the manifest read is the stored manifest`,
  )
  const before77 = await counts()
  const replayW = await freezeHttp(claimW.id, assessmentW.id, approvalW)
  check('T077', 'Identical repeat', replayW.status === 200 && same(replayW.body, frozenW.body) && (await unchanged(before77)), 'the same request again: 200 with the identical record; no row and no audit')
  const reuse = await freezeHttp(claimW.id, assessmentW2.id, approvalW)
  const approvalKey = await prisma.$queryRaw<{ def: string }[]>`SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'claim_freezes'`
  const twiceFrozen = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT approval_review_event_id FROM claim_freezes GROUP BY approval_review_event_id HAVING count(*) > 1) duplicated`
  check(
    'T078',
    'One freeze per approval',
    reuse.status === 409 && errorCode(reuse.body) === 'CLAIM_SUBMISSION_CONFLICT' && approvalKey.some((row) => /CREATE UNIQUE INDEX \w+ ON public\.claim_freezes USING btree \(approval_review_event_id\)$/.test(row.def)) && Number(twiceFrozen[0].n) === 0 && (await unchanged(before77)),
    'a frozen approval named with another assessment: CLAIM_SUBMISSION_CONFLICT; the database holds a unique index on approval_review_event_id and no approval is frozen twice anywhere',
  )
  const freezeAttacks = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_freezes SET payload_sha256 = payload_sha256 WHERE id = $1::uuid`, S1)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_freezes WHERE id = $1::uuid`, S1)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_freeze_evidence_manifests SET entry_count = entry_count WHERE claim_submission_id = $1::uuid`, S1)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_freeze_evidence_entries SET ordinal = ordinal WHERE evidence_package_id = $1::uuid`, rowS1.evidenceManifest!.id)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_freeze_evidence_entries WHERE evidence_package_id = $1::uuid`, rowS1.evidenceManifest!.id)),
  ]
  let corruption = 'NOT_RUN'
  await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await tx.$executeRawUnsafe(`UPDATE claim_freezes SET canonical_payload_bytes = canonical_payload_bytes || '\\x20'::bytea WHERE id = $1::uuid`, S1)
      corruption = await attemptAdversarial(() => getFrozenSubmission(claimW.id, S1, tx))
      throw new Error(NOT_REFUSED)
    }),
  )
  check(
    'T079',
    'Immutable and corruption-evident',
    freezeAttacks.every((message) => /is append-only/.test(message)) && /do not match their stored digests/.test(corruption) && sha256Of(Buffer.from((await prisma.claimFreeze.findUniqueOrThrow({ where: { id: S1 } })).canonicalPayloadBytes)) === rowS1.payloadSha256,
    'freeze, package and entries refuse UPDATE/DELETE; bytes altered behind the guards (rolled back) are detected on read and never returned',
  )
  const CR = await approvedOf('freeze crash')
  const beforeCrash = await counts()
  const crashes: string[] = []
  for (const probe of ['claimSubmission.package_written', 'claimSubmission.audited']) {
    failAt(probe)
    crashes.push(await attemptAdversarial(() => freezeClaimSubmission(CR.claimId, { draftAssessmentId: CR.assessment.id, approvalDecisionId: CR.approvalId }, creatorId)))
    clearConcurrencyProbes()
  }
  const crashLeftNothing = await unchanged(beforeCrash)
  const retryCR = await freezeHttp(CR.claimId, CR.assessment.id, CR.approvalId)
  check(
    'T080',
    'Crash leaves no partial freeze',
    crashes.every((message) => message.includes('INJECTED_CRASH')) && crashLeftNothing && retryCR.status === 201 && (await prisma.claimFreeze.count({ where: { claimId: CR.claimId } })) === 1,
    'a failure after the package or after the audit leaves no freeze, package, entry or audit; the retry freezes exactly once',
  )

  // ---------------------------------------------------------------- A6.8 (T081–T090)
  section('A6.8 internal lifecycle: every legal and forbidden edge, derived state, stable frozen bytes, no payer send')
  const lifecycleOf = async (submissionId: string, who: Who = asAdmin) => (await get(`/api/claim-submissions/${submissionId}/lifecycle`, who)).body
  const historyOf = async (submissionId: string, who: Who = asAdmin) => (await get(`/api/claim-submissions/${submissionId}/lifecycle-events`, who)).body?.items ?? []
  const record = (submissionId: string, eventCode: string, who: Who = asAdmin) =>
    post(`/api/claim-submissions/${submissionId}/lifecycle-events`, { eventCode, reasonCode: eventCode === 'AUTHORIZE_RELEASE' ? null : 'INTERNAL_DATA_REVIEW' }, who)
  const initial = await lifecycleOf(S1)
  check('T081', 'FROZEN with zero events', initial?.state === 'FROZEN' && initial?.lastSequence === 0 && initial?.lastEventId === null && (await historyOf(S1)).length === 0, 'a fresh freeze is FROZEN with no event and no stored state')
  const hashBeforeEvents = await freezeHash(claimW.id)
  const lifecycleCountsBefore = await counts()
  // Every illegal event is tried in the state it is illegal in, before the legal step out of that state.
  const transitions = lifecycleTransitions as unknown as Record<string, Record<string, string>>
  const illegal: { state: string; event: string; status: number; code?: string }[] = []
  const tryIllegal = async (submissionId: string, state: string) => {
    for (const event of LIFECYCLE_EVENTS.filter((e) => !(e in transitions[state]))) {
      const res = await record(submissionId, event)
      illegal.push({ state, event, status: res.status, code: errorCode(res.body) })
    }
  }
  const legal: { from: string; event: string; to: string; status: number; sequence: number }[] = []
  const step = async (submissionId: string, from: string, event: string) => {
    await tryIllegal(submissionId, from)
    const res = await record(submissionId, event)
    legal.push({ from, event, to: res.body?.lifecycle?.state, status: res.status, sequence: res.body?.event?.sequence })
    return res
  }
  await step(S1, 'FROZEN', 'PLACE_HOLD')
  await step(S1, 'HELD', 'RELEASE_HOLD')
  await step(S1, 'FROZEN', 'AUTHORIZE_RELEASE')
  await step(S1, 'RELEASE_ELIGIBLE', 'PLACE_HOLD')
  await step(S1, 'HELD', 'WITHDRAW_INTERNAL')
  await tryIllegal(S1, 'WITHDRAWN_INTERNAL')
  const lifecycleDelta = delta(lifecycleCountsBefore, await counts())
  const hashAfterEvents = await freezeHash(claimW.id)
  check(
    'T082',
    'Worked lifecycle',
    same(legal.map((l) => [l.status, l.to, l.sequence]), [[201, 'HELD', 1], [201, 'FROZEN', 2], [201, 'RELEASE_ELIGIBLE', 3], [201, 'HELD', 4], [201, 'WITHDRAWN_INTERNAL', 5]]),
    'hold, release the hold, authorize internal release, hold again, withdraw: sequences 1..5 with the derived states in order',
  )
  const LT = await frozenOf('lifecycle edges')
  await nextFreeze(LT)
  await step(LT.freezes[0], 'FROZEN', 'WITHDRAW_INTERNAL')
  await step(LT.freezes[1], 'FROZEN', 'AUTHORIZE_RELEASE')
  await step(LT.freezes[1], 'RELEASE_ELIGIBLE', 'WITHDRAW_INTERNAL')
  const legalEdges = sortedSet(legal.filter((l) => l.status === 201 && l.to === transitions[l.from][l.event]).map((l) => `${l.from}>${l.event}`))
  const allowedEdges = sortedSet(LIFECYCLE_STATES.flatMap((s) => Object.keys(transitions[s]).map((e) => `${s}>${e}`)))
  check('T083', 'Every legal edge', legalEdges.length === 7 && same(legalEdges, allowedEdges), `all 7 allowed edges were recorded through the route with their exact next state: ${legalEdges.join(', ')}`)
  const illegalPairs = sortedSet(illegal.map((i) => `${i.state}>${i.event}`))
  check(
    'T084',
    'Every forbidden edge',
    illegalPairs.length === 9 && illegal.every((i) => i.status === 409 && i.code === 'CLAIM_LIFECYCLE_TRANSITION_NOT_ALLOWED') && illegalPairs.length + allowedEdges.length === 16,
    `the 9 forbidden pairs (incl. everything after WITHDRAWN_INTERNAL) were each refused with 409 in their own state (${illegal.length} attempts)`,
  )
  const historyS1 = await historyOf(S1)
  let folded = 'FROZEN'
  for (const event of historyS1) folded = transitions[folded]?.[event.eventCode] ?? 'ILLEGAL'
  const freezeColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('claims', 'claim_freezes')`).map((row) => row.c)
  check(
    'T085',
    'Derived, never stored',
    historyS1.every((e: any, i: number) => e.sequence === i + 1) && folded === 'WITHDRAWN_INTERNAL' && (await lifecycleOf(S1))?.state === folded && !freezeColumns.some((c) => /state|status|lifecycle|latest|current/.test(c)),
    'the A6.8 history 1..N folds to the read state; no state, status or latest pointer is stored on a Claim or freeze',
  )
  check(
    'T086',
    'Frozen bytes unchanged',
    hashAfterEvents === hashBeforeEvents && lifecycleDelta.claim_freeze_lifecycle_events === 5 && lifecycleDelta.claim_freezes === 0 && lifecycleDelta.claim_review_events === 0,
    'five events later every stored byte of the freeze, its package and the review history is identical; the illegal attempts wrote nothing',
  )
  const allColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`).map((row) => row.c)
  const sendColumns = allColumns.filter((c) => /\.(sent_at|sent|submitted_at|transmitted_at|acknowledg\w*|payer_status|delivery_status|payer_claim_id|external_claim_id)$/.test(c))
  const eventDtoKeys = [...deepKeys(historyS1)]
  check(
    'T087',
    'No payer send',
    sendColumns.length === 0 && !eventDtoKeys.some((k) => /payer|destination|sent|deliver|transmi|acknowledg|external/i.test(k)) && lifecycleDelta.audit_events === 5,
    'RELEASE_ELIGIBLE is an internal decision: no sent/submitted/acknowledgement/payer-status column exists anywhere and an event carries no destination',
  )
  const EV = await frozenOf('lifecycle guards')
  const insertEvent = (tx: any, submissionId: string, sequence: number, eventCode: string, reasonCode: string | null) =>
    tx.$executeRawUnsafe(
      `INSERT INTO claim_freeze_lifecycle_events (id, claim_submission_id, sequence, event_code, reason_code, actor_user_id, lifecycle_contract_version) VALUES (gen_random_uuid(), $1::uuid, $2::int, $3, $4, $5::uuid, 'A6-LIFECYCLE-1')`,
      submissionId,
      sequence,
      eventCode,
      reasonCode,
      creatorId,
    )
  const controlEvent = await rolledBack((tx) => insertEvent(tx, EV.freezes[0], 1, 'PLACE_HOLD', 'INTERNAL_OTHER'))
  const forgedEdge = await rolledBack((tx) => insertEvent(tx, EV.freezes[0], 1, 'RELEASE_HOLD', 'INTERNAL_OTHER'))
  check('T088', 'Transition guard in the database', controlEvent.includes(NOT_REFUSED) && refusedBy(forgedEdge, /claim_lifecycle_transition/), 'a legal first event inserted directly is accepted (rolled back); a forged RELEASE_HOLD from FROZEN is refused by the database')
  const eventAttacks = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_freeze_lifecycle_events SET reason_code = reason_code WHERE claim_submission_id = $1::uuid`, S1)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_freeze_lifecycle_events WHERE claim_submission_id = $1::uuid`, S1)),
  ]
  check('T089', 'Events append-only', eventAttacks.every((message) => /is append-only/.test(message)) && (await historyOf(S1)).length === 5, 'UPDATE (even a no-op) and DELETE of a lifecycle event are refused')
  const before90 = await counts()
  const lifecycleOutsiders = [await record(EV.freezes[0], 'PLACE_HOLD', asViewer), await record(EV.freezes[0], 'PLACE_HOLD', O.who), await get(`/api/claim-submissions/${S1}/lifecycle`, O.who)]
  const viewerState = await lifecycleOf(S1, asViewer)
  check(
    'T090',
    'Viewer and foreign limits',
    lifecycleOutsiders[0].status === 403 && lifecycleOutsiders.slice(1).every((res) => res.status === 404) && viewerState?.state === 'WITHDRAWN_INTERNAL' && (await unchanged(before90)),
    'a Viewer reads the state but records nothing (403); the other organization gets 404 for events and reads',
  )

  // ---------------------------------------------------------------- A6.9 (T091–T100)
  section('A6.9 correction lineage: an independently approved and frozen successor, chain order, exclusions')
  const subjectW: Frozen = { ...W, claimId: claimW.id, ...structW, pricing: pricingW, assessment: assessmentW, approvalId: approvalW, freezes: [S1] }
  const freezeRowOf = async (id: string) => JSON.stringify(await prisma.claimFreeze.findUniqueOrThrow({ where: { id }, include: { evidenceManifest: { include: { entries: { orderBy: { ordinal: 'asc' } } } } } }))
  const s1RowBefore = await freezeRowOf(S1)
  // The correction: a coding change (the first line also points to the SECONDARY diagnosis), re-priced,
  // re-assessed and approved by the other reviewer, then frozen as S2.
  const frozenS2 = await nextFreeze(subjectW, () => setPointers(structW.lineIds[0], structW.claimDiagnosisIds))
  const S2 = frozenS2.submissionId as string
  const s2RowBefore = await freezeRowOf(S2)
  const linksPath = (claimId: string) => `/api/claims/${claimId}/correction-links`
  const link = (claimId: string, prior: string, corrected: string, reasonCode = 'CORRECTED_CODING', who: Who = asAdmin) => post(linksPath(claimId), { priorSubmissionId: prior, correctedSubmissionId: corrected, reasonCode }, who)
  const L1 = await link(claimW.id, S1, S2)
  const rowsS = await prisma.claimFreeze.findMany({ where: { id: { in: [S1, S2] } }, select: { id: true, draftAssessmentId: true, approvalReviewEventId: true, frozenAt: true, payloadSha256: true } })
  const s1Row = rowsS.find((r) => r.id === S1)!
  const s2Row = rowsS.find((r) => r.id === S2)!
  check(
    'T091',
    'Correction links an independent successor',
    L1.status === 201 && L1.body?.contractVersion === 'A6-CORRECTION-1' && L1.body?.priorSubmissionId === S1 && L1.body?.correctedSubmissionId === S2 &&
      s1Row.draftAssessmentId !== s2Row.draftAssessmentId && s1Row.approvalReviewEventId !== s2Row.approvalReviewEventId && s2Row.frozenAt > s1Row.frozenAt && s1Row.payloadSha256 !== s2Row.payloadSha256,
    'S1 → S2 (CORRECTED_CODING): S2 rests on its own assessment, its own approval by reviewer C, its own bytes, and was frozen strictly later',
  )
  // S3: a further correction (the lines in reverse order), linked by the second reviewer.
  const frozenS3 = await nextFreeze(subjectW, () => api('PUT', `/api/claims/${claimW.id}/lines/order`, { claimLineIds: [...structW.lineIds].reverse() }))
  const S3 = frozenS3.submissionId as string
  const L2 = await link(claimW.id, S2, S3, 'CORRECTED_DOCUMENTATION', B.who)
  const chainW = (await get(linksPath(claimW.id))).body?.items ?? []
  check(
    'T092',
    'Chain order',
    L2.status === 201 && L2.body?.recordedByUserId === B.id && same(chainW.map((l: any) => [l.priorSubmissionId, l.correctedSubmissionId, l.reasonCode]), [[S1, S2, 'CORRECTED_CODING'], [S2, S3, 'CORRECTED_DOCUMENTATION']]),
    'the history reads S1 → S2 → S3 in chain order, each link naming its actor',
  )
  const before93 = await counts()
  const replayL1 = await link(claimW.id, S1, S2)
  const otherReason = await link(claimW.id, S1, S2, 'CORRECTED_PRICING')
  check('T093', 'Exact replay, never a rewrite', replayL1.status === 200 && same(replayL1.body, L1.body) && otherReason.status === 409 && errorCode(otherReason.body) === 'CLAIM_CORRECTION_NOT_ALLOWED' && (await unchanged(before93)), 'the identical link replays 200 with no write; the same pair with another reason is refused')
  const crossClaimLink = await link(claimW.id, S3, retryCR.body?.submissionId ?? MISSING)
  const crossClaimSql = await rolledBack((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO claim_correction_links (id, claim_id, prior_submission_id, corrected_submission_id, reason_code, recorded_by_user_id, contract_version) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'CORRECTED_CODING', $4::uuid, 'A6-CORRECTION-1')`,
      claimW.id,
      S3,
      LT.freezes[1],
      creatorId,
    ),
  )
  check('T094', 'Same Claim only', crossClaimLink.status === 404 && refusedBy(crossClaimSql, /claim_correction_coherence/) && (await unchanged(before93)), "another Claim's freeze is answered like a missing one (404) and refused by the database guard")
  const fork = await link(claimW.id, S1, S3)
  check('T095', 'No branch', fork.status === 409 && errorCode(fork.body) === 'CLAIM_CORRECTION_NOT_ALLOWED', 'S1 is already corrected by S2: a second correction of S1 is refused')
  const cycle = await link(claimW.id, S3, S1)
  check('T096', 'No cycle', cycle.status === 409, 'S3 → S1 would close a cycle: refused')
  const Q = await frozenOf('join')
  await nextFreeze(Q)
  await nextFreeze(Q)
  const joinFirst = await link(Q.claimId, Q.freezes[0], Q.freezes[2])
  const join = await link(Q.claimId, Q.freezes[1], Q.freezes[2])
  check('T097', 'No join', joinFirst.status === 201 && join.status === 409 && errorCode(join.body) === 'CLAIM_CORRECTION_NOT_ALLOWED' && (await prisma.claimCorrectionLink.count({ where: { claimId: Q.claimId } })) === 1, 'Q3 already corrects Q1: Q3 cannot also correct Q2; one link')
  const freezeColumnNames = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claim_freezes'`).map((row) => row.c)
  check(
    'T098',
    'No reverse pointer on A6.7 rows',
    freezeColumnNames.length === 13 && !freezeColumnNames.some((c) => /correct|success|supersed|prior|replac|predecess/.test(c)) && (await prisma.claimCorrectionLink.count({ where: { claimId: claimW.id } })) === 2,
    'claim_freezes keeps its 13 columns; lineage lives only in claim_correction_links',
  )
  check(
    'T099',
    'Freezes and lifecycle untouched',
    (await freezeRowOf(S1)) === s1RowBefore && (await freezeRowOf(S2)) === s2RowBefore && (await lifecycleOf(S1))?.state === 'WITHDRAWN_INTERNAL' && (await lifecycleOf(S2))?.state === 'FROZEN' && (await lifecycleOf(S3))?.state === 'FROZEN' &&
      (await historyOf(S1)).length === 5,
    'linking changed no frozen byte; withdrawn S1 stays WITHDRAWN_INTERNAL (history only) and S2/S3 stay FROZEN — a link never sends, releases or reopens',
  )
  const inTx = await withReadSnapshot(undefined, (tx) => getCorrectionChain(claimW.id, tx))
  const rowsW = await prisma.claimCorrectionLink.findMany({ where: { claimId: claimW.id } })
  const followed: string[] = []
  for (let cursor: string | undefined = S1; cursor !== undefined; cursor = rowsW.find((row) => row.priorSubmissionId === cursor)?.correctedSubmissionId) followed.push(cursor)
  check('T100', 'Transaction-aware lineage', inTx.ok && same(inTx.value.items, chainW) && same(followed, [S1, S2, S3]), 'getCorrectionChain(claimId, tx) for A7 equals the HTTP read; following the stored links from the root gives the same order')

  // ---------------------------------------------------------------- cross-module (T101–T110)
  section('Cross-module races, rollback, tenancy and privacy, provenance read-back, no downstream leakage')
  const K1 = await reviewableOf('edit versus approve')
  const hold101 = holdAt('claimLine.removed')
  const removal101 = removeClaimLine(K1.lineIds[1], {}, creatorId)
  await Promise.race([hold101.arrived, removal101])
  const approve101 = recordReviewDecision(K1.claimId, approveBody(K1.assessment), B.id)
  const waited101 = !(await settledWithin(approve101, 3000))
  hold101.release()
  const [removed101, approved101] = await Promise.all([removal101, approve101])
  clearConcurrencyProbes()
  check('T101', 'Edit versus approve', waited101 && removed101.ok && !approved101.ok && approved101.code === 'CLAIM_REVIEW_STALE' && (await prisma.claimReviewEvent.count({ where: { claimId: K1.claimId } })) === 0, 'an approval during an uncommitted line removal waits for the Claim lock, then judges the edited draft: CLAIM_REVIEW_STALE')
  const K2 = await approvedOf('edit versus freeze')
  const hold102 = holdAt('claimLine.removed')
  const removal102 = removeClaimLine(K2.lineIds[1], {}, creatorId)
  await Promise.race([hold102.arrived, removal102])
  const freeze102 = freezeClaimSubmission(K2.claimId, { draftAssessmentId: K2.assessment.id, approvalDecisionId: K2.approvalId }, creatorId)
  const waited102 = !(await settledWithin(freeze102, 3000))
  hold102.release()
  const [removed102, frozen102] = await Promise.all([removal102, freeze102])
  clearConcurrencyProbes()
  check('T102', 'Edit versus freeze', waited102 && removed102.ok && !frozen102.ok && frozen102.code === 'CLAIM_SUBMISSION_STALE' && (await prisma.claimFreeze.count({ where: { claimId: K2.claimId } })) === 0, 'a freeze during an uncommitted line removal waits, then re-evaluates: CLAIM_SUBMISSION_STALE — never mixed facts')
  const K3 = await approvedOf('concurrent freeze')
  const before103 = await counts()
  const pair = await Promise.all([freezeHttp(K3.claimId, K3.assessment.id, K3.approvalId), freezeHttp(K3.claimId, K3.assessment.id, K3.approvalId)])
  const d103 = delta(before103, await counts())
  check('T103', 'Concurrent freeze', same(pair.map((r) => r.status).sort(), [200, 201]) && same(pair[0].body, pair[1].body) && d103.claim_freezes === 1 && d103.audit_events === 1, `two simultaneous identical freezes: ${pair.map((r) => r.status).sort().join('/')}, one immutable submission and one audit`)
  const K3S = pair.find((r) => r.status === 201)?.body?.submissionId as string
  const before104 = await counts()
  const holds = await Promise.all([record(K3S, 'PLACE_HOLD'), record(K3S, 'PLACE_HOLD')])
  const d104 = delta(before104, await counts())
  check('T104', 'Lifecycle race', same(holds.map((r) => r.status).sort(), [201, 409]) && d104.claim_freeze_lifecycle_events === 1 && (await lifecycleOf(K3S))?.state === 'HELD', `two simultaneous holds: ${holds.map((r) => r.status).sort().join('/')}; exactly one event at sequence 1`)
  const R = await frozenOf('correction race')
  await nextFreeze(R)
  await nextFreeze(R)
  const forkRace = await Promise.all([link(R.claimId, R.freezes[0], R.freezes[1]), link(R.claimId, R.freezes[0], R.freezes[2])])
  check('T105', 'Correction race', same(forkRace.map((r) => r.status).sort(), [201, 409]) && (await prisma.claimCorrectionLink.count({ where: { claimId: R.claimId } })) === 1, `two different corrections of one prior at once: ${forkRace.map((r) => r.status).sort().join('/')}; exactly one link`)
  const K4 = await reviewableOf('review crash')
  const beforeReviewCrash = await counts()
  failAt('claimReview.audited')
  const reviewCrash = await attemptAdversarial(() => recordReviewDecision(K4.claimId, approveBody(K4.assessment), B.id))
  clearConcurrencyProbes()
  const reviewCrashClean = await unchanged(beforeReviewCrash)
  const beforeLifecycleCrash = await counts()
  failAt('claimLifecycle.audited')
  const lifecycleCrash = await attemptAdversarial(() => recordLifecycleEvent(K3S, { eventCode: 'RELEASE_HOLD', reasonCode: 'INTERNAL_OTHER' }, creatorId))
  clearConcurrencyProbes()
  const lifecycleCrashClean = await unchanged(beforeLifecycleCrash)
  const beforeLinkCrash = await counts()
  failAt('claimCorrection.audited')
  const linkCrash = await attemptAdversarial(() => recordCorrectionLink(LT.claimId, { priorSubmissionId: LT.freezes[0], correctedSubmissionId: LT.freezes[1], reasonCode: 'INTERNAL_OTHER' }, creatorId))
  clearConcurrencyProbes()
  const linkCrashClean = await unchanged(beforeLinkCrash)
  const retries = [await decide(K4.claimId, approveBody(K4.assessment)), await record(K3S, 'RELEASE_HOLD'), await link(LT.claimId, LT.freezes[0], LT.freezes[1], 'INTERNAL_OTHER')]
  check(
    'T106',
    'Rollback of every owning write',
    [reviewCrash, lifecycleCrash, linkCrash].every((m) => m.includes('INJECTED_CRASH')) && reviewCrashClean && lifecycleCrashClean && linkCrashClean && retries.every((res) => res.status === 201),
    'a failure after the audit of a review decision, a lifecycle event and a correction link leaves no row and no audit; each retry records exactly once',
  )
  const tenantReads = [
    await get(`/api/claims/${claimW.id}`, O.who), await get(`/api/claims/${claimW.id}/lines`, O.who), await get(`/api/claim-pricing-runs/${pricingW.id}`, O.who), await get(`/api/claim-draft-assessments/${assessmentW.id}`, O.who),
    await get(`/api/claim-review-decisions/${approvalW}`, O.who), await get(`/api/claim-submissions/${S1}`, O.who), await get(`/api/claim-submissions/${S1}/evidence-manifest`, O.who), await get(`/api/claim-submissions/${S1}/lifecycle-events`, O.who),
    await get(linksPath(claimW.id), O.who), await get(`/api/claim-correction-links/${L1.body?.correctionLinkId}`, O.who), await get(`/api/claims/${foreign.claimId}`), await get(`/api/claims/${foreign.claimId}/submissions`),
  ]
  const tenantLeak = (body: unknown) => JSON.stringify(body ?? {}).includes(claimW.id) || JSON.stringify(body ?? {}).includes(S1) || JSON.stringify(body ?? {}).includes(foreign.encounterId)
  check('T107', 'Tenant isolation', tenantReads.every((res) => (res.status === 403 || res.status === 404) && !tenantLeak(res.body)), `every A6 read across the tenant boundary is refused without disclosure (${sortedSet(tenantReads.map((r) => String(r.status))).join('/')})`)
  const runAudits = await prisma.auditEvent.findMany({ where: { occurredAt: { gte: runStartedAt }, organizationId: org, actionCode: { startsWith: 'claim' } }, select: { afterState: true, beforeState: true } })
  const exposed = JSON.stringify([responses.filter((body) => JSON.stringify(body ?? {}).includes(claimW.id)), runAudits])
  check(
    'T108',
    'Privacy minimization',
    runAudits.length > 0 && !exposed.includes(`${runId}-P`) && !exposed.includes('1990-01-01') && !exposed.includes(memberIdentifier) && !manifestBytesS1.toString('utf8').includes(memberIdentifier),
    `${runAudits.length} A6 audits of this run and every Claim response carry no patient name, birth date or member identifier`,
  )
  const headerS1 = JSON.parse(storedBytesS1.toString('utf8')).header
  const provenance = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT
      (SELECT encounter_id = ${headerS1.encounterId}::uuid AND pre_claim_readiness_assessment_id = ${headerS1.readinessAssessmentId}::uuid FROM claims WHERE id = ${headerS1.claimId}::uuid)
      AND (SELECT validation_run_id = ${headerS1.assessedValidationRunId}::uuid FROM pre_claim_readiness_assessments WHERE id = ${headerS1.readinessAssessmentId}::uuid)
      AND (SELECT encounter_id = ${headerS1.encounterId}::uuid FROM validation_runs WHERE id = ${headerS1.assessedValidationRunId}::uuid)
      AND (SELECT claim_id = ${headerS1.claimId}::uuid FROM claim_pricing_runs WHERE id = ${headerS1.pricingRunId}::uuid)
      AND (SELECT claim_id = ${headerS1.claimId}::uuid AND pricing_run_id = ${headerS1.pricingRunId}::uuid FROM claim_draft_assessments WHERE id = ${headerS1.draftAssessmentId}::uuid)
      AND (SELECT claim_id = ${headerS1.claimId}::uuid AND draft_assessment_id = ${headerS1.draftAssessmentId}::uuid AND decision_code = 'APPROVE' FROM claim_review_events WHERE id = ${headerS1.approvalDecisionId}::uuid)
      AND (SELECT count(*) = 2 FROM encounter_activities WHERE encounter_id = ${headerS1.encounterId}::uuid AND id IN (${W.activityIds[0]}::uuid, ${W.activityIds[1]}::uuid)) AS ok`
  const kindTables: Record<string, string> = {
    VALIDATION_RUN: 'validation_runs', READINESS_ASSESSMENT: 'pre_claim_readiness_assessments', VALIDATION_FINDING: 'validation_findings', ENCOUNTER_ACTIVITY: 'encounter_activities', ENCOUNTER_DIAGNOSIS: 'encounter_diagnoses',
    ELIGIBILITY_VERIFICATION: 'eligibility_verifications', PRICING_RUN: 'claim_pricing_runs', PRICING_LINE_RESULT: 'claim_pricing_line_results', DRAFT_ASSESSMENT: 'claim_draft_assessments', REVIEW_EVENT: 'claim_review_events',
  }
  const unresolved: string[] = []
  for (const entry of entries.filter((e) => e.referenceKind in kindTables)) {
    const found = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM ${kindTables[entry.referenceKind]} WHERE id = $1::uuid`, entry.referenceId)
    if (Number(found[0].n) !== 1) unresolved.push(`${entry.referenceKind}:${entry.referenceId}`)
  }
  check(
    'T109',
    'Provenance read-back from stored bytes',
    provenance[0]?.ok === true && unresolved.length === 0 && entries.filter((e) => e.referenceKind in kindTables).length >= 10,
    'the identity in S1\'s stored bytes resolves to one coherent Claim → readiness → run → pricing → assessment → approval → activities lineage, and every typed manifest reference resolves to exactly one row',
  )
  // Later phases' tables: those created by migrations committed after A6.10's own merge (none on its own branch, so
  // this boundary is unchanged there). Every table that existed when A6.10 merged is judged as before.
  const a610OwnMerge = branch === a610Branch ? '' : mergeOf(a610Branch)
  const migrationDirsIn = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const laterPhaseTables = new Set(a610OwnMerge ? migrationDirsIn('HEAD').filter((dir) => !migrationDirsIn(a610OwnMerge).includes(dir)).flatMap((dir) => [...committedText(`${dir}/migration.sql`).matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1])) : [])
  const laterTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(remittance|payment|adjudicat|denial|receivable|outbox|queue|transmission|acknowledg|exception)'`).map((row) => row.t).filter((t) => !laterPhaseTables.has(t))
  const laterRoutes = [
    await post(`/api/claims/${claimW.id}/submit`, {}), await post(`/api/claim-submissions/${S2}/send`, {}), await post(`/api/claim-submissions/${S2}/transmit`, {}),
    await get(`/api/claim-submissions/${S2}/remittance`), await post(`/api/claims/${claimW.id}/payments`, {}), await get(`/api/claims/${claimW.id}/denials`),
  ]
  const a6Production = committedProductionCodeOf(A6_MODULES)
  check(
    'T110',
    'No downstream leakage',
    laterTables.length === 0 && laterRoutes.every((res) => res.status === 404) && a6Production.files.length > 40 &&
      !/from 'node:(http|https|net|tls|dgram)'|\bfetch\(|axios|undici|<\?xml|\bx12\b|\bhl7\b|\bfhir\b|enqueue|remittance|receivable/i.test(a6Production.code),
    `no A7–A10 table, no submit/send/transmit/remittance/payment/denial route (${laterRoutes.map((r) => r.status).join('/')}), and no network client, XML/X12/HL7/FHIR or queue in ${a6Production.files.length} committed A6 files`,
  )

  // The read-only reconstruction of the worked journey, taken now and compared after the nested chain and
  // the database restart (T129): stored bytes and their digests, never an application response alone.
  const reconstruct = async () => {
    const freezes = await prisma.claimFreeze.findMany({ where: { claimId: claimW.id }, orderBy: { frozenAt: 'asc' }, include: { evidenceManifest: true } })
    return {
      claim: await prisma.claim.findUniqueOrThrow({ where: { id: claimW.id } }),
      submissions: (await get(`/api/claims/${claimW.id}/submissions`)).body?.items,
      freezes: freezes.map((f) => ({
        id: f.id, payloadSha256: f.payloadSha256, bytes: sha256Of(Buffer.from(f.canonicalPayloadBytes)), manifestSha256: f.evidenceManifest?.manifestSha256, manifestBytes: sha256Of(Buffer.from(f.evidenceManifest?.manifestBytes ?? Buffer.alloc(0))), seal: f.evidenceManifest?.packageSealSha256,
      })),
      approvals: (await get(`/api/claims/${claimW.id}/review-decisions`)).body?.items,
      lifecycle: await Promise.all([S1, S2, S3].map(async (id) => ({ id, state: (await lifecycleOf(id))?.state, history: await historyOf(id) }))),
      lineage: (await get(linksPath(claimW.id))).body?.items,
      freezeHash: await freezeHash(claimW.id),
    }
  }
  const reconstructionBefore = JSON.stringify(await reconstruct())
  const a5StillUnchanged = await a5Unchanged()
  const lineageBytesOk = (await reconstruct()).freezes.every((f) => f.bytes === f.payloadSha256 && f.manifestBytes === f.manifestSha256)

  // ---------------------------------------------------------------- nested regressions (T111–T120)
  section('Regressions — A6.9 invoked, nesting A6.8 -> A6.7 -> A6.6 -> A6.5 -> A6.4 -> A6.3 -> A6.2 -> A6.1 -> A5.10 -> A1')
  await apiReady('the A6.9 and backward regression chain')
  const chain = run('npm run test:a6:claim-correction')
  await waitFor(databaseUp, 90_000)
  await apiReady('the checks after the regression chain')
  const rows = suiteLines(chain.output, 'A6.9')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.9] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.9 asserts facts about its own branch, its own migration (and so its replay count) and diff, its nested
  // N/A proofs against its own branch, and its own upstream. On A6.10 those statements are obsolete by design;
  // every other A6.9 check is substantive. T120 below proves each cause independently, never from the id.
  const a69NonApplicable: Record<string, string> = {
    T001: "A6.9 'Start gate' requires the A6.9 feature branch; A6.10 is branched from the main that contains the A6.9 merge (T001/T003 here)",
    T004: "A6.9 'Only the A6.9 migration' requires its branch to add its one migration; on A6.10 that migration is part of main and A6.10 adds none (T004 here)",
    T010: "A6.9 'Diff scope' lists the paths A6.9 was allowed to change; A6.10 legitimately changes only its harness, script and closure record (T010 here)",
    T120: "A6.9 'Nested N/A causes proven' proves A6.8's causes against the A6.9 branch (its migration, diff and upstream); on A6.10 those proofs are re-done here (T120)",
    T130: "A6.9 'Exact head, repeatability, evidence' requires the upstream to be the A6.9 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a69NonApplicable))
  const summary = chain.output.match(/\[A6\.9\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A6\.9\] RUN ABORTED|\[A6\.9\] uncaught error|\[A6\.9\] INVALID RUN/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOfRow = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  const a69Substantive = rows.filter((row) => !(row.id in a69NonApplicable) && !row.id.includes('/') && row.verdict !== 'PASS')
  const a69Passing = rows.filter((row) => !row.id.includes('/') && row.verdict === 'PASS').length
  check(
    'T111',
    'A6.9 regression',
    ran && reconciled && undocumented.length === 0 && a69Substantive.length === 0 && a69Passing >= 124,
    !ran
      ? 'the A6.9 suite did not complete'
      : !reconciled
        ? `A6.9 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A6.9 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A6\.9\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.9] automated summary: ', 'A6.9 ')}; all ${a69Passing} substantive checks PASS and every failure is documented`,
  )
  for (const id of Object.keys(a69NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A6.9 ${titleOf(row.line)}`, a69NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[${TAG}]      ${text.slice(0, 400)}`)
  check('T112', 'A6.8 regression', verdictOf('T111') === 'PASS' && verdictOf('T119') === 'PASS', `A6.9 T111 (A6.8 with its own justified N/A) ${verdictOf('T111')}, T119 (A6.8 substantive) ${verdictOf('T119')}`)
  check('T113', 'A6.7 regression', verdictOf('T112') === 'PASS', `A6.9 T112 (A6.7) ${verdictOf('T112')}`)
  check('T114', 'A6.6 regression', verdictOf('T113') === 'PASS', `A6.9 T113 (A6.6) ${verdictOf('T113')}`)
  check('T115', 'A6.5 regression', verdictOf('T114') === 'PASS', `A6.9 T114 (A6.5) ${verdictOf('T114')}`)
  check('T116', 'A6.4 regression', verdictOf('T115') === 'PASS', `A6.9 T115 (A6.4) ${verdictOf('T115')}`)
  check('T117', 'A6.3 regression', verdictOf('T116') === 'PASS', `A6.9 T116 (A6.3) ${verdictOf('T116')}`)
  check('T118', 'A6.2 and A6.1 regression', verdictOf('T117') === 'PASS', `A6.9 T117 (A6.2, A6.1) ${verdictOf('T117')}`)
  check('T119', 'A5.10 → A1 regression', verdictOf('T118') === 'PASS', `A6.9 T118 (A5.8–A5.10 and A1–A4) ${verdictOf('T118')}`)
  // Each documented A6.9 failure must fail for its branch-only reason, proved independently on this branch.
  const tracking = git('status -sb').split(/\r?\n/)[0]
  const a610Allowed = (path: string) => path.startsWith(`${HARNESS_DIR}/`) || path === 'backend/package.json' || path === CLOSURE_DOC || OWNER_HARNESS_CORRECTIONS.includes(path)
  const outOfScope = changedPaths.filter((path) => !a610Allowed(path))
  const a69Unexpected = (lineOfRow('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const a69Migration = 'backend/prisma/migrations/20261019090000_a6_9_correction_resubmission_lineage/migration.sql'
  const unprovenA68 = (lineOfRow('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const replayOwn = run('npm run db:verify:replay')
  const causes: Record<string, boolean> = {
    T001: branch === a610Branch && a69Merge.length === 40 && gitOk(`merge-base --is-ancestor ${a69Merge} HEAD`) && laterCode.length === 0,
    T004: prismaChanged.length === 0 && headMigrations.some((dir) => a69Migration.startsWith(`${dir}/`)) && mainMigrations.some((dir) => a69Migration.startsWith(`${dir}/`)),
    T010: a69Unexpected.length > 0 && a69Unexpected.every((path, index) => changedPaths.includes(path) || (index === a69Unexpected.length - 1 && changedPaths.some((p) => p.startsWith(path)))) && outOfScope.length === 0,
    // A6.9 re-proves A6.8's branch-only causes against the A6.9 branch; on A6.10 only those tied to the branch
    // (its migration, diff and upstream) can be unproven — re-proved here against this branch.
    T120: unprovenA68.length > 0 && unprovenA68.every((id) => ['T004', 'T010', 'T120', 'T130'].includes(id)) && prismaChanged.length === 0 && outOfScope.length === 0 && tracking.includes(`origin/${a610Branch}`),
    T130: tracking.includes(`origin/${a610Branch}`) && !/origin\/feature\/a6-9/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  check('T120', 'Nested N/A causes proven', ran && unproven.length === 0, unproven.length === 0 ? `each documented A6.9 failure (${failing.join(', ') || 'none'}) fails only for its branch-only reason, proved independently on this branch` : `cause not proven for: ${unproven.join(', ')}`)

  // ---------------------------------------------------------------- build, database and closure (T121–T130)
  section('Units, typecheck, frontend, Prisma checksums, from-empty replay, outage and recovery, golden proof, exact head')
  const allUnit = run('npm run test:unit')
  check('T121', 'Unit tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, every A1–A6 owner unit suite`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Typecheck', typecheck.ok, 'backend typecheck clean, including this harness')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const applied = await prisma.$queryRaw<{ name: string; checksum: string }[]>`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`
  // Prisma's checksum is the SHA-256 of the migration file as it was read when applied. With core.autocrlf the
  // committed blob (LF) and its checkout (CRLF) are the same committed content; a migration applied from
  // either form matches one of them exactly, and any other difference means the file was changed after apply.
  const committedBlob = (path: string) => spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0)
  const checksumForms = applied.map((row) => {
    const path = `backend/prisma/migrations/${row.name}/migration.sql`
    const blob = committedBlob(path)
    const form = blob.length > 0 && sha256Of(blob) === row.checksum ? 'blob' : sha256Of(readFileSync(`prisma/migrations/${row.name}/migration.sql`)) === row.checksum ? 'checkout' : 'DIFFERS'
    return { name: row.name, form }
  })
  const checksumMismatch = checksumForms.filter((row) => row.form === 'DIFFERS').map((row) => row.name)
  const formCount = (form: string) => checksumForms.filter((row) => row.form === form).length
  check(
    'T125',
    'Prisma status and checksums',
    status.ok && applied.length === headMigrations.length && same(applied.map((row) => row.name), headMigrations.map((dir) => dir.split('/').pop())) && checksumMismatch.length === 0,
    checksumMismatch.length === 0
      ? `all ${applied.length} committed migrations are applied, in order, each with the checksum of its committed file (${formCount('checkout')} as checked out, ${formCount('blob')} as the committed blob); none changed after apply`
      : `checksum differs: ${checksumMismatch.join(', ')}`,
  )
  const replayCount = Number((replayOwn.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  check(
    'T126',
    'From-empty replay',
    replayOwn.ok && /ALL CHECKS PASS/.test(replayOwn.output) && replayCount === headMigrations.length && /scratch database dropped; the working database was only ever read/.test(replayOwn.output),
    `${replayCount} migrations applied cleanly from empty in the dedicated scratch database (dropped afterwards); every A6 table, constraint and guard survives; the working database was only read`,
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
  check('T127', 'Outage and recovery', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')
  await waitFor(databaseUp, 60_000)
  const runClaims = await prisma.claim.findMany({ where: { id: { in: createdClaimIds } }, select: { encounter: { select: { patient: { select: { familyName: true, organizationId: true } } } } } })
  check(
    'T128',
    'Synthetic only, no unexpected 5xx',
    serverErrors === 0 && connectionResets === 0 && runClaims.length === createdClaimIds.length && runClaims.every((c) => c.encounter.patient.familyName === `${runId}-P` && c.encounter.patient.organizationId === org),
    `${createdClaimIds.length} Claims, every one on this run's synthetic patient (keyed ${runId}); ${serverErrors} HTTP 5xx answers`,
  )
  const reconstructionAfter = JSON.stringify(await reconstruct())
  const reconstructionAgain = JSON.stringify(await reconstruct())
  progress(`worked journey: Claim ${claimW.id} — run ${W.validationRunId}, readiness ${W.readinessId}, pricing ${pricingW.id} (AED 200.01), assessment ${assessmentW.id}, approval ${approvalW}`)
  progress(`  S1 ${S1} (payload ${rowS1.payloadSha256.slice(0, 16)}…, seal ${sealS1.slice(0, 16)}…) FROZEN → HELD → FROZEN → RELEASE_ELIGIBLE → HELD → WITHDRAWN_INTERNAL`)
  progress(`  S1 → S2 ${S2} (CORRECTED_CODING) → S3 ${S3} (CORRECTED_DOCUMENTATION)`)
  check(
    'T129',
    'Golden worked proof after restart',
    a5StillUnchanged && (await a5Unchanged()) && lineageBytesOk && reconstructionAfter === reconstructionBefore && reconstructionAgain === reconstructionAfter,
    'after the 2-hour nested chain and a database restart, the Claim binding, all three freezes (digests recomputed from stored bytes), manifests, seals, approvals, lifecycle histories and correction lineage reconstruct identically, twice',
  )

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  // package.json may differ only by the one new script (and the comma it adds to the line before it).
  const packageDiff = gitArgs(['diff', 'origin/main...HEAD', '--', ':/backend/package.json']).split(/\r?\n/).filter((line) => /^[+-][^+-]/.test(line))
  const added = packageDiff.filter((line) => line.startsWith('+')).map((line) => line.slice(1).replace(/,$/, ''))
  const removed = packageDiff.filter((line) => line.startsWith('-')).map((line) => line.slice(1).replace(/,$/, ''))
  const packageOk = added.some((line) => line.trim() === `"test:a6:integration": "${SCRIPT}"`) && same(added.filter((line) => !line.includes('test:a6:integration')), removed)
  // The owner-harness correction may touch only the T006 replay-count lines of those three suites.
  const correctionLines = OWNER_HARNESS_CORRECTIONS.flatMap((path) => gitArgs(['diff', 'origin/main...HEAD', '--', `:/${path}`]).split(/\r?\n/).filter((line) => /^[+-][^+-]/.test(line)))
  const correctionOk = correctionLines.every((line) => /mainMigrationDirs|mainMigrationCount|ownMigrationAdded|A6\.10 correction|Before its merge this branch adds|appliedCount === mainMigrationCount|migrations applied cleanly from empty/.test(line))
  check(
    'T010',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && productionChanged.length === 0 && packageOk && correctionOk,
    !correctionOk ? `an owner harness changed beyond its T006 replay count: ${correctionLines.filter((line) => !/mainMigration|ownMigrationAdded|appliedCount|applied cleanly|A6\.10 correction|Before its merge/.test(line)).join(' | ').slice(0, 200)}` : outOfScope.length === 0 ? `${changedPaths.length} path(s): the A6.10 harness, one npm script, the closure record and the A6.7/A6.8/A6.9 T006 replay-count correction; no owner module, schema, route, permission or frontend file` : `unexpected: ${outOfScope.join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  check(
    'T130',
    'Exact head and repeatability',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a610Branch}`) && !/ahead|behind/.test(tracking) && reconstructionAgain === reconstructionBefore,
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; the worked journey reconstructs identically on repeated reads`,
  )

  console.log(`\n[${TAG}] run ${runId} — HEAD ${headSha}`)
  console.log(`[${TAG}] A6.9 accepted merge ${a69Merge}; toolchain node ${versions.node}, npm ${versions.npm}, prisma ${versions.prisma}`)
  if (failures.length > 0) {
    console.log(`[${TAG}] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[${TAG}] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[${TAG}] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[${TAG}] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? `[${TAG}] A6 INTEGRATION ACCEPTANCE & PHASE CLOSURE COMPLETE` : `[${TAG}] A6.10 FINAL FAIL`)
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
