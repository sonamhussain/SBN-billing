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
import { recordReviewDecision } from '../../modules/claim-review/claim-review.service.ts'
import { recordLifecycleEvent } from '../../modules/claim-lifecycle/claim-lifecycle.service.ts'
import { getCorrectionChain, recordCorrectionLink } from '../../modules/claim-correction/claim-correction.service.ts'

// A6.9 — focused acceptance for Correction & Resubmission Lineage (T001–T130).
//
// Every frozen submission is built through its owners, exactly as the A6.7/A6.8 suites build them: tariff
// world and rates through REF-01 and the A6.3 rate routes, runs through the A5.7 recorder, readiness through
// the A5.9 route, the Claim, lines, diagnoses and pointers through the A6.1/A6.2 routes, pricing through A6.3,
// draft assessments through A6.4, APPROVE/REVOKE decisions through A6.5 by a separate synthetic Admin, and
// every freeze through the A6.7 route. A later freeze of the same Claim is made the lawful way: the current
// approval is revoked, a new draft assessment is recorded, approved and frozen. Correction links go through
// the A6.9 route (or, for barrier-controlled races and crash injection, its service in-process).
// ADVERSARIAL writes go in only to prove a database guard or the chain logic's refusal of a corrupt history;
// every one of them runs in a transaction that is always rolled back. Synthetic Admins are provisioned per
// run through Better Auth's own server-side creation with a random password that is never printed. Every
// value is synthetic and keyed by this run's id.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A6.9] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A6.9] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A6.9] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A6.9] ${title}`)

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
const committedCode = (path: string) =>
  git(`show HEAD:${path}`)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
