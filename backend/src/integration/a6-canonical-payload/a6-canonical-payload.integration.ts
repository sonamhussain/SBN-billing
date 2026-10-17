import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { delimiter } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prisma } from '../../shared/database/prisma.ts'
import { auth } from '../../shared/auth/auth.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordReadinessAssessment } from '../../modules/pre-claim-readiness/pre-claim-readiness.service.ts'
import { createClaim } from '../../modules/claim/claim.service.ts'
import { removeClaimLine } from '../../modules/claim-line/claim-line.service.ts'
import { updateTariffScheduleVersionVerification } from '../../modules/commercial-coverage/tariff-schedule.service.ts'
import { createPricingRun } from '../../modules/claim-pricing/claim-pricing.service.ts'
import { createDraftAssessment } from '../../modules/claim-draft/claim-draft.service.ts'
import { recordReviewDecision } from '../../modules/claim-review/claim-review.service.ts'
import { composeCanonicalClaimPayload } from '../../modules/claim-payload/claim-payload.composer.ts'
import { encodeCanonicalPayload } from '../../modules/claim-payload/claim-payload.serializer.ts'

// A6.6 — focused acceptance for the Canonical Claim Payload Contract & Deterministic Serialization
// (T001–T120).
//
// Every Claim is built through its owners: tariff worlds and rates through REF-01 and the A6.3 rate routes,
// runs through the A5.7 recorder, readiness through the A5.9 route, the Claim, its lines, diagnoses and
// pointers through the A6.1/A6.2 routes, pricing runs through the A6.3 route, draft assessments through the
// A6.4 route and review decisions through the A6.5 route. A separate reviewer approves (separation of duties):
// two synthetic Admin members are provisioned per run through Better Auth's own server-side user and
// credential creation and the existing membership tables, with a random password that is never printed.
// ADVERSARIAL writes go in only to create a state no owner path can create (another tenant's chain, a
// changed source quantity, a corrupted position, a malformed stored amount); every adversarial write that
// must not persist runs in a transaction that is always rolled back. Every value is synthetic and keyed by
// this run's id. A6.6 itself writes nothing, and this suite proves it.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A6.6] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A6.6] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A6.6] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A6.6] ${title}`)

// Every `npm run` prepends its node_modules/.bin directories to PATH again, so each level of the nested
// regression chain makes PATH longer; on Windows the deepest suites then exceed the length cmd.exe can use
// and their own tools stop resolving. A spawned command therefore gets PATH without the .bin entries npm
// added on the way here: npm adds exactly those back for the command it runs, so the nested chain starts
// with the PATH it has when it is run on its own. Nothing else in the environment changes.
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
const gitGrep = (pattern: string, paths: string[]) => {
  const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
  return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
}

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

