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
import { apiFixtures } from '../a3-governance/a3-governance.fixtures.ts'
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
import { importReferenceDataset, importReferenceDatasetVersion } from '../../modules/reference-dataset/reference-dataset.maintenance.ts'
import { buildEvidenceManifest, encodeEvidenceManifest, evidenceReferencesFromPayload } from '../../modules/claim-evidence/claim-evidence.manifest.ts'
import { packageSealSha256 } from '../../modules/claim-evidence/claim-evidence.hash.ts'
import { freezeClaimSubmission, getFrozenSubmission } from '../../modules/claim-submission/claim-submission.service.ts'
import { insertEvidenceEntries, insertEvidencePackage, insertFreeze, readOwnerVersionFacts } from '../../modules/claim-submission/claim-submission.repository.ts'

// A6.7 — focused acceptance for the Immutable ClaimSubmission & Claim Evidence Package (T001–T130).
//
// Every Claim is built through its owners, exactly as the A6.6 suite builds them: tariff worlds and rates
// through REF-01 and the A6.3 rate routes, runs through the A5.7 recorder, readiness through the A5.9 route,
// the Claim, its lines, diagnoses and pointers through the A6.1/A6.2 routes, pricing runs through the A6.3
// route, draft assessments through the A6.4 route and review decisions through the A6.5 route by a separate
// synthetic Admin (provisioned per run through Better Auth's own server-side creation; its random password
// is never printed). The rich example also names an eligibility verification, a prior authorization version
// and line, an evidence requirement, an evidence artifact version, a rule, source and reference dataset
// version, each created through its own owner route or maintenance function. ADVERSARIAL writes go in only
// to prove a database guard; every one of them runs in a transaction that is always rolled back. Every
// value is synthetic and keyed by this run's id.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A6.7] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A6.7] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A6.7] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A6.7] ${title}`)

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