const committedProductionCodeOf = (dirs: string[]) => {
  const files = dirs.flatMap((dir) => committedFiles(dir)).filter((file) => !file.endsWith('.test.ts'))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `A69-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const a61Branch = 'feature/a6-1-claim-foundation-a5-handoff-binding'
const a62Branch = 'feature/a6-2-claim-line-diagnosis-source-traceability'
const a63Branch = 'feature/a6-3-tariff-rate-claim-pricing'
const a64Branch = 'feature/a6-4-claim-draft-integrity'
const a65Branch = 'feature/a6-5-human-review-submission-approval'
const a66Branch = 'feature/a6-6-canonical-claim-payload'
const a67Branch = 'feature/a6-7-immutable-claim-submission-evidence'
const a68Branch = 'feature/a6-8-claim-lifecycle-transition-governance'
const a69Branch = 'feature/a6-9-correction-resubmission-lineage'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const CORRECTION_DIR = 'backend/src/modules/claim-correction'
const FE_CORRECTION_DIR = 'frontend/src/modules/claim-correction'
const HARNESS_DIR = 'backend/src/integration/a6-claim-correction'
const LIFECYCLE_DIR = 'backend/src/modules/claim-lifecycle'
const FE_LIFECYCLE_DIR = 'frontend/src/modules/claim-lifecycle'
const LIFECYCLE_HARNESS_DIR = 'backend/src/integration/a6-claim-lifecycle'
const MIGRATION = 'backend/prisma/migrations/20261019090000_a6_9_correction_resubmission_lineage/migration.sql'
const CHAIN_TEST = `${CORRECTION_DIR}/claim-correction.chain.test.ts`
const TABLE = 'claim_correction_links'
const REASONS = ['CORRECTED_CODING', 'CORRECTED_SOURCE', 'CORRECTED_PRICING', 'CORRECTED_DOCUMENTATION', 'INTERNAL_OTHER']
const DTO_KEYS = ['correctionLinkId', 'claimId', 'priorSubmissionId', 'correctedSubmissionId', 'reasonCode', 'recordedByUserId', 'recordedAt', 'contractVersion']
const AUDIT_KEYS = ['correctionLinkId', 'claimId', 'priorSubmissionId', 'correctedSubmissionId', 'reasonCode', 'contractVersion', 'recordedAt']
const A69_COLUMNS = ['id', 'claim_id', 'prior_submission_id', 'corrected_submission_id', 'reason_code', 'recorded_by_user_id', 'recorded_at', 'contract_version', 'created_at']
// The owners A6.9 consumes or must leave untouched.
const OWNER_DIRS = [
  'backend/src/modules/claim',
  'backend/src/modules/claim-line',
  'backend/src/modules/claim-diagnosis',
  'backend/src/modules/claim-pricing',
  'backend/src/modules/claim-draft',
  'backend/src/modules/claim-review',
  'backend/src/modules/claim-payload',
  'backend/src/modules/claim-submission',
  'backend/src/modules/claim-evidence',
  'backend/src/modules/claim-lifecycle',
  'backend/src/modules/pre-claim-readiness',
  'backend/src/modules/validation-run',
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

  console.log(`[A6.9] A6.9 correction & resubmission lineage — run ${runId}`)
  console.log(`[A6.9] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- gates (T001–T009)
  section('Preflight: accepted A6.8 ancestry, the one A6.9 migration, contracts, permissions and wiring')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const merges = [a61Branch, a62Branch, a63Branch, a64Branch, a65Branch, a66Branch, a67Branch, a68Branch].map(mergeOf)
  const laterCode = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /claim-transport|claim-outbox|claim-remittance|remittance|integration\/a9|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Start gate',
    branch === a69Branch && merges.every((sha) => sha.length === 40) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterCode.length === 0,
    `branch ${branch}; A6.1–A6.8 merged as ${merges.map((sha) => sha.slice(0, 7) || 'NOT FOUND').join(', ')}; contains latest main ${git('rev-parse --short origin/main')}; no A9/A7 code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check('T003', 'A6.1–A6.8 ancestry', merges.every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)), 'the eight accepted merge commits (A6.8 = the actual merge) are ancestors of HEAD')
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma/migrations']).split(/\r?\n/).filter(Boolean)
  check(
    'T004',
    'Only the A6.9 migration',
    same(migrationStatus, [`A\t${MIGRATION}`]),
    migrationStatus.length === 1 ? `one added migration, no applied migration modified: ${MIGRATION.split('/').slice(-2, -1)[0]}` : `migration changes: ${migrationStatus.join(' | ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  const replayExpected = [
    /PASS {2}the A6\.9 tables are exactly claim_correction_links/,
    /PASS {2}claim_correction_links_insert_guard_trg is present after a clean replay/,
    /PASS {2}the A6\.9 CHECKs pin A6-CORRECTION-1/,
    /PASS {2}one correction per prior freeze and one prior per corrected freeze are unique/,
    /PASS {2}the A6\.8 tables are exactly claim_freeze_lifecycle_events/,
    /PASS {2}the A6\.7 tables are exactly claim_freezes and its evidence manifest and entry tables/,
    /PASS {2}the claim tables are exactly claims plus the four A6\.2 tables/,
  ]
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  const migrationDirsAt = (ref: string) => git(`ls-tree -d --name-only --full-tree ${ref} backend/prisma/migrations/`).split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const headMigrationDirs = migrationDirsAt('HEAD')
  const mainMigrationCount = migrationDirsAt('origin/main').length
  // Every migration committed at HEAD replays from empty, the A6.9 one included. (Corrected after A6.10: main's
  // count plus one held only on this package's own branch, not on a later branch with or without a migration.)
  const ownMigrationCommitted = headMigrationDirs.some((dir) => MIGRATION.startsWith(`${dir}/`))
  check(
    'T006',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === headMigrationDirs.length && ownMigrationCommitted,
    `${appliedCount} migrations applied cleanly from empty — all ${headMigrationDirs.length} committed at HEAD (main has ${mainMigrationCount}), the A6.9 migration included; every A6.2–A6.9 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^claimCorrection/.test(code)).sort()
  const invented = allCodes.filter((code) => /(approve|approval|submit|transmit|signOff|claimSubmission|remittance|send|export|acknowledg|resubmi|claim\w*\.(status|replace|supersede))/i.test(code))
  check(
    'T007',
    'Permissions',
    same(family, ['claimCorrection.link', 'claimCorrection.read']) &&
      (await grantsOf('claimCorrection.link')) === 'ORG_ADMIN' &&
      (await grantsOf('claimCorrection.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('claimLifecycle.record')) === 'ORG_ADMIN' &&
      (await grantsOf('claimLifecycle.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('claimFreeze.create')) === 'ORG_ADMIN' &&
      invented.length === 0,
    'link (Admin) and read (Admin, Viewer); A6.7/A6.8 grants unchanged; no resubmit, send, submit, status or replace permission',
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
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  // Raw database text in a response body: SQL keywords, a stack frame, or a physical table/guard name (lower
  // case — the public error codes such as CLAIM_CORRECTION_CONFLICT are upper case and expected).
  const rawError = (body: unknown) => {
    const text = JSON.stringify(body ?? {})
    return /\bat [\w.$<>]+ \(|\.ts:\d+:\d+|prisma|SELECT |INSERT |constraint|trigger/i.test(text) || /claim_correction_[a-z]|claim_freeze/.test(text)
  }
  // The guard that refused a direct write: a constraint name first (CHECK, foreign or unique key), else the
  // trigger's marker.
  const markerOf = (message: string) => (message.match(/[a-z_]+_(chk|fkey|key)\b/) ?? message.match(/claim_correction_(time|coherence|chronology|chain)|is append-only/) ?? [message.includes('ROLLED_BACK') ? 'ACCEPTED' : '?'])[0]

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
  // B approves (separation of duties for A6.5) and records links as a second actor; O is an Admin of the
  // OTHER organization.
  const B = await provisionAdmin('b')
  const O = await provisionAdmin('o', otherOrg)

  const linksPath = (claimId: string) => `/api/claims/${claimId}/correction-links`
  const linkPath = (linkId: string) => `/api/claim-correction-links/${linkId}`
  const link = (claimId: string, priorSubmissionId: string, correctedSubmissionId: string, reasonCode = 'CORRECTED_CODING', who: Who = asAdmin) =>
    post(linksPath(claimId), { priorSubmissionId, correctedSubmissionId, reasonCode }, who)
  const historyOf = async (claimId: string) => (await api('GET', linksPath(claimId))).body?.items ?? []
  const wiring = [await link(MISSING, MISSING, '22222222-2222-4222-8222-222222222222'), await api('GET', linksPath(MISSING)), await api('GET', linkPath(MISSING))]
  const absent = [
    await api('PATCH', linkPath(MISSING), {}),
    await api('PUT', linkPath(MISSING), {}),
    await api('DELETE', linkPath(MISSING)),
    await api('DELETE', linksPath(MISSING)),
    await api('PUT', linksPath(MISSING), {}),
    await api('POST', `/api/claims/${MISSING}/resubmissions`, {}),
    await api('POST', `${linkPath(MISSING)}/send`, {}),
    await api('POST', `${linkPath(MISSING)}/resubmit`, {}),
    await api('GET', `${linkPath(MISSING)}/payer-response`),
  ]
  const unauthenticated = [await link(MISSING, MISSING, '22222222-2222-4222-8222-222222222222', 'CORRECTED_CODING', anonymous), await api('GET', linksPath(MISSING), undefined, anonymous), await api('GET', linkPath(MISSING), undefined, anonymous)]
  check(
    'T008',
    'Route wiring',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && absent.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `three routes answer a missing target with a privacy-safe 404; PATCH/PUT/DELETE, resubmission, send, resubmit and payer-response routes are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
  )

  const constantOf = (path: string, name: string) => (git(`show HEAD:${path}`).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-draft/claim-draft.types.ts', 'DRAFT_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-review/claim-review.types.ts', 'REVIEW_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-payload/claim-payload.types.ts', 'PAYLOAD_SCHEMA_VERSION'),
    constantOf('backend/src/modules/claim-submission/claim-submission.types.ts', 'SUBMISSION_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-evidence/claim-evidence.types.ts', 'EVIDENCE_MANIFEST_VERSION'),
    constantOf('backend/src/modules/claim-lifecycle/claim-lifecycle.types.ts', 'LIFECYCLE_CONTRACT_VERSION'),
  ]
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)))
  // The paths A6.9 may change (judged in T010 at the end, and used to prove the nested N/A causes).
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
  const ownDirs = [CORRECTION_DIR, FE_CORRECTION_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const laterDomain = changedPaths.filter((file) => /claim-transport|claim-outbox|remittance|integration\/a9|dhpo|eclaimlink|nabidh|malaffi|riayati/i.test(file))
  check(
    'T009',
    'Historical invariants',
    same(contracts, ['A6-CLAIM-1', 'A6-DRAFT-1', 'A6-REVIEW-1', 'A6-PAYLOAD-1', 'A6-SUBMISSION-1', 'A6-EVIDENCE-1', 'A6-LIFECYCLE-1']) && ownerChanged.length === 0,
    ownerChanged.length === 0 ? 'A6-CLAIM-1 … A6-LIFECYCLE-1 unchanged; no A5/A6.1–A6.8 owner module changed' : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes: Claims with several lawfully frozen submissions')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: `${runId} service B` })).body)
  const procA = must('procedure A', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PA'), displayName: `${runId} procedure A`, codeSystem: 'SYNTHETIC', externalCode: key('XA') })).body)
  const dxA = must('diagnosis A', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DXA'), displayName: `${runId} diagnosis A` })).body)
  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const contract = must('contract', (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  must('contract facility', (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
  const schedule = must('schedule', (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
  const version = must('version', (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  const rate = (body: Record<string, unknown>) => post(`/api/tariff-schedule-versions/${version.id}/rates`, { modifierCodes: [], currencyCode: 'AED', ...body })
  must('rate A', (await rate({ selectorKind: 'PROCEDURE_CODE', procedureCodeId: procA.id, unitTariffAmount: '125.2500' })).body)
  must('rate B', (await rate({ selectorKind: 'SERVICE', serviceId: svcB.id, unitTariffAmount: '12.1250' })).body)
  if ((await post(`/api/tariff-schedule-versions/${version.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error('fixture: the tariff version could not be verified')

  const plainContext = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: payer.id as string | null, tpaId: null, networkId: null, insuranceProductId: null,
      providerContractId: contract.id as string | null, tariffScheduleId: schedule.id as string | null, tariffScheduleVersionId: version.id as string | null,
    }
  }
  const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
  type Assessed = { id: string; assemblyFingerprint: string; pricingRunId: string }
  const assess = async (claimId: string, pricingRunId: string) => {
    const res = await post(`/api/claims/${claimId}/draft-assessments`, { pricingRunId })
    if (res.status !== 201 || res.body?.outcome !== 'REVIEWABLE') throw new Error(`fixture: expected a REVIEWABLE assessment, got ${res.status} ${res.body?.outcome}`)
    return res.body as Assessed
  }
  const approve = async (claimId: string, assessment: Assessed) => {
    const res = await post(`/api/claims/${claimId}/review-decisions`, { draftAssessmentId: assessment.id, assemblyFingerprint: assessment.assemblyFingerprint, decisionCode: 'APPROVE' }, B.who)
    if (res.status !== 201) throw new Error(`fixture: approval refused with ${res.status}`)
    return res.body.decision.id as string
  }
  const revoke = async (claimId: string, assessment: Assessed, approvalId: string) => {
    const res = await post(`/api/claims/${claimId}/review-decisions`, { draftAssessmentId: assessment.id, assemblyFingerprint: assessment.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: approvalId }, B.who)
    if (res.status !== 201) throw new Error(`fixture: revocation refused with ${res.status}`)
  }
  const freezeNow = async (claimId: string, assessment: Assessed, approvalId: string) => {
    const res = await post(`/api/claims/${claimId}/submissions`, { draftAssessmentId: assessment.id, approvalDecisionId: approvalId })
    if (res.status !== 201) throw new Error(`fixture: the A6.7 freeze was refused with ${res.status} ${errorCode(res.body) ?? ''}`)
    return res.body.submissionId as string
  }
  // A Claim with `count` lawfully frozen submissions: each later one after revoking the current approval, on
  // a NEW draft assessment with its own new approval. With sameAssessmentSecond the second freeze re-approves
  // the SAME assessment (a re-approval, not a correction).
  const series = async (label: string, count: number, options: { sameAssessmentSecond?: boolean } = {}) => {
    const encounter = must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body)
    const activityIds: string[] = []
    for (const activity of [{ procedureCodeId: procA.id, quantity: '1.5' }, { serviceId: svcB.id, quantity: '1' }]) activityIds.push(must(`${label} activity`, (await post(`/api/encounters/${encounter.id}/activities`, activity)).body).id)
    const encounterDiagnosisId = must(`${label} diagnosis`, (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body).id
    const contextSnapshot = await plainContext(encounter.id)
    const findings = [finding('WARNING', { layer: 'CODING' }), ...activityIds.map((encounterActivityId) => finding('PASS', { encounterActivityId })), finding('PASS', { layer: 'CODING', encounterDiagnosisId })]
    const recorded = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId: encounter.id, contextSnapshot, validatorVersion: 'A5-VAL-1', findings }, creatorId, tx))
    if (!recorded.ok) throw new Error(`fixture ${label}: a valid run was refused (${recorded.message})`)
    const readiness = await post(`/api/validation-runs/${recorded.value.id}/readiness-assessments`, {})
    if (readiness.status !== 201) throw new Error(`fixture ${label}: readiness refused with ${readiness.status}`)
    const claim = must(`${label} claim`, (await post(`/api/pre-claim-readiness-assessments/${readiness.body.id}/claims`, {})).body)
    const lineIds: string[] = []
    for (const activityId of activityIds) lineIds.push(must('line', (await post(`/api/claims/${claim.id}/lines`, { encounterActivityId: activityId })).body).id)
    const claimDiagnosisId = must('claim diagnosis', (await post(`/api/claims/${claim.id}/diagnoses`, { encounterDiagnosisId, roleCode: 'PRIMARY' })).body).id
    for (const lineId of lineIds)
      if ((await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds: [claimDiagnosisId] })).status !== 200) throw new Error(`fixture ${label}: pointers refused`)
    const pricing = await post(`/api/claims/${claim.id}/pricing-runs`, {})
    const freezes: string[] = []
    const assessments: string[] = []
    let assessment = await assess(claim.id, pricing.body.id)
    let approvalId = await approve(claim.id, assessment)
    freezes.push(await freezeNow(claim.id, assessment, approvalId))
    assessments.push(assessment.id)
    for (let i = 1; i < count; i += 1) {
      await revoke(claim.id, assessment, approvalId)
      if (!(options.sameAssessmentSecond && i === 1)) assessment = await assess(claim.id, pricing.body.id)
      approvalId = await approve(claim.id, assessment)
      freezes.push(await freezeNow(claim.id, assessment, approvalId))
      assessments.push(assessment.id)
    }
    return { claimId: claim.id as string, freezes, assessments, lineIds }
  }
  type Series = Awaited<ReturnType<typeof series>>

  const counts = async () => {
    const rows = await prisma.$queryRaw<{ t: string; n: bigint }[]>`
      SELECT 'links' AS t, count(*) AS n FROM claim_correction_links UNION ALL SELECT 'correction_audits', count(*) FROM audit_events WHERE action_code = 'claim_correction.linked'
      UNION ALL SELECT 'all_audits', count(*) FROM audit_events UNION ALL SELECT 'freezes', count(*) FROM claim_freezes UNION ALL SELECT 'lifecycle_events', count(*) FROM claim_freeze_lifecycle_events
      UNION ALL SELECT 'decisions', count(*) FROM claim_review_events`
    // PostgreSQL may run the UNION ALL as a Parallel Append, so the row order is not guaranteed: the object
    // is always built in this fixed key order, so equal counts always compare equal.
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(['links', 'correction_audits', 'all_audits', 'freezes', 'lifecycle_events', 'decisions'].map((name) => [name, byName.get(name) as number])) as Record<string, number>
  }
  const unchanged = async (before: Record<string, number>) => same(await counts(), before)
  // Every byte of a Claim's freezes, packages, entries and lifecycle events, as one digest.
  const claimHash = async (claimId: string) =>
    (
      await prisma.$queryRaw<{ h: string }[]>`SELECT encode(sha256(convert_to(
        coalesce((SELECT string_agg(row_to_json(f)::text, '|' ORDER BY f.id) FROM claim_freezes f WHERE f.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(m)::text, '|' ORDER BY m.id) FROM claim_freeze_evidence_manifests m JOIN claim_freezes f ON f.id = m.claim_submission_id WHERE f.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(e)::text, '|' ORDER BY e.id) FROM claim_freeze_lifecycle_events e JOIN claim_freezes f ON f.id = e.claim_submission_id WHERE f.claim_id = ${claimId}::uuid), '') ||
        coalesce((SELECT string_agg(row_to_json(r)::text, '|' ORDER BY r.sequence) FROM claim_review_events r WHERE r.claim_id = ${claimId}::uuid), ''),
        'UTF8')), 'hex') AS h`
    )[0].h
  const NOT_REFUSED = 'ROLLED_BACK'
  const refusedBy = (message: string, marker: RegExp) => message !== '' && !message.includes(NOT_REFUSED) && marker.test(message)
  // A direct INSERT of a link inside a transaction that is always rolled back.
  const directInsert = (values: { claimId: string; prior: string; corrected: string; reason?: string; actor?: string; contract?: string; recordedAt?: boolean }) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, claim_id, prior_submission_id, corrected_submission_id, reason_code, recorded_by_user_id, contract_version${values.recordedAt ? ', recorded_at' : ''})
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6${values.recordedAt ? ", now() - interval '1 day'" : ''})`,
          values.claimId,
          values.prior,
          values.corrected,
          values.reason ?? 'CORRECTED_CODING',
          values.actor ?? creatorId,
          values.contract ?? 'A6-CORRECTION-1',
        )
        throw new Error(NOT_REFUSED)
      }),
    )

  const C = await series('worked chain', 4)
  const D = await series('same assessment', 2, { sameAssessmentSecond: true })
  const G = await series('join', 3)
  const H = await series('second chain', 4)
  const E = await series('other claim', 1)
  console.log('[A6.9]      fixtures ready: patient, AE-DU/DHA facility profile, clinician, masters, a verified AED tariff world, two synthetic Admins (one of another organization) and five Claims with lawfully frozen submissions')

  // ---------------------------------------------------------------- strict request (T011–T020)
  section('Strict request: actor and Claim ownership, session, malicious fields, UUIDs, codes')
  const countsAtStart = await counts()
  const [S1, S2, S3, S4] = C.freezes
  check(
    'T011',
    'Contract version',
    constantOf(`${CORRECTION_DIR}/claim-correction.types.ts`, 'CORRECTION_CONTRACT_VERSION') === 'A6-CORRECTION-1',
    'A6-CORRECTION-1 is the literal contract in code (and on every row and DTO, T021/T026)',
  )
  const unknownFields = [await post(linksPath(C.claimId), { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'CORRECTED_CODING', extra: 1 }), await post(linksPath(C.claimId), { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'CORRECTED_CODING', profile: 'X12' })]
  check('T012', 'Strict body', unknownFields.every((res) => res.status === 400 && /unknown field/.test(res.body?.error?.message ?? '')), 'an unknown field is refused by name: 400')
  const serverOwned = await Promise.all(
    ['claimId', 'recordedByUserId', 'recordedAt', 'contractVersion', 'status', 'note', 'reason', 'payer', 'destination', 'externalReference', 'resubmissionId'].map((field) =>
      post(linksPath(C.claimId), { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'CORRECTED_CODING', [field]: 'x' }),
    ),
  )
  check('T013', 'Malicious fields', serverOwned.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')), 'client Claim, actor, time, contract, status, free-text note/reason, payer, destination, external reference and resubmission id are refused by name')
  const badReasons = [
    await post(linksPath(C.claimId), { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'typo fixed' }),
    await post(linksPath(C.claimId), { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: null }),
    await post(linksPath(C.claimId), { priorSubmissionId: S1, correctedSubmissionId: S2 }),
    await post(linksPath(C.claimId), { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'corrected_coding' }),
  ]
  check('T014', 'Controlled reason codes', badReasons.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR'), 'free text, null, missing and lowercase reasons are refused: 400')
  const malformed = [
    await post('/api/claims/not-a-uuid/correction-links', { priorSubmissionId: S1, correctedSubmissionId: S2, reasonCode: 'CORRECTED_CODING' }),
    await post(linksPath(C.claimId), { priorSubmissionId: 'nope', correctedSubmissionId: S2, reasonCode: 'CORRECTED_CODING' }),
    await post(linksPath(C.claimId), { priorSubmissionId: S1, correctedSubmissionId: 42, reasonCode: 'CORRECTED_CODING' }),
    await api('GET', '/api/claim-correction-links/1234'),
    await post(linksPath(C.claimId), []),
  ]
  check('T015', 'Malformed UUIDs and bodies', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `malformed path and body ids and an array body: ${malformed.map((r) => r.status).join('/')}; no raw database text`)
  const self = await link(C.claimId, S1, S1)
  check('T016', 'Self link refused', self.status === 400 && /cannot correct itself/.test(self.body?.error?.message ?? ''), 'a freeze cannot correct itself: 400 before any lookup')
  const anon = [await link(C.claimId, S1, S2, 'CORRECTED_CODING', anonymous), await api('GET', linksPath(C.claimId), undefined, anonymous)]
  check('T017', 'Session required', anon.every((res) => res.status === 401), 'every A6.9 route requires a session: 401 without one')
  const viewerPost = await link(C.claimId, S1, S2, 'CORRECTED_CODING', asViewer)
  const viewerList = await api('GET', linksPath(C.claimId), undefined, asViewer)
  check('T018', 'Viewer limits', viewerPost.status === 403 && errorCode(viewerPost.body) === 'FORBIDDEN' && viewerList.status === 200, 'a Viewer reads the history (200) but cannot link (403)')
  const foreignAdmin = [await link(C.claimId, S1, S2, 'CORRECTED_CODING', O.who), await api('GET', linksPath(C.claimId), undefined, O.who)]
  const foreignMissing = await api('GET', linksPath(MISSING), undefined, O.who)
  check('T019', 'Claim ownership', foreignAdmin.every((res) => res.status === 404) && same(foreignAdmin[1].body?.error?.message, foreignMissing.body?.error?.message), "an Admin of another organization gets 404 for this tenant's Claim — exactly like a missing one")
  const refusalsLeftNothing = await unchanged(countsAtStart)

  // ---------------------------------------------------------------- legitimate corrections (T021–T030)
  section('Legitimate corrections: distinct freezes of one Claim, independent approvals, chronology')
  const hashCBefore = await claimHash(C.claimId)
  const lifecycleBefore = await Promise.all(C.freezes.map(async (id) => (await api('GET', `/api/claim-submissions/${id}/lifecycle`)).body?.state))
  const freezeReadBefore = (await api('GET', `/api/claim-submissions/${S1}`)).body
  const before21 = await counts()
  const L1 = await link(C.claimId, S1, S2, 'CORRECTED_CODING')
  const after21 = await counts()
  check(
    'T021',
    'S1 → S2 recorded',
    L1.status === 201 && same(Object.keys(L1.body), DTO_KEYS) && L1.body.priorSubmissionId === S1 && L1.body.correctedSubmissionId === S2 && L1.body.contractVersion === 'A6-CORRECTION-1' && after21.links - before21.links === 1 && after21.correction_audits - before21.correction_audits === 1,
    '201: one immutable link and one audit; the bounded DTO carries exactly its eight fields',
  )
  check('T020', 'Actor from the session', L1.body?.recordedByUserId === creatorId, 'the link names the signed-in Admin; no request field can name an actor (a second actor is proven in T030)')
  const L2 = await link(C.claimId, S2, S3, 'CORRECTED_DOCUMENTATION', B.who)
  check('T022', 'S2 → S3 extends the chain', L2.status === 201 && L2.body.reasonCode === 'CORRECTED_DOCUMENTATION', 'the second link extends the chain at its tail')
  const historyC = await historyOf(C.claimId)
  check('T023', 'Ordered chain', same(historyC.map((l: any) => [l.priorSubmissionId, l.correctedSubmissionId]), [[S1, S2], [S2, S3]]), 'the history reads S1 → S2 → S3 in chain order')
  const freezeRows = await prisma.claimFreeze.findMany({ where: { id: { in: C.freezes } }, select: { id: true, approvalReviewEventId: true, draftAssessmentId: true, frozenAt: true } })
  const byId = new Map(freezeRows.map((row) => [row.id, row]))
  check(
    'T024',
    'Independent approvals and assessments',
    new Set(freezeRows.map((row) => row.approvalReviewEventId)).size === 4 && new Set(freezeRows.map((row) => row.draftAssessmentId)).size === 4,
    'each of the four freezes rests on its own A6.5 approval and its own A6.4 assessment',
  )
  const chronology = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT bool_and(c.frozen_at > p.frozen_at AND l.recorded_at = l.created_at AND l.recorded_at <= now()) AS ok FROM claim_correction_links l JOIN claim_freezes p ON p.id = l.prior_submission_id JOIN claim_freezes c ON c.id = l.corrected_submission_id WHERE l.claim_id = ${C.claimId}::uuid`
  check('T025', 'Chronology and database time', chronology[0]?.ok === true, 'every correction was frozen strictly after its prior (database instants); links carry database time')
  const rowL1 = await prisma.claimCorrectionLink.findUniqueOrThrow({ where: { id: L1.body.correctionLinkId } })
  check(
    'T026',
    'Exact rows',
    rowL1.claimId === C.claimId && rowL1.priorSubmissionId === S1 && rowL1.correctedSubmissionId === S2 && rowL1.reasonCode === 'CORRECTED_CODING' && rowL1.contractVersion === 'A6-CORRECTION-1' && rowL1.recordedAt.toISOString() === L1.body.recordedAt,
    'the stored row is exactly the returned DTO',
  )
  const readL1 = await api('GET', linkPath(L1.body.correctionLinkId))
  check('T027', 'Link read', readL1.status === 200 && same(readL1.body, L1.body), 'the single-link read is the recorded DTO')
  check('T028', 'Freezes unchanged', (await claimHash(C.claimId)) === hashCBefore && same((await api('GET', `/api/claim-submissions/${S1}`)).body, freezeReadBefore), 'every byte of the freezes, packages, lifecycle events and approvals is identical after two links')
  const lifecycleAfter = await Promise.all(C.freezes.map(async (id) => (await api('GET', `/api/claim-submissions/${id}/lifecycle`)).body?.state))
  check('T029', 'Lifecycle untouched', same(lifecycleAfter, lifecycleBefore) && lifecycleAfter.every((state) => state === 'FROZEN'), 'all four freezes are still FROZEN: a link never releases, holds or withdraws')
  check('T030', 'Second actor', L2.body?.recordedByUserId === B.id, 'a link recorded by the second Admin names that Admin')

  // ---------------------------------------------------------------- rejected identities (T031–T040)
  section('Rejected identities: missing, foreign tenant, cross-Claim, self, chronology, reason')
  const before31 = await counts()
  const missingPrior = await link(C.claimId, MISSING, S4)
  const missingCorrected = await link(C.claimId, S3, MISSING)
  check('T031', 'Missing prior', missingPrior.status === 404 && errorCode(missingPrior.body) === 'NOT_FOUND', 'a non-existent prior freeze: 404')
  check('T032', 'Missing correction', missingCorrected.status === 404 && errorCode(missingCorrected.body) === 'NOT_FOUND', 'a non-existent corrected freeze: 404')
  const crossClaim = await link(C.claimId, S3, E.freezes[0])
  check('T033', 'Freeze of another Claim', crossClaim.status === 404 && same(crossClaim.body?.error?.message, missingCorrected.body?.error?.message), "another Claim's freeze is answered exactly like a missing one")
  const foreignClaim = await prisma.claim.findFirst({ where: { encounter: { patient: { organizationId: otherOrg } } }, select: { id: true } })
  const foreignPost = foreignClaim ? await link(foreignClaim.id, S3, S4) : { status: 0, body: null }
  check('T034', 'Foreign tenant Claim', foreignPost.status === 404, "a Claim of another organization: 404 at the privacy boundary, before any freeze is read")
  const sameAssessment = await link(D.claimId, D.freezes[0], D.freezes[1])
  check('T035', 'Same draft assessment', sameAssessment.status === 409 && errorCode(sameAssessment.body) === 'CLAIM_CORRECTION_NOT_ALLOWED' && D.assessments[0] === D.assessments[1], 'a re-approval of the same assessment is not a correction: 409')
  const reverse = await link(H.claimId, H.freezes[1], H.freezes[0])
  check('T036', 'Backdated correction', reverse.status === 409 && /frozen before/.test(reverse.body?.error?.message ?? ''), 'a correction frozen before its prior is refused: 409')
  const chainTest = run(`node --test ${CHAIN_TEST.replace('backend/', '')}`)
  const migrationText = readFileSync(`../${MIGRATION}`, 'utf8')
  check(
    'T037',
    'Equal instants refused',
    chainTest.ok && /✔ chronology: the correction must be frozen strictly after the prior; equal is ambiguous/.test(chainTest.output) && /IF NOT \(corrected_frozen > prior_frozen\) THEN/.test(migrationText),
    'two freezes at one instant are ambiguous and refused (the pure rule and the strict > in the database guard); no identifier breaks the tie',
  )
  const lowerReason = await post(linksPath(C.claimId), { priorSubmissionId: S3, correctedSubmissionId: S4, reasonCode: 'Corrected_Coding' })
  check('T038', 'Reason is exact', lowerReason.status === 400, 'reason codes are exact and case-sensitive')
  const wrongPathClaim = await link(H.claimId, S3, S4)
  check('T039', 'Path Claim must own both', wrongPathClaim.status === 404, "freezes of Claim C named under Claim H's path: 404, nothing linked")
  const identityRefusalsLeftNothing = await unchanged(before31)
  check('T040', 'Refusals wrote nothing', identityRefusalsLeftNothing, 'nine refused identities left every count unchanged (no link, no audit)')

  // ---------------------------------------------------------------- linearity (T041–T050)
  section('Linearity: one predecessor, one successor, no fork, no join, no cycle, multi-step chain')
  const fork = await link(C.claimId, S1, S4)
  check('T041', 'No fork', fork.status === 409 && errorCode(fork.body) === 'CLAIM_CORRECTION_NOT_ALLOWED', 'S1 is already corrected by S2: a second correction of S1 is refused')
  const G1 = await link(G.claimId, G.freezes[0], G.freezes[2])
  const join = await link(G.claimId, G.freezes[1], G.freezes[2])
  check('T042', 'No join', G1.status === 201 && join.status === 409 && errorCode(join.body) === 'CLAIM_CORRECTION_NOT_ALLOWED', 'G3 already corrects G1: G3 cannot also correct G2')
  const cycle = await link(C.claimId, S3, S1)
  check('T043', 'No cycle', cycle.status === 409, 'S3 → S1 would close a cycle: refused')
  const H1 = await link(H.claimId, H.freezes[0], H.freezes[1])
  const secondChain = await link(H.claimId, H.freezes[2], H.freezes[3])
  check('T044', 'One chain per Claim', H1.status === 201 && secondChain.status === 409 && /tail/.test(secondChain.body?.error?.message ?? ''), 'a link that does not start at the chain\'s tail would start a second chain: refused')
  const before45 = await counts()
  const replay1 = await link(C.claimId, S1, S2, 'CORRECTED_CODING')
  check('T045', 'Exact replay', replay1.status === 200 && same(replay1.body, L1.body) && (await unchanged(before45)), 'the identical request again: 200 with the identical body, no row and no audit')
  const otherReason = await link(C.claimId, S1, S2, 'CORRECTED_PRICING')
  check('T046', 'Same pair, other reason', otherReason.status === 409 && errorCode(otherReason.body) === 'CLAIM_CORRECTION_NOT_ALLOWED' && (await unchanged(before45)), 'a recorded pair with another reason is refused, never rewritten')
  const L3 = await link(C.claimId, S3, S4, 'INTERNAL_OTHER')
  const chain3 = await historyOf(C.claimId)
  check('T047', 'Multi-step chain', L3.status === 201 && same(chain3.map((l: any) => l.correctedSubmissionId), [S2, S3, S4]), 'S1 → S2 → S3 → S4: a three-link chain in order')
  const replayAfterGrowth = await link(C.claimId, S1, S2, 'CORRECTED_CODING')
  check('T048', 'Replay after growth', replayAfterGrowth.status === 200 && same(replayAfterGrowth.body, L1.body), 'the first link still replays exactly after the chain has grown')
  check('T049', 'Graph shapes (unit)', chainTest.ok && /ℹ pass 10/.test(chainTest.output) && /ℹ fail 0/.test(chainTest.output), 'self, fork, join, two- and three-cycles, two chains, chronology, same assessment and tail-only growth are proven on the pure chain logic')
  const nonLinear = await prisma.$queryRaw<{ bad: bigint }[]>`
    SELECT count(*) AS bad FROM (
      SELECT l.claim_id, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM claim_correction_links n WHERE n.corrected_submission_id = l.prior_submission_id)) AS roots
      FROM claim_correction_links l GROUP BY l.claim_id) g WHERE g.roots <> 1`
  check('T050', 'Every Claim is one chain', Number(nonLinear[0].bad) === 0, 'every Claim with links in the database has exactly one root: one linear chain each')

  // ---------------------------------------------------------------- direct SQL (T051–T060)
  section('Direct SQL: foreign keys, unique keys, CHECKs, same-Claim, chronology, time and immutability')
  const fkRows = await prisma.$queryRaw<{ name: string; del: string }[]>`SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = ${TABLE}`
  check('T051', 'RESTRICT foreign keys', fkRows.length === 4 && fkRows.every((row) => row.del === 'r'), 'Claim, prior, correction and actor foreign keys are all ON DELETE RESTRICT')
  const control = await directInsert({ claimId: H.claimId, prior: H.freezes[1], corrected: H.freezes[2] })
  check('T052', 'Valid direct insert accepted', control.includes(NOT_REFUSED), 'a legal next link inserted directly is accepted (then rolled back): the refusals below are the guards, not the setup')
  const forkSql = await directInsert({ claimId: H.claimId, prior: H.freezes[0], corrected: H.freezes[2] })
  check('T053', 'Fork refused', refusedBy(forkSql, /prior_submission_id_key|claim_correction_chain/), `a second correction of one prior is refused by the database (${markerOf(forkSql)})`)
  const joinSql = await directInsert({ claimId: G.claimId, prior: G.freezes[1], corrected: G.freezes[2] })
  check('T054', 'Join refused', refusedBy(joinSql, /corrected_submission_id_key|claim_correction_chain/), `a second prior of one correction is refused by the database (${markerOf(joinSql)})`)
  const contractSql = await directInsert({ claimId: H.claimId, prior: H.freezes[1], corrected: H.freezes[2], contract: 'A6-CORRECTION-2' })
  check('T055', 'Contract CHECK', refusedBy(contractSql, /contract_version_chk/), 'only A6-CORRECTION-1')
  const reasonSql = [await directInsert({ claimId: H.claimId, prior: H.freezes[1], corrected: H.freezes[2], reason: 'typo fixed' }), await directInsert({ claimId: H.claimId, prior: H.freezes[1], corrected: H.freezes[2], reason: 'corrected_coding' })]
  check('T056', 'Reason CHECK', reasonSql.every((message) => refusedBy(message, /reason_chk/)), `free text and a near-miss code are refused by CHECK (${reasonSql.map(markerOf).join(', ')})`)
  const crossSql = await directInsert({ claimId: H.claimId, prior: H.freezes[1], corrected: E.freezes[0] })
  const tenantSql = await directInsert({ claimId: E.claimId, prior: H.freezes[1], corrected: H.freezes[2] })
  check('T057', 'Same-Claim guard', refusedBy(crossSql, /claim_correction_coherence/) && refusedBy(tenantSql, /claim_correction_coherence/), 'a correction of another Claim, or a link filed under another Claim, is refused by the database (cross-Claim, therefore cross-tenant)')
  const assessmentSql = await directInsert({ claimId: D.claimId, prior: D.freezes[0], corrected: D.freezes[1] })
  const backdatedSql = await directInsert({ claimId: H.claimId, prior: H.freezes[2], corrected: H.freezes[1] })
  check('T058', 'Assessment and chronology guard', refusedBy(assessmentSql, /claim_correction_coherence/) && refusedBy(backdatedSql, /claim_correction_chronology|claim_correction_chain/), `same assessment (${markerOf(assessmentSql)}) and a backdated correction (${markerOf(backdatedSql)}) are refused by the database`)
  const timeSql = await directInsert({ claimId: H.claimId, prior: H.freezes[1], corrected: H.freezes[2], recordedAt: true })
  check('T059', 'Database time only', refusedBy(timeSql, /claim_correction_time/), 'a supplied instant is refused')
  const updates = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${TABLE} SET reason_code = reason_code WHERE claim_id = $1::uuid`, C.claimId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE claim_id = $1::uuid`, C.claimId)),
  ]
  check('T060', 'No update or delete', updates.every((message) => /is append-only/.test(message)), 'UPDATE (even a no-op) and DELETE are refused')

  // ---------------------------------------------------------------- atomicity (T061–T070)
  section('Atomicity: crash after insert, crash after audit, rollback, no partial data, audit once')
  check('T061', 'One-shot link', after21.links - before21.links === 1 && after21.correction_audits - before21.correction_audits === 1 && after21.all_audits - before21.all_audits === 1 && after21.freezes === before21.freezes, 'exactly one link and one audit; no freeze, decision or lifecycle row')
  const K = await series('crash injection', 2)
  const countsBeforeCrash = await counts()
  const crashAt = async (probe: string) => {
    clearConcurrencyProbes()
    setConcurrencyProbe(probe, async () => {
      throw new Error(`INJECTED_CRASH_AT_${probe}`)
    })
    const message = await attemptAdversarial(() => recordCorrectionLink(K.claimId, { priorSubmissionId: K.freezes[0], correctedSubmissionId: K.freezes[1], reasonCode: 'CORRECTED_SOURCE' }, creatorId))
    clearConcurrencyProbes()
    return { message, unchanged: await unchanged(countsBeforeCrash) }
  }
  const crash1 = await crashAt('claimCorrection.inserted')
  const crash2 = await crashAt('claimCorrection.audited')
  check('T062', 'Crash after the link', crash1.message.includes('INJECTED_CRASH') && crash1.unchanged, 'a failure after the link insert rolls back everything')
  check('T063', 'Crash after the audit', crash2.message.includes('INJECTED_CRASH') && crash2.unchanged, 'a failure after the audit, before commit, rolls back the link and the audit')
  const retry = await link(K.claimId, K.freezes[0], K.freezes[1], 'CORRECTED_SOURCE')
  check('T064', 'Retry after a crash', retry.status === 201 && (await prisma.claimCorrectionLink.count({ where: { claimId: K.claimId } })) === 1, 'the same request after the failures links exactly once')
  const missingActor = await directInsert({ claimId: H.claimId, prior: H.freezes[1], corrected: H.freezes[2], actor: MISSING })
  check('T065', 'Missing actor refused', refusedBy(missingActor, /recorded_by_user_id_fkey|foreign key/), 'a link by a non-existent user is refused by the foreign key')
  const atomic = await prisma.$queryRaw<{ bad: bigint }[]>`
    SELECT count(*) AS bad FROM claim_correction_links l WHERE (SELECT count(*) FROM audit_events a WHERE a.entity_id = l.id AND a.action_code = 'claim_correction.linked') <> 1`
  check('T066', 'Audit exactly once', Number(atomic[0].bad) === 0, 'every correction link in the database has exactly one audit event')
  const audits67 = await counts()
  check(
    'T067',
    'No audit on replay or refusal',
    audits67.correction_audits - before45.correction_audits === 2 && audits67.links - before45.links === 2,
    'since T045 exactly the two new links (S3 → S4 and the crash retry) wrote one audit each; two replays, the reused pair, the crashes and every refusal wrote none',
  )
  const missingFreeze = await directInsert({ claimId: H.claimId, prior: H.freezes[1], corrected: MISSING })
  check('T068', 'Missing freeze refused', refusedBy(missingFreeze, /corrected_submission_id_fkey|foreign key/), 'a link to a non-existent freeze is refused by the foreign key')
  const distinctSql = await directInsert({ claimId: H.claimId, prior: H.freezes[1], corrected: H.freezes[1] })
  check('T069', 'Self link refused in SQL', refusedBy(distinctSql, /distinct_chk|claim_correction_coherence/), `a direct self link is refused by the database (${markerOf(distinctSql)})`)
  const auditTimes = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT bool_and((a.after_state->>'recordedAt')::timestamptz = date_trunc('milliseconds', l.recorded_at)) AS ok FROM claim_correction_links l JOIN audit_events a ON a.entity_id = l.id WHERE l.claim_id = ${C.claimId}::uuid`
  check('T070', 'One database instant', auditTimes[0]?.ok === true, 'each audit records exactly its link\'s database time')

  // ---------------------------------------------------------------- concurrency (T071–T080)
  section('Concurrency: duplicates, fork and join races, lock ordering, bounded retry, unknown outcome')
  const serviceCode = committedCode(`${CORRECTION_DIR}/claim-correction.service.ts`)
  const txBody = serviceCode.slice(serviceCode.indexOf('async function linkOnTransaction'), serviceCode.indexOf('export async function recordCorrectionLink'))
  check(
    'T071',
    'Claim lock first, SERIALIZABLE',
    /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(txBody.split('\n').slice(0, 3).join('\n')) && /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode) && !/withReadSnapshot|prisma\./.test(txBody),
    'the Claim row lock (NOWAIT) is the first statement; every read and write uses the one SERIALIZABLE transaction client',
  )
  const R1 = await series('concurrent duplicate', 2)
  const before72 = await counts()
  const dup = await Promise.all([link(R1.claimId, R1.freezes[0], R1.freezes[1]), link(R1.claimId, R1.freezes[0], R1.freezes[1])])
  const after72 = await counts()
  check('T072', 'Simultaneous duplicates', same(dup.map((r) => r.status).sort(), [200, 201]) && same(dup[0].body, dup[1].body) && after72.links - before72.links === 1 && after72.correction_audits - before72.correction_audits === 1, `${dup.map((r) => r.status).sort().join('/')}: one link, one audit`)
  const R2 = await series('fork race', 3)
  const forkRace = await Promise.all([link(R2.claimId, R2.freezes[0], R2.freezes[1]), link(R2.claimId, R2.freezes[0], R2.freezes[2])])
  check('T073', 'Fork race', same(forkRace.map((r) => r.status).sort(), [201, 409]) && (await prisma.claimCorrectionLink.count({ where: { claimId: R2.claimId } })) === 1, `two different corrections of one prior at once: ${forkRace.map((r) => r.status).sort().join('/')}; exactly one link`)
  const R3 = await series('join race', 3)
  const joinRace = await Promise.all([link(R3.claimId, R3.freezes[0], R3.freezes[2]), link(R3.claimId, R3.freezes[1], R3.freezes[2])])
  check('T074', 'Join race', same(joinRace.map((r) => r.status).sort(), [201, 409]) && (await prisma.claimCorrectionLink.count({ where: { claimId: R3.claimId } })) === 1, `two priors for one correction at once: ${joinRace.map((r) => r.status).sort().join('/')}; exactly one link`)
  const R4 = await series('line edit', 2)
  const hold75 = holdAt('claimLine.removed')
  const removal = removeClaimLine(R4.lineIds[1], {}, creatorId)
  await Promise.race([hold75.arrived, removal])
  const link75 = recordCorrectionLink(R4.claimId, { priorSubmissionId: R4.freezes[0], correctedSubmissionId: R4.freezes[1], reasonCode: 'CORRECTED_SOURCE' }, creatorId)
  const waited75 = !(await settledWithin(link75, 3000))
  hold75.release()
  const removed = await removal
  const r75 = await link75
  clearConcurrencyProbes()
  check('T075', 'Ordered after Claim writers', waited75 && removed.ok && r75.ok && !r75.value.replayed, 'a link during an uncommitted A6.2 line edit waits for the shared Claim lock, then records')
  const R5 = await series('revocation', 2)
  const latest5 = await prisma.claimReviewEvent.findFirstOrThrow({ where: { claimId: R5.claimId }, orderBy: { sequence: 'desc' } })
  const assessment5 = await prisma.claimDraftAssessment.findUniqueOrThrow({ where: { id: latest5.draftAssessmentId }, select: { id: true, assemblyFingerprint: true } })
  const hold76 = holdAt('claimReview.inserted')
  const revoke76 = recordReviewDecision(R5.claimId, { draftAssessmentId: assessment5.id, assemblyFingerprint: assessment5.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: latest5.id }, B.id)
  await Promise.race([hold76.arrived, revoke76])
  const link76 = recordCorrectionLink(R5.claimId, { priorSubmissionId: R5.freezes[0], correctedSubmissionId: R5.freezes[1], reasonCode: 'CORRECTED_PRICING' }, creatorId)
  const waited76 = !(await settledWithin(link76, 3000))
  hold76.release()
  const revoked = await revoke76
  const r76 = await link76
  clearConcurrencyProbes()
  check('T076', 'Approvals are not rechecked', waited76 && revoked.ok && r76.ok, 'a link during an uncommitted A6.5 REVOKE waits for the Claim lock, then records: a link neither re-derives nor extends approval')
  const R6 = await series('lifecycle race', 2)
  const hold77 = holdAt('claimCorrection.claim_locked')
  const link77 = recordCorrectionLink(R6.claimId, { priorSubmissionId: R6.freezes[0], correctedSubmissionId: R6.freezes[1], reasonCode: 'CORRECTED_CODING' }, creatorId)
  await Promise.race([hold77.arrived, link77])
  const event77 = recordLifecycleEvent(R6.freezes[0], { eventCode: 'WITHDRAW_INTERNAL', reasonCode: 'INTERNAL_CORRECTION_PENDING' }, creatorId)
  const waited77 = !(await settledWithin(event77, 3000))
  hold77.release()
  const r77 = await link77
  const e77 = await event77
  clearConcurrencyProbes()
  check('T077', 'Lifecycle decisions serialize with links', waited77 && r77.ok && e77.ok && e77.value.lifecycle.state === 'WITHDRAWN_INTERNAL', 'an A6.8 event during an in-flight link waits for the Claim lock; both commit; the link changed no disposition')
  check(
    'T078',
    'Bounded retry',
    /const MAX_LINK_ATTEMPTS = 3/.test(serviceCode) && /const MAX_LOCK_WAITS = 5/.test(serviceCode) && /P2034/.test(serviceCode) && /40001/.test(serviceCode) && /isUniqueViolation\(error\)/.test(serviceCode),
    'serialization, deadlock and unique races retry at most three times on a fresh transaction (re-reading the replay or refusal); a busy Claim is waited for at most five times',
  )
  check(
    'T079',
    'Unknown outcome never re-appended',
    /if \(isUnknownOutcome\(error\)\)\s*return \{ ok: false, code: 'CLAIM_CORRECTION_CONFLICT'/.test(serviceCode),
    'a lost connection or transaction is a safe 409 telling the caller to read the history, never a blind second append',
  )
  const R7 = await series('isolation', 2)
  const hold80 = holdAt('claimCorrection.inserted')
  const pending80 = recordCorrectionLink(R7.claimId, { priorSubmissionId: R7.freezes[0], correctedSubmissionId: R7.freezes[1], reasonCode: 'CORRECTED_CODING' }, creatorId)
  await Promise.race([hold80.arrived, pending80])
  const during80 = api('GET', linksPath(R7.claimId))
  const prompt80 = await settledWithin(during80, 5000)
  const duringItems = (await during80).body?.items ?? null
  hold80.release()
  const r80 = await pending80
  clearConcurrencyProbes()
  check('T080', 'Reads see committed history', prompt80 && Array.isArray(duringItems) && duringItems.length === 0 && r80.ok && (await historyOf(R7.claimId)).length === 1, 'a read during an uncommitted link answers at once from the committed history; after the commit it shows the link')

  // ---------------------------------------------------------------- read integrity (T081–T090)
  section('Read integrity: history order, deterministic chain, corrupt history refusal, tenant reads')
  const twice = [await historyOf(C.claimId), await historyOf(C.claimId)]
  check('T081', 'Deterministic history', same(twice[0], twice[1]) && twice[0].length === 3, 'the same links always read in the same chain order')
  const followed: string[] = []
  const rowsC = await prisma.claimCorrectionLink.findMany({ where: { claimId: C.claimId } })
  for (let cursor: string | undefined = S1; cursor !== undefined; cursor = rowsC.find((row) => row.priorSubmissionId === cursor)?.correctedSubmissionId) followed.push(cursor)
  check('T082', 'Independent chain derivation', same(followed, [S1, S2, S3, S4]) && same(twice[0].map((l: any) => l.priorSubmissionId).concat(twice[0].at(-1).correctedSubmissionId), followed), 'following the stored links from the root gives exactly the history order')
  const corruptRead = async (setup: (tx: any) => Promise<unknown>) => {
    let outcome = 'NOT_RUN'
    await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        await setup(tx)
        const result = await getCorrectionChain(C.claimId, tx)
        outcome = result.ok ? `OK ${result.value.items.length}` : result.code
        throw new Error(NOT_REFUSED)
      }),
    )
    return outcome
  }
  const insertRaw = (tx: any, prior: string, corrected: string) =>
    tx.$executeRawUnsafe(`INSERT INTO ${TABLE} (id, claim_id, prior_submission_id, corrected_submission_id, reason_code, recorded_by_user_id, contract_version) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'INTERNAL_OTHER', $4::uuid, 'A6-CORRECTION-1')`, C.claimId, prior, corrected, creatorId)
  const cycleRead = await corruptRead((tx) => insertRaw(tx, S4, S1))
  check('T083', 'Cycle refused on read', cycleRead === 'CLAIM_CORRECTION_CONFLICT', `a cycle written behind the guards (rolled back) is refused on read: ${cycleRead}; never guessed`)
  const secondRead = await corruptRead((tx) => insertRaw(tx, E.freezes[0], H.freezes[0]))
  check('T084', 'Second chain refused on read', secondRead === 'CLAIM_CORRECTION_CONFLICT', `a disjoint second chain written behind the guards (rolled back): ${secondRead}`)
  const tenantReads = [await api('GET', linksPath(C.claimId), undefined, O.who), await api('GET', linkPath(L1.body.correctionLinkId), undefined, O.who)]
  check('T085', 'Cross-tenant reads', tenantReads.every((res) => res.status === 404), "another organization's Admin gets 404 for this Claim's history and links")
  const before86 = await counts()
  for (const target of [C, G, H]) await api('GET', linksPath(target.claimId))
  await api('GET', linkPath(L1.body.correctionLinkId))
  const readsLeftNothing = await unchanged(before86)
  check('T086', 'Reads write nothing', readsLeftNothing, 'history and link reads wrote no row and no audit')
  const viewerHistory = await api('GET', linksPath(C.claimId), undefined, asViewer)
  const viewerLink = await api('GET', linkPath(L1.body.correctionLinkId), undefined, asViewer)
  check('T087', 'Viewer sees the same', same(viewerHistory.body, { items: twice[0] }) && same(viewerLink.body, L1.body), 'a Viewer reads exactly what an Admin reads')
  const missingLink = await api('GET', linkPath(MISSING))
  check('T088', 'Missing link', missingLink.status === 404 && errorCode(missingLink.body) === 'NOT_FOUND', 'a missing link: 404')
  check('T089', 'Empty history', same((await api('GET', linksPath(E.claimId))).body, { items: [] }), 'a Claim without links has an empty history')
  const inTx = await withReadSnapshot(undefined, (tx) => getCorrectionChain(C.claimId, tx))
  check('T090', 'Transaction-aware read', inTx.ok && same(inTx.value.items, twice[0]), 'getCorrectionChain(claimId, tx) for later owners equals the HTTP read')

  // ---------------------------------------------------------------- lifecycle separation (T091–T100)
  section('Lifecycle separation: A6.8 dispositions unchanged, no transport, no payer status, A6.7 bytes kept')
  const W = await series('withdrawn prior', 2)
  const withdrawn = await post(`/api/claim-submissions/${W.freezes[0]}/lifecycle-events`, { eventCode: 'WITHDRAW_INTERNAL', reasonCode: 'INTERNAL_CORRECTION_PENDING' })
  const eventsBefore = (await api('GET', `/api/claim-submissions/${W.freezes[0]}/lifecycle-events`)).body?.items
  const linkW = await link(W.claimId, W.freezes[0], W.freezes[1], 'CORRECTED_CODING')
  const stateW = await api('GET', `/api/claim-submissions/${W.freezes[0]}/lifecycle`)
  check('T091', 'Withdrawn prior stays terminal', withdrawn.status === 201 && linkW.status === 201 && stateW.body?.state === 'WITHDRAWN_INTERNAL', 'a withdrawn prior may be linked as history; it stays WITHDRAWN_INTERNAL (never reopened)')
  const Hd = await series('held correction', 2)
  await post(`/api/claim-submissions/${Hd.freezes[1]}/lifecycle-events`, { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_DATA_REVIEW' })
  const linkHd = await link(Hd.claimId, Hd.freezes[0], Hd.freezes[1])
  check('T092', 'Dispositions unchanged', linkHd.status === 201 && (await api('GET', `/api/claim-submissions/${Hd.freezes[1]}/lifecycle`)).body?.state === 'HELD' && (await api('GET', `/api/claim-submissions/${Hd.freezes[0]}/lifecycle`)).body?.state === 'FROZEN', 'a HELD correction stays HELD and its prior stays FROZEN: a link does not gate on or change any disposition')
  const production = committedProductionCodeOf([CORRECTION_DIR])
  check('T093', 'No transport', !/from 'node:(http|https|net|tls|dgram)'|fetch\(|axios|undici|<\?xml|x12|hl7|fhir|outbox|queue|enqueue/i.test(production.code), 'no network client, XML/X12/HL7/FHIR, outbox or queue in A6.9 code')
  const columns = async (table: string) => (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`).map((row) => row.c)
  const linkColumns = await columns(TABLE)
  check(
    'T094',
    'No payer status anywhere',
    linkColumns.length === 9 && linkColumns.every((c) => A69_COLUMNS.includes(c)) && (await columns('claims')).length === 7 && (await columns('claim_freezes')).length === 13,
    'the link table has exactly its 9 columns (no status, payer or resubmission field); claims and claim_freezes gained no column',
  )
  check('T095', 'A6.7 bytes kept', (await claimHash(C.claimId)) === hashCBefore && same((await api('GET', `/api/claim-submissions/${S4}`)).body?.payloadSha256, (await prisma.claimFreeze.findUniqueOrThrow({ where: { id: S4 }, select: { payloadSha256: true } })).payloadSha256), 'every frozen submission keeps its own bytes and digest; no correction replaces them')
  check('T096', 'A6.7 reads unchanged', same((await api('GET', `/api/claim-submissions/${S1}`)).body, freezeReadBefore), 'the A6.7 frozen submission read is identical before and after three links')
  const eventsAfter = (await api('GET', `/api/claim-submissions/${W.freezes[0]}/lifecycle-events`)).body?.items
  check('T097', 'No automatic withdrawal or release', same(eventsAfter, eventsBefore) && same(await Promise.all(C.freezes.map(async (id) => (await api('GET', `/api/claim-submissions/${id}/lifecycle`)).body?.state)), ['FROZEN', 'FROZEN', 'FROZEN', 'FROZEN']), 'linking wrote no lifecycle event on either freeze')
  const decisionsBefore98 = (await counts()).decisions
  await link(C.claimId, S1, S2, 'CORRECTED_CODING')
  check('T098', 'Approvals untouched', (await counts()).decisions === decisionsBefore98, 'a link writes no A6.5 decision')
  const extraTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(correction|successor|supersed|resubmi|outbox|queue|job|transmission|acknowledg|remittance)'`).map((row) => row.t)
  check('T099', 'One new table, no queue', same(extraTables, [TABLE]), 'exactly one correction table; no successor, resubmission, outbox, queue, job, transmission or acknowledgement table')
  check(
    'T100',
    'Never a writer of earlier owners',
    !/recordLifecycleEvent|insertFreeze|freezeClaimSubmission|recordReviewDecision|createDraftAssessment|createPricingRun/.test(production.code) && /getFrozenSubmission/.test(production.code) && /getCurrentLifecycle/.test(production.code),
    'A6.9 only reads the A6.7 freeze and the A6.8 lifecycle through their owners; it never freezes, records lifecycle, decides, assesses or prices',
  )

  // ---------------------------------------------------------------- privacy and audit (T101–T110)
  section('Privacy and audit: minimal DTO, one audit, no PHI or payload exposure')
  check('T101', 'Minimal DTO', [L1.body, L2.body, ...twice[0]].every((dto: any) => same(Object.keys(dto), DTO_KEYS)), 'every response carries exactly the eight DTO fields')
  const auditL1 = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: L1.body.correctionLinkId } })
  check('T102', 'Audit action and keys', auditL1.actionCode === 'claim_correction.linked' && auditL1.entityType === 'CLAIM_CORRECTION_LINK' && same(Object.keys(auditL1.afterState as object).sort(), [...AUDIT_KEYS].sort()) && auditL1.beforeState === null, 'claim_correction.linked on CLAIM_CORRECTION_LINK with exactly ids, reason, contract and time')
  const auditL2 = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: L2.body.correctionLinkId } })
  check('T103', 'Audit actor and tenant', auditL1.actorUserId === creatorId && auditL2.actorUserId === B.id && auditL1.organizationId === org, 'each audit names its actor and the Claim\'s organization')
  const exposed = JSON.stringify([L1.body, twice[0], auditL1.afterState, auditL2.afterState])
  check('T104', 'PHI minimization', !exposed.includes(`${runId}-P`) && !exposed.includes('1990-01-01') && !exposed.includes(key('DXA')) && !/125\.25|12\.125|[0-9a-f]{64}/.test(exposed), 'no patient name, birth date, diagnosis code, amount or digest in any DTO or audit')
  check('T105', 'No bytes or manifest', ![...deepKeys(JSON.parse(exposed))].some((k) => /bytes|manifest|payload|seal|sha|hash/i.test(k)), 'link responses and audits carry no payload bytes, manifest, seal or digest')
  check('T106', 'Safe error bodies', [...unknownFields, ...serverOwned, ...badReasons, ...malformed, self, viewerPost, ...foreignAdmin, fork, join, cycle, secondChain, otherReason, sameAssessment, reverse].every((res) => !rawError(res.body)), 'every 400/403/404/409 carries a code and a safe message only')
  const frontend = committedCode(`${FE_CORRECTION_DIR}/ClaimCorrectionCheck.tsx`)
  check('T107', 'Read-only page, no storage', frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|console\.|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend), 'the Developer Tools page only reads; nothing is logged or kept in browser storage')
  check('T108', 'No logs', !/console\.|logger\./.test(production.code), 'the A6.9 backend code logs nothing')
  check('T109', 'Refusals audited never', refusalsLeftNothing && identityRefusalsLeftNothing, 'request refusals (T012–T019) and identity refusals (T031–T039) wrote no row and no audit')
  check('T110', 'No audit on reads', readsLeftNothing, 'reads wrote no audit (T086)')

  // ---------------------------------------------------------------- regressions (T111–T120)
  section('Regressions — A6.8 invoked, nesting A6.7 -> A6.6 -> A6.5 -> A6.4 -> A6.3 -> A6.2 -> A6.1 -> A5.10 -> A1')
  await apiReady('the A6.8 and backward regression chain')
  const chain = run('npm run test:a6:claim-lifecycle')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A6.8')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.8] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.8 asserts facts about its own branch, its own migration and diff, the absence of a correction table
  // (the A6.8 → A6.9 boundary) and its own upstream. On A6.9 those statements are obsolete by design; every
  // other A6.8 check is substantive. T120 below proves each cause independently, never from the id.
  const a68NonApplicable: Record<string, string> = {
    T001: "A6.8 'Start gate' requires the A6.8 feature branch and no correction code; A6.9 is branched from the main that contains A6.8 and adds the claim-correction module",
    T004: "A6.8 'Only the A6.8 migration' judges its own branch's migration; A6.9 adds exactly one different migration (T004 here)",
    T010: "A6.8 'Diff scope' lists the paths A6.8 was allowed to change; A6.9 legitimately changes different ones (T010 here)",
    T109: "A6.8 'No queue, successor or second table' is the A6.8 → A6.9 boundary itself: the only such table is A6.9's own claim_correction_links and no queue/outbox table exists (T099/T120 here)",
    T120: "A6.8 'Nested N/A causes proven' proves A6.7's causes against the A6.8 branch (its migration, diff, schema, tables and upstream); on A6.9 those proofs are re-done here (T120)",
    T130: "A6.8 'Exact head, repeatability, evidence' requires the upstream to be the A6.8 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a68NonApplicable))
  const summary = chain.output.match(/\[A6\.8\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T130') && !/\[A6\.8\] RUN ABORTED|\[A6\.8\] uncaught error/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOf = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  check(
    'T111',
    'A6.8 regression',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A6.8 suite did not complete'
      : !reconciled
        ? `A6.8 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A6.8 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A6\.8\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.8] automated summary: ', 'A6.8 ')}; all ${failedCount} failure(s) named and accounted for`,
  )
  for (const id of Object.keys(a68NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A6.8 ${titleOf(row.line)}`, a68NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[A6.9]      ${text.slice(0, 400)}`)
  check('T112', 'A6.7 regression', verdictOf('T111') === 'PASS', `A6.8 T111 (A6.7 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A6.6 regression', verdictOf('T112') === 'PASS', `A6.8 T112 (A6.6) ${verdictOf('T112')}`)
  check('T114', 'A6.5 regression', verdictOf('T113') === 'PASS', `A6.8 T113 (A6.5) ${verdictOf('T113')}`)
  check('T115', 'A6.4 regression', verdictOf('T114') === 'PASS', `A6.8 T114 (A6.4) ${verdictOf('T114')}`)
  check('T116', 'A6.3 regression', verdictOf('T115') === 'PASS', `A6.8 T115 (A6.3) ${verdictOf('T115')}`)
  check('T117', 'A6.2 and A6.1 regression', verdictOf('T116') === 'PASS' && verdictOf('T117') === 'PASS', `A6.8 T116 (A6.2) ${verdictOf('T116')}, T117 (A6.1) ${verdictOf('T117')}`)
  check('T118', 'A5 and A1–A4 regression', verdictOf('T118') === 'PASS', `A6.8 T118 (A5.8–A5.10 and A1–A4 through A6.7) ${verdictOf('T118')}`)
  const a68Substantive = rows.filter((row) => !(row.id in a68NonApplicable) && row.verdict !== 'PASS' && !row.id.includes('/'))
  check('T119', 'A6.8 substantive checks', ran && a68Substantive.length === 0 && rows.filter((row) => row.verdict === 'PASS').length >= 120 && verdictOf('T119') === 'PASS', `${rows.filter((row) => row.verdict === 'PASS').length} A6.8 checks PASS — transitions, guards, races, crash, reducer and audit — with no substantive FAIL`)
  // Each documented A6.8 failure must fail for its branch-only reason, proved independently on this branch.
  const a68LaterFiles = git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter((file) => /claim-correction|claim-supersession|claim-resubmission|claim-transport|claim-outbox|dhpo|eclaimlink|remittance/i.test(file))
  const a68Unexpected = (lineOf('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const isA69Change = (file: string, index: number) => changedPaths.includes(file) || (index === a68Unexpected.length - 1 && changedPaths.some((path) => path.startsWith(file)))
  const unprovenA67 = (lineOf('T120').match(/cause not proven for: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  const schemaDiff = gitArgs(['diff', 'origin/main...HEAD', '--', ':/backend/prisma/schema.prisma']).split(/\r?\n/)
  const schemaRemoved = schemaDiff.filter((line) => /^-[^-]/.test(line))
  const schemaModels = schemaDiff.filter((line) => /^\+model /.test(line)).map((line) => line.replace(/^\+model (\w+).*/, '$1'))
  const queueLike = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(outbox|queue|job|transmission|acknowledg|remittance|successor|supersed|correction)'`).map((row) => row.t)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  const causes: Record<string, boolean> = {
    T001: a68LaterFiles.length > 0 && a68LaterFiles.every((file) => ownDirs.some((dir) => file.startsWith(`${dir}/`))),
    T004: same(migrationStatus, [`A\t${MIGRATION}`]),
    T010: a68Unexpected.length > 0 && a68Unexpected.every(isA69Change) && outOfScope.length === 0,
    T109: same(queueLike, [TABLE]),
    // A6.8 re-proves A6.7's branch-only causes against the A6.8 branch; on A6.9 only those tied to the
    // branch (migration, diff, schema model, the correction table and upstream) can be unproven — re-proved
    // here against this branch.
    T120:
      unprovenA67.length > 0 &&
      unprovenA67.every((id) => ['T004', 'T010', 'T105', 'T109', 'T120', 'T130'].includes(id)) &&
      same(migrationStatus, [`A\t${MIGRATION}`]) &&
      outOfScope.length === 0 &&
      schemaRemoved.length === 0 &&
      same(schemaModels, ['ClaimCorrectionLink']) &&
      same(queueLike, [TABLE]) &&
      tracking.includes(`origin/${a69Branch}`),
    T130: tracking.includes(`origin/${a69Branch}`) && !/origin\/feature\/a6-8/.test(tracking),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  check('T120', 'Nested N/A causes proven', ran && unproven.length === 0, unproven.length === 0 ? `each documented A6.8 failure (${failing.join(', ') || 'none'}) fails only for its branch-only reason, proved independently on this branch` : `cause not proven for: ${unproven.join(', ')}`)

  // ---------------------------------------------------------------- builds and final evidence (T121–T130)
  section('Units, typecheck, frontend, Prisma/replay, DB outage truth, synthetic only, exact head')
  const allUnit = run('npm run test:unit')
  check('T121', 'Unit tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the A6.9 chain and request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Typecheck', typecheck.ok, 'backend typecheck clean')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const appliedChecksum = (await prisma.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM _prisma_migrations WHERE migration_name = '20261019090000_a6_9_correction_resubmission_lineage' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.checksum
  const fileChecksum = sha256Of(readFileSync(`../${MIGRATION}`))
  check('T125', 'Prisma and replay', replay.ok && status.ok && appliedChecksum === fileChecksum, `the A6.9 migration is applied with the checksum of the committed file (${fileChecksum.slice(0, 12)}…); replay clean`)
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
  const afterOutage = await historyOf(C.claimId)
  const runClaims = new Set([C, D, G, H, E, K, R1, R2, R3, R4, R5, R6, R7, W, Hd].map((subject) => subject.claimId))
  const runLinks = await prisma.claimCorrectionLink.findMany({ where: { createdAt: { gte: rowL1.createdAt } }, select: { claimId: true } })
  check('T127', 'Synthetic data only', runLinks.length > 0 && runLinks.every((row) => runClaims.has(row.claimId)), `${runLinks.length} links in this run, every one on a synthetic Claim built by this run (names keyed by ${runId})`)
  check('T128', 'No unexpected 5xx', serverErrors === 0 && same(afterOutage, twice[0]), `${serverErrors} HTTP 5xx answers in this run; the chain reads back identically after the database restart`)
  console.log(`[A6.9]      worked example: Claim ${C.claimId}: S1 ${S1} -> S2 ${S2} (CORRECTED_CODING) -> S3 ${S3} (CORRECTED_DOCUMENTATION) -> S4 ${S4} (INTERNAL_OTHER)`)
  check('T129', 'Worked example evidence', same(afterOutage.map((l: any) => [l.priorSubmissionId, l.correctedSubmissionId, l.reasonCode]), [[S1, S2, 'CORRECTED_CODING'], [S2, S3, 'CORRECTED_DOCUMENTATION'], [S3, S4, 'INTERNAL_OTHER']]) && fork.status === 409 && cycle.status === 409 && crossClaim.status === 404, 'the printed chain reads back exactly; its second successor, reverse cycle and cross-Claim link were refused')

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  check(
    'T010',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A6.9 module, migration and model, harness and check page, two permissions, two error codes, one audit action and wiring; no owner changed; no A9/A7 domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  check(
    'T130',
    'Exact head, repeatability, evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a69Branch}`) && !/ahead|behind/.test(tracking) && same(afterOutage, twice[0]),
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; after the database restart the worked chain reads back identically`,
  )

  console.log(`\n[A6.9] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A6.9] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A6.9] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A6.9] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A6.9] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A6.9] CORRECTION & RESUBMISSION LINEAGE ACCEPTANCE COMPLETE' : '[A6.9] A6.9 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A6.9] RUN ABORTED: ${error.message}`)
      console.log('[A6.9] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A6.9] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A6.9] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