const runId = `A66-${Date.now()}`
const runStartedAt = new Date()
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
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const PAYLOAD_DIR = 'backend/src/modules/claim-payload'
const FE_PAYLOAD_DIR = 'frontend/src/modules/claim-payload'
const HARNESS_DIR = 'backend/src/integration/a6-canonical-payload'
const UNIT_TEST = `${PAYLOAD_DIR}/claim-payload.validation.test.ts`
const PAYLOAD_KEYS = ['schemaVersion', 'header', 'commercial', 'lines', 'diagnoses', 'financial', 'evidence', 'approval']
const HEADER_KEYS = ['claimId', 'claimContractVersion', 'handoffSchemaVersion', 'encounterId', 'serviceDate', 'facilityId', 'facilityRegulatoryProfileId', 'jurisdictionCode', 'assessedValidationRunId', 'readinessAssessmentId', 'readinessPolicyVersion', 'draftAssessmentId', 'draftContractVersion', 'draftFingerprint', 'pricingRunId', 'pricingContractVersion', 'approvalDecisionId']
const COMMERCIAL_KEYS = ['providerContractId', 'tariffScheduleId', 'tariffScheduleVersionId', 'payerId', 'tpaId', 'networkId', 'insuranceProductId', 'currencyCode']
const LINE_KEYS = ['claimLineId', 'sequence', 'encounterActivityId', 'serviceId', 'procedureCodeId', 'quantity', 'unitCode', 'modifierCodes', 'pricingLineResultId', 'tariffRateId', 'unitTariffAmount', 'extendedAmount', 'currencyCode', 'claimDiagnosisIds']
const DIAGNOSIS_KEYS = ['claimDiagnosisId', 'sequence', 'encounterDiagnosisId', 'roleCode', 'diagnosisCodeId']
const EVIDENCE_KEYS = ['validationFindingIds', 'eligibilityVerificationIds', 'priorAuthorizationVersionIds', 'authorizationLineIds', 'evidenceRequirementIds', 'evidenceArtifactVersionIds', 'ruleVersionIds', 'governingSourceVersionIds', 'referenceDatasetVersionIds']
const APPROVAL_KEYS = ['reviewContractVersion', 'decisionId', 'reviewedAssessmentId', 'reviewFingerprint', 'reviewerUserId']
// The owners A6.6 consumes. A change to any of them would be a change to an accepted contract.
const OWNER_DIRS = [
  'backend/src/modules/claim',
  'backend/src/modules/claim-line',
  'backend/src/modules/claim-diagnosis',
  'backend/src/modules/claim-pricing',
  'backend/src/modules/tariff-rate',
  'backend/src/modules/claim-draft',
  'backend/src/modules/claim-review',
  'backend/src/modules/pre-claim-readiness',
  'backend/src/modules/pre-claim-validation',
  'backend/src/modules/validation-run',
  'backend/src/modules/commercial-coverage',
]
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

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
const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A6.6] A6.6 canonical claim payload & deterministic serialization — run ${runId}`)
  console.log(`[A6.6] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  const tablesAtStart = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).map((row) => row.table_name)

  // ---------------------------------------------------------------- gates (T001–T009)
  section('Start gate, no migration, contract, permission and wiring')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const merges = [mergeOf(a61Branch), mergeOf(a62Branch), mergeOf(a63Branch), mergeOf(a64Branch), mergeOf(a65Branch)]
  const laterA6Code = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /claim-submission|submission-freeze|evidence-package|claim-transport|claim-lifecycle|dhpo|eclaimlink/i.test(file))
  check(
    'T001',
    'Start gate',
    branch === a66Branch && merges.every((sha) => sha.length === 40) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterA6Code.length === 0,
    `branch ${branch}; A6.1–A6.5 merged as ${merges.map((sha) => sha.slice(0, 7) || 'NOT FOUND').join(', ')}; contains latest main ${git('rev-parse --short origin/main')}; no A6.7+ code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check('T003', 'A6.1–A6.5 ancestry', merges.every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)), 'the five accepted merge commits are ancestors of HEAD')
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationChanges = changedPaths.filter((file) => file.includes('prisma/migrations/'))
  const schemaChanged = changedPaths.includes('backend/prisma/schema.prisma')
  check('T004', 'No migration or business table', changedPaths.length > 0 && migrationChanges.length === 0 && !schemaChanged, migrationChanges.length + Number(schemaChanged) === 0 ? 'no migration and no schema change: A6.6 adds no table, column or index' : `changed: ${[...migrationChanges, ...(schemaChanged ? ['schema.prisma'] : [])].join(', ')}`)
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  const replayExpected = [
    /PASS {2}the A6\.5 tables are exactly claim_review_events/,
    /PASS {2}the A6\.4 tables are exactly claim_draft_assessments and claim_draft_findings/,
    /PASS {2}the A6\.3 tables are exactly tariff_rates, claim_pricing_runs and claim_pricing_line_results/,
    /PASS {2}the claim tables are exactly claims plus the four A6\.2 tables/,
  ]
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  const mainMigrationCount = git('ls-tree -d --name-only --full-tree origin/main backend/prisma/migrations/').split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line)).length
  check(
    'T006',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === mainMigrationCount,
    `${appliedCount} migrations applied cleanly from empty — exactly main's ${mainMigrationCount}; every A6.2–A6.5 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^claimCanonical\./.test(code)).sort()
  const invented = allCodes.filter((code) => /(approve|approval|submit|transmit|signOff|patientShare|claimPayload|claimSubmission|remittance|send|export)/i.test(code))
  check(
    'T007',
    'Permission',
    same(family, ['claimCanonical.read']) &&
      (await grantsOf('claimCanonical.read')) === 'ORG_ADMIN' &&
      (await grantsOf('claimReview.decide')) === 'ORG_ADMIN' &&
      (await grantsOf('claimReview.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('claimDraft.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      invented.length === 0,
    'claimCanonical.read for Admin only (no automatic Viewer access); A6.4/A6.5 grants unchanged; no submit, send, export or payload permission',
  )

  await apiReady('signing in')
  let connectionResets = 0
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
  const rawError = (body: unknown) => /\bat \w|prisma|SELECT|INSERT|constraint|trigger/i.test(JSON.stringify(body ?? {}))

  // Synthetic reviewers: Better Auth's own server-side user and credential creation, then an ORG_ADMIN
  // membership through the existing tables. The password is random per run and never printed.
  const authContext = await auth.$context
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' }, select: { id: true } })
  const provisionReviewer = async (label: string) => {
    const email = `${runId.toLowerCase()}-${label}@reviewers.sbn.test`
    const secretValue = randomBytes(24).toString('base64url')
    const user = await authContext.internalAdapter.createUser({ email, name: `Synthetic reviewer ${label}`, emailVerified: false }, { method: 'email-password' })
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', issuer: 'local:credential', accountId: user.id, password: await authContext.password.hash(secretValue) })
    const membership = await prisma.organizationMembership.create({ data: { organizationId: org, userId: user.id } })
    await prisma.membershipRole.create({ data: { membershipId: membership.id, roleId: adminRole.id } })
    const signed = await signIn(email, secretValue)
    if (signed.status !== 200) throw new Error(`fixture reviewer ${label} could not sign in (${signed.status})`)
    return { id: user.id as string, membershipId: membership.id, who: as(signed.cookie) }
  }
  const B = await provisionReviewer('b')
  const D = await provisionReviewer('d')

  const previewPath = (claimId: string) => `/api/claims/${claimId}/canonical-payload/preview`
  const preview = (claimId: string, body: unknown, who: Who = asAdmin) => api('POST', previewPath(claimId), body, who)
  const wiring = await preview(MISSING, { draftAssessmentId: MISSING, approvalDecisionId: MISSING })
  const otherVerbs = [
    await api('GET', previewPath(MISSING)),
    await api('PUT', previewPath(MISSING), {}),
    await api('PATCH', previewPath(MISSING), {}),
    await api('DELETE', previewPath(MISSING)),
    await api('POST', `/api/claims/${MISSING}/canonical-payload`, {}),
    await api('GET', `/api/claims/${MISSING}/canonical-payload`),
    await api('POST', `/api/claims/${MISSING}/canonical-payload/submit`, {}),
    await api('POST', `/api/claims/${MISSING}/submissions`, {}),
  ]
  const unauthenticated = await preview(MISSING, { draftAssessmentId: MISSING, approvalDecisionId: MISSING }, anonymous)
  check(
    'T008',
    'Route wiring',
    wiring.status === 404 && errorCode(wiring.body) === 'NOT_FOUND' && otherVerbs.every((res) => res.status === 404) && unauthenticated.status === 401,
    `one POST preview answers a missing Claim with a privacy-safe 404; GET/PUT/PATCH/DELETE, a bare payload route, submit and submissions are absent (${otherVerbs.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.status}`,
  )

  const constantOf = (path: string, name: string) => (git(`show HEAD:${path}`).match(new RegExp(`export const ${name} = '([^']+)'`)) ?? [])[1]
  const contracts = [
    constantOf('backend/src/modules/pre-claim-readiness/pre-claim-readiness.types.ts', 'READINESS_POLICY_VERSION'),
    constantOf('backend/src/modules/pre-claim-readiness/pre-claim-readiness.types.ts', 'HANDOFF_SCHEMA_VERSION'),
    constantOf('backend/src/modules/claim/claim.types.ts', 'CLAIM_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-line/claim-line.types.ts', 'CLAIM_LINE_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-diagnosis/claim-diagnosis.types.ts', 'CLAIM_DIAGNOSIS_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-pricing/claim-pricing.types.ts', 'PRICING_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-draft/claim-draft.types.ts', 'DRAFT_CONTRACT_VERSION'),
    constantOf('backend/src/modules/claim-review/claim-review.types.ts', 'REVIEW_CONTRACT_VERSION'),
    constantOf(`${PAYLOAD_DIR}/claim-payload.types.ts`, 'PAYLOAD_SCHEMA_VERSION'),
  ]
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)))
  check(
    'T009',
    'Old contracts preserved',
    same(contracts, ['A5-READY-1', 'PreClaimA6HandoffV1', 'A6-CLAIM-1', 'A6-LINE-1', 'A6-DX-1', 'A6-PRICE-1', 'A6-DRAFT-1', 'A6-REVIEW-1', 'A6-PAYLOAD-1']) && ownerChanged.length === 0 && migrationChanges.length === 0,
    ownerChanged.length === 0 ? 'A5-READY-1, PreClaimA6HandoffV1, A6-CLAIM-1, A6-LINE-1, A6-DX-1, A6-PRICE-1, A6-DRAFT-1 and A6-REVIEW-1 unchanged beside A6-PAYLOAD-1; no A5/A6.1–A6.5 owner changed' : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- fixtures
  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: `${runId} service B` })).body)
  const procA = must('procedure A', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PA'), displayName: `${runId} procedure A`, codeSystem: 'SYNTHETIC', externalCode: key('XA') })).body)
  const procZ = must('procedure Z', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PZ'), displayName: `${runId} procedure Z`, codeSystem: 'SYNTHETIC', externalCode: key('XZ') })).body)
  const procM = must('procedure M', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: key('PM'), displayName: `${runId} procedure M`, codeSystem: 'SYNTHETIC', externalCode: key('XM') })).body)
  const dx: { id: string }[] = []
  for (const letter of ['A', 'B', 'C']) dx.push(must(`diagnosis ${letter}`, (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key(`DX${letter}`), displayName: `${runId} diagnosis ${letter}` })).body))

  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const contract = must('contract', (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  must('contract facility', (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
  const schedule = must('schedule', (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
  const version = must('version', (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  const rate = (body: Record<string, unknown>) => post(`/api/tariff-schedule-versions/${version.id}/rates`, { modifierCodes: [], currencyCode: 'AED', ...body })
  must('rate A', (await rate({ selectorKind: 'PROCEDURE_CODE', procedureCodeId: procA.id, unitTariffAmount: '125.2500' })).body)
  must('rate B', (await rate({ selectorKind: 'SERVICE', serviceId: svcB.id, unitTariffAmount: '12.1250' })).body)
  must('rate Z', (await rate({ selectorKind: 'PROCEDURE_CODE', procedureCodeId: procZ.id, unitTariffAmount: '0.0000' })).body)
  must('rate M', (await rate({ selectorKind: 'PROCEDURE_CODE', procedureCodeId: procM.id, unitCodeKey: 'SYN-U', modifierCodes: ['M1', 'M2'], unitTariffAmount: '10.0000' })).body)
  if ((await post(`/api/tariff-schedule-versions/${version.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error('fixture: the tariff version could not be verified')
  const world = { payerId: payer.id as string, contractId: contract.id as string, scheduleId: schedule.id as string, versionId: version.id as string }

  const plainContext = async (encounterId: string) => {
    const row = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true, serviceDate: true } })
    return {
      serviceDate: formatDateOnly(row.serviceDate) as string, facilityId: row.facilityId, facilityRegulatoryProfileId: row.facilityRegulatoryProfileId,
      insuranceMembershipId: null, payerId: world.payerId as string | null, tpaId: null, networkId: null, insuranceProductId: null,
      providerContractId: world.contractId as string | null, tariffScheduleId: world.scheduleId as string | null, tariffScheduleVersionId: world.versionId as string | null,
    }
  }
  const finding = (outcome: string, overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.', ...overrides })
  const recordRun = async (encounterId: string, activityIds: string[], diagnosisIds: string[]) => {
    const contextSnapshot = await plainContext(encounterId)
    const findings = [
      finding('WARNING', { layer: 'CODING' }),
      ...activityIds.map((encounterActivityId) => finding('PASS', { encounterActivityId })),
      ...diagnosisIds.map((encounterDiagnosisId) => finding('PASS', { layer: 'CODING', encounterDiagnosisId })),
    ]
    const result = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId, contextSnapshot, validatorVersion: 'A5-VAL-1', findings }, creatorId, tx))
    if (!result.ok) throw new Error(`a valid synthetic run was refused by the A5.7 recorder: ${result.message}`)
    return result.value.id
  }
  // Two runs at one exact instant cannot come from any owner path: the second is copied from the first.
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
  }
  const setPointers = async (lineId: string, claimDiagnosisIds: string[]) => {
    const res = await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds })
    if (res.status !== 200) throw new Error(`fixture pointers refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
  }

  type ActivitySpec = { serviceId?: string; procedureCodeId?: string; quantity: string; unitCode?: string; modifierCodes?: string[] }
  type Spec = { activities?: ActivitySpec[]; roles?: string[]; spareDiagnoses?: number; lineCount?: number }
  const defaultActivities = (): ActivitySpec[] => [{ procedureCodeId: procA.id, quantity: '1.5' }, { serviceId: svcB.id, quantity: '1' }]
  // An Encounter with the given activities and diagnoses, all named by one READY run, its Claim (created by
  // the creator Admin), one line per activity (or the first lineCount), one ClaimDiagnosis per role and every
  // line pointing to the PRIMARY.
  const draftClaim = async (label: string, spec: Spec = {}) => {
    const encounter = must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: null })).body)
    const activityIds: string[] = []
    for (const activity of spec.activities ?? defaultActivities()) activityIds.push(must(`${label} activity`, (await post(`/api/encounters/${encounter.id}/activities`, activity)).body).id)
    const roles = spec.roles ?? ['PRIMARY']
    const encounterDiagnosisIds: string[] = []
    for (let i = 0; i < roles.length + (spec.spareDiagnoses ?? 0); i += 1)
      encounterDiagnosisIds.push(must(`${label} encounter diagnosis`, (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: dx[i].id })).body).id)
    const validationRunId = await recordRun(encounter.id, activityIds, encounterDiagnosisIds)
    const readiness = await post(`/api/validation-runs/${validationRunId}/readiness-assessments`, {})
    if (readiness.status !== 201 || readiness.body?.state !== 'READY_FOR_REVIEW') throw new Error(`fixture ${label}: a valid READY assessment was refused with ${readiness.status}`)
    const claim = must(`${label} claim`, (await post(`/api/pre-claim-readiness-assessments/${readiness.body.id}/claims`, {})).body)
    const lineIds: string[] = []
    for (const activityId of activityIds.slice(0, spec.lineCount ?? activityIds.length)) lineIds.push(must('line', (await post(`/api/claims/${claim.id}/lines`, { encounterActivityId: activityId })).body).id)
    const claimDiagnosisIds: string[] = []
    for (let i = 0; i < roles.length; i += 1) claimDiagnosisIds.push(must('claim diagnosis', (await post(`/api/claims/${claim.id}/diagnoses`, { encounterDiagnosisId: encounterDiagnosisIds[i], roleCode: roles[i] })).body).id)
    for (const lineId of lineIds) await setPointers(lineId, [claimDiagnosisIds[0]])
    return { encounterId: encounter.id as string, claimId: claim.id as string, activityIds, encounterDiagnosisIds, claimDiagnosisIds, lineIds, validationRunId, readinessAssessmentId: readiness.body.id as string }
  }
  const price = async (claimId: string) => {
    const res = await post(`/api/claims/${claimId}/pricing-runs`, {})
    if (res.status !== 201) throw new Error(`fixture pricing refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as any
  }
  const assess = async (claimId: string, pricingRunId: string) => {
    const res = await post(`/api/claims/${claimId}/draft-assessments`, { pricingRunId })
    if (res.status !== 201) throw new Error(`fixture assessment refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as { id: string; outcome: string; assemblyFingerprint: string; pricingRunId: string }
  }
  type Assessed = { id: string; assemblyFingerprint: string }
  const decide = (claimId: string, body: Record<string, unknown>, who: Who = B.who) => api('POST', `/api/claims/${claimId}/review-decisions`, body, who)
  const approve = async (claimId: string, assessment: Assessed) => {
    const res = await decide(claimId, { draftAssessmentId: assessment.id, assemblyFingerprint: assessment.assemblyFingerprint, decisionCode: 'APPROVE' })
    if (res.status !== 201) throw new Error(`fixture approval refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body.decision.id as string
  }
  // A Claim, its exact PRICED run, its REVIEWABLE assessment (all by the creator Admin) and a current
  // APPROVE by a separate Admin.
  const approved = async (label: string, spec: Spec = {}) => {
    const claim = await draftClaim(label, spec)
    const pricing = await price(claim.claimId)
    const assessment = await assess(claim.claimId, pricing.id)
    if (assessment.outcome !== 'REVIEWABLE') throw new Error(`fixture ${label}: expected a REVIEWABLE assessment, got ${assessment.outcome}`)
    const approvalId = await approve(claim.claimId, assessment)
    return { ...claim, pricing, assessment, approvalId, body: { draftAssessmentId: assessment.id, approvalDecisionId: approvalId } }
  }
  type Approved = Awaited<ReturnType<typeof approved>>
  const inProcess = async (subject: { claimId: string; body: { draftAssessmentId: string; approvalDecisionId: string } }) =>
    withReadSnapshot(undefined, (tx) => composeCanonicalClaimPayload(subject.claimId, subject.body.draftAssessmentId, subject.body.approvalDecisionId, tx))
  const outcomeOf = (res: { status: number; body: any }) => (res.status === 200 ? 'COMPOSED' : errorCode(res.body))
  const tableCounts = async () =>
    JSON.stringify(
      await prisma.$queryRaw<{ t: string; n: bigint }[]>`
        SELECT 'claims' AS t, count(*) AS n FROM claims UNION ALL SELECT 'lines', count(*) FROM claim_lines UNION ALL SELECT 'pointers', count(*) FROM claim_line_diagnosis_pointers
        UNION ALL SELECT 'diagnoses', count(*) FROM claim_diagnoses UNION ALL SELECT 'runs', count(*) FROM claim_pricing_runs UNION ALL SELECT 'line_results', count(*) FROM claim_pricing_line_results
        UNION ALL SELECT 'assessments', count(*) FROM claim_draft_assessments UNION ALL SELECT 'findings', count(*) FROM claim_draft_findings UNION ALL SELECT 'decisions', count(*) FROM claim_review_events
        UNION ALL SELECT 'audit', count(*) FROM audit_events UNION ALL SELECT 'validation_runs', count(*) FROM validation_runs`,
      (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    )
  // Runs the composer inside a transaction that is always rolled back, after an adversarial setup that no
  // owner path allows (triggers off for that transaction only). Nothing persists.
  const NOT_REFUSED = 'ROLLED_BACK'
  const composeAfterRolledBackChange = async (subject: Approved, change: (tx: any) => Promise<unknown>) => {
    let outcome = 'NOT_RUN'
    await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
        await change(tx)
        const result = await composeCanonicalClaimPayload(subject.claimId, subject.body.draftAssessmentId, subject.body.approvalDecisionId, tx)
        outcome = result.ok ? 'COMPOSED' : result.outcome
        throw new Error(NOT_REFUSED)
      }),
    )
    return outcome
  }

  // Another tenant: a verified tariff world and a priced, assessed and returned Claim of the other
  // organization, built through the owner services in-process (synthetic, keyed by this run).
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  let foreign: { claimId: string; assessmentId: string; decisionId: string } | null = null
  if (foreignEncounter) {
    const foreignPayer = await prisma.payer.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign payer` } })
    const foreignContract = await prisma.providerContract.create({ data: { organizationId: otherOrg, payerId: foreignPayer.id, contractKey: key('FC'), displayName: 'Synthetic foreign contract', effectiveFrom: new Date('2000-01-01') } })
    const foreignSchedule = await prisma.tariffSchedule.create({ data: { providerContractId: foreignContract.id, tariffKey: key('FT'), displayName: 'Synthetic foreign tariff' } })
    const foreignVersion = await prisma.tariffScheduleVersion.create({ data: { tariffScheduleId: foreignSchedule.id, version: key('FV'), effectiveFrom: new Date('2000-01-01') } })
    const verified = await updateTariffScheduleVersionVerification(foreignVersion.id, 'VERIFIED', creatorId)
    const contextSnapshot = await plainContext(foreignEncounter.id)
    Object.assign(contextSnapshot, { payerId: foreignPayer.id, providerContractId: foreignContract.id, tariffScheduleId: foreignSchedule.id, tariffScheduleVersionId: foreignVersion.id })
    const recorded = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId: foreignEncounter.id, contextSnapshot, validatorVersion: 'A5-VAL-1', findings: [finding('PASS', { findingCode: 'SYNTHETIC_FOREIGN' })] }, creatorId, tx))
    const readiness = verified.ok && recorded.ok ? await recordReadinessAssessment(recorded.value.id, {}, creatorId) : null
    const claim = readiness?.ok ? await createClaim(readiness.value.id, {}, creatorId) : null
    const priced = claim?.ok ? await createPricingRun(claim.value.id, {}, creatorId) : null
    const assessed = claim?.ok && priced?.ok ? await createDraftAssessment(claim.value.id, { pricingRunId: priced.value.id }, creatorId) : null
    const returned = claim?.ok && assessed?.ok ? await recordReviewDecision(claim.value.id, { draftAssessmentId: assessed.value.id, assemblyFingerprint: assessed.value.assemblyFingerprint, decisionCode: 'RETURN', reasonCode: 'REVIEW_OTHER' }, B.id) : null
    if (claim?.ok && assessed?.ok && returned?.ok) foreign = { claimId: claim.value.id, assessmentId: assessed.value.id, decisionId: returned.value.decision.id }
  }
  if (!foreign) throw new Error("fixture: another tenant's assessed and reviewed Claim could not be built (no encounter of the other organization, or an owner refused)")

  // The worked example: 1.5 x AED 125.2500 + 1 x AED 12.1250 = AED 200.01, approved by a separate Admin.
  const W = await approved('worked example')
  // The stress example: a 2.5 quantity with unit and modifiers stored M2, M1; a zero-rate line; two
  // diagnoses, the second line pointing to both in reverse order.
  const X = await approved('stress', {
    activities: [{ procedureCodeId: procM.id, quantity: '2.5', unitCode: 'SYN-U', modifierCodes: ['M2', 'M1'] }, { procedureCodeId: procZ.id, quantity: '3' }],
    roles: ['PRIMARY', 'SECONDARY'],
  }).catch(async () => null)
  if (!X) throw new Error('fixture: the stress example could not be priced, assessed and approved')
  console.log('[A6.6]      fixtures ready: patient, AE-DU/DHA facility profile, clinician, masters, a verified AED tariff world (incl. a zero rate and a modifier rate), two synthetic reviewer Admins, the worked and stress examples, and another tenant\'s reviewed Claim')

  // ---------------------------------------------------------------- request and DTO (T011–T020)
  section('Strict request, UUIDs, schema version and the typed DTO')
  const pW = await preview(W.claimId, W.body)
  const pX = await preview(X.claimId, X.body)
  // Every later check compares against these two compositions, so without them no check can be judged.
  if (pW.status !== 200 || pX.status !== 200)
    throw new RunAborted(`the worked and stress examples did not compose (${pW.status} ${errorCode(pW.body) ?? ''} / ${pX.status} ${errorCode(pX.body) ?? ''}). If this is 403, grant claimCanonical.read by running the authorization bootstrap, then run this suite again.`)
  const payloadW = pW.body.payload
  const payloadX = pX.body.payload
  check('T011', 'Schema version', pW.status === 200 && pW.body?.schemaVersion === 'A6-PAYLOAD-1' && payloadW?.schemaVersion === 'A6-PAYLOAD-1', 'A6-PAYLOAD-1 on the preview and inside the payload')
  const malformedIds = [
    await api('POST', '/api/claims/not-a-uuid/canonical-payload/preview', W.body),
    await preview(W.claimId, { ...W.body, draftAssessmentId: 'not-a-uuid' }),
    await preview(W.claimId, { ...W.body, approvalDecisionId: '1234' }),
  ]
  check('T012', 'Malformed UUIDs', malformedIds.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `path claim id, draftAssessmentId and approvalDecisionId: ${malformedIds.map((r) => r.status).join('/')}; no raw database text`)
  const missingParts = [await preview(W.claimId, {}), await preview(W.claimId, { draftAssessmentId: W.body.draftAssessmentId }), await preview(W.claimId, { approvalDecisionId: W.body.approvalDecisionId }), await preview(W.claimId, [])]
  check('T013', 'Missing body or ids', missingParts.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR'), `empty, half and array bodies: ${missingParts.map((r) => r.status).join('/')}`)
  const extraFields = [await preview(W.claimId, { ...W.body, jurisdiction: 'US' }), await preview(W.claimId, { ...W.body, profile: 'X12' }), await preview(W.claimId, { ...W.body, format: 'xml' })]
  check('T014', 'Unknown fields', extraFields.every((res) => res.status === 400 && /unknown field/.test(res.body?.error?.message ?? '')), 'an unrecognized jurisdiction, profile or format field is refused by name; no destination is selectable')
  const clientPayload = [await preview(W.claimId, { ...W.body, payload: payloadW }), await preview(W.claimId, { ...W.body, bytes: 'e30=' }), await preview(W.claimId, { ...W.body, sha256: 'a'.repeat(64) }), await preview(W.claimId, { ...W.body, claimId: W.claimId })]
  check('T015', 'No client payload', clientPayload.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')), 'a client-supplied payload, bytes, digest or Claim id is refused: the server composes everything')
  const clientBusiness = [await preview(W.claimId, { ...W.body, total: '1.00' }), await preview(W.claimId, { ...W.body, lines: [] }), await preview(W.claimId, { ...W.body, diagnoses: [] }), await preview(W.claimId, { ...W.body, currencyCode: 'USD' })]
  check('T016', 'No client business values', clientBusiness.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')), 'client totals, lines, diagnoses and currency are refused as authoritative input')
  check('T017', 'Preview DTO shape', same(Object.keys(pW.body ?? {}), ['schemaVersion', 'previewDigestSha256', 'byteLength', 'payload']) && same(Object.keys(payloadW ?? {}), PAYLOAD_KEYS), 'schemaVersion, previewDigestSha256, byteLength and payload; the payload segments in A6-PAYLOAD-1 order; no bytes returned')
  const segmentKeys = [
    same(Object.keys(payloadW.header), HEADER_KEYS),
    same(Object.keys(payloadW.commercial), COMMERCIAL_KEYS),
    payloadW.lines.every((line: any) => same(Object.keys(line), LINE_KEYS)),
    payloadW.diagnoses.every((diagnosis: any) => same(Object.keys(diagnosis), DIAGNOSIS_KEYS)),
    same(Object.keys(payloadW.financial), ['totalExtendedAmount', 'currencyCode']),
    same(Object.keys(payloadW.evidence), EVIDENCE_KEYS),
    same(Object.keys(payloadW.approval), APPROVAL_KEYS),
  ]
  check('T018', 'Segment keys', segmentKeys.every(Boolean), 'header 17, commercial 8, line 14, diagnosis 5, financial 2, evidence 9 and approval 5 keys, each in contract order')
  check(
    'T019',
    'Explicit nulls',
    payloadW.commercial.tpaId === null && payloadW.commercial.networkId === null && payloadW.commercial.insuranceProductId === null && payloadW.lines[0].serviceId === null && payloadW.lines[1].procedureCodeId === null && payloadW.lines[0].unitCode === null,
    'nullable ids are present as explicit null, never omitted or undefined',
  )
  const upper = await preview(W.claimId, { draftAssessmentId: W.body.draftAssessmentId.toUpperCase(), approvalDecisionId: W.body.approvalDecisionId.toUpperCase() })
  check('T020', 'UUID normalization', upper.status === 200 && upper.body?.previewDigestSha256 === pW.body?.previewDigestSha256 && upper.body?.payload?.header?.draftAssessmentId === W.body.draftAssessmentId, 'uppercase ids are validated and normalized to lowercase: identical payload and digest')

  // ---------------------------------------------------------------- coherence and authority (T021–T030)
  section('Claim/assessment/approval coherence, A5.9 handoff, A6.4 currentness and A6.5 approval')
  const encodedW = encodeCanonicalPayload(payloadW, 2)
  check(
    'T021',
    'Composed',
    pW.status === 200 && encodedW.sha256 === pW.body.previewDigestSha256 && encodedW.bytes.length === pW.body.byteLength && payloadW.header.claimId === W.claimId && payloadW.approval.decisionId === W.approvalId,
    `200 COMPOSED: digest ${pW.body?.previewDigestSha256}, ${pW.body?.byteLength} bytes; the harness re-encodes the returned payload to the same digest`,
  )
  const otherAssessment = await preview(W.claimId, { draftAssessmentId: X.assessment.id, approvalDecisionId: W.approvalId })
  const missingAssessment = await preview(W.claimId, { draftAssessmentId: MISSING, approvalDecisionId: W.approvalId })
  check('T022', 'Assessment of another Claim', otherAssessment.status === 404 && same(otherAssessment.body?.error?.message, missingAssessment.body?.error?.message), "another Claim's assessment is answered exactly like a missing one (404)")
  const otherApproval = await preview(W.claimId, { draftAssessmentId: W.assessment.id, approvalDecisionId: X.approvalId })
  const missingApproval = await preview(W.claimId, { draftAssessmentId: W.assessment.id, approvalDecisionId: MISSING })
  check('T023', 'Approval of another Claim', otherApproval.status === 404 && same(otherApproval.body?.error?.message, missingApproval.body?.error?.message), "another Claim's approval is answered exactly like a missing one (404)")
  const secondAssessmentW = await assess(W.claimId, W.pricing.id)
  const mismatched = await preview(W.claimId, { draftAssessmentId: secondAssessmentW.id, approvalDecisionId: W.approvalId })
  check('T024', 'Approval of another assessment', mismatched.status === 409 && errorCode(mismatched.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED', 'an approval paired with a different (even identical) assessment of the same Claim: NOT_AUTHORIZED')
  const I = await draftClaim('incomplete', { lineCount: 0 })
  const assessedI = await assess(I.claimId, (await price(I.claimId)).id)
  const returnedI = await decide(I.claimId, { draftAssessmentId: assessedI.id, assemblyFingerprint: assessedI.assemblyFingerprint, decisionCode: 'RETURN', reasonCode: 'REVIEW_OTHER' })
  const notReviewable = await preview(I.claimId, { draftAssessmentId: assessedI.id, approvalDecisionId: returnedI.body?.decision?.id })
  check('T025', 'Not REVIEWABLE', assessedI.outcome === 'INCOMPLETE' && notReviewable.status === 409 && errorCode(notReviewable.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED', 'an INCOMPLETE assessment can carry no approval: NOT_AUTHORIZED')
  const H = await approved('superseded handoff')
  await recordRun(H.encounterId, H.activityIds, H.encounterDiagnosisIds)
  const superseded = await preview(H.claimId, H.body)
  check('T026', 'Superseded handoff', superseded.status === 409 && errorCode(superseded.body) === 'CLAIM_PAYLOAD_STALE', 'a newer validation run supersedes the bound A5.9 handoff: STALE')
  const Ti = await approved('recency tie')
  await copyRunAtSameInstant(Ti.validationRunId)
  const tie = await preview(Ti.claimId, Ti.body)
  check('T027', 'Recency tie', tie.status === 409 && errorCode(tie.body) === 'CLAIM_PAYLOAD_STALE', 'a second validation run at the same instant makes the handoff ambiguous: STALE, no identifier wins')
  const L = await approved('line removed')
  await post(`/api/claim-lines/${L.lineIds[1]}/remove`, {})
  const lineRemoved = await preview(L.claimId, L.body)
  check('T028', 'Draft no longer current', lineRemoved.status === 409 && errorCode(lineRemoved.body) === 'CLAIM_PAYLOAD_STALE', 'a line removed after approval: the A6.4 owner no longer recomposes the reviewed fingerprint: STALE')
  const Rt = await draftClaim('return only')
  const assessedRt = await assess(Rt.claimId, (await price(Rt.claimId)).id)
  const returnedRt = await decide(Rt.claimId, { draftAssessmentId: assessedRt.id, assemblyFingerprint: assessedRt.assemblyFingerprint, decisionCode: 'RETURN', reasonCode: 'REVIEW_CODING_CORRECTION' })
  const noApproval = await preview(Rt.claimId, { draftAssessmentId: assessedRt.id, approvalDecisionId: returnedRt.body?.decision?.id })
  check('T029', 'Not an approval', noApproval.status === 409 && errorCode(noApproval.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED', 'a RETURN decision named as the approval: NOT_AUTHORIZED')
  const Rv = await approved('revoked')
  await decide(Rv.claimId, { draftAssessmentId: Rv.assessment.id, assemblyFingerprint: Rv.assessment.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: Rv.approvalId })
  const revoked = await preview(Rv.claimId, Rv.body)
  check('T030', 'Revoked approval', revoked.status === 409 && errorCode(revoked.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED', 'an approval withdrawn by REVOKE no longer authorizes anything: NOT_AUTHORIZED')

  // ---------------------------------------------------------------- lines and diagnoses (T031–T040)
  section('ClaimLine 1..N, ClaimDiagnosis 1..N, pointers, exact A6.2 sources, modifiers, roles and positions')
  check('T031', 'Lines 1..N', same(payloadW.lines.map((l: any) => [l.sequence, l.claimLineId, l.encounterActivityId]), W.lineIds.map((lineId, i) => [i + 1, lineId, W.activityIds[i]])), 'lines in A6.2 position order with exactly their source activities')
  const activities = await prisma.encounterActivity.findMany({ where: { id: { in: [...W.activityIds, ...X.activityIds] } }, include: { modifiers: { orderBy: { sequence: 'asc' } } } })
  const factsOf = (activityId: string) => {
    const row = activities.find((a) => a.id === activityId)
    return row ? { serviceId: row.serviceId, procedureCodeId: row.procedureCodeId, quantity: row.quantity.toFixed(4), unitCode: row.unitCode, modifierCodes: row.modifiers.map((m) => m.code) } : null
  }
  const lineFacts = (line: any) => ({ serviceId: line.serviceId, procedureCodeId: line.procedureCodeId, quantity: line.quantity, unitCode: line.unitCode, modifierCodes: line.modifierCodes })
  check('T032', 'Exact source facts', [...payloadW.lines, ...payloadX.lines].every((line: any) => same(lineFacts(line), factsOf(line.encounterActivityId))), 'service, procedure, quantity, unit and modifiers are exactly the stored A4.6 source facts')
  check('T033', 'Modifier order', same(payloadX.lines[0].modifierCodes, ['M2', 'M1']), 'modifiers keep their stored A4.6 sequence (M2, M1), never re-sorted')
  const encounterDiagnoses = await prisma.encounterDiagnosis.findMany({ where: { id: { in: X.encounterDiagnosisIds } } })
  check(
    'T034',
    'Diagnoses 1..N',
    same(payloadX.diagnoses.map((d: any) => [d.sequence, d.claimDiagnosisId, d.roleCode]), [[1, X.claimDiagnosisIds[0], 'PRIMARY'], [2, X.claimDiagnosisIds[1], 'SECONDARY']]) &&
      payloadX.diagnoses.every((d: any) => encounterDiagnoses.find((e) => e.id === d.encounterDiagnosisId)?.diagnosisCodeId === d.diagnosisCodeId),
    'diagnoses in A6.2 order with their explicit roles and the exact source diagnosis-code ids',
  )
  // Pointers of the second stress line, set in reverse order, come out in ClaimDiagnosis sequence order.
  const Pt = await draftClaim('pointer order', { roles: ['PRIMARY', 'SECONDARY'] })
  await setPointers(Pt.lineIds[1], [Pt.claimDiagnosisIds[1], Pt.claimDiagnosisIds[0]])
  const ptPricing = await price(Pt.claimId)
  const ptAssessment = await assess(Pt.claimId, ptPricing.id)
  const ptApproval = await approve(Pt.claimId, ptAssessment)
  const pPt = await preview(Pt.claimId, { draftAssessmentId: ptAssessment.id, approvalDecisionId: ptApproval })
  check('T035', 'Pointer order', same(pPt.body?.payload?.lines?.[1]?.claimDiagnosisIds, Pt.claimDiagnosisIds) && same(pPt.body?.payload?.lines?.[0]?.claimDiagnosisIds, [Pt.claimDiagnosisIds[0]]), 'pointers written in reverse order are emitted in ClaimDiagnosis sequence order')
  const Ro = await draftClaim('reordered')
  const reordered = await api('PUT', `/api/claims/${Ro.claimId}/lines/order`, { claimLineIds: [...Ro.lineIds].reverse() })
  const roPricing = await price(Ro.claimId)
  const roAssessment = await assess(Ro.claimId, roPricing.id)
  const roApproval = await approve(Ro.claimId, roAssessment)
  const pRo = await preview(Ro.claimId, { draftAssessmentId: roAssessment.id, approvalDecisionId: roApproval })
  check('T036', 'Reordered lines', reordered.status === 200 && same(pRo.body?.payload?.lines?.map((l: any) => [l.sequence, l.claimLineId]), [[1, Ro.lineIds[1]], [2, Ro.lineIds[0]]]), 'after an A6.2 reorder and a fresh review the payload follows the new positions')
  const repricedL = await price(L.claimId)
  const reassessedL = await assess(L.claimId, repricedL.id)
  const reapprovedL = await approve(L.claimId, reassessedL)
  const pL = await preview(L.claimId, { draftAssessmentId: reassessedL.id, approvalDecisionId: reapprovedL })
  check('T037', 'Removed line excluded', pL.status === 200 && same(pL.body?.payload?.lines?.map((l: any) => l.claimLineId), [L.lineIds[0]]) && pL.body?.payload?.lines?.[0]?.sequence === 1, 'after a removal, a fresh pricing run, assessment and approval, only the active line remains, at position 1')
  const handoffW = await prisma.validationFinding.findMany({ where: { validationRunId: W.validationRunId }, select: { encounterActivityId: true, encounterDiagnosisId: true } })
  check(
    'T038',
    'Sources in the handoff',
    payloadW.lines.every((l: any) => handoffW.some((f) => f.encounterActivityId === l.encounterActivityId)) && payloadW.diagnoses.every((d: any) => handoffW.some((f) => f.encounterDiagnosisId === d.encounterDiagnosisId)),
    'every line and diagnosis source is one the approved A5.9 handoff named',
  )
  const codeTexts = [key('DXA'), key('XA'), key('PA'), key('SB'), `${runId} diagnosis A`, `${runId} procedure A`, `${runId} service B`, `${runId}-P`, `${runId} payer`, `${runId} facility`]
  const textW = JSON.stringify([pW.body, pX.body])
  check('T039', 'No code or display text', codeTexts.every((text) => !textW.includes(text)), 'no diagnosis or procedure code, service code, display name, patient, payer or facility text: identifiers only')
  const C = await approved('corrupted position')
  await prisma.$executeRawUnsafe('UPDATE claim_lines SET sequence = 5 WHERE id = $1::uuid', C.lineIds[1])
  const corrupted = await preview(C.claimId, C.body)
  check('T040', 'Corrupted position', corrupted.status === 409 && ['CLAIM_PAYLOAD_STALE', 'INTEGRITY_CONFLICT'].includes(errorCode(corrupted.body) ?? ''), `a stored position gap (written directly): ${errorCode(corrupted.body)}; no payload`)

  // ---------------------------------------------------------------- pricing and commercial (T041–T050)
  section('Exact A6.3 run, currency and Decimal formatting, historical commercial ids, no pricing math')
  const runW = await prisma.claimPricingRun.findUniqueOrThrow({ where: { id: W.pricing.id }, include: { lineResults: true } })
  check('T041', 'Exact pricing run', payloadW.header.pricingRunId === W.pricing.id && payloadW.header.pricingRunId === W.assessment.pricingRunId && payloadW.header.pricingContractVersion === 'A6-PRICE-1', 'the pricing run is exactly the one the reviewed assessment judged (A6-PRICE-1)')
  check(
    'T042',
    'Line pricing lineage',
    payloadW.lines.every((l: any) => {
      const result = runW.lineResults.find((r) => r.claimLineId === l.claimLineId)
      return result !== undefined && result.id === l.pricingLineResultId && result.tariffRateId === l.tariffRateId && result.extendedAmount?.toFixed(2) === l.extendedAmount && result.unitTariffAmount?.toFixed(4) === l.unitTariffAmount
    }),
    'each line carries its exact pricing line result, tariff rate and stored amounts',
  )
  check('T043', 'Exact total', payloadW.financial.totalExtendedAmount === '200.01' && runW.totalExtendedAmount?.toFixed(2) === '200.01' && payloadW.financial.currencyCode === 'AED', 'AED 200.01: the stored A6.3 total, never re-summed or re-priced')
  check('T044', 'Decimal strings', payloadW.lines[0].quantity === '1.5000' && payloadW.lines[0].unitTariffAmount === '125.2500' && payloadW.lines[0].extendedAmount === '187.88' && payloadW.lines[1].unitTariffAmount === '12.1250' && payloadX.lines[0].quantity === '2.5000', 'quantity and unit rate at 4 decimals (1.5000, 125.2500, 2.5000); money at AED minor units (187.88)')
  check('T045', 'Zero charge', payloadX.lines[1].unitTariffAmount === '0.0000' && payloadX.lines[1].extendedAmount === '0.00' && payloadX.financial.totalExtendedAmount === '25.00', 'a zero rate is "0.0000" and its charge "0.00" — unambiguous strings')
  const newerVersion = must('newer version', (await post(`/api/tariff-schedules/${world.scheduleId}/versions`, { version: key('V-newer'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  must('newer rate', (await post(`/api/tariff-schedule-versions/${newerVersion.id}/rates`, { selectorKind: 'PROCEDURE_CODE', procedureCodeId: procA.id, modifierCodes: [], currencyCode: 'AED', unitTariffAmount: '999.0000' })).body)
  await post(`/api/tariff-schedule-versions/${newerVersion.id}/verification`, { verificationStatus: 'VERIFIED' })
  const pWafterNewer = await preview(W.claimId, W.body)
  check(
    'T046',
    'Historical commercial ids',
    pWafterNewer.body?.previewDigestSha256 === pW.body?.previewDigestSha256 && same(payloadW.commercial, { providerContractId: world.contractId, tariffScheduleId: world.scheduleId, tariffScheduleVersionId: world.versionId, payerId: world.payerId, tpaId: null, networkId: null, insuranceProductId: null, currencyCode: 'AED' }),
    'exactly the bound ValidationRun commercial ids; a newer VERIFIED tariff version changes nothing (same digest)',
  )
  check('T047', 'One currency and scale', [...payloadW.lines, ...payloadX.lines].every((l: any) => l.currencyCode === 'AED' && /^\d+\.\d{2}$/.test(l.extendedAmount)) && /^\d+\.\d{2}$/.test(payloadW.financial.totalExtendedAmount), 'every amount and the total in AED at 2 decimals')
  const payloadCode = committedProductionCodeOf([PAYLOAD_DIR])
  const reached = payloadCode.files.length === 5 && payloadCode.code.includes('composeCurrentDraft') && payloadCode.code.includes('getCurrentReviewAuthority') && payloadCode.code.includes('composeA6Handoff')
  const runsBefore48 = await prisma.claimPricingRun.count()
  await preview(W.claimId, W.body)
  await preview(X.claimId, X.body)
  check(
    'T048',
    'No pricing math',
    reached && (await prisma.claimPricingRun.count()) === runsBefore48 && !/\b(evaluateLine|evaluateRun|matchingRates|extendedAmount|createPricingRun)\s*\(|\.times\(|\.plus\(|\.mul\(|ROUND_HALF|toDecimalPlaces|parseFloat|\bNumber\(/.test(payloadCode.code),
    'previews create no pricing run; the A6.6 code never matches rates, multiplies, rounds or converts money to Number',
  )
  const benefitKeys = [...deepKeys(pW.body), ...deepKeys(pX.body)].filter((k) => /copay|coinsur|deductible|discount|tax|patient_?share|payer_?share|net_?amount|net_?payer|^net$|benefit|balance/i.test(k))
  check('T049', 'No tax or benefit', benefitKeys.length === 0, 'no co-pay, tax, discount, net, patient-share or benefit field: an extended tariff charge only')
  const usd = await composeAfterRolledBackChange(W, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE claim_pricing_runs SET currency_code = 'XTS' WHERE id = $1::uuid`, W.pricing.id)
    await tx.$executeRawUnsafe(`UPDATE claim_pricing_line_results SET currency_code = 'XTS' WHERE pricing_run_id = $1::uuid`, W.pricing.id)
  })
  check('T050', 'Unsupported currency fails closed', ['UNSUPPORTED', 'STALE', 'INTEGRITY_CONFLICT'].includes(usd), `a run in a currency with no defined scale (written and rolled back): ${usd}; no bytes`)

  // ---------------------------------------------------------------- determinism (T051–T060)
  section('Canonical JSON order, UTF-8, no BOM or newline, stable hash across processes, runs and permutations')
  const iW = await inProcess(W)
  check('T051', 'HTTP equals in-process', iW.ok && iW.sha256 === pW.body.previewDigestSha256 && same(iW.payload, payloadW), 'the route and the exported composer produce the same payload and digest')
  check('T052', 'Contract key order', iW.ok && same(Object.keys(iW.payload), PAYLOAD_KEYS) && same(Object.keys(iW.payload.header), HEADER_KEYS), 'the composer builds every object in A6-PAYLOAD-1 order')
  const reversed = (value: unknown): unknown => (Array.isArray(value) ? value.map(reversed) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)])) : value)
  check('T053', 'Permutation stable', encodeCanonicalPayload(reversed(payloadW) as any, 2).sha256 === pW.body.previewDigestSha256 && encodeCanonicalPayload(JSON.parse(JSON.stringify(payloadX)), 2).sha256 === pX.body.previewDigestSha256, 'the same semantics with every key order reversed encode to identical bytes')
  const bytesW = iW.ok ? iW.bytes : Buffer.alloc(0)
  check('T054', 'Byte form', bytesW.length > 0 && bytesW[0] === 0x7b && bytesW[bytesW.length - 1] === 0x7d && !bytesW.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && !bytesW.includes(0x0a) && !bytesW.includes(0x0d) && sha256Of(bytesW) === pW.body.previewDigestSha256, 'UTF-8 JSON starting { and ending }, no BOM, no CR/LF; the digest is the SHA-256 of exactly these bytes')
  const composerUrl = pathToFileURL(`${process.cwd()}/src/modules/claim-payload/claim-payload.composer.ts`).href
  const snapshotUrl = pathToFileURL(`${process.cwd()}/src/shared/database/read-snapshot.ts`).href
  const prismaUrl = pathToFileURL(`${process.cwd()}/src/shared/database/prisma.ts`).href
  const separateProcessDigest = (subject: Approved, extraEnv: Record<string, string> = {}) => {
    const code = `const { prisma } = await import(${JSON.stringify(prismaUrl)}); const { withReadSnapshot } = await import(${JSON.stringify(snapshotUrl)}); const { composeCanonicalClaimPayload } = await import(${JSON.stringify(composerUrl)}); const r = await withReadSnapshot(undefined, (tx) => composeCanonicalClaimPayload(process.env.A66_C, process.env.A66_A, process.env.A66_D, tx)); console.log('A66_DIGEST=' + (r.ok ? r.sha256 : 'REFUSED:' + r.outcome)); await prisma.$disconnect()`
    const out = spawnSync(process.execPath, ['--env-file=.env', '--input-type=module', '-e', code], { encoding: 'utf8', cwd: process.cwd(), env: childEnv({ A66_C: subject.claimId, A66_A: subject.body.draftAssessmentId, A66_D: subject.body.approvalDecisionId, ...extraEnv }) })
    return ((`${out.stdout ?? ''}`.match(/A66_DIGEST=(\S+)/) ?? [])[1] ?? `NO OUTPUT ${(out.stderr ?? '').slice(0, 160)}`)
  }
  const digestOtherProcess = separateProcessDigest(W)
  check('T055', 'Separate process', digestOtherProcess === pW.body.previewDigestSha256, `a fresh Node process with its own connection composes the same digest (${digestOtherProcess.slice(0, 16)}…)`)
  const iW2 = await inProcess(W)
  check('T056', 'Separate transactions', iW2.ok && iW.ok && iW2.bytes.equals(iW.bytes), 'two separate read transactions compose byte-identical output')
  const digestTz = separateProcessDigest(W, { TZ: 'Pacific/Kiritimati', LANG: 'ar_AE.UTF-8', LC_ALL: 'ar_AE.UTF-8' })
  check('T057', 'Time zone and locale', digestTz === pW.body.previewDigestSha256, 'a process in UTC+14 with an Arabic locale composes the same digest; dates stay YYYY-MM-DD')
  const repeated = await Promise.all([preview(W.claimId, W.body), preview(W.claimId, W.body), preview(W.claimId, W.body)])
  check('T058', 'Repeated previews', repeated.every((res) => res.status === 200 && res.body.previewDigestSha256 === pW.body.previewDigestSha256 && same(res.body.payload, payloadW)), 'repeated and concurrent previews return the identical payload and digest')
  const goldenRun = run(`node --test ${UNIT_TEST.replace('backend/', '')}`, { TZ: 'Asia/Tokyo', LANG: 'ar_AE.UTF-8' })
  const goldenFrozen = (git(`show HEAD:${UNIT_TEST}`).match(/const GOLDEN_SHA256 = '([0-9a-f]{64})'/) ?? [])[1]
  check('T059', 'Golden vector in a fresh process', goldenRun.ok && /ℹ fail 0/.test(goldenRun.output) && /✔ golden vector: exact bytes and SHA-256/.test(goldenRun.output) && goldenFrozen?.length === 64, `the frozen golden vector ${goldenFrozen?.slice(0, 16)}… reproduces byte-for-byte in a separate process (Asia/Tokyo, Arabic locale)`)
  let seqScanDigest = 'NOT_RUN'
  await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_indexscan = off')
      await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off')
      await tx.$executeRawUnsafe('SET LOCAL enable_indexonlyscan = off')
      const result = await composeCanonicalClaimPayload(W.claimId, W.body.draftAssessmentId, W.body.approvalDecisionId, tx)
      seqScanDigest = result.ok ? result.sha256 : result.outcome
      throw new Error(NOT_REFUSED)
    }),
  )
  check('T060', 'Read order independent', seqScanDigest === pW.body.previewDigestSha256, 'with index scans disabled (rows arrive in physical order) the bytes are identical')

  // ---------------------------------------------------------------- refusals after change (T061–T070)
  section('Source, line, pointer, pricing, validation and review changes refuse')
  const So = await approved('source removed')
  await post(`/api/encounter-activities/${So.activityIds[1]}/remove`, {})
  const sourceRemoved = await preview(So.claimId, So.body)
  check('T061', 'Source removed', sourceRemoved.status === 409 && errorCode(sourceRemoved.body) === 'CLAIM_PAYLOAD_STALE', 'a source activity removed after approval: STALE')
  check('T062', 'Line removed', lineRemoved.status === 409 && errorCode(lineRemoved.body) === 'CLAIM_PAYLOAD_STALE' && !('payload' in (lineRemoved.body ?? {})), 'a line removed after approval: STALE and no payload')
  const Pc = await approved('pointer changed', { roles: ['PRIMARY', 'SECONDARY'] })
  await setPointers(Pc.lineIds[0], Pc.claimDiagnosisIds)
  const pointerChanged = await preview(Pc.claimId, Pc.body)
  check('T063', 'Pointer changed, same price', pointerChanged.status === 409 && errorCode(pointerChanged.body) === 'CLAIM_PAYLOAD_STALE', 'a pointer edit that leaves every price unchanged still refuses: STALE')
  const Q = await approved('quantity changed')
  // A4.6 exposes no activity edit, so the source quantity is changed directly (synthetic, adversarial).
  await prisma.$executeRawUnsafe('UPDATE encounter_activities SET quantity = 3 WHERE id = $1::uuid', Q.activityIds[1])
  const pricingDrift = await preview(Q.claimId, Q.body)
  check('T064', 'Pricing changed', pricingDrift.status === 409 && errorCode(pricingDrift.body) === 'CLAIM_PAYLOAD_STALE', 'a priced source quantity changed after approval: STALE')
  check('T065', 'New validation', superseded.status === 409 && !('payload' in (superseded.body ?? {})), 'a newer A5.8 validation run refuses (STALE) with no payload')
  check('T066', 'Revoked', revoked.status === 409 && errorCode(revoked.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED' && !('previewDigestSha256' in (revoked.body ?? {})), 'after REVOKE: NOT_AUTHORIZED and no digest')
  check('T067', 'Returned', noApproval.status === 409 && errorCode(noApproval.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED', 'a RETURN never authorizes: NOT_AUTHORIZED')
  const Rj = await draftClaim('rejected')
  const assessedRj = await assess(Rj.claimId, (await price(Rj.claimId)).id)
  const rejectedRj = await decide(Rj.claimId, { draftAssessmentId: assessedRj.id, assemblyFingerprint: assessedRj.assemblyFingerprint, decisionCode: 'REJECT', reasonCode: 'REVIEW_INTEGRITY_CONCERN' })
  const rejected = await preview(Rj.claimId, { draftAssessmentId: assessedRj.id, approvalDecisionId: rejectedRj.body?.decision?.id })
  check('T068', 'Rejected', rejected.status === 409 && errorCode(rejected.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED', 'a REJECT never authorizes: NOT_AUTHORIZED')
  // The draft of Rv is unchanged: after its revocation a fresh assessment is approved again, so the old
  // approval is superseded while its draft is still current. L's draft changed: its old pair is stale.
  const freshRv = await assess(Rv.claimId, Rv.pricing.id)
  const reapprovedRv = await approve(Rv.claimId, freshRv)
  const oldPairRv = await preview(Rv.claimId, Rv.body)
  const newPairRv = await preview(Rv.claimId, { draftAssessmentId: freshRv.id, approvalDecisionId: reapprovedRv })
  const oldApprovalL = await preview(L.claimId, L.body)
  check(
    'T069',
    'Superseded approval',
    oldPairRv.status === 409 && errorCode(oldPairRv.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED' && newPairRv.status === 200 && oldApprovalL.status === 409 && errorCode(oldApprovalL.body) === 'CLAIM_PAYLOAD_STALE' && pL.status === 200,
    'an approval superseded by a newer one on the unchanged draft is NOT_AUTHORIZED and only the newer one composes; an old approval of a changed draft is STALE',
  )
  const refusals = [sourceRemoved, lineRemoved, pointerChanged, pricingDrift, superseded, tie, revoked, noApproval, rejected, oldApprovalL, mismatched, notReviewable]
  check('T070', 'Refusals carry nothing', refusals.every((res) => res.status === 409 && !('payload' in (res.body ?? {})) && !('previewDigestSha256' in (res.body ?? {})) && !rawError(res.body)), `${refusals.length} refusals: each a 409 with a code and message only; no payload, digest or raw database text`)

  // ---------------------------------------------------------------- tenancy and safety (T071–T080)
  section('Permission and tenant refusal, absent and foreign ids, no PHI leak, safe errors, no browser truth')
  const countsBefore71 = await tableCounts()
  const viewerPreview = await preview(W.claimId, W.body, asViewer)
  check('T071', 'Viewer refused', viewerPreview.status === 403 && errorCode(viewerPreview.body) === 'FORBIDDEN', 'claimCanonical.read is Admin only: the Viewer receives 403')
  const anonymousPreview = await preview(W.claimId, W.body, anonymous)
  check('T072', 'Anonymous', anonymousPreview.status === 401, '401 without a session')
  const missingClaim = await preview(MISSING, W.body)
  const foreignClaim = await preview(foreign.claimId, { draftAssessmentId: foreign.assessmentId, approvalDecisionId: foreign.decisionId })
  check('T073', 'Foreign Claim', foreignClaim.status === 404 && same(foreignClaim.body?.error?.code, missingClaim.body?.error?.code) && same(foreignClaim.body?.error?.message, missingClaim.body?.error?.message), "another tenant's Claim is answered exactly like a missing one (404)")
  const foreignAssessment = await preview(W.claimId, { draftAssessmentId: foreign.assessmentId, approvalDecisionId: W.approvalId })
  check('T074', 'Foreign assessment', foreignAssessment.status === 404 && same(foreignAssessment.body?.error?.message, missingAssessment.body?.error?.message), "another tenant's assessment on an own Claim is answered exactly like a missing one")
  const foreignDecision = await preview(W.claimId, { draftAssessmentId: W.assessment.id, approvalDecisionId: foreign.decisionId })
  check('T075', 'Foreign approval', foreignDecision.status === 404 && same(foreignDecision.body?.error?.message, missingApproval.body?.error?.message), "another tenant's decision on an own Claim is answered exactly like a missing one")
  const dBefore = await preview(W.claimId, W.body, D.who)
  await prisma.membershipRole.deleteMany({ where: { membershipId: D.membershipId } })
  const dAfter = await preview(W.claimId, W.body, D.who)
  check('T076', 'Authorization at request time', dBefore.status === 200 && dAfter.status === 403, 'an Admin who loses the role is refused (403) on the next preview; nothing is remembered')
  const errorBodies = JSON.stringify([foreignClaim.body, foreignAssessment.body, foreignDecision.body, viewerPreview.body, ...refusals.map((r) => r.body)])
  check('T077', 'Safe errors', !errorBodies.includes(foreign.claimId) && !errorBodies.includes(foreign.assessmentId) && !/AED|200\.01|187\.88|\b\d+\.\d{2}\b/.test(errorBodies) && !rawError(JSON.parse(errorBodies)), 'no foreign id, amount or raw database text in any error')
  const phiKeyPattern = new RegExp(['patient', 'member', 'dateOfBirth', 'name', 'address', 'phone', 'email', 'emir' + 'ates', 'pass' + 'port', 'clinical', 'observation', 'note'].join('|'), 'i')
  const phiKeys = [...deepKeys(pW.body)].filter((k) => phiKeyPattern.test(k))
  check('T078', 'No PHI', phiKeys.length === 0 && codeTexts.every((text) => !JSON.stringify(pW.body).includes(text)) && !JSON.stringify(pW.body).includes('1990-01-01'), 'no patient, member, contact or clinical key or value; identifiers only')
  const feCode = committedProductionCodeOf([FE_PAYLOAD_DIR])
  check(
    'T079',
    'No browser truth',
    feCode.files.length === 1 && !/\b(localStorage|sessionStorage|indexedDB|console\.)/.test(feCode.code) && /JSON\.stringify\(\{ draftAssessmentId: [^,]+, approvalDecisionId: [^}]+\}\)/.test(feCode.code) && (feCode.code.match(/method: '(POST|PUT|PATCH|DELETE)'/g) ?? []).length === 1 && !/(===|!==|==)\s*'(COMPOSED|STALE|NOT_AUTHORIZED|APPROVED_CURRENT)'/.test(feCode.code),
    'the check page sends exactly the two ids, keeps nothing in browser storage, logs nothing and decides nothing',
  )
  const scanPaths = [`:/${PAYLOAD_DIR}`, `:/${FE_PAYLOAD_DIR}`]
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const logReach = gitGrep('composeCanonicalClaimPayload|ClaimPayloadCheck', scanPaths)
  const secretScan = gitGrep("((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})", [`:/${HARNESS_DIR}`, ...scanPaths])
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [`:/${HARNESS_DIR}`])
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git(`show HEAD:${HARNESS_DIR}/a6-canonical-payload.integration.ts`)
  check(
    'T080',
    'No logging, secrets or real data',
    logReach.status === 0 && logScan.status === 1 && secretReach.status === 0 && secretScan.status === 1 && harnessSource.length > 0 && harnessSource.match(realDataMarkers) === null && !/req\.query/.test(payloadCode.code),
    'no console logging, committed secret, real-data marker or query-string read',
  )

  // ---------------------------------------------------------------- no writes or future phases (T081–T090)
  section('No writable A6.6 table, ClaimSubmission, sender, XML/X12, HIE, frozen hash or approval mutation')
  const tablesNow = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).map((row) => row.table_name)
  check('T081', 'No new table', same(tablesNow, tablesAtStart) && !tablesNow.some((t) => /payload|submission|canonical|evidence_package|transport|outbox/.test(t)), 'the database holds exactly the tables it held before the run; none for payloads, submissions or transport')
  const snapshotRows = async () => JSON.stringify([await prisma.claimLine.findMany({ where: { claimId: W.claimId }, orderBy: { id: 'asc' } }), await prisma.claimPricingRun.findUnique({ where: { id: W.pricing.id } }), await prisma.claimDraftAssessment.findUnique({ where: { id: W.assessment.id } }), await prisma.claimReviewEvent.findMany({ where: { claimId: W.claimId }, orderBy: { sequence: 'asc' } })])
  const rowsBefore82 = await snapshotRows()
  const countsBefore82 = await tableCounts()
  for (let i = 0; i < 5; i += 1) await preview(W.claimId, W.body)
  await preview(X.claimId, X.body)
  await preview(L.claimId, L.body)
  check('T082', 'Previews write nothing', (await snapshotRows()) === rowsBefore82 && (await tableCounts()) === countsBefore82 && countsBefore71 === countsBefore82, 'the Claim lines, pricing run, assessment and review history are byte-identical and no table count moves across previews and refusals')
  check('T083', 'Read-only composition', /withReadSnapshot\(undefined/.test(payloadCode.code) && !/\b(tx|db|prisma)\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|recordAuditEvent/.test(payloadCode.code), 'the preview runs in a READ ONLY snapshot; the module has no Prisma create, update or delete, no raw SQL and no audit call')
  check('T084', 'No ClaimSubmission', !/claimSubmission|ClaimSubmission|submission/i.test(payloadCode.code) && !tablesNow.some((t) => /submission/.test(t)), 'no ClaimSubmission model, row, id or call')
  check('T085', 'No destination format', !/\b(xml|xsd|x12|edi|dhpo|eclaimlink|soap|wsdl|nabidh|malaffi|riayati|fhir|hl7)\b/i.test(payloadCode.code + feCode.code), 'no XML/XSD, X12/EDI, DHPO/eClaimLink, SOAP or HIE term in A6.6 code')
  check('T086', 'No transport', !/\b(fetch|axios|https?\.request|net\.connect|sftp|smtp|webhook)\b/i.test(payloadCode.code), 'no network call from the A6.6 backend')
  check('T087', 'No frozen hash', !/(payloadHash|submissionHash|frozen|freeze|persist)\w*\s*[:(=]/i.test(payloadCode.code) && /previewDigestSha256/.test(payloadCode.code), 'the only digest is the preview comparison aid; nothing is stored or named a submission hash')
  const reviewBefore88 = JSON.stringify(await prisma.claimReviewEvent.findMany({ where: { claimId: { in: [W.claimId, L.claimId, Rv.claimId] } }, orderBy: [{ claimId: 'asc' }, { sequence: 'asc' }] }))
  await preview(Rv.claimId, Rv.body)
  await preview(W.claimId, W.body)
  check('T088', 'No approval mutation', JSON.stringify(await prisma.claimReviewEvent.findMany({ where: { claimId: { in: [W.claimId, L.claimId, Rv.claimId] } }, orderBy: [{ claimId: 'asc' }, { sequence: 'asc' }] })) === reviewBefore88 && !/claimReviewEvent\.(create|createMany|update|updateMany|upsert|delete|deleteMany)|recordReviewDecision|createDecisionRecord/.test(payloadCode.code), 'previews never approve, revoke or touch review history; the module only reads decisions and cannot reach a decision writer')
  const auditBefore89 = await prisma.auditEvent.count({ where: { occurredAt: { gte: runStartedAt } } })
  await preview(W.claimId, W.body)
  await preview(Rv.claimId, Rv.body)
  check('T089', 'No audit event', (await prisma.auditEvent.count({ where: { occurredAt: { gte: runStartedAt } } })) === auditBefore89, 'a preview, composed or refused, writes no audit event')
  check('T090', 'No global market switch', !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION|CURRENCY|MODE|PROFILE)\w*/i.test(payloadCode.code) && !/\b(US|UAE)_?(MODE|PROFILE)\b/.test(payloadCode.code), 'no process-global UAE/US switch in the common core')

  // ---------------------------------------------------------------- A6.7 boundary and races (T091–T100)
  section('A6.7 transaction-aware composer, lock order, races and deterministic refusals')
  let lockedDigest = 'NOT_RUN'
  await attemptAdversarial(() =>
    prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRawUnsafe<{ id: string }[]>('SELECT id::text AS id FROM claims WHERE id = $1::uuid FOR UPDATE NOWAIT', W.claimId)
        const result = await composeCanonicalClaimPayload(W.claimId, W.body.draftAssessmentId, W.body.approvalDecisionId, tx)
        lockedDigest = locked.length === 1 && result.ok ? result.sha256 : `REFUSED ${result.ok ? '' : result.outcome}`
        throw new Error(NOT_REFUSED)
      },
      { isolationLevel: 'Serializable' },
    ),
  )
  check('T091', 'Inside a guarded write transaction', lockedDigest === pW.body.previewDigestSha256 && /export async function composeCanonicalClaimPayload\(claimId: string, draftAssessmentId: string, approvalDecisionId: string, tx: DbClient\)/.test(payloadCode.code), 'called the A6.7 way — Claim locked FOR UPDATE NOWAIT first, SERIALIZABLE — the composer returns the same bytes')
  let sameTxOutcome = 'NOT_RUN'
  await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await tx.$executeRawUnsafe('UPDATE claim_lines SET removed_at = now() WHERE id = $1::uuid', W.lineIds[1])
      const result = await composeCanonicalClaimPayload(W.claimId, W.body.draftAssessmentId, W.body.approvalDecisionId, tx)
      sameTxOutcome = result.ok ? 'COMPOSED' : result.outcome
      throw new Error(NOT_REFUSED)
    }),
  )
  const afterRollback = await preview(W.claimId, W.body)
  check('T092', 'Uses the caller\'s transaction', sameTxOutcome === 'STALE' && afterRollback.status === 200 && afterRollback.body.previewDigestSha256 === pW.body.previewDigestSha256, 'an uncommitted change inside the caller\'s transaction is seen (STALE); after its rollback the committed state composes again')
  let lockHeldPrompt = false
  let lockHeldStatus = 0
  await attemptAdversarial(() =>
    prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM claims WHERE id = $1::uuid FOR UPDATE', W.claimId)
        const during = preview(W.claimId, W.body)
        lockHeldPrompt = await settledWithin(during, 5000)
        lockHeldStatus = (await during).status
        throw new Error(NOT_REFUSED)
      },
      { timeout: 20_000 },
    ),
  )
  check('T093', 'Takes no lock', lockHeldPrompt && lockHeldStatus === 200, 'while another transaction holds the Claim row lock, a preview still answers at once: the composer takes no lock and never blocks an A6.2/A6.3/A6.4/A6.5 writer')
  const R1 = await approved('race removal')
  const pR1 = await preview(R1.claimId, R1.body)
  const hold1 = holdAt('claimLine.removed')
  const remove1 = removeClaimLine(R1.lineIds[1], {}, creatorId)
  await Promise.race([hold1.arrived, remove1])
  const during1 = preview(R1.claimId, R1.body)
  const during1Prompt = await settledWithin(during1, 5000)
  const during1Res = await during1
  hold1.release()
  await remove1
  clearConcurrencyProbes()
  const after1 = await preview(R1.claimId, R1.body)
  check(
    'T094',
    'Edit race',
    during1Prompt && during1Res.status === 200 && during1Res.body.previewDigestSha256 === pR1.body.previewDigestSha256 && after1.status === 409 && errorCode(after1.body) === 'CLAIM_PAYLOAD_STALE',
    'a preview during an uncommitted line removal answers from one committed snapshot (same digest); after the commit it is STALE — never a mixed snapshot',
  )
  const both = await Promise.all([preview(X.claimId, X.body), inProcess(X)])
  check('T095', 'Simultaneous previews', both[0].status === 200 && both[1].ok && both[0].body.previewDigestSha256 === both[1].sha256, 'an HTTP preview and an in-process composition at the same moment agree byte for byte')
  const R2 = await approved('race revoke')
  const hold2 = holdAt('claimReview.inserted')
  const revoke2 = recordReviewDecision(R2.claimId, { draftAssessmentId: R2.assessment.id, assemblyFingerprint: R2.assessment.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: R2.approvalId }, B.id)
  await Promise.race([hold2.arrived, revoke2])
  const during2 = preview(R2.claimId, R2.body)
  const during2Prompt = await settledWithin(during2, 5000)
  const during2Res = await during2
  hold2.release()
  const r2 = await revoke2
  clearConcurrencyProbes()
  const after2 = await preview(R2.claimId, R2.body)
  check('T096', 'Revoke race', during2Prompt && during2Res.status === 200 && r2.ok && after2.status === 409 && errorCode(after2.body) === 'CLAIM_PAYLOAD_NOT_AUTHORIZED', 'a preview during an uncommitted revocation still sees the committed approval; after the commit it is NOT_AUTHORIZED')
  const again = [await preview(Rv.claimId, Rv.body), await preview(Rv.claimId, Rv.body)]
  check('T097', 'Deterministic refusal', same(again[0].body?.error?.code, again[1].body?.error?.code) && same(again[0].body?.error?.message, again[1].body?.error?.message), 'the same refused request answers with the same code and message every time')
  const countsBefore98 = await tableCounts()
  for (const subject of [Rv, L, H, Ti, So]) await preview(subject.claimId, subject.body)
  check('T098', 'Refusals leave nothing', (await tableCounts()) === countsBefore98, 'repeated refusals leave every table count unchanged: no partial state')
  const R3 = await approved('race pointer')
  const p3a = await preview(R3.claimId, R3.body)
  await setPointers(R3.lineIds[0], [R3.claimDiagnosisIds[0]])
  const p3same = await preview(R3.claimId, R3.body)
  const R3b = await approved('race pointer two', { roles: ['PRIMARY', 'SECONDARY'] })
  const p3b = await preview(R3b.claimId, R3b.body)
  await setPointers(R3b.lineIds[0], R3b.claimDiagnosisIds)
  const p3bAfter = await preview(R3b.claimId, R3b.body)
  check('T099', 'Edit between previews', p3a.status === 200 && p3same.status === 200 && p3same.body.previewDigestSha256 === p3a.body.previewDigestSha256 && p3b.status === 200 && p3bAfter.status === 409, 're-saving identical pointers keeps the same digest; a real pointer change committed between two previews makes the second STALE')
  let revokedInTx = 'NOT_RUN'
  await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO claim_review_events (id, claim_id, draft_assessment_id, reviewer_user_id, decision_code, sequence, referenced_approval_id, review_contract_version) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'REVOKE', 2, $4::uuid, 'A6-REVIEW-1')`,
        X.claimId,
        X.assessment.id,
        B.id,
        X.approvalId,
      )
      const result = await composeCanonicalClaimPayload(X.claimId, X.body.draftAssessmentId, X.body.approvalDecisionId, tx)
      revokedInTx = result.ok ? 'COMPOSED' : result.outcome
      throw new Error(NOT_REFUSED)
    }),
  )
  check('T100', 'Recheck inside the freeze transaction', revokedInTx === 'NOT_AUTHORIZED' && (await preview(X.claimId, X.body)).status === 200, 'a revocation written inside the same transaction (as A6.7 would see it) refuses: NOT_AUTHORIZED; rolled back, the approval composes again')

  // ---------------------------------------------------------------- adversarial vectors (T101–T110)
  section('Golden vectors, dates, scale, Unicode, separate processes; malformed amounts and unsupported fields fail closed')
  check('T101', 'Golden vector frozen', goldenRun.ok && goldenFrozen === '155ad44f6d1fe8d7bb17791cc809d40b74d878f01171d4c0a148df027de80685', 'the committed golden digest is the one verified independently (Node and Python) when the contract was frozen')
  const unitTests = run(`node --test ${UNIT_TEST.replace('backend/', '')}`)
  check('T102', 'Adversarial encoder vectors', unitTests.ok && /ℹ fail 0/.test(unitTests.output) && /ℹ pass 12/.test(unitTests.output), 'unknown/missing/undefined keys, Number money, exponent, sign, scale, NaN, Infinity, -0, uppercase UUID, impossible date, lone surrogate and unsorted sets are all refused')
  const runRow = await prisma.validationRun.findUniqueOrThrow({ where: { id: W.validationRunId }, select: { serviceDate: true } })
  check('T103', 'Date only', payloadW.header.serviceDate === SERVICE_DATE && formatDateOnly(runRow.serviceDate) === SERVICE_DATE && digestTz === pW.body.previewDigestSha256, 'the service date is YYYY-MM-DD from the bound run, unchanged in UTC+14')
  check('T104', 'Quantity scale', payloadX.lines[0].quantity === '2.5000' && payloadX.lines[0].extendedAmount === '25.00' && payloadX.lines[1].quantity === '3.0000', 'stored 2.5 and 3 become "2.5000" and "3.0000"; never 2.5, 3 or 2.5e0')
  check('T105', 'Zero and nulls', payloadX.lines[1].extendedAmount === '0.00' && payloadW.commercial.tpaId === null && JSON.stringify(payloadX).includes('"unitCode":null'), 'AED 0.00 and null optional ids are unambiguous')
  const malformedAmount = await composeAfterRolledBackChange(W, (tx) => tx.$executeRawUnsafe('UPDATE claim_pricing_line_results SET extended_amount = extended_amount + 0.0001 WHERE pricing_run_id = $1::uuid', W.pricing.id))
  check('T106', 'Malformed amount fails closed', ['INTEGRITY_CONFLICT', 'STALE'].includes(malformedAmount), `a stored amount with more precision than AED's 2 decimals (written and rolled back): ${malformedAmount}; never rounded into bytes`)
  const inactiveProfile = await composeAfterRolledBackChange(W, async (tx) => {
    const profileId = (await tx.$queryRawUnsafe(`SELECT facility_regulatory_profile_id::text AS id FROM validation_runs WHERE id = $1::uuid`, W.validationRunId))[0].id
    await tx.$executeRawUnsafe(`UPDATE facility_regulatory_profiles SET status = 'INACTIVE' WHERE id = $1::uuid`, profileId)
  })
  check('T107', 'Unfrozen jurisdiction fails closed', ['INCOMPLETE', 'STALE'].includes(inactiveProfile), `a bound profile that is no longer ACTIVE (written and rolled back): ${inactiveProfile}; its jurisdiction is not asserted`)
  const noPayer = await composeAfterRolledBackChange(W, (tx) => tx.$executeRawUnsafe('UPDATE validation_runs SET payer_id = NULL WHERE id = $1::uuid', W.validationRunId))
  check('T108', 'Missing payer fails closed', ['INCOMPLETE', 'STALE'].includes(noPayer), `a bound run without a payer (written and rolled back): ${noPayer}; no null is emitted for a required field`)
  const sumMismatch = await composeAfterRolledBackChange(W, (tx) => tx.$executeRawUnsafe('UPDATE claim_pricing_runs SET total_extended_amount = total_extended_amount + 1 WHERE id = $1::uuid', W.pricing.id))
  check('T109', 'Total mismatch fails closed', ['INTEGRITY_CONFLICT', 'STALE'].includes(sumMismatch), `a stored total that is not the sum of its lines (written and rolled back): ${sumMismatch}`)
  const livePreviewW = await api('GET', `/api/claims/${W.claimId}/draft?pricingRunId=${W.pricing.id}`)
  check(
    'T110',
    'One basis',
    payloadW.header.draftFingerprint === W.assessment.assemblyFingerprint && payloadW.approval.reviewFingerprint === W.assessment.assemblyFingerprint && livePreviewW.body?.assemblyFingerprint === W.assessment.assemblyFingerprint && payloadW.approval.reviewedAssessmentId === W.assessment.id,
    'the draft, approval and live A6.4 fingerprints are one and the same reviewed basis',
  )

  // ---------------------------------------------------------------- regressions (T111–T116)
  section('Regressions — A6.5 invoked, nesting A6.4 -> A6.3 -> A6.2 -> A6.1 -> A5.10 -> A1')
  await apiReady('the A6.5 and backward regression chain')
  const chain = run('npm run test:a6:claim-review')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A6.5')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.5] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.5 asserts facts about its own branch, its own migration, its own A6.4 owner diff and its own
  // upstream. On A6.6 those statements are obsolete by design; every other A6.5 check is substantive.
  const a65NonApplicable: Record<string, string> = {
    T001: "A6.5 'Start gate' requires the A6.5 feature branch and no A6.6+ code; A6.6 is branched from the main that contains A6.5 and adds the claim-payload module",
    T004: "A6.5 'Migration scope' judges the single migration its branch added against main; A6.6 adds none (T004 here proves it)",
    T009: "A6.5 'Old contracts preserved' also proves its own A6.4 composer diff against main, merged with A6.5; contracts and owners are re-proved by T009 here",
    T010: "A6.5 'Diff scope' lists the paths A6.5 was allowed to change; A6.6 legitimately changes different ones (T010 here)",
    T120: "A6.5 'Exact head, repeatability, no leakage' requires the upstream to be the A6.5 feature branch, deleted when it merged (exact head and repeatability are T120 here)",
  }
  const undocumented = failing.filter((id) => !(id in a65NonApplicable))
  const counts = chain.output.match(/\[A6\.5\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T116') && !/\[A6\.5\] RUN ABORTED|\[A6\.5\] uncaught error/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check(
    'T111',
    'A6.5 regression',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A6.5 suite did not complete'
      : !reconciled
        ? `A6.5 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A6.5 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A6\.5\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.5] automated summary: ', 'A6.5 ')}; all ${failedCount} failure(s) named and accounted for`,
  )
  for (const id of Object.keys(a65NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A6.5 ${titleOf(row.line)}`, a65NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[A6.6]      ${text.slice(0, 400)}`)
  check('T112', 'A6.4 regression', verdictOf('T111') === 'PASS', `A6.5 T111 (A6.4 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A6.3 regression', verdictOf('T112') === 'PASS', `A6.5 T112 (A6.3) ${verdictOf('T112')}`)
  check('T114', 'A6.2 regression', verdictOf('T113') === 'PASS', `A6.5 T113 (A6.2) ${verdictOf('T113')}`)
  check('T115', 'A6.1 regression', verdictOf('T114') === 'PASS', `A6.5 T114 (A6.1) ${verdictOf('T114')}`)
  check('T116', 'A5 and A1–A4 regression', verdictOf('T115') === 'PASS' && verdictOf('T116') === 'PASS', `A6.5 T115 (A5.8–A5.10) ${verdictOf('T115')}, T116 (A1–A4) ${verdictOf('T116')}`)

  // ---------------------------------------------------------------- builds, replay and DB truth (T117–T119)
  section('Build gates, migration replay and database truth')
  const allUnit = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  check('T117', 'Unit tests and typecheck', allUnit.ok && /ℹ fail 0/.test(allUnit.output) && typecheck.ok, `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}; backend typecheck clean`)
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T118', 'Frontend and replay', build.ok && lint.ok && replay.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean; migration replay clean with no A6.6 migration`)
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
  check('T119', 'DB health truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- diff scope, leakage and exact head (T010, T120)
  section('Diff scope, phase leakage and exact head')
  await waitFor(databaseUp, 60_000)
  const recoveredPreview = await preview(W.claimId, W.body)
  const allowed = ['backend/package.json', 'backend/src/app.ts', 'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/shared/authorization/authorization.types.ts', 'backend/src/shared/errors/error.types.ts', 'frontend/src/developer/checkRegistry.tsx']
  const ownDirs = [PAYLOAD_DIR, FE_PAYLOAD_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const laterDomain = changedPaths.filter((file) => /claim-submission|submission|evidence-package|claim-transport|remittance|integration\/a9|dhpo|eclaimlink|nabidh|malaffi|riayati/i.test(file))
  check(
    'T010',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0 && migrationChanges.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length + migrationChanges.length === 0
      ? `${changedPaths.length} path(s): the A6.6 module, harness and check page, one permission, four error codes and wiring; no owner, migration or schema changed; no A6.7+ domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain, ...migrationChanges].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T120',
    'Exact head, repeatability, no leakage',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a66Branch}`) && !/ahead|behind/.test(tracking) && recoveredPreview.status === 200 && recoveredPreview.body?.previewDigestSha256 === pW.body.previewDigestSha256,
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; after the database restart the worked example composes the same digest again`,
  )

  console.log(`\n[A6.6] run ${runId} — HEAD ${headSha}`)
  console.log(`[A6.6] worked example: Claim ${W.claimId}, assessment ${W.assessment.id}, approval ${W.approvalId} -> COMPOSED A6-PAYLOAD-1, ${pW.body?.byteLength} bytes, preview digest ${pW.body?.previewDigestSha256}, total AED ${payloadW?.financial?.totalExtendedAmount}`)
  if (failures.length > 0) {
    console.log(`[A6.6] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A6.6] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A6.6] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A6.6] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A6.6] CANONICAL CLAIM PAYLOAD / DETERMINISTIC SERIALIZATION ACCEPTANCE COMPLETE' : '[A6.6] A6.6 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A6.6] RUN ABORTED: ${error.message}`)
      console.log('[A6.6] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A6.6] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A6.6] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