const runId = `A67-${Date.now()}`
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
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const DOC = 'DOCUMENTATION_REQUIREMENT_EFFECT'
const REPORT = `SYNTHETIC_REPORT_${Date.now().toString(36).toUpperCase()}`
const ARTIFACT_HASH = createHash('sha256').update(`synthetic evidence ${Date.now()}`).digest('hex')
const SUBMISSION_DIR = 'backend/src/modules/claim-submission'
const EVIDENCE_DIR = 'backend/src/modules/claim-evidence'
const FE_SUBMISSION_DIR = 'frontend/src/modules/claim-submission'
const HARNESS_DIR = 'backend/src/integration/a6-claim-submission'
const MIGRATION = 'backend/prisma/migrations/20261017090000_a6_7_immutable_claim_submission_evidence/migration.sql'
const MANIFEST_UNIT_TEST = `${EVIDENCE_DIR}/claim-evidence.manifest.test.ts`
const DTO_KEYS = [
  'submissionId',
  'claimId',
  'draftAssessmentId',
  'approvalDecisionId',
  'pricingRunId',
  'submissionContractVersion',
  'payloadSchemaVersion',
  'approvedAssemblyFingerprint',
  'payloadSha256',
  'payloadByteLength',
  'frozenAt',
  'createdByUserId',
  'createdAt',
  'evidencePackage',
]
const PACKAGE_KEYS = ['evidencePackageId', 'manifestContractVersion', 'entryCount', 'manifestSha256', 'packageSealSha256', 'createdAt']
const AUDIT_KEYS = ['submissionId', 'claimId', 'draftAssessmentId', 'approvalDecisionId', 'pricingRunId', 'submissionContractVersion', 'payloadSchemaVersion', 'manifestContractVersion', 'entryCount', 'payloadByteLength', 'payloadSha256']
const KIND_ORDER = [
  'VALIDATION_RUN',
  'READINESS_ASSESSMENT',
  'VALIDATION_FINDING',
  'ENCOUNTER_ACTIVITY',
  'ENCOUNTER_DIAGNOSIS',
  'ELIGIBILITY_VERIFICATION',
  'PRIOR_AUTHORIZATION_VERSION',
  'AUTHORIZATION_LINE',
  'EVIDENCE_REQUIREMENT',
  'EVIDENCE_ARTIFACT_VERSION',
  'RULE_VERSION',
  'RULE_SOURCE_VERSION',
  'REFERENCE_DATASET_VERSION',
  'PRICING_RUN',
  'PRICING_LINE_RESULT',
  'DRAFT_ASSESSMENT',
  'REVIEW_EVENT',
]
// The owners A6.7 consumes. A change to any of them would be a change to an accepted contract.
const OWNER_DIRS = [
  'backend/src/modules/claim',
  'backend/src/modules/claim-line',
  'backend/src/modules/claim-diagnosis',
  'backend/src/modules/claim-pricing',
  'backend/src/modules/tariff-rate',
  'backend/src/modules/claim-draft',
  'backend/src/modules/claim-review',
  'backend/src/modules/claim-payload',
  'backend/src/modules/pre-claim-readiness',
  'backend/src/modules/pre-claim-validation',
  'backend/src/modules/validation-run',
  'backend/src/modules/commercial-coverage',
  'backend/src/modules/evidence-artifact',
  'backend/src/modules/prior-authorization',
  'backend/src/modules/reference-dataset',
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
const uuid16 = (value: string) => Buffer.from(value.replaceAll('-', ''), 'hex')

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A6.7] A6.7 immutable claim submission & evidence package — run ${runId}`)
  console.log(`[A6.7] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  section('Start gate, the one A6.7 migration, contracts, permissions and wiring')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const mergeOf = (name: string) => gitArgs(['log', 'origin/main', '--merges', `--grep=${name}`, '-n', '1', '--format=%H'])
  const merges = [mergeOf(a61Branch), mergeOf(a62Branch), mergeOf(a63Branch), mergeOf(a64Branch), mergeOf(a65Branch), mergeOf(a66Branch)]
  const laterA6Code = git('ls-tree -r --name-only --full-tree HEAD')
    .split(/\r?\n/)
    .filter((file) => /claim-lifecycle|submission-lifecycle|claim-transport|claim-outbox|dhpo|eclaimlink|remittance/i.test(file))
  check(
    'T001',
    'Start gate',
    branch === a67Branch && merges.every((sha) => sha.length === 40) && gitOk('merge-base --is-ancestor origin/main HEAD') && laterA6Code.length === 0,
    `branch ${branch}; A6.1–A6.6 merged as ${merges.map((sha) => sha.slice(0, 7) || 'NOT FOUND').join(', ')}; contains latest main ${git('rev-parse --short origin/main')}; no A6.8+ code`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check('T003', 'A6.1–A6.6 ancestry', merges.every((sha) => sha.length === 40 && gitOk(`merge-base --is-ancestor ${sha} HEAD`)), 'the six accepted merge commits are ancestors of HEAD')
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const migrationStatus = gitArgs(['diff', '--name-status', 'origin/main...HEAD', '--', ':/backend/prisma/migrations']).split(/\r?\n/).filter(Boolean)
  check(
    'T004',
    'Only the A6.7 migration',
    same(migrationStatus, [`A\t${MIGRATION}`]),
    migrationStatus.length === 1 ? `one added migration, no applied migration modified: ${MIGRATION.split('/').slice(-2, -1)[0]}` : `migration changes: ${migrationStatus.join(' | ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T005', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  const replayExpected = [
    /PASS {2}the A6\.7 tables are exactly claim_freezes and its evidence manifest and entry tables/,
    /PASS {2}claim_freezes_require_evidence_package_trg is present after a clean replay/,
    /PASS {2}one freeze per approval, one package per freeze and one entry per ordinal are unique/,
    /PASS {2}the A6\.5 tables are exactly claim_review_events/,
    /PASS {2}the A6\.4 tables are exactly claim_draft_assessments and claim_draft_findings/,
    /PASS {2}the claim tables are exactly claims plus the four A6\.2 tables/,
  ]
  const appliedCount = Number((replay.output.match(/(\d+) migrations applied cleanly/) ?? [])[1] ?? -1)
  const mainMigrationDirs = git('ls-tree -d --name-only --full-tree origin/main backend/prisma/migrations/').split(/\r?\n/).filter((line) => /\/\d{14}_/.test(line))
  const mainMigrationCount = mainMigrationDirs.length
  // Before its merge this branch adds the A6.7 migration to main's; after the merge it is part of main's count
  // (A6.10 correction: a later package that adds no migration replays exactly main's).
  const ownMigrationAdded = mainMigrationDirs.some((dir) => MIGRATION.startsWith(`${dir}/`)) ? 0 : 1
  check(
    'T006',
    'Migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && replayExpected.every((pattern) => pattern.test(replay.output)) && appliedCount === mainMigrationCount + ownMigrationAdded,
    `${appliedCount} migrations applied cleanly from empty — main's ${mainMigrationCount}${ownMigrationAdded ? ' plus the one A6.7 migration' : ', which already holds the A6.7 migration'}; every A6.2–A6.7 table, constraint and guard survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  const family = allCodes.filter((code) => /^claimFreeze/.test(code)).sort()
  const invented = allCodes.filter((code) => /(approve|approval|submit|transmit|signOff|patientShare|claimPayload|claimSubmission|remittance|send|export|acknowledg|claim\w*\.lifecycle)/i.test(code))
  check(
    'T007',
    'Permissions',
    same(family, ['claimFreeze.create', 'claimFreeze.read', 'claimFreezeEvidence.read']) &&
      (await grantsOf('claimFreeze.create')) === 'ORG_ADMIN' &&
      (await grantsOf('claimFreeze.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      (await grantsOf('claimFreezeEvidence.read')) === 'ORG_ADMIN' &&
      (await grantsOf('claimCanonical.read')) === 'ORG_ADMIN' &&
      (await grantsOf('claimReview.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      invented.length === 0,
    'freeze (Admin), metadata read (Admin, Viewer), evidence manifest read (Admin only); A6.5/A6.6 grants unchanged; no submit, send, export or lifecycle permission',
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
    return { status: res.status, body: res.body as any, text: JSON.stringify(res.body ?? null) }
  }
  const post = (path: string, body: unknown, who: Who = asAdmin) => api('POST', path, body, who)
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const creatorId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const key = (suffix: string) => `${runId}-${suffix}`
  const rawError = (body: unknown) => /\bat \w|prisma|SELECT|INSERT|constraint|trigger|claim_freeze/i.test(JSON.stringify(body ?? {}))

  // Synthetic reviewers: Better Auth's own server-side user and credential creation, then an ORG_ADMIN
  // membership through the existing tables. The password is random per run and never printed.
  const authContext = await auth.$context
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ORG_ADMIN' }, select: { id: true } })
  const provisionReviewer = async (label: string, organizationId = org) => {
    const email = `${runId.toLowerCase()}-${label}@reviewers.sbn.test`
    const secretValue = randomBytes(24).toString('base64url')
    const user = await authContext.internalAdapter.createUser({ email, name: `Synthetic reviewer ${label}`, emailVerified: false }, { method: 'email-password' })
    await authContext.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', issuer: 'local:credential', accountId: user.id, password: await authContext.password.hash(secretValue) })
    const membership = await prisma.organizationMembership.create({ data: { organizationId, userId: user.id } })
    await prisma.membershipRole.create({ data: { membershipId: membership.id, roleId: adminRole.id } })
    const signed = await signIn(email, secretValue)
    if (signed.status !== 200) throw new Error(`fixture reviewer ${label} could not sign in (${signed.status})`)
    return { id: user.id as string, membershipId: membership.id, who: as(signed.cookie) }
  }
  const B = await provisionReviewer('b')
  // An Admin of the OTHER organization: the tenant boundary seen from the other side.
  const O = await provisionReviewer('o', otherOrg)

  const freezePath = (claimId: string) => `/api/claims/${claimId}/submissions`
  const freeze = (claimId: string, body: unknown, who: Who = asAdmin) => api('POST', freezePath(claimId), body, who)
  const wiring = [
    await freeze(MISSING, { draftAssessmentId: MISSING, approvalDecisionId: MISSING }),
    await api('GET', freezePath(MISSING)),
    await api('GET', `/api/claim-submissions/${MISSING}`),
    await api('GET', `/api/claim-submissions/${MISSING}/evidence-manifest`),
  ]
  const absent = [
    await api('PATCH', `/api/claim-submissions/${MISSING}`, {}),
    await api('PUT', `/api/claim-submissions/${MISSING}`, {}),
    await api('DELETE', `/api/claim-submissions/${MISSING}`),
    await api('DELETE', freezePath(MISSING)),
    await api('POST', `/api/claim-submissions/${MISSING}/send`, {}),
    await api('POST', `/api/claim-submissions/${MISSING}/transmit`, {}),
    await api('POST', `/api/claim-submissions/${MISSING}/retry`, {}),
    await api('GET', `/api/claim-submissions/${MISSING}/status`),
    await api('GET', `/api/claim-submissions/${MISSING}/payload`),
  ]
  const unauthenticated = [
    await freeze(MISSING, { draftAssessmentId: MISSING, approvalDecisionId: MISSING }, anonymous),
    await api('GET', freezePath(MISSING), undefined, anonymous),
    await api('GET', `/api/claim-submissions/${MISSING}`, undefined, anonymous),
    await api('GET', `/api/claim-submissions/${MISSING}/evidence-manifest`, undefined, anonymous),
  ]
  check(
    'T008',
    'Route wiring',
    wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND') && absent.every((res) => res.status === 404) && unauthenticated.every((res) => res.status === 401),
    `four routes answer a missing target with a privacy-safe 404; PATCH/PUT/DELETE, send, transmit, retry, status and raw payload are absent (${absent.map((r) => r.status).join('/')}); unauthenticated ${unauthenticated.map((r) => r.status).join('/')}`,
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
    constantOf('backend/src/modules/claim-payload/claim-payload.types.ts', 'PAYLOAD_SCHEMA_VERSION'),
  ]
  const ownerChanged = changedPaths.filter((file) => OWNER_DIRS.some((dir) => file.startsWith(`${dir}/`)))
  // The paths A6.7 may change (judged in T010 at the end, and used to prove the nested N/A causes).
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
  const ownDirs = [SUBMISSION_DIR, EVIDENCE_DIR, FE_SUBMISSION_DIR, HARNESS_DIR]
  const outOfScope = changedPaths.filter((file) => !ownDirs.some((dir) => file.startsWith(`${dir}/`)) && !allowed.includes(file))
  const laterDomain = changedPaths.filter((file) => /claim-lifecycle|claim-transport|remittance|integration\/a9|dhpo|eclaimlink|nabidh|malaffi|riayati|outbox/i.test(file))
  check(
    'T009',
    'Old contracts preserved',
    same(contracts, ['A5-READY-1', 'PreClaimA6HandoffV1', 'A6-CLAIM-1', 'A6-LINE-1', 'A6-DX-1', 'A6-PRICE-1', 'A6-DRAFT-1', 'A6-REVIEW-1', 'A6-PAYLOAD-1']) && ownerChanged.length === 0,
    ownerChanged.length === 0 ? 'A5-READY-1, PreClaimA6HandoffV1, A6-CLAIM-1, A6-LINE-1, A6-DX-1, A6-PRICE-1, A6-DRAFT-1, A6-REVIEW-1 and A6-PAYLOAD-1 unchanged; no A5/A6.1–A6.6 owner changed' : `changed: ${ownerChanged.join(', ').slice(0, 200)}`,
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
  const dx: { id: string }[] = []
  for (const letter of ['A', 'B']) dx.push(must(`diagnosis ${letter}`, (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key(`DX${letter}`), displayName: `${runId} diagnosis ${letter}` })).body))

  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const contract = must('contract', (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  must('contract facility', (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
  const schedule = must('schedule', (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
  const version = must('version', (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  const rate = (body: Record<string, unknown>) => post(`/api/tariff-schedule-versions/${version.id}/rates`, { modifierCodes: [], currencyCode: 'AED', ...body })
  must('rate A', (await rate({ selectorKind: 'PROCEDURE_CODE', procedureCodeId: procA.id, unitTariffAmount: '125.2500' })).body)
  must('rate B', (await rate({ selectorKind: 'SERVICE', serviceId: svcB.id, unitTariffAmount: '12.1250' })).body)
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
  const recordRun = async (encounterId: string, activityIds: string[], diagnosisIds: string[], extra: Record<string, unknown>[] = []) => {
    const contextSnapshot = await plainContext(encounterId)
    const findings = [
      finding('WARNING', { layer: 'CODING' }),
      ...activityIds.map((encounterActivityId) => finding('PASS', { encounterActivityId })),
      ...diagnosisIds.map((encounterDiagnosisId) => finding('PASS', { layer: 'CODING', encounterDiagnosisId })),
      ...extra,
    ]
    const result = await prisma.$transaction(async (tx) => recordValidationRunInTransaction({ encounterId, contextSnapshot, validatorVersion: 'A5-VAL-1', findings }, creatorId, tx))
    if (!result.ok) throw new Error(`a valid synthetic run was refused by the A5.7 recorder: ${result.message}`)
    return result.value.id
  }
  const setPointers = async (lineId: string, claimDiagnosisIds: string[]) => {
    const res = await api('PUT', `/api/claim-lines/${lineId}/diagnosis-pointers`, { claimDiagnosisIds })
    if (res.status !== 200) throw new Error(`fixture pointers refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
  }

  type Spec = { roles?: string[]; membershipId?: string | null; extraFindings?: (encounterId: string) => Promise<Record<string, unknown>[]> }
  // An Encounter with two activities (1.5 x procedure A, 1 x service B) and its diagnoses, all named by one
  // READY run, its Claim (by the creator Admin), one line per activity, one ClaimDiagnosis per role and every
  // line pointing to the PRIMARY.
  const draftClaim = async (label: string, spec: Spec = {}) => {
    const encounter = must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: spec.membershipId ?? null })).body)
    const activityIds: string[] = []
    for (const activity of [{ procedureCodeId: procA.id, quantity: '1.5' }, { serviceId: svcB.id, quantity: '1' }]) activityIds.push(must(`${label} activity`, (await post(`/api/encounters/${encounter.id}/activities`, activity)).body).id)
    const roles = spec.roles ?? ['PRIMARY']
    const encounterDiagnosisIds: string[] = []
    for (let i = 0; i < roles.length; i += 1) encounterDiagnosisIds.push(must(`${label} encounter diagnosis`, (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: dx[i].id })).body).id)
    const validationRunId = await recordRun(encounter.id, activityIds, encounterDiagnosisIds, spec.extraFindings ? await spec.extraFindings(encounter.id) : [])
    const readiness = await post(`/api/validation-runs/${validationRunId}/readiness-assessments`, {})
    if (readiness.status !== 201 || readiness.body?.state !== 'READY_FOR_REVIEW') throw new Error(`fixture ${label}: a valid READY assessment was refused with ${readiness.status}`)
    const claim = must(`${label} claim`, (await post(`/api/pre-claim-readiness-assessments/${readiness.body.id}/claims`, {})).body)
    const lineIds: string[] = []
    for (const activityId of activityIds) lineIds.push(must('line', (await post(`/api/claims/${claim.id}/lines`, { encounterActivityId: activityId })).body).id)
    const claimDiagnosisIds: string[] = []
    for (let i = 0; i < roles.length; i += 1) claimDiagnosisIds.push(must('claim diagnosis', (await post(`/api/claims/${claim.id}/diagnoses`, { encounterDiagnosisId: encounterDiagnosisIds[i], roleCode: roles[i] })).body).id)
    for (const lineId of lineIds) await setPointers(lineId, [claimDiagnosisIds[0]])
    return { encounterId: encounter.id as string, claimId: claim.id as string, activityIds, encounterDiagnosisIds, claimDiagnosisIds, lineIds, validationRunId, readinessAssessmentId: readiness.body.id as string }
  }
  const price = async (claimId: string) => {
    const res = await post(`/api/claims/${claimId}/pricing-runs`, {})
    if (res.status !== 201) throw new Error(`fixture pricing refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    return res.body as { id: string }
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
  const revoke = async (claimId: string, assessment: Assessed, approvalId: string) => {
    const res = await decide(claimId, { draftAssessmentId: assessment.id, assemblyFingerprint: assessment.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: approvalId })
    if (res.status !== 201) throw new Error(`fixture revocation refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
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
  const composeNow = (subject: Approved) => withReadSnapshot(undefined, (tx) => composeCanonicalClaimPayload(subject.claimId, subject.body.draftAssessmentId, subject.body.approvalDecisionId, tx))
  const counts = async () => {
    const rows = await prisma.$queryRaw<{ t: string; n: bigint }[]>`
      SELECT 'freezes' AS t, count(*) AS n FROM claim_freezes UNION ALL SELECT 'packages', count(*) FROM claim_freeze_evidence_manifests
      UNION ALL SELECT 'entries', count(*) FROM claim_freeze_evidence_entries UNION ALL SELECT 'audits', count(*) FROM audit_events WHERE action_code = 'claim_submission.frozen'
      UNION ALL SELECT 'all_audits', count(*) FROM audit_events UNION ALL SELECT 'decisions', count(*) FROM claim_review_events UNION ALL SELECT 'claims', count(*) FROM claims
      UNION ALL SELECT 'lines', count(*) FROM claim_lines UNION ALL SELECT 'runs', count(*) FROM claim_pricing_runs UNION ALL SELECT 'assessments', count(*) FROM claim_draft_assessments`
    // PostgreSQL may run the UNION ALL as a Parallel Append, so the row order is not guaranteed: the
    // object is always built in this fixed key order, so equal counts always compare equal.
    const byName = new Map(rows.map((row) => [row.t, Number(row.n)]))
    return Object.fromEntries(['freezes', 'packages', 'entries', 'audits', 'all_audits', 'decisions', 'claims', 'lines', 'runs', 'assessments'].map((name) => [name, byName.get(name) as number])) as Record<string, number>
  }
  const delta = (before: Record<string, number>, after: Record<string, number>) => Object.fromEntries(Object.keys(after).map((name) => [name, after[name] - before[name]]))
  const NOT_REFUSED = 'ROLLED_BACK'

  // A complete, direct freeze of an approved subject inside a transaction that is ALWAYS rolled back: the
  // composer's bytes and the module's manifest and seal give valid rows; one mutation then targets exactly
  // one database guard. Deferred checks are fired before the rollback (SET CONSTRAINTS ALL IMMEDIATE).
  type Mutations = {
    freeze?: (row: any) => any
    frozenAt?: boolean
    skipPackage?: boolean
    manifestText?: (text: string) => string
    packageRow?: (row: any) => any
    entries?: (entries: any[]) => any[]
  }
  const directFreeze = async (subject: Approved, mutations: Mutations = {}) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        const composed = await composeCanonicalClaimPayload(subject.claimId, subject.body.draftAssessmentId, subject.body.approvalDecisionId, tx)
        if (!composed.ok) throw new Error(`setup: the subject did not compose (${composed.outcome})`)
        const identity = { claimId: subject.claimId, draftAssessmentId: subject.assessment.id, approvalReviewEventId: subject.approvalId, pricingRunId: subject.pricing.id }
        const manifest = buildEvidenceManifest(identity, composed.sha256, evidenceReferencesFromPayload(composed.payload, await readOwnerVersionFacts(composed.payload.evidence, tx)))
        const row = (mutations.freeze ?? ((value: any) => value))({
          ...identity,
          submissionContractVersion: 'A6-SUBMISSION-1',
          payloadSchemaVersion: 'A6-PAYLOAD-1',
          approvedAssemblyFingerprint: subject.assessment.assemblyFingerprint,
          canonicalPayloadBytes: composed.bytes,
          payloadSha256: composed.sha256,
          createdByUserId: creatorId,
        })
        const freezeId = mutations.frozenAt
          ? (
              await tx.$queryRawUnsafe<{ id: string }[]>(
                `INSERT INTO claim_freezes (id, claim_id, draft_assessment_id, approval_review_event_id, pricing_run_id, submission_contract_version, payload_schema_version, approved_assembly_fingerprint, canonical_payload_bytes, payload_sha256, created_by_user_id, frozen_at)
                 VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'A6-SUBMISSION-1', 'A6-PAYLOAD-1', $5, decode($6, 'hex'), $7, $8::uuid, now() - interval '1 day') RETURNING id::text AS id`,
                row.claimId,
                row.draftAssessmentId,
                row.approvalReviewEventId,
                row.pricingRunId,
                row.approvedAssemblyFingerprint,
                Buffer.from(row.canonicalPayloadBytes).toString('hex'),
                row.payloadSha256,
                creatorId,
              )
            )[0].id
          : await insertFreeze(row, tx)
        if (!mutations.skipPackage) {
          const text = (mutations.manifestText ?? ((value: string) => value))(encodeEvidenceManifest(manifest).text)
          const bytes = Buffer.from(text, 'utf8')
          const manifestSha256 = sha256Of(bytes)
          const packageRow = (mutations.packageRow ?? ((value: any) => value))({
            freezeId,
            manifestContractVersion: 'A6-EVIDENCE-1',
            entryCount: manifest.entries.length,
            manifestBytes: bytes,
            manifestSha256,
            packageSealSha256: packageSealSha256(composed.sha256, manifestSha256, identity),
          })
          const packageId = await insertEvidencePackage(packageRow, tx)
          await insertEvidenceEntries(packageId, (mutations.entries ?? ((value: any[]) => value))(manifest.entries), tx)
        }
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
        throw new Error(NOT_REFUSED)
      }),
    )
  const refusedBy = (message: string, marker: RegExp) => message !== '' && !message.includes(NOT_REFUSED) && marker.test(message)

  // Another tenant: a verified tariff world and a priced, assessed and reviewed Claim of the other
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

  // The rich example: every A5.9 reference kind, each created through its owner — an evidence artifact
  // version (with its owner's SHA-256), an eligibility verification, a prior authorization with a RESPONSE
  // version and one authorization line, a governing source version, a documentation rule version with an
  // evidence requirement, and a reference dataset version. Two findings name the same eligibility (dedupe).
  const fx = apiFixtures(baseUrl, admin.cookie, org, runId)
  const membership = must('membership', (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: world.payerId, memberIdentifier: `MEM-${key('M')}`, coverageFrom: '2025-01-01', coverageTo: null })).body)
  const artifact = must('evidence artifact', (await post(`/api/organizations/${org}/evidence-artifacts`, { storageRef: `synthetic://evidence/${key('E')}`, contentHash: ARTIFACT_HASH, documentType: REPORT, sourceDate: '2026-06-10', receivedAt: '2026-06-15T09:30:00.000Z' })).body) as any
  const artifactVersionId = artifact.latestVersion.id as string
  const governing = await fx.verifiedSource('A6.7 governing', { activateOn: '2025-01-01' })
  const rule = await fx.ruleDefinition('A6.7 documentation')
  const ruleVersion = await fx.draftRuleVersion(rule.id, '1', { effectType: DOC })
  const requirement = must('evidence requirement', (await post(`/api/rule-versions/${ruleVersion.id}/evidence-requirement`, { documentTypes: [REPORT], minimumCount: 1, sourceDateRequired: true, maxSourceAgeDays: 30 })).body)
  const dataset = await importReferenceDataset({ datasetKey: key('DS'), displayName: 'Synthetic A6.7 dataset', jurisdictionCode: 'AE-DU', authorityCode: 'DHA' })
  const datasetVersion = dataset.ok ? await importReferenceDatasetVersion({ datasetId: dataset.value.id, version: key('DV'), retrievedAt: '2026-06-01T00:00:00.000Z', contentHash: 'e'.repeat(64) }) : null
  if (!dataset.ok || !datasetVersion?.ok) throw new Error('fixture: the synthetic reference dataset version could not be imported')
  const richRefs: Record<string, string> = {}
  const R = await approved('rich evidence', {
    membershipId: membership.id,
    extraFindings: async (encounterId) => {
      const eligibility = must('eligibility', (await post(`/api/encounters/${encounterId}/eligibility-verifications`, {
        verificationMethod: 'PORTAL', status: 'ELIGIBLE', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z', validThrough: '2030-12-31T00:00:00.000Z',
        authorizationRequired: false, referralRequired: null, requestEvidenceVersionId: null, responseEvidenceVersionId: artifactVersionId,
      })).body)
      const authorization = must('prior authorization', (await post(`/api/encounters/${encounterId}/prior-authorizations`, {
        versionKind: 'INITIAL', status: 'REQUESTED', authorizationReference: null, eligibilityVerificationId: null, requestedAt: null, respondedAt: null, validFrom: null, validThrough: null,
        evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: artifactVersionId }],
      })).body) as any
      const response = must('authorization response', (await post(`/api/prior-authorizations/${authorization.id}/versions`, {
        versionKind: 'RESPONSE', status: 'APPROVED', authorizationReference: `AUTH-${key('R')}`, eligibilityVerificationId: null, requestedAt: null, respondedAt: '2026-06-10T09:00:00.000Z',
        validFrom: '2026-06-01', validThrough: '2026-06-30', evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: artifactVersionId }],
      })).body)
      const lines = (await post(`/api/prior-authorization-versions/${response.id}/authorization-lines`, {
        lines: [{ serviceId: svcB.id, procedureCodeId: null, diagnosisCodeId: null, requestedQty: '1', approvedQty: '1', unitCode: null, approvedFrom: null, approvedThrough: null, status: 'APPROVED' }],
      })).body as any
      const authorizationLineId = lines?.items?.[0]?.id
      if (!authorizationLineId) throw new Error(`fixture authorization line could not be captured: ${JSON.stringify(lines).slice(0, 200)}`)
      Object.assign(richRefs, { eligibilityId: eligibility.id, priorAuthorizationId: authorization.id, priorAuthorizationVersionId: response.id, authorizationLineId })
      return [
        finding('PASS', { layer: 'COVERAGE', findingCode: 'SYNTHETIC_ELIGIBILITY', eligibilityVerificationId: eligibility.id }),
        finding('PASS', { layer: 'COVERAGE', findingCode: 'SYNTHETIC_ELIGIBILITY_AGAIN', eligibilityVerificationId: eligibility.id }),
        finding('PASS', { layer: 'COVERAGE', findingCode: 'SYNTHETIC_AUTHORIZATION', priorAuthorizationVersionId: response.id }),
        finding('PASS', { layer: 'COVERAGE', findingCode: 'SYNTHETIC_AUTHORIZATION_LINE', authorizationLineId }),
        finding('PASS', { layer: 'EVIDENCE', findingCode: 'SYNTHETIC_REQUIREMENT', evidenceRequirementId: requirement.id }),
        finding('PASS', { layer: 'EVIDENCE', findingCode: 'SYNTHETIC_ARTIFACT', evidenceArtifactVersionId: artifactVersionId }),
        finding('PASS', { layer: 'CONTRACT', findingCode: 'SYNTHETIC_RULE', ruleVersionId: ruleVersion.id, governingSourceVersionId: governing.sourceVersion.id, referenceDatasetVersionId: datasetVersion.value.id }),
      ]
    },
  })
  const W = await approved('worked example')
  const X = await approved('second example', { roles: ['PRIMARY', 'SECONDARY'] })
  const P = await approved('pending direct')
  console.log('[A6.7]      fixtures ready: patient, AE-DU/DHA facility profile, clinician, masters, a verified AED tariff world, a synthetic reviewer Admin, the worked, second, pending and rich-evidence examples, and another tenant\'s reviewed Claim')

  // ---------------------------------------------------------------- request, authentication, ownership (T011–T020)
  section('Contracts, strict body, UUIDs, authentication and organization ownership')
  const countsAtStart = await counts()
  const unknownField = [await freeze(W.claimId, { ...W.body, note: 'x' }), await freeze(W.claimId, { ...W.body, profile: 'X12' })]
  check('T012', 'Strict body', unknownField.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && /unknown field/.test(res.body?.error?.message ?? '')), 'an unknown field (a note, a destination profile) is refused by name: 400')
  const forged = [
    await freeze(W.claimId, { ...W.body, payload: { schemaVersion: 'A6-PAYLOAD-1' } }),
    await freeze(W.claimId, { ...W.body, payloadSha256: 'a'.repeat(64) }),
    await freeze(W.claimId, { ...W.body, status: 'SENT' }),
    await freeze(W.claimId, { ...W.body, frozenAt: '2026-01-01T00:00:00Z' }),
    await freeze(W.claimId, { ...W.body, createdByUserId: B.id }),
    await freeze(W.claimId, { ...W.body, totalExtendedAmount: '1.00' }),
    await freeze(W.claimId, { ...W.body, sequence: 1 }),
  ]
  check('T013', 'Client values refused', forged.every((res) => res.status === 400 && /cannot be supplied/.test(res.body?.error?.message ?? '')), 'client payload, digest, state, instant, actor, amount and sequence are refused by name: the server owns them')
  const malformed = [
    await api('POST', '/api/claims/not-a-uuid/submissions', W.body),
    await freeze(W.claimId, { ...W.body, draftAssessmentId: 'nope' }),
    await freeze(W.claimId, { ...W.body, approvalDecisionId: 42 }),
    await freeze(W.claimId, {}),
    await freeze(W.claimId, [W.body.draftAssessmentId, W.body.approvalDecisionId]),
    await api('GET', '/api/claim-submissions/not-a-uuid'),
  ]
  check('T014', 'UUIDs and types', malformed.every((res) => res.status === 400 && errorCode(res.body) === 'VALIDATION_ERROR' && !rawError(res.body)), `malformed path and body ids, an empty and an array body: ${malformed.map((r) => r.status).join('/')}; no raw database text`)
  check('T015', 'Authentication', unauthenticated.every((res) => res.status === 401) && (await freeze(W.claimId, W.body, anonymous)).status === 401, 'every A6.7 route requires a session: 401 without one')
  const viewerFreeze = await freeze(W.claimId, W.body, asViewer)
  check('T016', 'Viewer cannot freeze', viewerFreeze.status === 403 && errorCode(viewerFreeze.body) === 'FORBIDDEN', 'a Viewer member has no claimFreeze.create: 403, nothing frozen')
  const foreignPost = await freeze(foreign.claimId, { draftAssessmentId: foreign.assessmentId, approvalDecisionId: foreign.decisionId })
  const foreignList = await api('GET', freezePath(foreign.claimId))
  const missingPost = await freeze(MISSING, W.body)
  check(
    'T017',
    'Organization ownership',
    foreignPost.status === 404 && foreignList.status === 404 && same(foreignPost.body?.error?.code, missingPost.body?.error?.code) && same(foreignPost.body?.error?.message, missingPost.body?.error?.message),
    "another tenant's Claim is answered exactly like a missing one (404) for freeze and history",
  )
  check('T018', 'Missing targets', missingPost.status === 404 && wiring.every((res) => res.status === 404 && errorCode(res.body) === 'NOT_FOUND'), 'a missing Claim or submission: 404 NOT_FOUND, never a 500')
  const otherAssessment = await freeze(W.claimId, { draftAssessmentId: X.assessment.id, approvalDecisionId: W.approvalId })
  const missingAssessment = await freeze(W.claimId, { draftAssessmentId: MISSING, approvalDecisionId: W.approvalId })
  const otherApproval = await freeze(W.claimId, { draftAssessmentId: W.assessment.id, approvalDecisionId: X.approvalId })
  const missingApproval = await freeze(W.claimId, { draftAssessmentId: W.assessment.id, approvalDecisionId: MISSING })
  check(
    'T019',
    'Cross-Claim ids',
    otherAssessment.status === 404 && same(otherAssessment.body?.error?.message, missingAssessment.body?.error?.message) && otherApproval.status === 404 && same(otherApproval.body?.error?.message, missingApproval.body?.error?.message),
    "another Claim's assessment or approval is answered exactly like a missing one (404)",
  )
  const refusalsLeftNothing = same(delta(countsAtStart, await counts()), Object.fromEntries(Object.keys(countsAtStart).map((name) => [name, 0])))

  // ---------------------------------------------------------------- A6.5 authority (T021–T030)
  section('A6.5 latest APPROVE currentness, exact assessment/decision/fingerprint, no implicit authority')
  const beforeW = await counts()
  const fW = await freeze(W.claimId, W.body)
  const afterW = await counts()
  if (fW.status !== 201) throw new RunAborted(`the worked example did not freeze (${fW.status} ${errorCode(fW.body) ?? ''}: ${fW.body?.error?.message ?? ''}). If this is 403, grant the claimFreeze permissions by running the authorization bootstrap, then run this suite again.`)
  const dW = fW.body
  const rowW = await prisma.claimFreeze.findUniqueOrThrow({ where: { id: dW.submissionId }, include: { evidenceManifest: { include: { entries: { orderBy: { ordinal: 'asc' } } } } } })
  const bytesW = Buffer.from(rowW.canonicalPayloadBytes)
  const payloadW = JSON.parse(bytesW.toString('utf8'))
  const rowHash = async (id: string) =>
    (
      await prisma.$queryRaw<{ h: string }[]>`SELECT encode(sha256(convert_to(
        (SELECT row_to_json(f)::text FROM claim_freezes f WHERE f.id = ${id}::uuid) ||
        (SELECT row_to_json(m)::text FROM claim_freeze_evidence_manifests m WHERE m.claim_submission_id = ${id}::uuid) ||
        (SELECT string_agg(row_to_json(e)::text, '|' ORDER BY e.ordinal) FROM claim_freeze_evidence_entries e JOIN claim_freeze_evidence_manifests m2 ON m2.id = e.evidence_package_id WHERE m2.claim_submission_id = ${id}::uuid),
        'UTF8')), 'hex') AS h`
    )[0].h
  const hashWAtFreeze = await rowHash(dW.submissionId)
  check(
    'T021',
    'Current approval freezes',
    fW.status === 201 && same(Object.keys(dW), DTO_KEYS) && same(Object.keys(dW.evidencePackage), PACKAGE_KEYS) && dW.claimId === W.claimId && dW.approvalDecisionId === W.approvalId && dW.draftAssessmentId === W.assessment.id && dW.pricingRunId === W.pricing.id,
    `201: submission ${dW.submissionId}, ${dW.payloadByteLength} bytes, ${dW.evidencePackage.entryCount} evidence reference(s); metadata only`,
  )
  check(
    'T011',
    'Contract versions',
    constantOf(`${SUBMISSION_DIR}/claim-submission.types.ts`, 'SUBMISSION_CONTRACT_VERSION') === 'A6-SUBMISSION-1' &&
      constantOf(`${EVIDENCE_DIR}/claim-evidence.types.ts`, 'EVIDENCE_MANIFEST_VERSION') === 'A6-EVIDENCE-1' &&
      dW.submissionContractVersion === 'A6-SUBMISSION-1' && dW.payloadSchemaVersion === 'A6-PAYLOAD-1' && dW.evidencePackage.manifestContractVersion === 'A6-EVIDENCE-1',
    'A6-SUBMISSION-1, the frozen A6-PAYLOAD-1 bytes and A6-EVIDENCE-1, in code, in the row and in the DTO',
  )
  const auditW = await prisma.auditEvent.findMany({ where: { entityId: dW.submissionId } })
  check('T020', 'Actor from the session', dW.createdByUserId === creatorId && auditW.length === 1 && auditW[0].actorUserId === creatorId, 'the authenticated Admin is the frozen actor and the audit actor; no client actor exists')
  const Rt = await draftClaim('returned')
  const assessedRt = await assess(Rt.claimId, (await price(Rt.claimId)).id)
  const returnedRt = await decide(Rt.claimId, { draftAssessmentId: assessedRt.id, assemblyFingerprint: assessedRt.assemblyFingerprint, decisionCode: 'RETURN', reasonCode: 'REVIEW_CODING_CORRECTION' })
  const fRt = await freeze(Rt.claimId, { draftAssessmentId: assessedRt.id, approvalDecisionId: returnedRt.body?.decision?.id })
  check('T022', 'RETURN never freezes', fRt.status === 409 && errorCode(fRt.body) === 'CLAIM_SUBMISSION_NOT_APPROVED', 'a RETURN decision named as the approval: NOT_APPROVED')
  const Rj = await draftClaim('rejected')
  const assessedRj = await assess(Rj.claimId, (await price(Rj.claimId)).id)
  const rejectedRj = await decide(Rj.claimId, { draftAssessmentId: assessedRj.id, assemblyFingerprint: assessedRj.assemblyFingerprint, decisionCode: 'REJECT', reasonCode: 'REVIEW_OTHER' })
  const fRj = await freeze(Rj.claimId, { draftAssessmentId: assessedRj.id, approvalDecisionId: rejectedRj.body?.decision?.id })
  check('T023', 'REJECT never freezes', fRj.status === 409 && errorCode(fRj.body) === 'CLAIM_SUBMISSION_NOT_APPROVED', 'a REJECT decision named as the approval: NOT_APPROVED')
  const Rv = await approved('revoked')
  await revoke(Rv.claimId, Rv.assessment, Rv.approvalId)
  const fRv = await freeze(Rv.claimId, Rv.body)
  check('T024', 'Revoked approval', fRv.status === 409 && errorCode(fRv.body) === 'CLAIM_SUBMISSION_NOT_APPROVED', 'an approval withdrawn by REVOKE authorizes no freeze: NOT_APPROVED')
  const S = await approved('superseded approval')
  await revoke(S.claimId, S.assessment, S.approvalId)
  const reapprovalS = await approve(S.claimId, S.assessment)
  const fSold = await freeze(S.claimId, S.body)
  const fSnew = await freeze(S.claimId, { draftAssessmentId: S.assessment.id, approvalDecisionId: reapprovalS })
  check(
    'T025',
    'Superseded approval',
    fSold.status === 409 && errorCode(fSold.body) === 'CLAIM_SUBMISSION_NOT_APPROVED' && fSnew.status === 201,
    'an old APPROVE superseded by a newer decision has no authority (NOT_APPROVED); the newer current approval freezes (201)',
  )
  const secondAssessmentX = await assess(X.claimId, X.pricing.id)
  const mismatched = await freeze(X.claimId, { draftAssessmentId: secondAssessmentX.id, approvalDecisionId: X.approvalId })
  check('T026', 'Approval of another assessment', mismatched.status === 409 && errorCode(mismatched.body) === 'CLAIM_SUBMISSION_NOT_APPROVED', 'an approval paired with a different (even identical) assessment of the same Claim: NOT_APPROVED')
  const L = await approved('line removed')
  await post(`/api/claim-lines/${L.lineIds[1]}/remove`, {})
  const fL = await freeze(L.claimId, L.body)
  check('T027', 'Changed draft is stale', fL.status === 409 && errorCode(fL.body) === 'CLAIM_SUBMISSION_STALE', 'a line removed after approval: the reviewed fingerprint no longer recomposes: STALE')
  const H = await approved('superseded handoff')
  await recordRun(H.encounterId, H.activityIds, H.encounterDiagnosisIds)
  const fH = await freeze(H.claimId, H.body)
  check('T028', 'Superseded validation is stale', fH.status === 409 && errorCode(fH.body) === 'CLAIM_SUBMISSION_STALE', 'a newer validation run supersedes the bound A5.9 basis after approval: STALE, nothing frozen')
  const approvalW = await prisma.claimReviewEvent.findUniqueOrThrow({ where: { id: W.approvalId } })
  check(
    'T029',
    'Exact fingerprint',
    rowW.approvedAssemblyFingerprint === W.assessment.assemblyFingerprint && approvalW.approvalFingerprint === W.assessment.assemblyFingerprint && payloadW.header.draftFingerprint === W.assessment.assemblyFingerprint && /^[0-9a-f]{64}$/.test(rowW.approvedAssemblyFingerprint),
    'the frozen fingerprint is the full 64-character fingerprint of the assessment, its APPROVE and the payload header',
  )
  const Na = await draftClaim('never reviewed')
  const assessedNa = await assess(Na.claimId, (await price(Na.claimId)).id)
  const decisionsBefore30 = (await counts()).decisions
  const noDecision = [await freeze(Na.claimId, { draftAssessmentId: assessedNa.id, approvalDecisionId: MISSING }), await freeze(Na.claimId, { draftAssessmentId: assessedNa.id, approvalDecisionId: W.approvalId })]
  check(
    'T030',
    'No implicit authority',
    noDecision.every((res) => res.status === 404) && (await counts()).decisions === decisionsBefore30 && refusalsLeftNothing,
    'a Claim with no decision cannot borrow one (404); A6.7 never writes a review decision; every refusal above left every table unchanged',
  )

  // ---------------------------------------------------------------- A6.6 compose (T031–T040)
  section('A6.6 composed on the same locked transaction: exact bytes, digest and lineage')
  const previewW = await post(`/api/claims/${W.claimId}/canonical-payload/preview`, W.body)
  check('T031', 'Preview and freeze agree', previewW.status === 200 && previewW.body.previewDigestSha256 === dW.payloadSha256 && previewW.body.byteLength === dW.payloadByteLength, 'the same approved data previewed by A6.6 and frozen by A6.7 gives the same digest and byte length')
  const composedW = await composeNow(W)
  check('T032', 'Byte-for-byte', composedW.ok && Buffer.compare(composedW.bytes, bytesW) === 0, `the stored bytes are exactly the A6.6 composer bytes (${bytesW.length} bytes)`)
  const dbDigestW = (await prisma.$queryRaw<{ h: string }[]>`SELECT encode(sha256(canonical_payload_bytes), 'hex') AS h FROM claim_freezes WHERE id = ${dW.submissionId}::uuid`)[0].h
  check('T033', 'Digest match', sha256Of(bytesW) === rowW.payloadSha256 && dbDigestW === rowW.payloadSha256 && dW.payloadSha256 === rowW.payloadSha256, 'SHA-256 of the stored bytes (harness and PostgreSQL) equals the stored and returned digest')
  check(
    'T034',
    'Payload lineage',
    payloadW.schemaVersion === 'A6-PAYLOAD-1' && payloadW.header.claimId === W.claimId && payloadW.header.draftAssessmentId === W.assessment.id && payloadW.header.approvalDecisionId === W.approvalId && payloadW.header.pricingRunId === W.pricing.id,
    'the frozen bytes are an A6-PAYLOAD-1 payload of exactly this Claim, assessment, approval and pricing run',
  )
  const serviceCode = committedCode(`${SUBMISSION_DIR}/claim-submission.service.ts`)
  const freezeBody = serviceCode.slice(serviceCode.indexOf('async function freezeOnTransaction'), serviceCode.indexOf('export async function freezeClaimSubmission'))
  check(
    'T035',
    'Same locked transaction',
    /lockRowForUpdateNowait\(tx, 'claims', claimId\)/.test(freezeBody.split('\n').slice(0, 3).join('\n')) &&
      /composeCanonicalClaimPayload\(claimId, assessment\.id, decision\.id, tx\)/.test(freezeBody) &&
      /getCurrentReviewAuthority\(claimId, tx\)/.test(freezeBody) &&
      !/withReadSnapshot|prisma\.\$transaction|prisma\./.test(freezeBody) &&
      /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/.test(serviceCode),
    'the Claim lock is the first statement; authority, composition and every write use the one SERIALIZABLE transaction client; no second snapshot',
  )
  const productionA67 = committedProductionCodeOf([SUBMISSION_DIR, EVIDENCE_DIR])
  check(
    'T036',
    'No second payload encoder',
    !/claim-payload\.serializer|encodeCanonicalPayload/.test(productionA67.code) && /canonicalPayloadBytes: composed\.bytes/.test(serviceCode),
    'A6.7 stores exactly the composer bytes and imports no payload encoder',
  )
  check(
    'T037',
    'No reprice, revalidate or approval',
    !/createPricingRun|createDraftAssessment|composeCurrentDraft|recordValidationRun|recordReadinessAssessment|recordReviewDecision|executePreClaimValidation|tariffRate\./.test(productionA67.code),
    'no pricing, draft assessment, validation, readiness or review decision is created or recomputed by A6.7',
  )
  const mapping = serviceCode.slice(serviceCode.indexOf('const composeRefusal'), serviceCode.indexOf('} as const satisfies'))
  check(
    'T038',
    'Composer refusal mapping',
    [
      "NOT_AUTHORIZED: 'CLAIM_SUBMISSION_NOT_APPROVED'",
      "STALE: 'CLAIM_SUBMISSION_STALE'",
      "INCOMPLETE: 'CLAIM_SUBMISSION_EVIDENCE_INCOMPLETE'",
      "UNSUPPORTED: 'CLAIM_SUBMISSION_UNSUPPORTED'",
      "INTEGRITY_CONFLICT: 'CLAIM_SUBMISSION_CONFLICT'",
      "NOT_FOUND: 'NOT_FOUND'",
      "VALIDATION_ERROR: 'VALIDATION_ERROR'",
    ].every((pair) => mapping.includes(pair)) &&
      errorCode(fL.body) === 'CLAIM_SUBMISSION_STALE' && errorCode(fRv.body) === 'CLAIM_SUBMISSION_NOT_APPROVED',
    'every A6.6 outcome maps to exactly one A6.7 refusal (fail closed); STALE and NOT_AUTHORIZED observed live above',
  )
  const before39 = await counts()
  const previewAgain = await post(`/api/claims/${W.claimId}/canonical-payload/preview`, W.body)
  check(
    'T039',
    'Preview never reused',
    !/previewCanonicalClaimPayload|canonical-payload\/preview|fetch\(/.test(productionA67.code) && previewAgain.status === 200 && same(delta(before39, await counts()), Object.fromEntries(Object.keys(before39).map((name) => [name, 0]))),
    'A6.7 never calls the preview; the preview still writes nothing after a freeze',
  )
  check(
    'T040',
    'Approval inside the bytes',
    payloadW.approval.decisionId === W.approvalId && payloadW.approval.reviewerUserId === B.id && payloadW.approval.reviewFingerprint === W.assessment.assemblyFingerprint && payloadW.approval.reviewedAssessmentId === W.assessment.id,
    'the frozen bytes name the human approval, its separate reviewer, the reviewed assessment and fingerprint',
  )

  // ---------------------------------------------------------------- evidence manifest (T041–T050)
  section('Evidence manifest: exact source provenance, order, dedupe, versions and content hashes')
  // Database guards are proven on the rich example before it is frozen (its approval is still unused).
  const firstOf = (entries: any[], kind: string) => entries.find((entry) => entry.referenceKind === kind).ordinal
  const foreignActivity = await directFreeze(R, { entries: (entries) => entries.map((entry) => (entry.ordinal === firstOf(entries, 'ENCOUNTER_ACTIVITY') ? { ...entry, referenceId: W.activityIds[0] } : entry)) })
  const wrongParent = await directFreeze(R, { entries: (entries) => entries.map((entry) => (entry.referenceKind === 'RULE_VERSION' ? { ...entry, referenceId: governing.source.id } : entry)) })
  const wrongHash = await directFreeze(R, { entries: (entries) => entries.map((entry) => (entry.referenceKind === 'EVIDENCE_ARTIFACT_VERSION' ? { ...entry, contentHash: 'f'.repeat(64) } : entry)) })
  const controlR = await directFreeze(R)
  const fR = await freeze(R.claimId, R.body)
  const manifestR = await api('GET', `/api/claim-submissions/${fR.body?.submissionId}/evidence-manifest`)
  const entriesR: any[] = manifestR.body?.manifest?.entries ?? []
  const kindsR = [...new Set(entriesR.map((entry) => entry.referenceKind))]
  check('T041', 'Every lineage kind', fR.status === 201 && same(kindsR, KIND_ORDER), `the rich example freezes (201) with all 17 A6-EVIDENCE-1 kinds: ${entriesR.length} references`)
  // The expected manifest, derived independently from the owners' rows (not from the payload or module).
  const findingsR = await prisma.validationFinding.findMany({ where: { validationRunId: R.validationRunId }, select: { id: true } })
  const lineResultsR = await prisma.claimPricingLineResult.findMany({ where: { pricingRunId: R.pricing.id }, select: { id: true, encounterActivityId: true } })
  const prv = await prisma.priorAuthorizationVersion.findUniqueOrThrow({ where: { id: richRefs.priorAuthorizationVersionId }, select: { priorAuthorizationId: true } })
  const sortIds = (ids: string[]) => [...new Set(ids)].sort()
  const expectedR = [
    ['VALIDATION_RUN', R.validationRunId, null, null],
    ['READINESS_ASSESSMENT', R.readinessAssessmentId, null, null],
    ...sortIds(findingsR.map((row) => row.id)).map((id) => ['VALIDATION_FINDING', id, null, null]),
    ...sortIds(lineResultsR.map((row) => row.encounterActivityId)).map((id) => ['ENCOUNTER_ACTIVITY', id, null, null]),
    ...sortIds(R.encounterDiagnosisIds).map((id) => ['ENCOUNTER_DIAGNOSIS', id, null, null]),
    ['ELIGIBILITY_VERIFICATION', richRefs.eligibilityId, null, null],
    ['PRIOR_AUTHORIZATION_VERSION', prv.priorAuthorizationId, richRefs.priorAuthorizationVersionId, null],
    ['AUTHORIZATION_LINE', richRefs.authorizationLineId, null, null],
    ['EVIDENCE_REQUIREMENT', requirement.id, null, null],
    ['EVIDENCE_ARTIFACT_VERSION', artifact.id, artifactVersionId, ARTIFACT_HASH],
    ['RULE_VERSION', rule.id, ruleVersion.id, null],
    ['RULE_SOURCE_VERSION', governing.source.id, governing.sourceVersion.id, null],
    ['REFERENCE_DATASET_VERSION', dataset.value.id, datasetVersion.value.id, null],
    ['PRICING_RUN', R.pricing.id, null, null],
    ...sortIds(lineResultsR.map((row) => row.id)).map((id) => ['PRICING_LINE_RESULT', id, null, null]),
    ['DRAFT_ASSESSMENT', R.assessment.id, null, null],
    ['REVIEW_EVENT', R.approvalId, null, null],
  ]
  check('T042', 'Exact source provenance', same(entriesR.map((e) => [e.referenceKind, e.referenceId, e.referenceVersionId, e.contentHash]), expectedR), 'the manifest is exactly the references the owners hold for this Claim, derived independently from their rows')
  check(
    'T043',
    'Order and ordinals',
    entriesR.every((entry, index) => entry.ordinal === index + 1) &&
      entriesR.every((entry, index) => index === 0 || KIND_ORDER.indexOf(entriesR[index - 1].referenceKind) < KIND_ORDER.indexOf(entry.referenceKind) || (entriesR[index - 1].referenceKind === entry.referenceKind && `${entriesR[index - 1].referenceId}${entriesR[index - 1].referenceVersionId ?? ''}` < `${entry.referenceId}${entry.referenceVersionId ?? ''}`)),
    'ordinals 1..N with no gap; kind order, then reference id, then version id, strictly ascending',
  )
  const eligibilityFindings = await prisma.validationFinding.count({ where: { validationRunId: R.validationRunId, eligibilityVerificationId: richRefs.eligibilityId } })
  check('T044', 'Dedupe', eligibilityFindings === 2 && entriesR.filter((entry) => entry.referenceKind === 'ELIGIBILITY_VERIFICATION').length === 1, 'two findings name the same eligibility verification; the manifest names it once')
  const versioned = entriesR.filter((entry) => entry.referenceVersionId !== null)
  check(
    'T045',
    'Versions and parents',
    same(versioned.map((entry) => entry.referenceKind), ['PRIOR_AUTHORIZATION_VERSION', 'EVIDENCE_ARTIFACT_VERSION', 'RULE_VERSION', 'RULE_SOURCE_VERSION', 'REFERENCE_DATASET_VERSION']) &&
      versioned.every((entry) => entry.referenceId !== entry.referenceVersionId),
    'exactly the five versioned kinds carry the exact version id, with the owner\'s parent (authorization, artifact, rule, source, dataset) as reference id',
  )
  const hashed = entriesR.filter((entry) => entry.contentHash !== null)
  const ownerHash = (await prisma.evidenceArtifactVersion.findUniqueOrThrow({ where: { id: artifactVersionId }, select: { contentHash: true } })).contentHash
  check('T046', 'Content hash rules', hashed.length === 1 && hashed[0].referenceKind === 'EVIDENCE_ARTIFACT_VERSION' && hashed[0].contentHash === ownerHash && ownerHash === ARTIFACT_HASH, "only the evidence artifact version carries a hash, exactly its owner's SHA-256; no hash is invented for any other kind")
  const payloadR = JSON.parse(Buffer.from((await prisma.claimFreeze.findUniqueOrThrow({ where: { id: fR.body.submissionId }, select: { canonicalPayloadBytes: true } })).canonicalPayloadBytes).toString('utf8'))
  const payloadIds = new Set<string>([...(JSON.stringify(payloadR).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])])
  const parentIds = new Set([prv.priorAuthorizationId, artifact.id, rule.id, governing.source.id, dataset.value.id])
  check(
    'T047',
    'No fabricated reference',
    entriesR.every((entry) => (entry.referenceVersionId ? payloadIds.has(entry.referenceVersionId) && parentIds.has(entry.referenceId) : payloadIds.has(entry.referenceId))),
    'every reference (or version) is named by the frozen payload; parents come only from the owners of those versions',
  )
  const unitRun = run(`node --test ${MANIFEST_UNIT_TEST.replace('backend/', '')}`)
  check(
    'T048',
    'Missing evidence fails closed',
    unitRun.ok && /✔ a missing owner version or a non-SHA-256 artifact hash is incomplete evidence, never a substitute/.test(unitRun.output) && /EvidenceIncompleteError\) return refuse\('CLAIM_SUBMISSION_EVIDENCE_INCOMPLETE'/.test(serviceCode),
    'a missing owner version or a non-SHA-256 artifact hash is EVIDENCE_INCOMPLETE; no newer version is substituted',
  )
  check(
    'T049',
    'Foreign or wrong-version reference',
    controlR.includes(NOT_REFUSED) && refusedBy(foreignActivity, /claim_freeze_evidence_coherence/) && refusedBy(wrongParent, /claim_freeze_evidence_coherence/) && refusedBy(wrongHash, /claim_freeze_evidence_coherence/),
    "the database refuses another Encounter's activity, a version under the wrong parent and a wrong artifact hash (a complete valid control chain is accepted)",
  )
  const manifestBytesR = (await prisma.claimFreezeEvidenceManifest.findFirstOrThrow({ where: { claimFreezeId: fR.body.submissionId }, select: { manifestBytes: true } })).manifestBytes
  const manifestTextR = Buffer.from(manifestBytesR).toString('utf8')
  check(
    'T050',
    'References only',
    same([...deepKeys(JSON.parse(manifestTextR))].sort(), ['approvalReviewEventId', 'claimId', 'contentHash', 'draftAssessmentId', 'entries', 'evidenceRole', 'ordinal', 'payloadSha256', 'pricingRunId', 'referenceId', 'referenceKind', 'referenceVersionId', 'schemaVersion']) &&
      !manifestTextR.includes('synthetic://') && !manifestTextR.includes(REPORT) && !manifestTextR.includes('Synthetic finding'),
    'typed ids, kinds, roles and owner hashes only: no storage reference, document type, message or evidence bytes',
  )

  // ---------------------------------------------------------------- database guards (T051–T060)
  section('Database: RESTRICT foreign keys, lineage guards, append-only, unique approval, no gaps')
  const fkRows = await prisma.$queryRaw<{ name: string; del: string }[]>`
    SELECT conname AS name, confdeltype::text AS del FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text IN ('claim_freezes', 'claim_freeze_evidence_manifests', 'claim_freeze_evidence_entries')`
  check('T051', 'RESTRICT foreign keys', fkRows.length === 7 && fkRows.every((row) => row.del === 'r'), `${fkRows.length} foreign keys, all ON DELETE RESTRICT; no CASCADE`)
  const control = await directFreeze(P)
  const wrongClaim = await directFreeze(P, { freeze: (row) => ({ ...row, claimId: X.claimId }) })
  check('T052', 'Claim-assessment linkage', control.includes(NOT_REFUSED) && refusedBy(wrongClaim, /claim_freeze_coherence/), 'a valid direct chain is accepted (then rolled back); naming another Claim for the assessment is refused')
  const wrongRun = await directFreeze(P, { freeze: (row) => ({ ...row, pricingRunId: X.pricing.id }) })
  check('T053', 'Pricing run linkage', refusedBy(wrongRun, /claim_freeze_coherence/), "another Claim's pricing run is refused by the database")
  const notApprove = await directFreeze(P, {
    freeze: (row) => ({ ...row, claimId: Rt.claimId, draftAssessmentId: assessedRt.id, approvalReviewEventId: returnedRt.body?.decision?.id, pricingRunId: assessedRt.pricingRunId, approvedAssemblyFingerprint: assessedRt.assemblyFingerprint }),
  })
  const superseded = await directFreeze(P, { freeze: (row) => ({ ...row, claimId: S.claimId, draftAssessmentId: S.assessment.id, approvalReviewEventId: S.approvalId, pricingRunId: S.pricing.id, approvedAssemblyFingerprint: S.assessment.assemblyFingerprint }) })
  check('T054', 'Only the latest APPROVE', refusedBy(notApprove, /claim_freeze_coherence/) && refusedBy(superseded, /claim_freeze_coherence/), 'a RETURN, and an APPROVE that is no longer the latest decision, are refused by the database')
  const forgedDigest = await directFreeze(P, { freeze: (row) => ({ ...row, payloadSha256: 'a'.repeat(64) }) })
  const mutatedBytes = await directFreeze(P, { freeze: (row) => ({ ...row, canonicalPayloadBytes: Buffer.concat([Buffer.from(row.canonicalPayloadBytes), Buffer.from(' ')]) }) })
  check('T055', 'Forged digest or bytes', refusedBy(forgedDigest, /claim_freeze_digest/) && refusedBy(mutatedBytes, /claim_freeze_digest/), 'a digest that is not the SHA-256 of the stored bytes, or altered bytes, are refused by the database')
  const appendOnly = [
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_freezes SET payload_sha256 = payload_sha256 WHERE id = $1::uuid`, dW.submissionId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_freezes WHERE id = $1::uuid`, dW.submissionId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_freeze_evidence_manifests SET entry_count = entry_count WHERE claim_submission_id = $1::uuid`, dW.submissionId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_freeze_evidence_manifests WHERE claim_submission_id = $1::uuid`, dW.submissionId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE claim_freeze_evidence_entries SET ordinal = ordinal WHERE evidence_package_id = $1::uuid`, dW.evidencePackage.evidencePackageId)),
    await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM claim_freeze_evidence_entries WHERE evidence_package_id = $1::uuid`, dW.evidencePackage.evidencePackageId)),
  ]
  check('T056', 'Append-only', appendOnly.every((message) => /is append-only/.test(message)), 'UPDATE and DELETE are refused on the freeze, its package and its entries')
  const duplicateApproval = await directFreeze(W)
  check('T057', 'One freeze per approval', /duplicate key|23505|claim_freezes_approval_review_event_id_key/.test(duplicateApproval), 'a second freeze of an already frozen approval is refused by the unique key')
  const forgedManifestDigest = await directFreeze(P, { packageRow: (row) => ({ ...row, manifestSha256: 'b'.repeat(64) }) })
  const forgedSeal = await directFreeze(P, { packageRow: (row) => ({ ...row, packageSealSha256: 'c'.repeat(64) }) })
  const otherIdentity = await directFreeze(P, { manifestText: (text) => text.replace(P.claimId, X.claimId) })
  check(
    'T058',
    'Forged manifest digest or seal',
    refusedBy(forgedManifestDigest, /claim_freeze_evidence_digest/) && refusedBy(forgedSeal, /claim_freeze_evidence_digest/) && refusedBy(otherIdentity, /claim_freeze_evidence_coherence/),
    'a wrong manifest digest, a wrong seal, or manifest bytes naming another freeze identity are refused by the database',
  )
  const gap = await directFreeze(P, { entries: (entries) => entries.map((entry, index) => (index === entries.length - 1 ? { ...entry, ordinal: entry.ordinal + 1 } : entry)) })
  const dropped = await directFreeze(P, { entries: (entries) => entries.slice(0, -1) })
  check('T059', 'No gaps at commit', refusedBy(gap, /claim_freeze_evidence_incomplete/) && refusedBy(dropped, /claim_freeze_evidence_incomplete/), 'an ordinal gap, or an entry missing from the declared count, is refused when the transaction commits')
  const lateEntry = await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await insertEvidenceEntries(dW.evidencePackage.evidencePackageId, [{ ordinal: dW.evidencePackage.entryCount + 1, referenceKind: 'REVIEW_EVENT', referenceId: W.approvalId, referenceVersionId: null, contentHash: null, evidenceRole: 'HUMAN_APPROVAL' }], tx)
      throw new Error(NOT_REFUSED)
    }),
  )
  const latePackage = await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await insertEvidencePackage({ freezeId: dW.submissionId, manifestContractVersion: 'A6-EVIDENCE-1', entryCount: 0, manifestBytes: Buffer.from('{}'), manifestSha256: sha256Of(Buffer.from('{}')), packageSealSha256: 'd'.repeat(64) }, tx)
      throw new Error(NOT_REFUSED)
    }),
  )
  check('T060', 'No late evidence', refusedBy(lateEntry, /claim_freeze_evidence_coherence/) && refusedBy(latePackage, /claim_freeze_evidence_coherence|duplicate key/), 'an entry or a package added to an already committed freeze by a later transaction is refused')

  // ---------------------------------------------------------------- atomicity (T061–T070)
  section('One-shot atomicity: deferred completeness, crash injection, no partial evidence or audit')
  check(
    'T061',
    'One-shot freeze',
    same(delta(beforeW, afterW), { ...Object.fromEntries(Object.keys(beforeW).map((name) => [name, 0])), freezes: 1, packages: 1, entries: dW.evidencePackage.entryCount, audits: 1, all_audits: 1 }),
    `exactly one freeze, one package, ${dW.evidencePackage.entryCount} entries and one audit event; nothing else changed`,
  )
  const noPackage = await directFreeze(P, { skipPackage: true })
  check('T062', 'Deferred completeness', refusedBy(noPackage, /claim_freeze_evidence_incomplete/), 'a freeze with no evidence package cannot commit')
  const Cr = await approved('crash injection')
  const historyOf = async (subject: Approved) =>
    JSON.stringify(
      await prisma.$queryRaw`SELECT
        (SELECT row_to_json(c)::text FROM claims c WHERE c.id = ${subject.claimId}::uuid) AS claim,
        (SELECT string_agg(row_to_json(l)::text, '|' ORDER BY l.id) FROM claim_lines l WHERE l.claim_id = ${subject.claimId}::uuid) AS lines,
        (SELECT string_agg(row_to_json(d)::text, '|' ORDER BY d.id) FROM claim_diagnoses d WHERE d.claim_id = ${subject.claimId}::uuid) AS diagnoses,
        (SELECT string_agg(row_to_json(e)::text, '|' ORDER BY e.sequence) FROM claim_review_events e WHERE e.claim_id = ${subject.claimId}::uuid) AS decisions,
        (SELECT string_agg(row_to_json(p)::text, '|' ORDER BY p.id) FROM claim_pricing_runs p WHERE p.claim_id = ${subject.claimId}::uuid) AS pricing,
        (SELECT string_agg(row_to_json(a)::text, '|' ORDER BY a.id) FROM claim_draft_assessments a WHERE a.claim_id = ${subject.claimId}::uuid) AS assessments`,
    )
  const historyBeforeCrash = await historyOf(Cr)
  const countsBeforeCrash = await counts()
  const crashAt = async (probe: string) => {
    clearConcurrencyProbes()
    setConcurrencyProbe(probe, async () => {
      throw new Error(`INJECTED_CRASH_AT_${probe}`)
    })
    const message = await attemptAdversarial(() => freezeClaimSubmission(Cr.claimId, Cr.body, creatorId))
    clearConcurrencyProbes()
    return { message, unchanged: same(await counts(), countsBeforeCrash) }
  }
  const crashes = [
    await crashAt('claimSubmission.submission_written'),
    await crashAt('claimSubmission.package_written'),
    await crashAt('claimSubmission.entry_written'),
    await crashAt('claimSubmission.audited'),
  ]
  check('T063', 'Crash after the freeze row', crashes[0].message.includes('INJECTED_CRASH') && crashes[0].unchanged, 'a failure after the freeze row rolls back everything')
  check('T064', 'Crash after the package', crashes[1].message.includes('INJECTED_CRASH') && crashes[1].unchanged, 'a failure after the package header rolls back everything')
  check('T065', 'Crash after the entries', crashes[2].message.includes('INJECTED_CRASH') && crashes[2].unchanged, 'a failure halfway (after the entries, before the audit) rolls back everything')
  check('T066', 'Crash after the audit', crashes[3].message.includes('INJECTED_CRASH') && crashes[3].unchanged, 'a failure after the audit, before commit, rolls back the audit too')
  check('T068', 'History untouched', (await historyOf(Cr)) === historyBeforeCrash, 'the Claim, lines, diagnoses, decisions, pricing and assessments are byte-identical after four failed freezes')
  const afterCrash = await freeze(Cr.claimId, Cr.body)
  check('T067', 'Retry after a crash', afterCrash.status === 201 && (await prisma.claimFreeze.count({ where: { approvalReviewEventId: Cr.approvalId } })) === 1, 'the same request after the failures freezes exactly once (201)')
  const integrity = await prisma.$queryRaw<{ bad: bigint }[]>`
    SELECT count(*) AS bad FROM claim_freezes f
    LEFT JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id
    WHERE m.id IS NULL OR m.entry_count <> (SELECT count(*) FROM claim_freeze_evidence_entries e WHERE e.evidence_package_id = m.id)
       OR (SELECT count(*) FROM audit_events a WHERE a.entity_id = f.id AND a.action_code = 'claim_submission.frozen') <> 1`
  check('T069', 'No partial evidence or audit', Number(integrity[0].bad) === 0, 'every freeze in the database has exactly one complete package and exactly one audit event')
  const clientTime = await directFreeze(P, { frozenAt: true })
  const timesW = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT (f.frozen_at = f.created_at AND f.created_at = m.created_at AND a.occurred_at >= f.frozen_at) AS ok
    FROM claim_freezes f JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id JOIN audit_events a ON a.entity_id = f.id WHERE f.id = ${dW.submissionId}::uuid`
  check('T070', 'Database time', refusedBy(clientTime, /claim_freeze_time/) && timesW[0]?.ok === true, 'freeze, package and entries carry one database transaction time; a supplied instant is refused')

  // ---------------------------------------------------------------- duplicates and concurrency (T071–T080)
  section('Duplicates, concurrent freezes, serialized line edits and revocations, retry safety')
  const before71 = await counts()
  const replayW = await freeze(W.claimId, W.body)
  check('T071', 'Sequential replay', replayW.status === 200 && same(replayW.body, dW) && same(delta(before71, await counts()), Object.fromEntries(Object.keys(before71).map((name) => [name, 0]))), 'the same request again: 200 with a byte-identical body, no new row and no audit')
  const D = await approved('concurrent duplicate')
  const before72 = await counts()
  const pair = await Promise.all([freeze(D.claimId, D.body), freeze(D.claimId, D.body)])
  const d72 = delta(before72, await counts())
  check(
    'T072',
    'Concurrent duplicates',
    same(pair.map((res) => res.status).sort(), [200, 201]) && same(pair[0].body, pair[1].body) && d72.freezes === 1 && d72.audits === 1,
    `two simultaneous identical requests: ${pair.map((res) => res.status).sort().join('/')}, one immutable submission, one package, one audit`,
  )
  const E1 = await approved('edit first')
  const hold73 = holdAt('claimLine.removed')
  const removal73 = removeClaimLine(E1.lineIds[1], {}, creatorId)
  await Promise.race([hold73.arrived, removal73])
  const freeze73 = freezeClaimSubmission(E1.claimId, E1.body, creatorId)
  const waited73 = !(await settledWithin(freeze73, 3000))
  hold73.release()
  const removed73 = await removal73
  const result73 = await freeze73
  clearConcurrencyProbes()
  check(
    'T073',
    'Freeze behind a line edit',
    waited73 && removed73.ok && !result73.ok && result73.code === 'CLAIM_SUBMISSION_STALE',
    'a freeze during an uncommitted line removal waits for the Claim lock, then re-evaluates on a fresh snapshot: STALE — never mixed facts',
  )
  const E2 = await approved('freeze first')
  const preEdit = await composeNow(E2)
  const hold74 = holdAt('claimSubmission.claim_locked')
  const freeze74 = freezeClaimSubmission(E2.claimId, E2.body, creatorId)
  await Promise.race([hold74.arrived, freeze74])
  const removal74 = removeClaimLine(E2.lineIds[1], {}, creatorId)
  const waited74 = !(await settledWithin(removal74, 3000))
  hold74.release()
  const result74 = await freeze74
  const removed74 = await removal74
  clearConcurrencyProbes()
  const frozen74 = result74.ok ? await prisma.claimFreeze.findUniqueOrThrow({ where: { id: result74.value.submission.submissionId }, select: { canonicalPayloadBytes: true } }) : null
  check(
    'T074',
    'Line edit behind a freeze',
    waited74 && result74.ok && !result74.value.replayed && removed74.ok && preEdit.ok && frozen74 !== null && Buffer.compare(Buffer.from(frozen74.canonicalPayloadBytes), preEdit.bytes) === 0,
    'a line removal waits for the freeze; the freeze stores exactly the pre-edit approved bytes; the edit applies after it',
  )
  const Rv2 = await approved('revoke first')
  const hold75 = holdAt('claimReview.inserted')
  const revoke75 = recordReviewDecision(Rv2.claimId, { draftAssessmentId: Rv2.assessment.id, assemblyFingerprint: Rv2.assessment.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: Rv2.approvalId }, B.id)
  await Promise.race([hold75.arrived, revoke75])
  const freeze75 = freezeClaimSubmission(Rv2.claimId, Rv2.body, creatorId)
  const waited75 = !(await settledWithin(freeze75, 3000))
  hold75.release()
  const revoked75 = await revoke75
  const result75 = await freeze75
  clearConcurrencyProbes()
  check('T075', 'Freeze behind a revocation', waited75 && revoked75.ok && !result75.ok && result75.code === 'CLAIM_SUBMISSION_NOT_APPROVED', 'a freeze during an uncommitted REVOKE waits, then finds no current authority: NOT_APPROVED')
  const F = await approved('freeze before revoke')
  const hold76 = holdAt('claimSubmission.entry_written')
  const freeze76 = freezeClaimSubmission(F.claimId, F.body, creatorId)
  await Promise.race([hold76.arrived, freeze76])
  const revoke76 = recordReviewDecision(F.claimId, { draftAssessmentId: F.assessment.id, assemblyFingerprint: F.assessment.assemblyFingerprint, decisionCode: 'REVOKE', referencedApprovalId: F.approvalId }, B.id)
  const waited76 = !(await settledWithin(revoke76, 3000))
  hold76.release()
  const result76 = await freeze76
  const revoked76 = await revoke76
  clearConcurrencyProbes()
  const replay76 = await freeze(F.claimId, F.body)
  check(
    'T076',
    'Revocation behind a freeze',
    waited76 && result76.ok && !result76.value.replayed && revoked76.ok && replay76.status === 200 && same(replay76.body, result76.ok ? result76.value.submission : null),
    'a REVOKE waits for the in-flight freeze; the freeze commits (immutable), the REVOKE follows, and the frozen record is unchanged on replay',
  )
  const fX = await freeze(X.claimId, X.body)
  const before77 = await counts()
  const reuse = await freeze(X.claimId, { draftAssessmentId: secondAssessmentX.id, approvalDecisionId: X.approvalId })
  check(
    'T077',
    'Inconsistent reuse',
    fX.status === 201 && reuse.status === 409 && errorCode(reuse.body) === 'CLAIM_SUBMISSION_CONFLICT' && same(delta(before77, await counts()), Object.fromEntries(Object.keys(before77).map((name) => [name, 0]))),
    'a frozen approval named with another assessment: CONFLICT, nothing written',
  )
  const listD = await api('GET', freezePath(D.claimId))
  const byApproval = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT approval_review_event_id FROM claim_freezes GROUP BY approval_review_event_id HAVING count(*) > 1) duplicated`
  check('T078', 'Re-query by approval', listD.status === 200 && listD.body.items.length === 1 && same(listD.body.items[0], pair[0].body) && Number(byApproval[0].n) === 0, 'after concurrent attempts the history names exactly one freeze per approval; a caller unsure of a commit re-queries safely')
  const C = await approved('correction')
  const firstC = await freeze(C.claimId, C.body)
  const firstRowC = await prisma.claimFreeze.findUniqueOrThrow({ where: { id: firstC.body.submissionId } })
  await revoke(C.claimId, C.assessment, C.approvalId)
  await post(`/api/claim-lines/${C.lineIds[1]}/remove`, {})
  const repricedC = await price(C.claimId)
  const reassessedC = await assess(C.claimId, repricedC.id)
  const reapprovedC = await approve(C.claimId, reassessedC)
  const secondC = await freeze(C.claimId, { draftAssessmentId: reassessedC.id, approvalDecisionId: reapprovedC })
  const listC = await api('GET', freezePath(C.claimId))
  check(
    'T079',
    'Correction is a new freeze',
    firstC.status === 201 && secondC.status === 201 && listC.body?.items?.length === 2 && same(await prisma.claimFreeze.findUniqueOrThrow({ where: { id: firstC.body.submissionId } }), firstRowC) && secondC.body.payloadSha256 !== firstC.body.payloadSha256,
    'after revoke, correction and a new human approval, a second immutable freeze exists; the first is byte-identical',
  )
  check(
    'T080',
    'Bounded retry',
    /const MAX_FREEZE_ATTEMPTS = 3/.test(serviceCode) && /const MAX_LOCK_WAITS = 5/.test(serviceCode) && /P2034/.test(serviceCode) && /40001/.test(serviceCode) && /isUniqueViolation\(error\)\) \{\s*attempt \+= 1/.test(serviceCode.replace(/isWriteConflict\(error\) \|\| /, '')),
    'serialization, deadlock and unique races retry at most three times and re-read; a busy Claim is waited for at most five times',
  )

  // ---------------------------------------------------------------- security and privacy (T081–T090)
  section('Cross-tenant reads, viewer limits, actor, PHI minimization, no raw bytes, audit discipline')
  const foreignReads = [
    await api('GET', `/api/claim-submissions/${dW.submissionId}`, undefined, O.who),
    await api('GET', `/api/claim-submissions/${dW.submissionId}/evidence-manifest`, undefined, O.who),
    await api('GET', freezePath(W.claimId), undefined, O.who),
    await freeze(W.claimId, W.body, O.who),
  ]
  const missingRead = await api('GET', `/api/claim-submissions/${MISSING}`, undefined, O.who)
  check(
    'T081',
    'Cross-tenant reads',
    foreignReads.every((res) => res.status === 404) && same(foreignReads[0].body?.error?.message, missingRead.body?.error?.message),
    "an Admin of another organization gets 404 for this tenant's frozen submission, manifest, history and freeze — exactly like a missing one",
  )
  const viewerReads = [await api('GET', `/api/claim-submissions/${dW.submissionId}`, undefined, asViewer), await api('GET', freezePath(W.claimId), undefined, asViewer)]
  const viewerManifest = await api('GET', `/api/claim-submissions/${dW.submissionId}/evidence-manifest`, undefined, asViewer)
  check('T082', 'Viewer limits', viewerReads.every((res) => res.status === 200) && viewerManifest.status === 403 && viewerFreeze.status === 403, 'a Viewer reads frozen metadata (200) but not the evidence manifest (403) and cannot freeze (403)')
  const G = await approved('second actor')
  const fG = await freeze(G.claimId, G.body, B.who)
  const auditG = await prisma.auditEvent.findFirst({ where: { entityId: fG.body?.submissionId } })
  check('T083', 'No actor spoofing', fG.status === 201 && fG.body.createdByUserId === B.id && auditG?.actorUserId === B.id, 'the freeze and its audit name whoever is signed in; nothing in the request can name an actor')
  const exposed = JSON.stringify([dW, replayW.body, viewerReads[0].body, auditW[0].afterState])
  check(
    'T084',
    'PHI minimization',
    !exposed.includes(`${runId}-P`) && !exposed.includes('1990-01-01') && !exposed.includes(key('DXA')) && !/200\.01|125\.25|12\.125/.test(exposed),
    'no patient name, birth date, diagnosis code or amount in any DTO or audit',
  )
  const bodies = JSON.stringify([dW, listD.body, viewerReads.map((res) => res.body), manifestR.body])
  check(
    'T085',
    'No raw bytes over HTTP',
    !bodies.includes('"schemaVersion":"A6-PAYLOAD-1"') && !bodies.includes(bytesW.toString('base64').slice(0, 40)) && ![...deepKeys(JSON.parse(bodies))].some((name) => /bytes$/i.test(name)),
    'metadata, digests and the typed manifest only: no canonical payload bytes, text or base64 in any response',
  )
  check('T086', 'Audit metadata only', auditW.length === 1 && auditW[0].actionCode === 'claim_submission.frozen' && auditW[0].entityType === 'CLAIM_SUBMISSION' && same(Object.keys(auditW[0].afterState as object).sort(), [...AUDIT_KEYS].sort()) && auditW[0].beforeState === null, 'one claim_submission.frozen event on CLAIM_SUBMISSION with exactly ids, versions, counts, byte length and digest')
  const before87 = await counts()
  await api('GET', `/api/claim-submissions/${dW.submissionId}`)
  await api('GET', `/api/claim-submissions/${dW.submissionId}/evidence-manifest`)
  await api('GET', freezePath(W.claimId))
  await freeze(W.claimId, W.body)
  await freeze(Rv.claimId, Rv.body)
  await freeze(W.claimId, { ...W.body, status: 'SENT' })
  check('T087', 'No audit on reads, replay or refusals', same(delta(before87, await counts()), Object.fromEntries(Object.keys(before87).map((name) => [name, 0]))), 'reads, an identical replay and refusals write no row and no audit event')
  check('T088', 'Safe error bodies', [fRt, fRv, fL, fH, reuse, otherAssessment, viewerFreeze, ...malformed].every((res) => !rawError(res.body)), 'refusals carry a code and a safe message; no SQL, constraint, trigger, table or stack text')
  const frontend = committedCode(`${FE_SUBMISSION_DIR}/ClaimSubmissionCheck.tsx`)
  check('T089', 'Read-only page, no storage', frontend.length > 0 && !/localStorage|sessionStorage|indexedDB|console\.|method:\s*'(POST|PUT|PATCH|DELETE)'/.test(frontend), 'the Developer Tools page only reads: no freeze, send or storage, nothing logged')
  check('T090', 'No logged bytes', !/console\.|logger\./.test(productionA67.code), 'the A6.7 backend code logs nothing (no bytes, digests or ids written to logs)')

  // ---------------------------------------------------------------- vectors and immutability (T091–T100)
  section('Hash and seal vectors, byte-for-byte readback, corruption detection, immutability')
  check(
    'T091',
    'Golden vectors',
    unitRun.ok && /ℹ pass 10/.test(unitRun.output) && /ℹ fail 0/.test(unitRun.output) && /3b536af22db9f3e8f4c76d4404a5413c510075b00a6445751ce4967aeb2f615b/.test(committedCode(MANIFEST_UNIT_TEST)) && /a30a418a5e4dbbaa391609e2986723fe56e7429dde84567475edb71517d2eb4b/.test(committedCode(MANIFEST_UNIT_TEST)),
    'the committed manifest digest and seal vectors (verified independently in PostgreSQL when frozen) still hold',
  )
  const sealOf = (row: { payloadSha256: string; claimId: string; draftAssessmentId: string; approvalReviewEventId: string; pricingRunId: string }, manifestSha256: string) =>
    sha256Of(Buffer.concat([Buffer.from('SBN-A6-SUBMISSION-1\n', 'utf8'), Buffer.from(row.payloadSha256, 'hex'), Buffer.from(manifestSha256, 'hex'), uuid16(row.claimId), uuid16(row.draftAssessmentId), uuid16(row.approvalReviewEventId), uuid16(row.pricingRunId)]))
  const dbSeals = await prisma.$queryRaw<{ id: string; seal: string; stored: string }[]>`
    SELECT f.id::text AS id, m.package_seal_sha256 AS stored, encode(sha256(convert_to('SBN-A6-SUBMISSION-1' || chr(10), 'UTF8') || decode(f.payload_sha256, 'hex') || decode(m.manifest_sha256, 'hex')
      || uuid_send(f.claim_id) || uuid_send(f.draft_assessment_id) || uuid_send(f.approval_review_event_id) || uuid_send(f.pricing_run_id)), 'hex') AS seal
    FROM claim_freezes f JOIN claim_freeze_evidence_manifests m ON m.claim_submission_id = f.id WHERE f.id IN (${dW.submissionId}::uuid, ${fR.body.submissionId}::uuid)`
  const rowR = await prisma.claimFreeze.findUniqueOrThrow({ where: { id: fR.body.submissionId }, include: { evidenceManifest: true } })
  check(
    'T092',
    'Seal recomputation',
    dbSeals.length === 2 &&
      dbSeals.every((row) => row.seal === row.stored) &&
      sealOf(rowW, rowW.evidenceManifest!.manifestSha256) === rowW.evidenceManifest!.packageSealSha256 &&
      sealOf(rowR, rowR.evidenceManifest!.manifestSha256) === rowR.evidenceManifest!.packageSealSha256,
    'the harness (its own byte concatenation) and PostgreSQL recompute exactly the stored seal for the worked and rich examples',
  )
  const dbManifestDigest = (await prisma.$queryRaw<{ h: string }[]>`SELECT encode(sha256(manifest_bytes), 'hex') AS h FROM claim_freeze_evidence_manifests WHERE claim_submission_id = ${dW.submissionId}::uuid`)[0].h
  const manifestBytesW = Buffer.from(rowW.evidenceManifest!.manifestBytes)
  check(
    'T093',
    'Manifest digest',
    sha256Of(manifestBytesW) === rowW.evidenceManifest!.manifestSha256 && dbManifestDigest === rowW.evidenceManifest!.manifestSha256 && encodeEvidenceManifest(JSON.parse(manifestBytesW.toString('utf8'))).text === manifestBytesW.toString('utf8'),
    'SHA-256 of the stored manifest bytes (harness and PostgreSQL) is the stored digest; the bytes are already canonical (re-encoding is identical)',
  )
  const readback = await prisma.$transaction((tx) => getFrozenSubmission(W.claimId, dW.submissionId, tx))
  const readbackOther = await prisma.$transaction((tx) => getFrozenSubmission(X.claimId, dW.submissionId, tx))
  check(
    'T094',
    'Byte-for-byte readback',
    readback !== null && Buffer.compare(readback.canonicalPayloadBytes, bytesW) === 0 && Buffer.compare(readback.manifestBytes, manifestBytesW) === 0 && same(readback.submission, dW) && readbackOther === null,
    'the transaction-aware read returns exactly the frozen payload and manifest bytes; under another Claim it returns nothing',
  )
  let corruption = 'NOT_RUN'
  await attemptAdversarial(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica')
      await tx.$executeRawUnsafe(`UPDATE claim_freezes SET canonical_payload_bytes = canonical_payload_bytes || '\\x20'::bytea WHERE id = $1::uuid`, dW.submissionId)
      corruption = await attemptAdversarial(() => getFrozenSubmission(W.claimId, dW.submissionId, tx))
      throw new Error(NOT_REFUSED)
    }),
  )
  check('T095', 'Corruption detection', /do not match their stored digests/.test(corruption), 'bytes altered behind the guards (written and rolled back) are detected on read and never returned')
  check('T097', 'One digest everywhere', dW.payloadSha256 === (auditW[0].afterState as any).payloadSha256 && JSON.parse(manifestBytesW.toString('utf8')).payloadSha256 === dW.payloadSha256, 'the DTO, the audit and the manifest carry the same payload digest')
  const manifestW = JSON.parse(manifestBytesW.toString('utf8'))
  check(
    'T098',
    'Manifest identity',
    manifestW.claimId === rowW.claimId && manifestW.draftAssessmentId === rowW.draftAssessmentId && manifestW.approvalReviewEventId === rowW.approvalReviewEventId && manifestW.pricingRunId === rowW.pricingRunId && manifestW.entries.length === rowW.evidenceManifest!.entryCount,
    'the manifest names exactly the freeze identity and declares exactly its entry count',
  )
  const manifestApiW = await api('GET', `/api/claim-submissions/${dW.submissionId}/evidence-manifest`)
  check(
    'T099',
    'Manifest read',
    manifestApiW.status === 200 && same(manifestApiW.body.manifest, manifestW) && manifestApiW.body.manifestSha256 === rowW.evidenceManifest!.manifestSha256 && same(manifestApiW.body.manifest.entries, rowW.evidenceManifest!.entries.map((e) => ({ ordinal: e.ordinal, referenceKind: e.referenceKind, referenceId: e.referenceId, referenceVersionId: e.referenceVersionId, contentHash: e.contentHash, evidenceRole: e.evidenceRole }))),
    'the Admin manifest read is the stored manifest exactly, and equals the stored entry rows',
  )
  const getW = await api('GET', `/api/claim-submissions/${dW.submissionId}`)
  const listW = await api('GET', freezePath(W.claimId))
  check('T100', 'Reads equal the freeze', same(getW.body, dW) && listW.body.items.length === 1 && same(listW.body.items[0], dW), 'the metadata read and the history return exactly the frozen response')

  // ---------------------------------------------------------------- phase boundaries (T101–T110)
  section('No lifecycle, SENT, XML/X12/HIE, transport or A6.8/A9/A7 leakage')
  const freezeColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('claim_freezes', 'claim_freeze_evidence_manifests', 'claim_freeze_evidence_entries')`).map((row) => row.c)
  check('T101', 'No lifecycle column', freezeColumns.length === 30 && !freezeColumns.some((column) => /(^|[._])(status|state|sent|sent_at|acknowledg\w*|ack|external\w*|payer_claim\w*|submitted_at|lifecycle\w*|retry\w*|attempt\w*)($|_)/i.test(column)), `${freezeColumns.length} columns: no status, SENT, acknowledgement, external identifier or submittedAt`)
  check('T102', 'No XML, X12 or HIE', !/<\?xml|xmlbuilder|fast-xml|ISA\*|GS\*|MSH\||fhir|hl7/i.test(productionA67.code), 'no XML, X12/EDI, HL7 or FHIR construction in A6.7 code')
  check('T103', 'No outbound call', !/from 'node:(http|https|net|tls|dgram)'|fetch\(|axios|undici|XMLHttpRequest/.test(productionA67.code), 'A6.7 code imports no network client and makes no outbound call')
  const repositoryCode = committedCode(`${SUBMISSION_DIR}/claim-submission.repository.ts`)
  const insertTargets = [...repositoryCode.matchAll(/INSERT INTO "([a-z_]+)"/g)].map((match) => match[1]).sort()
  check(
    'T104',
    'Writes only the freeze',
    same(insertTargets, ['claim_freeze_evidence_entries', 'claim_freeze_evidence_manifests', 'claim_freezes']) &&
      !/\b(tx|db|prisma)\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(productionA67.code) &&
      !/\bUPDATE "|DELETE FROM/.test(productionA67.code),
    'the only writes are the three append-only inserts (and the shared audit); no Claim or owner row is updated',
  )
  const schemaDiff = gitArgs(['diff', 'origin/main...HEAD', '--', ':/backend/prisma/schema.prisma']).split(/\r?\n/)
  const schemaRemoved = schemaDiff.filter((line) => /^-[^-]/.test(line))
  const schemaModels = schemaDiff.filter((line) => /^\+model /.test(line)).map((line) => line.replace(/^\+model (\w+).*/, '$1'))
  check(
    'T105',
    'Additive schema only',
    schemaRemoved.length === 0 && same(schemaModels, ['ClaimFreeze', 'ClaimFreezeEvidenceManifest', 'ClaimFreezeEvidenceEntry']),
    'the schema diff adds exactly the three models and their back-relations; no existing field (and no Claim status) changes',
  )
  check('T106', 'Correction ownership', !freezeColumns.some((column) => /supersed|resubmi|correct|successor|predecessor|parent_submission/i.test(column)) && secondC.status === 201, 'no successor or supersede link: a correction is simply a new, independent freeze (A6.9 owns the relationship)')
  const laterDirs = git('ls-tree -d --name-only --full-tree HEAD backend/src/modules/').split(/\r?\n/).filter((dir) => /lifecycle|transport|outbox|remittance|dhpo|eclaimlink|adapter/i.test(dir))
  check('T107', 'No A6.8/A9/A7 code', laterDirs.length === 0 && laterA6Code.length === 0, 'no lifecycle, transport, outbox, adapter or remittance module exists')
  check('T108', 'No transport routes', absent.every((res) => res.status === 404), 'send, transmit, retry, status, raw payload and every mutation route answer 404')
  const queueTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(outbox|queue|job|transmission|acknowledg|remittance|submission_event)'`).map((row) => row.t)
  const freezeTables = (await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'claim_freeze%' ORDER BY table_name`).map((row) => row.t)
  check('T109', 'No queue or job table', queueTables.length === 0 && same(freezeTables, ['claim_freeze_evidence_entries', 'claim_freeze_evidence_manifests', 'claim_freezes']), 'exactly the three freeze tables; no outbox, queue, job, transmission or acknowledgement table')
  const before110 = await counts()
  const preview110 = await post(`/api/claims/${P.claimId}/canonical-payload/preview`, P.body)
  check('T110', 'A6.6 stays read-only', preview110.status === 200 && same(delta(before110, await counts()), Object.fromEntries(Object.keys(before110).map((name) => [name, 0]))), 'the A6.6 preview still composes and writes nothing; only the A6.7 POST freezes')

  // ---------------------------------------------------------------- regressions (T111–T120)
  section('Regressions — A6.6 invoked, nesting A6.5 -> A6.4 -> A6.3 -> A6.2 -> A6.1 -> A5.10 -> A1')
  await apiReady('the A6.6 and backward regression chain')
  const chain = run('npm run test:a6:canonical-payload')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chain.output, 'A6.6')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A6.6] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A6.6 asserts facts about its own branch, its own (absent) migration, its own diff and its own upstream.
  // On A6.7 those statements are obsolete by design; every other A6.6 check is substantive. T120 below
  // proves each cause from its detail, never from the id alone.
  const a66NonApplicable: Record<string, string> = {
    T001: "A6.6 'Start gate' requires the A6.6 feature branch and no A6.7+ code; A6.7 is branched from the main that contains A6.6 and adds the claim-submission module",
    T004: "A6.6 'No migration or business table' judges its own branch, which added none; A6.7 adds exactly one migration and its schema models (T004/T105 here)",
    T006: "A6.6 'Migration replay' pins the applied count to main's; A6.7 adds one migration, so the count is main's plus one (T006 here proves the replay)",
    T009: "A6.6 'Old contracts preserved' also requires no migration on its branch; contracts and owners are re-proved by T009 here",
    T010: "A6.6 'Diff scope' lists the paths A6.6 was allowed to change and refuses any submission path; A6.7 legitimately changes different ones (T010 here)",
    T120: "A6.6 'Exact head, repeatability, no leakage' requires the upstream to be the A6.6 feature branch, deleted when it merged (exact head and repeatability are T130 here)",
  }
  const undocumented = failing.filter((id) => !(id in a66NonApplicable))
  const summary = chain.output.match(/\[A6\.6\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = summary ? Number(summary[2]) - Number(summary[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T120') && !/\[A6\.6\] RUN ABORTED|\[A6\.6\] uncaught error/.test(chain.output)
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  const lineOf = (id: string) => rows.find((row) => row.id === id)?.line ?? ''
  check(
    'T111',
    'A6.6 regression',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A6.6 suite did not complete'
      : !reconciled
        ? `A6.6 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A6.6 failures: ${undocumented.join(', ')}`
          : `${(chain.output.match(/\[A6\.6\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A6.6] automated summary: ', 'A6.6 ')}; all ${failedCount} failure(s) named and accounted for`,
  )
  for (const id of Object.keys(a66NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T111/${id}`, `A6.6 ${titleOf(row.line)}`, a66NonApplicable[id])
  }
  if (!ran || !reconciled || undocumented.length > 0)
    for (const text of chain.output.split(/\r?\n/).filter((l) => / \.{3,} FAIL|RUN ABORTED|uncaught error|INVALID RUN/.test(l))) console.log(`[A6.7]      ${text.slice(0, 400)}`)
  check('T112', 'A6.5 regression', verdictOf('T111') === 'PASS', `A6.6 T111 (A6.5 with its own justified N/A) ${verdictOf('T111')}`)
  check('T113', 'A6.4 regression', verdictOf('T112') === 'PASS', `A6.6 T112 (A6.4) ${verdictOf('T112')}`)
  check('T114', 'A6.3 regression', verdictOf('T113') === 'PASS', `A6.6 T113 (A6.3) ${verdictOf('T113')}`)
  check('T115', 'A6.2 regression', verdictOf('T114') === 'PASS', `A6.6 T114 (A6.2) ${verdictOf('T114')}`)
  check('T116', 'A6.1 regression', verdictOf('T115') === 'PASS', `A6.6 T115 (A6.1) ${verdictOf('T115')}`)
  check('T117', 'A5 and A1–A4 regression', verdictOf('T116') === 'PASS', `A6.6 T116 (A5.8–A5.10 and A1–A4 through A6.5) ${verdictOf('T116')}`)
  const a66Substantive = rows.filter((row) => !(row.id in a66NonApplicable) && row.verdict !== 'PASS' && !row.id.includes('/'))
  check('T118', 'A6.6 substantive checks', ran && a66Substantive.length === 0 && rows.filter((row) => row.verdict === 'PASS').length >= 110, `${rows.filter((row) => row.verdict === 'PASS').length} A6.6 checks PASS, including its own composer, vectors, races and fail-closed cases; no substantive FAIL`)
  check('T119', 'A6.6 build and DB truth', verdictOf('T117') === 'PASS' && verdictOf('T118') === 'PASS' && verdictOf('T119') === 'PASS', `A6.6 T117 (units/typecheck) ${verdictOf('T117')}, T118 (frontend/replay) ${verdictOf('T118')}, T119 (DB health truth) ${verdictOf('T119')}`)
  // Each documented A6.6 failure must fail for its branch-only reason, proved from its own detail.
  const a66Migrations = (lineOf('T006').match(/(\d+) migrations applied cleanly from empty — exactly main's (\d+)/) ?? []).slice(1).map(Number)
  const a66Unexpected = (lineOf('T010').match(/unexpected: (.*)$/) ?? ['', ''])[1].split(', ').filter(Boolean)
  // A6.6 truncates its detail, so the last listed path may be cut short: it must still begin a changed path.
  const isA67Change = (file: string, index: number) => changedPaths.includes(file) || (index === a66Unexpected.length - 1 && changedPaths.some((path) => path.startsWith(file)))
  const causes: Record<string, boolean> = {
    T001: git('ls-tree -r --name-only --full-tree HEAD').split(/\r?\n/).filter((file) => /claim-submission|submission-freeze|evidence-package|claim-transport|claim-lifecycle|dhpo|eclaimlink/i.test(file)).every((file) => file.startsWith(`${SUBMISSION_DIR}/`) || file.startsWith(`${FE_SUBMISSION_DIR}/`) || file.startsWith(`${HARNESS_DIR}/`)),
    T004: same(migrationStatus, [`A\t${MIGRATION}`]),
    T006: a66Migrations.length === 2 && a66Migrations[0] === a66Migrations[1] + 1,
    T009: ownerChanged.length === 0 && /A6-PAYLOAD-1 unchanged|no A5\/A6\.1–A6\.5 owner changed/.test(lineOf('T009')),
    T010: a66Unexpected.length > 0 && a66Unexpected.every(isA67Change) && outOfScope.length === 0,
    T120: /origin\/feature\/a6-7-immutable-claim-submission-evidence/.test(lineOf('T120')),
  }
  const unproven = failing.filter((id) => id in causes && !causes[id])
  check('T120', 'Nested N/A causes proven', ran && unproven.length === 0, unproven.length === 0 ? `each documented A6.6 failure (${failing.join(', ') || 'none'}) fails only for its branch-only reason, proved from its own detail` : `cause not proven for: ${unproven.join(', ')}`)

  // ---------------------------------------------------------------- builds, replay and DB truth (T121–T130)
  section('Units, typecheck, frontend, Prisma/replay, DB outage recovery, exact head')
  const allUnit = run('npm run test:unit')
  check('T121', 'Unit tests', allUnit.ok && /ℹ fail 0/.test(allUnit.output), `${(allUnit.output.match(/ℹ pass \d+/) ?? ['unit output unavailable'])[0]}, including the A6.7 manifest, seal and request tests`)
  const typecheck = run('npm run typecheck')
  check('T122', 'Typecheck', typecheck.ok, 'backend typecheck clean')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Frontend lint', lint.ok, 'frontend lint clean')
  const build = run('npm run build --prefix ../frontend')
  check('T124', 'Frontend build', build.ok, `${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}`)
  const appliedChecksum = (await prisma.$queryRaw<{ checksum: string }[]>`SELECT checksum FROM _prisma_migrations WHERE migration_name = '20261017090000_a6_7_immutable_claim_submission_evidence' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0]?.checksum
  const fileChecksum = sha256Of(readFileSync(`../${MIGRATION}`))
  check('T125', 'Prisma and replay', replay.ok && status.ok && appliedChecksum === fileChecksum, `the A6.7 migration is applied with the checksum of the committed file (${fileChecksum.slice(0, 12)}…); replay clean`)
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
  check('T126', 'DB outage recovery', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')
  await waitFor(databaseUp, 60_000)
  const afterOutage = await api('GET', `/api/claim-submissions/${dW.submissionId}`)
  const readbackAfter = await prisma.$transaction((tx) => getFrozenSubmission(W.claimId, dW.submissionId, tx))
  check('T096', 'Immutable to the end', (await rowHash(dW.submissionId)) === hashWAtFreeze && readbackAfter !== null && Buffer.compare(readbackAfter.canonicalPayloadBytes, bytesW) === 0, 'after every later test and a database restart the worked freeze, its package and entries are byte-identical')
  check('T127', 'No unexpected 5xx', serverErrors === 0 && afterOutage.status === 200, `${serverErrors} HTTP 5xx answers in this run; the frozen record reads back after the restart`)
  // This run freezes W, S (re-approved), R, Cr, D, E2, F, X, C (twice) and G: eleven freezes, nothing else.
  const runClaims = new Set([W, S, R, Cr, D, E2, F, X, C, G].map((subject) => subject.claimId))
  const runFreezes = await prisma.claimFreeze.findMany({ where: { createdAt: { gte: rowW.createdAt } }, select: { claimId: true } })
  check('T128', 'Synthetic data only', runFreezes.length === 11 && runFreezes.every((row) => runClaims.has(row.claimId)), `${runFreezes.length} freezes in this run, every one of a synthetic Claim built by this run (names keyed by ${runId})`)
  console.log(`[A6.7]      worked example: Claim ${W.claimId}, assessment ${W.assessment.id}, approval ${W.approvalId} -> submission ${dW.submissionId}`)
  console.log(`[A6.7]      A6-PAYLOAD-1 ${dW.payloadByteLength} bytes, SHA-256 ${dW.payloadSha256}; manifest ${dW.evidencePackage.entryCount} entries, SHA-256 ${dW.evidencePackage.manifestSha256}; seal ${dW.evidencePackage.packageSealSha256}`)
  console.log(`[A6.7]      rich example: Claim ${R.claimId} -> submission ${fR.body.submissionId}, ${entriesR.length} references (${KIND_ORDER.length} kinds), artifact SHA-256 ${ARTIFACT_HASH}`)
  check(
    'T129',
    'Frozen example evidence',
    sealOf(rowW, dW.evidencePackage.manifestSha256) === dW.evidencePackage.packageSealSha256 && sha256Of(bytesW) === dW.payloadSha256 && sha256Of(manifestBytesW) === dW.evidencePackage.manifestSha256,
    'the printed worked example (lineage, payload bytes and SHA-256, manifest entries and seal) is recomputed from the stored bytes',
  )

  // ---------------------------------------------------------------- diff scope and exact head (T010, T130)
  section('Diff scope and exact head')
  check(
    'T010',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && ownerChanged.length === 0 && laterDomain.length === 0,
    outOfScope.length + ownerChanged.length + laterDomain.length === 0
      ? `${changedPaths.length} path(s): the A6.7 modules, migration and models, harness and check page, three permissions, five error codes, one audit action and wiring; no owner changed; no A6.8+ domain`
      : `unexpected: ${[...outOfScope, ...ownerChanged, ...laterDomain].join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T130',
    'Exact head, repeatability, evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a67Branch}`) && !/ahead|behind/.test(tracking) && afterOutage.status === 200 && same(afterOutage.body, dW),
    `all evidence corresponds to ${headSha}; ${tracking}; fresh runId ${runId}; after the database restart the worked freeze reads back identically`,
  )

  console.log(`\n[A6.7] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A6.7] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A6.7] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A6.7] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A6.7] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A6.7] IMMUTABLE CLAIM SUBMISSION / EVIDENCE PACKAGE ACCEPTANCE COMPLETE' : '[A6.7] A6.7 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A6.7] RUN ABORTED: ${error.message}`)
      console.log('[A6.7] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A6.7] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A6.7] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
