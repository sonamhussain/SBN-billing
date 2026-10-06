import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { apiFixtures } from '../a3-governance/a3-governance.fixtures.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { executePreClaimValidation } from '../../modules/pre-claim-validation/pre-claim-validation.service.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'
import { recordReadinessAssessment } from '../../modules/pre-claim-readiness/pre-claim-readiness.service.ts'

// A5.10 — cumulative acceptance and phase closure for the A5 Pre-Claim Lifecycle (T001–T140).
//
// One synthetic UAE (Dubai) facility and regulatory profile carries every scenario through the whole
// owner graph: A4 Encounter context -> A5.1 evidence -> A5.2 eligibility -> A5.3/A5.4 authorization ->
// A5.5 commercial context -> A5.6 evidence completeness -> A5.8 validation recorded through A5.7 ->
// A5.9 readiness -> PreClaimA6HandoffV1. Every decision is the owner's: this runner creates fixtures
// through owner routes, calls owner endpoints and compares observable results. It copies no owner
// algorithm, adds no schema, route, permission or audit vocabulary, and adds no US behaviour.
//
// Internal owner functions are used only where the behaviour is internal by design (the A5.7 recorder,
// forced-failure probes). Direct database writes are adversarial only: to create a state no owner path
// can create, or to prove something refuses them. Every value is synthetic.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.10] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.10] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.10] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.10] ${title}`)
const progress = (text: string) => console.log(`[A5.10]      ${text}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
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
  const files = dirs.flatMap((dir) => committedFiles(dir)).filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `A510-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A5.9 FINAL PASS was merged into main as PR #63. The first A5.10 self-test then exposed the A5.6
// completeness read-snapshot bound, corrected by PR #64 and merged before A5.10 was recreated. The first
// official run then showed A5.9 T44/T88 tied to the A5.9 branch diff; PR #65 judges them on the live
// catalog and was merged into this branch (a merge, never a rebase).
const a59Merge = 'e9b9159'
const a56Correction = '9028911'
const a59HarnessCorrection = 'c4751f7'
const a510Branch = 'feature/a5-10-a5-integration-acceptance'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const FRESH_UNTIL = '2030-12-31T00:00:00.000Z'
const STALE_UNTIL = '2026-06-20T00:00:00.000Z'
const DOC = 'DOCUMENTATION_REQUIREMENT_EFFECT'
const REPORT = `SYNTHETIC_REPORT_${Date.now().toString(36).toUpperCase()}`
const HARNESS_DIR = 'backend/src/integration/a5-phase-closure'
const UAE_JURISDICTION = 'AE-DU'
const UAE_AUTHORITY = 'DHA'
// The A5 owner modules, backend and frontend, whose committed production code the privacy scans judge.
const A5_BACKEND = ['evidence-artifact', 'eligibility-verification', 'prior-authorization', 'authorization-line', 'pre-claim-commercial-context', 'evidence-requirement', 'encounter-evidence', 'validation-run', 'pre-claim-validation', 'pre-claim-readiness'].map((m) => `backend/src/modules/${m}`)
const A5_FRONTEND = ['evidence-artifact', 'eligibility-verification', 'prior-authorization', 'authorization-line', 'pre-claim-commercial-context', 'evidence-completeness', 'validation-run', 'pre-claim-validation', 'pre-claim-readiness'].map((m) => `frontend/src/modules/${m}`)

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

function failAt(probe: string, message: string) {
  clearConcurrencyProbes()
  setConcurrencyProbe(probe, async () => {
    throw new Error(message)
  })
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sortedSet = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => typeof id === 'string'))].sort()

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

type StoredFinding = Awaited<ReturnType<typeof findingsOf>>[number]
async function findingsOf(validationRunId: string) {
  return prisma.validationFinding.findMany({
    where: { validationRunId },
    orderBy: { sequence: 'asc' },
    include: { ruleProvenance: true, supportingBindings: true, matchedApplicabilities: true, consumedDatasetVersions: true },
  })
}
const has = (findings: StoredFinding[], code: string, where: (f: StoredFinding) => boolean = () => true) => findings.some((f) => f.findingCode === code && where(f))
const outcomeOf = (findings: StoredFinding[], code: string) => findings.find((f) => f.findingCode === code)?.outcome ?? null

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A5.10] A5 integration acceptance & phase closure — run ${runId}`)
  console.log(`[A5.10] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  const priorRunsAtStart = await prisma.validationRun.count({ where: { createdAt: { lt: runStartedAt } } })
  const priorAssessmentsAtStart = await prisma.preClaimReadinessAssessment.count({ where: { createdAt: { lt: runStartedAt } } })

  // ---------------------------------------------------------------- gates (T001–T010)
  section('Start gate, schema lock and harness wiring')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T001',
    'Start gate',
    branch === a510Branch && gitOk(`merge-base --is-ancestor ${a59Merge} origin/main`) && gitOk(`merge-base --is-ancestor ${a56Correction} origin/main`) && gitOk(`merge-base --is-ancestor ${a59HarnessCorrection} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the A5.9 merge ${a59Merge} (PR #63), the A5.6 correction ${a56Correction} (PR #64) and the A5.9 harness correction ${a59HarnessCorrection} (PR #65) are on main, and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T002', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)
  check('T003', 'A5.9 ancestry', gitOk(`merge-base --is-ancestor ${a59Merge} HEAD`), `the exact A5.9 merge ${a59Merge} is an ancestor of HEAD`)
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const schemaChanged = changedPaths.filter((p) => p.startsWith('backend/prisma/'))
  check('T004', 'No A5.10 schema', !changedPaths.includes('backend/prisma/schema.prisma'), 'schema.prisma is unchanged against main')
  check('T005', 'No A5.10 migration', !changedPaths.some((p) => p.startsWith('backend/prisma/migrations/')), schemaChanged.length === 0 ? 'no migration folder or file against main' : `changed: ${schemaChanged.join(', ')}`)
  const productionChanged = changedPaths.filter((p) => /^(backend\/src\/(modules|shared|app\.ts|server\.ts)|frontend\/src\/)/.test(p))
  check('T006', 'No new production route', productionChanged.length === 0 && !changedPaths.some((p) => /\.route\.ts$/.test(p)), 'the diff touches no route, module, app wiring or frontend file')
  check(
    'T007',
    'No new permission',
    !changedPaths.some((p) => /authorization\.types\.ts$|bootstrap-authz-dev\.ts$|audit\.types\.ts$|error\.types\.ts$/.test(p)),
    'no permission, audit or error vocabulary is added',
  )
  const packageJson = JSON.parse(git('show HEAD:backend/package.json') || '{}') as { scripts?: Record<string, string> }
  const scripts = packageJson.scripts ?? {}
  check(
    'T008',
    'Harness script',
    scripts['test:a5:integration'] === 'node --env-file=.env src/integration/a5-phase-closure/a5-phase-closure.integration.ts',
    'test:a5:integration resolves to this one cumulative runner',
  )
  check('T009', 'Synthetic run identity', /^A510-\d+$/.test(runId), `fresh runId ${runId}; every fixture is keyed by it and no global count is assumed`)
  // §15: the owner suites are read from the merged package.json, never copied. The A5.9 suite is the
  // head of the chain: it invokes A5.8, which invokes A5.7, and so on down to A1.
  const ownerScripts = ['test:a5:evidence', 'test:a5:eligibility', 'test:a5:authorization', 'test:a5:authorization-lines', 'test:a5:commercial-context', 'test:a5:evidence-completeness', 'test:a5:validation-foundation', 'test:a5:pre-claim-validation', 'test:a5:readiness']
  const harnessCode = committedCode(`${HARNESS_DIR}/a5-phase-closure.integration.ts`)
  check(
    'T010',
    'Owner suite discovery',
    ownerScripts.every((name) => typeof scripts[name] === 'string' && scripts[name].includes('src/integration/')) && /run\('npm run test:a5:readiness'\)/.test(harnessCode),
    `all nine A5.1–A5.9 owner scripts exist in the merged package.json; the A5.9 suite (which nests A5.8 → A1) is invoked, not reimplemented`,
  )

  // ---------------------------------------------------------------- fixtures and scenarios
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
  const ownerWrites: { what: string; status: number }[] = []
  const post = async (path: string, body: unknown, who = asAdmin) => {
    const res = await httpCall(path, who({ method: 'POST', body: JSON.stringify(body) }))
    if (who === asAdmin) ownerWrites.push({ what: path.replace(/[0-9a-f-]{36}/g, ':id'), status: res.status })
    return res
  }
  const patchApi = (path: string, body: unknown, who = asAdmin) => httpCall(path, who({ method: 'PATCH', body: JSON.stringify(body) }))
  const send = (method: string, path: string, who = asAdmin) => httpCall(path, who({ method, body: '{}' }))
  const get = (path: string, who = asAdmin) => httpCall(path, who())
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const fx = apiFixtures(baseUrl, admin.cookie, org, runId)
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  let serial = 0
  const key = (prefix: string) => `${runId}-${prefix}-${++serial}`

  section('Synthetic UAE fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const newFacility = async (label: string) => {
    const facility = must(`${label} facility`, (await post(`/api/organizations/${org}/facilities`, { name: `${runId} ${label}` })).body)
    const profile = must(`${label} profile`, (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: UAE_JURISDICTION, regulatoryAuthorityCode: UAE_AUTHORITY, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error(`fixture ${label} profile activation failed`)
    const clinician = must(`${label} clinician`, (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} ${label} clinician` })).body)
    const assignment = must(`${label} assignment`, (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    return { facility, profile, clinician, assignment }
  }
  const site = await newFacility('dubai')
  const svcA = must('service A', (await post(`/api/organizations/${org}/services`, { internalCode: key('SA'), displayName: 'Synthetic service A' })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: 'Synthetic service B' })).body)
  const dxA = must('diagnosis A', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DXA'), displayName: 'Synthetic diagnosis A' })).body)
  const governing = await fx.verifiedSource('closure governing', { activateOn: '2025-01-01' })
  const supportingSource = await fx.verifiedSource('closure supporting', { activateOn: '2025-01-01' })
  const evidenceArtifact = async (documentType: string, sourceDate: string | null) => {
    const artifact = must('evidence', (await post(`/api/organizations/${org}/evidence-artifacts`, { storageRef: `synthetic://evidence/${key('E')}`, contentHash: 'f'.repeat(64), documentType, sourceDate, receivedAt: '2026-06-15T09:30:00.000Z' })).body) as any
    return { artifactId: artifact.id as string, versionId: artifact.latestVersion.id as string, storageRef: artifact.latestVersion.storageRef as string }
  }
  const responseEvidence = await evidenceArtifact('SYNTHETIC_RESPONSE', '2026-06-10')
  const requestEvidence = await evidenceArtifact('SYNTHETIC_REQUEST', '2026-06-05')

  type Commercial = 'one' | 'none' | 'two' | 'unverified' | 'twoVersions' | 'indeterminate'
  const memberIdentifiers: string[] = []
  const world = async (label: string, commercial: Commercial = 'one', where = site) => {
    const payer = must(`${label} payer`, (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} ${label} payer` })).body)
    const memberIdentifier = `MEM-${key('M')}`
    memberIdentifiers.push(memberIdentifier)
    const membership = must(`${label} membership`, (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier, coverageFrom: '2025-01-01', coverageTo: null })).body)
    const contract = async () => {
      const c = must(`${label} contract`, (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
      must(`${label} contract facility`, (await post(`/api/provider-contracts/${c.id}/contract-facilities`, { facilityId: where.facility.id })).body)
      const schedule = must(`${label} schedule`, (await post(`/api/provider-contracts/${c.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
      return { contract: c, schedule }
    }
    const version = async (scheduleId: string, effectiveFrom: string | null, verify = true) => {
      const v = must(`${label} tariff version`, (await post(`/api/tariff-schedules/${scheduleId}/versions`, { version: key('V'), effectiveFrom, effectiveTo: null })).body)
      if (verify && (await post(`/api/tariff-schedule-versions/${v.id}/verification`, { verificationStatus: 'VERIFIED' })).status !== 200) throw new Error(`fixture ${label} tariff verification failed`)
      return v
    }
    let resolved: { contractId: string; scheduleId: string; versionId: string } | null = null
    if (commercial !== 'none') {
      const first = await contract()
      if (commercial === 'one' || commercial === 'two') {
        const v = await version(first.schedule.id, '2026-01-01')
        resolved = { contractId: first.contract.id, scheduleId: first.schedule.id, versionId: v.id }
      }
      if (commercial === 'two') await version((await contract()).schedule.id, '2026-01-01')
      if (commercial === 'unverified') await version(first.schedule.id, '2026-01-01', false)
      if (commercial === 'twoVersions') {
        await version(first.schedule.id, '2026-01-01')
        await version(first.schedule.id, '2026-02-01')
      }
      if (commercial === 'indeterminate') await version(first.schedule.id, null)
    }
    const encounter = async (member: 'm1' | 'none' = 'm1') =>
      must(`${label} encounter`, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: where.facility.id, clinicianId: where.clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: member === 'none' ? null : membership.id })).body) as { id: string }
    return { payer, membership, memberIdentifier, encounter, resolved }
  }
  const activity = async (encounterId: string, overrides: Record<string, unknown> = {}) =>
    must('activity', (await post(`/api/encounters/${encounterId}/activities`, { serviceId: svcA.id, quantity: '1', ...overrides })).body)
  const diagnosis = async (encounterId: string) => must('diagnosis', (await post(`/api/encounters/${encounterId}/diagnoses`, { diagnosisCodeId: dxA.id })).body)
  const eligibility = async (encounterId: string, overrides: Record<string, unknown> = {}) =>
    must(
      'eligibility',
      (await post(`/api/encounters/${encounterId}/eligibility-verifications`, {
        verificationMethod: 'PORTAL', status: 'ELIGIBLE', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z', validThrough: FRESH_UNTIL, authorizationRequired: false, referralRequired: null,
        requestEvidenceVersionId: null, responseEvidenceVersionId: responseEvidence.versionId, ...overrides,
      })).body,
    )
  const line = (overrides: Record<string, unknown> = {}) => ({ serviceId: svcA.id, procedureCodeId: null, diagnosisCodeId: null, requestedQty: '1', approvedQty: '1', unitCode: null, approvedFrom: null, approvedThrough: null, status: 'APPROVED', ...overrides })
  const authorizationReferences: string[] = []
  const respond = async (authorizationId: string, header: { status: string; validFrom?: string | null; validThrough?: string | null; kind?: string }, lines: unknown[]) => {
    const authorizationReference = `AUTH-${key('R')}`
    authorizationReferences.push(authorizationReference)
    const version = must(`${header.status} version`, (await post(`/api/prior-authorizations/${authorizationId}/versions`, {
      versionKind: header.kind ?? 'RESPONSE', status: header.status, authorizationReference, eligibilityVerificationId: null,
      requestedAt: null, respondedAt: '2026-06-10T09:00:00.000Z', validFrom: header.validFrom ?? null, validThrough: header.validThrough ?? null,
      evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: responseEvidence.versionId }],
    })).body)
    const captured = lines.length > 0 ? ((await post(`/api/prior-authorization-versions/${version.id}/authorization-lines`, { lines })).body as any) : { items: [] }
    if (lines.length > 0 && !captured?.items) throw new Error(`fixture authorization lines could not be captured: ${JSON.stringify(captured).slice(0, 200)}`)
    return { versionId: version.id as string, lineIds: ((captured.items ?? []) as { id: string }[]).map((row) => row.id) }
  }
  const authorizationCase = async (encounterId: string, header: { status: string; validFrom?: string | null; validThrough?: string | null }, lines: unknown[]) => {
    const created = must('prior authorization', (await post(`/api/encounters/${encounterId}/prior-authorizations`, {
      versionKind: 'INITIAL', status: 'REQUESTED', authorizationReference: null, eligibilityVerificationId: null, requestedAt: null, respondedAt: null, validFrom: null, validThrough: null,
      evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: requestEvidence.versionId }],
    })).body) as any
    const response = await respond(created.id, header, lines)
    return { authorizationId: created.id as string, initialVersionId: created.latestRecordedVersion.id as string, ...response }
  }
  type Payload = { documentTypes: string[]; minimumCount: number; sourceDateRequired: boolean; maxSourceAgeDays: number | null }
  const STANDARD: Payload = { documentTypes: [REPORT], minimumCount: 1, sourceDateRequired: true, maxSourceAgeDays: 30 }
  const docRule = async (payerId: string, payload: Payload | null, options: { verify?: boolean; rule?: { id: string }; label?: string; supporting?: boolean; effectType?: string } = {}) => {
    const rule = options.rule ?? (await fx.ruleDefinition('closure documentation'))
    const version = await fx.draftRuleVersion(rule.id, options.label ?? '1', { effectType: options.effectType ?? DOC })
    const applicability = await fx.applicability(version.id, { payerId })
    const binding = await fx.bind(version.id, governing.interpretation.id)
    const supporting = options.supporting ? await fx.bind(version.id, supportingSource.interpretation.id, 'SUPPORTING') : null
    if (payload) {
      const created = await post(`/api/rule-versions/${version.id}/evidence-requirement`, payload)
      if (created.status !== 201) throw new Error(`fixture requirement returned ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`)
    }
    if (options.verify !== false) await fx.verifyRuleVersion(version.id)
    return { rule, version, applicability, binding, supporting }
  }
  const linkEvidence = async (encounterId: string, versionId: string) => {
    const res = await post(`/api/encounters/${encounterId}/evidence-links`, { evidenceArtifactVersionId: versionId })
    if (res.status !== 201) throw new Error('fixture evidence link failed')
    return (res.body as any).id as string
  }

  // The full lifecycle, as an Admin: A5.8 execute -> A5.9 assess -> A6 handoff. Every step is the owner.
  const executeHttp = async (encounterId: string, body?: unknown, who = asAdmin) => {
    const res = await httpCall(`/api/encounters/${encounterId}/pre-claim-validation/execute`, who(body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) }))
    return { status: res.status, body: res.body as any }
  }
  const assessHttp = async (validationRunId: string, body?: unknown, who = asAdmin) => {
    const res = await httpCall(`/api/validation-runs/${validationRunId}/readiness-assessments`, who(body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) }))
    return { status: res.status, body: res.body as any }
  }
  const handoffHttp = async (assessmentId: string, who = asAdmin) => {
    const res = await get(`/api/pre-claim-readiness-assessments/${assessmentId}/a6-handoff`, who)
    return { status: res.status, body: res.body as any }
  }
  const errorCode = (body: any) => body?.error?.code as string | undefined
  const createdRunIds: string[] = []
  const createdAssessmentIds: string[] = []
  const executions: number[] = []
  type Chain = { label: string; encounterId: string; status: number; runId: string; run: Awaited<ReturnType<typeof prisma.validationRun.findUniqueOrThrow>>; findings: StoredFinding[]; assessment: any; handoff: { status: number; body: any } }
  const chain = async (label: string, encounterId: string): Promise<Chain> => {
    const started = Date.now()
    const exec = await executeHttp(encounterId, {})
    executions.push(Date.now() - started)
    if (exec.status !== 201) throw new Error(`the ${label} execution was refused with ${exec.status}: ${JSON.stringify(exec.body).slice(0, 200)}`)
    const validationRunId = exec.body.validationRunId as string
    createdRunIds.push(validationRunId)
    const assessed = await assessHttp(validationRunId, {})
    if (assessed.status !== 201) throw new Error(`the ${label} assessment was refused with ${assessed.status}: ${JSON.stringify(assessed.body).slice(0, 200)}`)
    createdAssessmentIds.push(assessed.body.id)
    const handoff = await handoffHttp(assessed.body.id)
    return { label, encounterId, status: exec.status, runId: validationRunId, run: await prisma.validationRun.findUniqueOrThrow({ where: { id: validationRunId } }), findings: await findingsOf(validationRunId), assessment: assessed.body, handoff }
  }
  const notReady = (c: Chain, state: string) => c.assessment.state === state && c.handoff.status === 409 && errorCode(c.handoff.body) === 'PRECLAIM_NOT_READY_FOR_HANDOFF'

  // ---- X01: the complete UAE ready chain
  const happyWorld = await world('happy')
  const happyRule = await docRule(happyWorld.payer.id, STANDARD, { supporting: true })
  // A VERIFIED rule with a raw non-documentation effect for the same payer: it must never execute.
  const otherEffect = await docRule(happyWorld.payer.id, null, { effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT' })
  const happyEncounter = await happyWorld.encounter()
  const happyActivity = await activity(happyEncounter.id)
  const happyDiagnosis = await diagnosis(happyEncounter.id)
  must('observation', (await post(`/api/encounters/${happyEncounter.id}/observations`, { encounterActivityId: happyActivity.id, factKey: `SYNTHETIC_FACT_${serial}`, value: { type: 'TEXT', text: 'Synthetic observation' } })).body)
  const report = await evidenceArtifact(REPORT, '2026-06-01')
  const happyLink = await linkEvidence(happyEncounter.id, report.versionId)
  const happyEligibility = await eligibility(happyEncounter.id, { authorizationRequired: true })
  const happyAuth = await authorizationCase(happyEncounter.id, { status: 'APPROVED', validFrom: '2026-06-01', validThrough: '2026-06-30' }, [line()])
  const happy = await chain('happy', happyEncounter.id)
  progress(`X01 happy chain: run ${happy.runId}, assessment ${happy.assessment.id} (${happy.assessment.state}), handoff ${happy.handoff.status}`)

  // Owner reads of the same graph, captured before anything newer exists.
  const artifactRead = await get(`/api/evidence-artifacts/${report.artifactId}`)
  const versionRead = await get(`/api/evidence-artifact-versions/${report.versionId}`)
  const eligibilityRead = await get(`/api/eligibility-verifications/${happyEligibility.id}`)
  const authorizationRead = await get(`/api/prior-authorizations/${happyAuth.authorizationId}`)
  const authorizationVersionsRead = await get(`/api/prior-authorizations/${happyAuth.authorizationId}/versions`)
  const linesRead = await get(`/api/prior-authorization-versions/${happyAuth.versionId}/authorization-lines`)
  const scopeRead = await get(`/api/prior-authorization-versions/${happyAuth.versionId}/scope-evaluation`)
  const commercialRead = await get(`/api/encounters/${happyEncounter.id}/pre-claim-commercial-context`)
  const completenessRead = await post(`/api/encounters/${happyEncounter.id}/evidence-completeness/evaluate`, {})
  const happyHandoffAgain = await handoffHttp(happy.assessment.id)
  const happyAssessmentRead = await get(`/api/pre-claim-readiness-assessments/${happy.assessment.id}`)

  // ---- coverage, commercial and evidence scenarios, each on an Encounter of its own
  const basic = await world('basic')
  const readyBasic = async (label: string) => {
    const encounter = await basic.encounter()
    await activity(encounter.id)
    await diagnosis(encounter.id)
    await eligibility(encounter.id)
    return encounter
  }
  const noAuth = await chain('authorization not required', (await readyBasic('no auth')).id)
  const noMembership = await chain('no membership', (await basic.encounter('none')).id)
  const membershipOnlyEncounter = await basic.encounter()
  await activity(membershipOnlyEncounter.id)
  const membershipOnly = await chain('membership without eligibility', membershipOnlyEncounter.id)
  const eligibilityScenario = async (label: string, setup: (id: string) => Promise<unknown>) => {
    const encounter = await basic.encounter()
    await activity(encounter.id)
    await setup(encounter.id)
    return chain(label, encounter.id)
  }
  const ineligible = await eligibilityScenario('ineligible', (id) => eligibility(id, { status: 'INELIGIBLE' }))
  const stale = await eligibilityScenario('stale eligibility', (id) => eligibility(id, { validThrough: STALE_UNTIL }))
  const unknownFreshness = await eligibilityScenario('unknown freshness', (id) => eligibility(id, { validThrough: null }))
  const ambiguousEligibility = await eligibilityScenario('ambiguous eligibility', async (id) => {
    await eligibility(id, { status: 'ELIGIBLE' })
    await eligibility(id, { status: 'INELIGIBLE', respondedAt: '2026-06-15T10:31:00.000Z' })
  })
  progress('coverage eligibility scenarios recorded')

  const authWorld = await world('authorization')
  const authEncounter = async () => {
    const encounter = await authWorld.encounter()
    await eligibility(encounter.id, { authorizationRequired: true })
    return encounter
  }
  const missingAuthEncounter = await authEncounter()
  await activity(missingAuthEncounter.id)
  const missingAuth = await chain('authorization missing', missingAuthEncounter.id)
  const partialEncounter = await authEncounter()
  const partialA = await activity(partialEncounter.id, { serviceId: svcA.id })
  const partialB = await activity(partialEncounter.id, { serviceId: svcB.id })
  await authorizationCase(partialEncounter.id, { status: 'APPROVED' }, [line({ serviceId: svcA.id })])
  const partial = await chain('authorization partial', partialEncounter.id)
  const ambiguousAuthEncounter = await authEncounter()
  const ambiguousAuthActivity = await activity(ambiguousAuthEncounter.id)
  await authorizationCase(ambiguousAuthEncounter.id, { status: 'APPROVED' }, [line()])
  await authorizationCase(ambiguousAuthEncounter.id, { status: 'APPROVED' }, [line()])
  const ambiguousAuth = await chain('authorization ambiguous', ambiguousAuthEncounter.id)
  // X12 + T076: an approved case, then a DENIED amendment. The older READY assessment cannot bypass it.
  const amendEncounter = await authEncounter()
  const amendActivity = await activity(amendEncounter.id)
  const amendCase = await authorizationCase(amendEncounter.id, { status: 'APPROVED' }, [line()])
  const amendBefore = await chain('authorization before amendment', amendEncounter.id)
  const amendHistoryBefore = JSON.stringify({
    versions: await prisma.priorAuthorizationVersion.findMany({ where: { priorAuthorizationId: amendCase.authorizationId }, orderBy: { version: 'asc' } }),
    lines: await prisma.authorizationLine.findMany({ where: { priorAuthorizationVersionId: amendCase.versionId }, orderBy: { sequence: 'asc' } }),
  })
  const denied = await respond(amendCase.authorizationId, { status: 'DENIED', kind: 'AMENDMENT' }, [line()])
  const amendAfter = await chain('authorization after amendment', amendEncounter.id)
  const amendHistoryAfter = JSON.stringify({
    versions: await prisma.priorAuthorizationVersion.findMany({ where: { priorAuthorizationId: amendCase.authorizationId, id: { in: [amendCase.initialVersionId, amendCase.versionId] } }, orderBy: { version: 'asc' } }),
    lines: await prisma.authorizationLine.findMany({ where: { priorAuthorizationVersionId: amendCase.versionId }, orderBy: { sequence: 'asc' } }),
  })
  const amendOldHandoff = await handoffHttp(amendBefore.assessment.id)
  progress('coverage authorization scenarios recorded')

  const contractScenario = async (commercial: Commercial) => {
    const w = await world(`contract ${commercial}`, commercial)
    const encounter = await w.encounter()
    await eligibility(encounter.id)
    return chain(`contract ${commercial}`, encounter.id)
  }
  const noContract = await contractScenario('none')
  const ambiguousContract = await contractScenario('two')
  const noTariff = await contractScenario('unverified')
  const ambiguousTariff = await contractScenario('twoVersions')
  const indeterminateTariff = await contractScenario('indeterminate')
  progress('commercial scenarios recorded')

  const govWorld = await world('governed')
  await docRule(govWorld.payer.id, STANDARD)
  const govEncounter = async () => {
    const encounter = await govWorld.encounter()
    await eligibility(encounter.id)
    return encounter
  }
  const evidenceMissing = await chain('evidence missing', (await govEncounter()).id)
  const staleEvidenceEncounter = await govEncounter()
  const staleReport = await evidenceArtifact(REPORT, '2026-01-01')
  await linkEvidence(staleEvidenceEncounter.id, staleReport.versionId)
  const evidenceStale = await chain('evidence stale', staleEvidenceEncounter.id)
  const minWorld = await world('evidence minimum')
  await docRule(minWorld.payer.id, { ...STANDARD, minimumCount: 2 })
  const minEncounter = await minWorld.encounter()
  await eligibility(minEncounter.id)
  await linkEvidence(minEncounter.id, (await evidenceArtifact(REPORT, '2026-06-01')).versionId)
  const evidenceIncomplete = await chain('evidence incomplete', minEncounter.id)
  const blockedWorld = await world('evidence blocked')
  const blockedRule = await fx.ruleDefinition('closure blocked')
  await docRule(blockedWorld.payer.id, STANDARD, { rule: blockedRule, label: '1' })
  await docRule(blockedWorld.payer.id, STANDARD, { rule: blockedRule, label: '2' })
  const blockedEncounter = await blockedWorld.encounter()
  await eligibility(blockedEncounter.id)
  const evidenceBlocked = await chain('evidence resolution blocked', blockedEncounter.id)
  // A VERIFIED documentation rule without its payload cannot be made through the owner route; the
  // verification flag is set directly so the configuration failure itself can be observed.
  const legacyWorld = await world('evidence configuration')
  const legacy = await docRule(legacyWorld.payer.id, null, { verify: false })
  await prisma.$executeRawUnsafe("UPDATE rule_versions SET verification_status = 'VERIFIED', verified_at = now() WHERE id = $1::uuid", legacy.version.id)
  const legacyEncounter = await legacyWorld.encounter()
  await eligibility(legacyEncounter.id)
  const evidenceConfig = await chain('evidence configuration incomplete', legacyEncounter.id)
  progress('evidence scenarios recorded')

  // ---- TECHNICAL contradictions on a site of their own
  const integritySite = await newFacility('integrity')
  const driftWorld = await world('coverage drift', 'one', integritySite)
  const driftEncounter = await driftWorld.encounter()
  await patchApi(`/api/insurance-memberships/${driftWorld.membership.id}`, { coverageTo: '2026-05-31' })
  const coverageDrift = await chain('coverage drift', driftEncounter.id)
  const assignmentWorld = await world('assignment drift', 'one', integritySite)
  const assignmentEncounter = await assignmentWorld.encounter()
  await post(`/api/clinician-facility-assignments/${integritySite.assignment.id}/close`, { effectiveTo: '2026-06-14' })
  must('covering assignment', (await post(`/api/clinicians/${integritySite.clinician.id}/facility-assignments`, { facilityId: integritySite.facility.id, effectiveFrom: '2026-06-15', effectiveTo: null })).body)
  const assignmentDrift = await chain('assignment drift', assignmentEncounter.id)
  progress('technical scenarios recorded')

  // ---- X31: a correction chain. A stale verification, then a fresh one; nothing earlier is touched.
  const correctionEncounter = await basic.encounter()
  await activity(correctionEncounter.id)
  const staleVerification = await eligibility(correctionEncounter.id, { validThrough: STALE_UNTIL })
  const correctionBefore = await chain('before correction', correctionEncounter.id)
  const correctionHistoryBefore = JSON.stringify({
    run: correctionBefore.run,
    findings: correctionBefore.findings,
    assessment: await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: correctionBefore.assessment.id } }),
    verification: await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: staleVerification.id } }),
  })
  await eligibility(correctionEncounter.id)
  const correctionAfter = await chain('after correction', correctionEncounter.id)
  const correctionHistoryAfter = JSON.stringify({
    run: await prisma.validationRun.findUniqueOrThrow({ where: { id: correctionBefore.runId } }),
    findings: await findingsOf(correctionBefore.runId),
    assessment: await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: correctionBefore.assessment.id } }),
    verification: await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: staleVerification.id } }),
  })
  const correctionOldHandoff = await handoffHttp(correctionBefore.assessment.id)
  progress('correction chain recorded')

  // ---- evidence history: a newer version of the happy report leaves the linked version untouched
  const versionRowBefore = JSON.stringify(await prisma.evidenceArtifactVersion.findUniqueOrThrow({ where: { id: report.versionId } }))
  const newerVersion = must('newer evidence version', (await post(`/api/evidence-artifacts/${report.artifactId}/versions`, { storageRef: `synthetic://evidence/${key('E2')}`, contentHash: 'a'.repeat(64), documentType: REPORT, sourceDate: '2026-06-02', receivedAt: '2026-06-15T10:30:00.000Z' })).body)
  const versionRowAfter = JSON.stringify(await prisma.evidenceArtifactVersion.findUniqueOrThrow({ where: { id: report.versionId } }))
  const oldVersionRead = await get(`/api/evidence-artifact-versions/${report.versionId}`)

  // ---- recency: two runs at one instant cannot come from an owner path, so the second is a copy of a
  // real run (same evaluation time, creation time offset by `createdOffset`) with one finding, in one
  // transaction.
  const copyRunAt = async (sourceRunId: string, createdOffset: string, outcome: string) => {
    const newRunId = (await prisma.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid()::text AS id`)[0].id
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO validation_runs (id, encounter_id, service_date, facility_id, facility_regulatory_profile_id, insurance_membership_id, payer_id, tpa_id, network_id, insurance_product_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at)
         SELECT $1::uuid, encounter_id, service_date, facility_id, facility_regulatory_profile_id, insurance_membership_id, payer_id, tpa_id, network_id, insurance_product_id, provider_contract_id, tariff_schedule_id, tariff_schedule_version_id, validator_version, evaluated_at, created_by_user_id, created_at + $3::interval
         FROM validation_runs WHERE id = $2::uuid`,
        newRunId,
        sourceRunId,
        createdOffset,
      )
      await tx.$executeRawUnsafe(
        `INSERT INTO validation_findings (id, validation_run_id, sequence, layer, outcome, finding_code, message) VALUES (gen_random_uuid(), $1::uuid, 1, 'TECHNICAL', $2, 'SYNTHETIC_COPY', 'Synthetic copy.')`,
        newRunId,
        outcome,
      )
    })
    return newRunId
  }
  const laterCreated = await chain('recency created-at', (await readyBasic('created-at')).id)
  await copyRunAt(laterCreated.runId, '1 millisecond', 'PASS')
  const laterCreatedHandoff = await handoffHttp(laterCreated.assessment.id)
  const tie = await chain('recency tie', (await readyBasic('tie')).id)
  const tieCopy = await copyRunAt(tie.runId, '0 seconds', 'FAIL')
  const tieCopyAssessed = await assessHttp(tieCopy, {})
  if (tieCopyAssessed.status === 201) createdAssessmentIds.push(tieCopyAssessed.body.id)
  const tieHandoff = await handoffHttp(tie.assessment.id)
  const tieCopyHandoff = tieCopyAssessed.status === 201 ? await handoffHttp(tieCopyAssessed.body.id) : null

  // ---- X28 and T072: a WARNING-only run and an incompatible validator, through A5.7's internal recorder
  const recorded = async (encounterId: string, outcomes: string[], validatorVersion = 'A5-VAL-1') => {
    const stored = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, select: { facilityId: true, facilityRegulatoryProfileId: true } })
    const result = await prisma.$transaction(async (tx) =>
      recordValidationRunInTransaction(
        {
          encounterId,
          contextSnapshot: { serviceDate: SERVICE_DATE, facilityId: stored.facilityId, facilityRegulatoryProfileId: stored.facilityRegulatoryProfileId, insuranceMembershipId: null, payerId: null, tpaId: null, networkId: null, insuranceProductId: null, providerContractId: null, tariffScheduleId: null, tariffScheduleVersionId: null },
          validatorVersion,
          findings: outcomes.map((outcome) => ({ layer: 'TECHNICAL', outcome, findingCode: `SYNTHETIC_${outcome}`, message: 'Synthetic finding.' })),
        },
        actorUserId,
        tx,
      ),
    )
    if (!result.ok) throw new Error(`a valid synthetic run was refused by the A5.7 recorder: ${result.message}`)
    return result.value.id
  }
  const warningRun = await recorded((await basic.encounter()).id, ['PASS', 'WARNING', 'WARNING'])
  const warningAssessed = await assessHttp(warningRun, {})
  if (warningAssessed.status === 201) createdAssessmentIds.push(warningAssessed.body.id)
  const incompatibleRun = await recorded((await basic.encounter()).id, ['PASS'], 'A5-VAL-2')
  const incompatibleAssessed = await assessHttp(incompatibleRun, {})

  // ---- T074/T077: a READY Encounter is validated again and the newer run is assessed READY too; the
  // older READY assessment can no longer hand off, the newer one can.
  const noAuthAgain = await chain('authorization not required, revalidated', noAuth.encounterId)
  const noAuthOldHandoff = await handoffHttp(noAuth.assessment.id)

  // ---- T075: the happy Encounter is validated again; its older READY assessment can no longer hand off
  const happyRerun = await executeHttp(happyEncounter.id, {})
  if (happyRerun.status === 201) createdRunIds.push(happyRerun.body.validationRunId)
  const happyAfterRerun = await handoffHttp(happy.assessment.id)
  const avgSeconds = Math.round(executions.reduce((a, b) => a + b, 0) / Math.max(1, executions.length) / 100) / 10
  progress(`all scenarios recorded: ${createdRunIds.length} validation runs (average execution ${avgSeconds} s), ${createdAssessmentIds.length} readiness assessments`)

  // ---------------------------------------------------------------- happy path (T011–T030)
  section('Cumulative UAE happy path — A4.9 -> A5.1 ... A5.9 -> A6 handoff')
  const versionBody = versionRead.body as any
  check('T011', 'A5.1 evidence version', artifactRead.status === 200 && versionRead.status === 200 && versionBody?.id === report.versionId && versionBody?.version === 1, 'the synthetic artifact and its immutable version 1 are read back through the owner')
  const eligibilityBody = eligibilityRead.body as any
  check(
    'T012',
    'A5.2 fresh eligibility',
    eligibilityRead.status === 200 && eligibilityBody?.status === 'ELIGIBLE' && eligibilityBody?.freshness?.state === 'FRESH' && eligibilityBody?.responseEvidenceVersionId === responseEvidence.versionId && eligibilityBody?.insuranceMembershipId === happyWorld.membership.id && eligibilityBody?.serviceDate === SERVICE_DATE,
    'ELIGIBLE and FRESH under the exact membership and service date, backed by the exact response evidence version',
  )
  check(
    'T013',
    'Membership != eligibility',
    has(membershipOnly.findings, 'COVERAGE_ELIGIBILITY_MISSING') && !has(membershipOnly.findings, 'COVERAGE_ELIGIBILITY_ELIGIBLE') && membershipOnly.assessment.state !== 'READY_FOR_REVIEW' && membershipOnly.handoff.status === 409,
    `an active membership with no verification is COVERAGE_ELIGIBILITY_MISSING and ${membershipOnly.assessment.state}; registration is never coverage`,
  )
  const versionsBody = (authorizationVersionsRead.body as any)?.items as any[] | undefined
  check(
    'T014',
    'A5.3 authorization case',
    authorizationRead.status === 200 && (authorizationRead.body as any)?.id === happyAuth.authorizationId && Array.isArray(versionsBody) && same(versionsBody.map((v) => v.id), [happyAuth.initialVersionId, happyAuth.versionId]),
    'one stable case with its INITIAL and APPROVED immutable versions in order',
  )
  const linesBody = (linesRead.body as any)?.items as any[] | undefined
  check('T015', 'A5.4 authorization lines', linesRead.status === 200 && Array.isArray(linesBody) && same(linesBody.map((l) => l.id), happyAuth.lineIds) && linesBody.every((l) => l.priorAuthorizationVersionId === happyAuth.versionId), 'the complete line set belongs to that exact version')
  const scopeActivities = (scopeRead.body as any)?.activities as any[] | undefined
  check(
    'T016',
    'A5.4 scope match',
    scopeRead.status === 200 && scopeActivities?.find((a) => a.encounterActivityId === happyActivity.id)?.outcome === 'MATCHED' && has(happy.findings, 'COVERAGE_AUTHORIZATION_SCOPE_MATCHED', (f) => f.encounterActivityId === happyActivity.id && f.authorizationLineId === happyAuth.lineIds[0]),
    'the A5.4 owner evaluation and the A5.8 finding both scope the intended activity to the exact line',
  )
  const commercialBody = commercialRead.body as any
  check('T017', 'A5.5 contract', commercialRead.status === 200 && commercialBody?.providerContractId === happyWorld.resolved?.contractId && happy.run.providerContractId === happyWorld.resolved?.contractId, 'exactly one ProviderContract, the same in the owner read and in the run context')
  check(
    'T018',
    'A5.5 tariff',
    commercialBody?.tariffScheduleVersionId === happyWorld.resolved?.versionId && happy.run.tariffScheduleVersionId === happyWorld.resolved?.versionId && happy.run.tariffScheduleId === happyWorld.resolved?.scheduleId,
    'exactly one VERIFIED TariffScheduleVersion for the service date',
  )
  const requirements = ((completenessRead.body as any)?.requirements ?? []) as any[]
  const happyRequirement = requirements.find((r) => r.ruleVersionId === happyRule.version.id)
  check('T019', 'A5.6 governed requirement', completenessRead.status === 200 && happyRequirement !== undefined && happyRequirement.provenance?.governingBindingId === happyRule.binding.id, `the applicable requirement resolves through the A3 owner path with its governing binding (evaluate ${completenessRead.status}${completenessRead.status === 200 ? '' : ` ${errorCode(completenessRead.body) ?? ''}`})`)
  check('T020', 'A5.6 completeness', happyRequirement?.state === 'SATISFIED' && happyRequirement?.validCount >= 1, `SATISFIED with ${happyRequirement?.validCount ?? 0} valid evidence version(s)`)
  check('T021', 'A5.7 run persistence', happy.status === 201 && happy.run.validatorVersion === 'A5-VAL-1' && happy.findings.length > 0, `one complete immutable A5-VAL-1 run with ${happy.findings.length} findings`)
  check('T022', 'A5.7 findings', happy.findings.every((f, i) => f.sequence === i + 1), 'findings are contiguous 1..N in validator order')
  check('T023', 'A5.8 technical', outcomeOf(happy.findings, 'TECHNICAL_CONTEXT_VALID') === 'PASS', 'TECHNICAL_CONTEXT_VALID / PASS')
  check(
    'T024',
    'A5.8 coding',
    ['CODING_DIAGNOSIS_INVARIANTS_PASS', 'CODING_ACTIVITY_INVARIANTS_PASS', 'CODING_OBSERVATION_INVARIANTS_PASS'].every((code) => outcomeOf(happy.findings, code) === 'PASS'),
    'the A4.5/A4.6/A4.7 owner invariants each PASS',
  )
  check(
    'T025',
    'A5.8 coverage',
    has(happy.findings, 'COVERAGE_ELIGIBILITY_ELIGIBLE', (f) => f.eligibilityVerificationId === happyEligibility.id && f.outcome === 'PASS') && has(happy.findings, 'COVERAGE_AUTHORIZATION_ACTIVITY_SATISFIED', (f) => f.encounterActivityId === happyActivity.id && f.outcome === 'PASS'),
    'the exact fresh verification and the satisfied activity authorization',
  )
  const pricingKeys = (value: unknown) => [...deepKeys(value)].filter((k) => /(price|rate|fee|amount|allowed|reimburs|responsib|copay|deductible)/i.test(k))
  check('T026', 'A5.8 contract', outcomeOf(happy.findings, 'CONTRACT_CONTEXT_RESOLVED') === 'PASS' && pricingKeys(happy.handoff.body).length === 0, 'CONTRACT_CONTEXT_RESOLVED / PASS; no price anywhere')
  const governedHappy = happy.findings.filter((f) => f.ruleVersionId === happyRule.version.id)
  check('T027', 'A5.8 evidence', governedHappy.length > 0 && governedHappy.every((f) => f.findingCode === 'EVIDENCE_REQUIREMENT_SATISFIED' && f.outcome === 'PASS'), `${governedHappy.length} governed EVIDENCE_REQUIREMENT_SATISFIED finding(s) reflect the A5.6 result`)
  check(
    'T028',
    'A5.8 provenance',
    governedHappy.length > 0 &&
      governedHappy.every(
        (f) =>
          f.ruleProvenance?.provenanceContractVersion === 'A3-PROV-1' &&
          f.ruleProvenance.governingBindingId === happyRule.binding.id &&
          f.ruleProvenance.governingSourceInterpretationId === governing.interpretation.id &&
          f.governingSourceVersionId === governing.sourceVersion.id &&
          same(f.supportingBindings.map((s) => s.ruleSourceBindingId), [happyRule.supporting!.id]) &&
          same(f.matchedApplicabilities.map((a) => a.ruleApplicabilityId), [happyRule.applicability.id]) &&
          f.ruleProvenance.businessDate.getTime() === happy.run.serviceDate.getTime() &&
          f.ruleProvenance.evaluationTimestamp.getTime() === happy.run.evaluatedAt.getTime(),
      ),
    'A3-PROV-1 with the exact binding, interpretation, source version, supporting binding, applicability, business date and transaction instant',
  )
  check('T029', 'A5.9 readiness', happy.findings.every((f) => f.outcome === 'PASS' || f.outcome === 'WARNING') && happy.assessment.state === 'READY_FOR_REVIEW' && happy.assessment.readinessPolicyVersion === 'A5-READY-1', 'a PASS-only run is an immutable READY_FOR_REVIEW under A5-READY-1')
  check('T030', 'A5.9 handoff', happy.handoff.status === 200 && happy.handoff.body?.schemaVersion === 'PreClaimA6HandoffV1' && happy.handoff.body?.validationRun?.id === happy.runId, `PreClaimA6HandoffV1 for run ${happy.runId}`)

  // ---------------------------------------------------------------- scenarios (T031–T060)
  section('Cross-module scenarios through validation, readiness and handoff')
  check('T031', 'No membership', outcomeOf(noMembership.findings, 'COVERAGE_MEMBERSHIP_MISSING') === 'FAIL' && noMembership.run.insuranceMembershipId === null && notReady(noMembership, 'BLOCKED'), 'COVERAGE_MEMBERSHIP_MISSING / FAIL; no coverage invented; BLOCKED and no handoff')
  check('T032', 'Eligibility INELIGIBLE', outcomeOf(ineligible.findings, 'COVERAGE_ELIGIBILITY_INELIGIBLE') === 'FAIL' && notReady(ineligible, 'BLOCKED'), 'FAIL -> BLOCKED')
  check('T033', 'Eligibility stale', outcomeOf(stale.findings, 'COVERAGE_ELIGIBILITY_STALE') === 'RESTRICT' && notReady(stale, 'RESTRICTED'), 'RESTRICT -> RESTRICTED')
  check('T034', 'Eligibility unknown freshness', outcomeOf(unknownFreshness.findings, 'COVERAGE_ELIGIBILITY_FRESHNESS_UNKNOWN') === 'RESTRICT' && notReady(unknownFreshness, 'RESTRICTED'), 'RESTRICT -> RESTRICTED')
  check(
    'T035',
    'Eligibility ambiguity',
    has(ambiguousEligibility.findings, 'COVERAGE_ELIGIBILITY_AMBIGUOUS', (f) => f.eligibilityVerificationId === null && f.outcome === 'RESTRICT') && notReady(ambiguousEligibility, 'RESTRICTED'),
    'two fresh exact-context verifications stay ambiguous; neither is targeted; RESTRICTED',
  )
  check(
    'T036',
    'Authorization not required',
    outcomeOf(noAuth.findings, 'COVERAGE_AUTHORIZATION_NOT_REQUIRED') === 'PASS' && (await prisma.priorAuthorization.count({ where: { encounterId: noAuth.encounterId } })) === 0 && noAuth.assessment.state === 'READY_FOR_REVIEW' && noAuth.handoff.status === 200,
    'an explicit false needs no case and none is manufactured; READY_FOR_REVIEW',
  )
  check('T037', 'Authorization missing', outcomeOf(missingAuth.findings, 'COVERAGE_AUTHORIZATION_MISSING') === 'FAIL' && notReady(missingAuth, 'BLOCKED'), 'required with no case: FAIL -> BLOCKED')
  const summaryOf = (c: Chain, activityId: string) => c.findings.find((f) => /^COVERAGE_AUTHORIZATION_ACTIVITY_/.test(f.findingCode) && f.encounterActivityId === activityId)
  check(
    'T038',
    'Authorization partial',
    summaryOf(partial, partialA.id)?.findingCode === 'COVERAGE_AUTHORIZATION_ACTIVITY_SATISFIED' && summaryOf(partial, partialB.id)?.findingCode === 'COVERAGE_AUTHORIZATION_ACTIVITY_UNSATISFIED' && notReady(partial, 'BLOCKED'),
    'only the exactly scoped activity is satisfied; the other stays unsatisfied and the run is BLOCKED',
  )
  check('T039', 'Authorization ambiguity', summaryOf(ambiguousAuth, ambiguousAuthActivity.id)?.findingCode === 'COVERAGE_AUTHORIZATION_ACTIVITY_AMBIGUOUS' && summaryOf(ambiguousAuth, ambiguousAuthActivity.id)?.outcome === 'RESTRICT' && notReady(ambiguousAuth, 'RESTRICTED'), 'two matching cases: RESTRICT, no winner; RESTRICTED')
  const amendDetail = amendAfter.findings.filter((f) => f.priorAuthorizationVersionId !== null && f.encounterActivityId === amendActivity.id)
  check(
    'T040',
    'Authorization version chronology',
    amendBefore.assessment.state === 'READY_FOR_REVIEW' && amendDetail.length > 0 && amendDetail.every((f) => f.priorAuthorizationVersionId === denied.versionId) && !amendAfter.findings.some((f) => f.priorAuthorizationVersionId === amendCase.versionId),
    'after the DENIED amendment only the highest version of that case is evaluated; the older APPROVED version is never consulted',
  )
  check('T041', 'No applicable contract', outcomeOf(noContract.findings, 'CONTRACT_NO_APPLICABLE_CONTRACT') === 'FAIL' && noContract.run.providerContractId === null && notReady(noContract, 'BLOCKED'), 'FAIL, no fallback contract; BLOCKED')
  check('T042', 'Ambiguous contract', outcomeOf(ambiguousContract.findings, 'CONTRACT_AMBIGUOUS_CONTRACT') === 'RESTRICT' && ambiguousContract.run.providerContractId === null && notReady(ambiguousContract, 'RESTRICTED'), 'RESTRICT, no ranking; RESTRICTED')
  check('T043', 'No applicable tariff', outcomeOf(noTariff.findings, 'CONTRACT_NO_APPLICABLE_TARIFF_VERSION') === 'FAIL' && notReady(noTariff, 'BLOCKED'), 'FAIL -> BLOCKED')
  check('T044', 'Ambiguous tariff', outcomeOf(ambiguousTariff.findings, 'CONTRACT_AMBIGUOUS_TARIFF_VERSION') === 'RESTRICT' && notReady(ambiguousTariff, 'RESTRICTED'), 'RESTRICT -> RESTRICTED')
  check('T045', 'Indeterminate tariff dates', outcomeOf(indeterminateTariff.findings, 'CONTRACT_INDETERMINATE_TARIFF_DATES') === 'RESTRICT' && notReady(indeterminateTariff, 'RESTRICTED'), 'RESTRICT -> RESTRICTED')
  check('T046', 'Evidence missing', outcomeOf(evidenceMissing.findings, 'EVIDENCE_REQUIREMENT_MISSING') === 'FAIL' && notReady(evidenceMissing, 'BLOCKED'), 'FAIL -> BLOCKED')
  check('T047', 'Evidence incomplete', outcomeOf(evidenceIncomplete.findings, 'EVIDENCE_REQUIREMENT_INCOMPLETE') === 'RESTRICT' && notReady(evidenceIncomplete, 'RESTRICTED'), 'RESTRICT -> RESTRICTED')
  check(
    'T048',
    'Evidence stale',
    has(evidenceStale.findings, 'EVIDENCE_STALE', (f) => f.outcome === 'RESTRICT' && f.evidenceArtifactVersionId === staleReport.versionId) && !evidenceStale.findings.some((f) => f.outcome === 'FAIL') && notReady(evidenceStale, 'RESTRICTED'),
    'the exact stale version is a RESTRICT detail; RESTRICTED',
  )
  check('T049', 'Evidence resolution blocked', outcomeOf(evidenceBlocked.findings, 'EVIDENCE_REQUIREMENT_RESOLUTION_BLOCKED') === 'RESTRICT' && notReady(evidenceBlocked, 'RESTRICTED'), 'two equally specific governed versions stay RESTRICT; no requirement guessed')
  check('T050', 'Evidence config incomplete', outcomeOf(evidenceConfig.findings, 'EVIDENCE_REQUIREMENT_CONFIGURATION_INCOMPLETE') === 'FAIL' && notReady(evidenceConfig, 'BLOCKED'), 'a verified rule without its payload is a visible FAIL -> BLOCKED')
  const technicalOnly = (c: Chain) => c.findings.length === 1 && c.findings[0].findingCode === 'TECHNICAL_CONTEXT_INTEGRITY_FAIL' && c.findings[0].outcome === 'FAIL'
  check('T051', 'Technical contradiction', technicalOnly(coverageDrift) && technicalOnly(assignmentDrift) && notReady(coverageDrift, 'BLOCKED') && notReady(assignmentDrift, 'BLOCKED'), 'coverage and assignment drift each record one TECHNICAL FAIL and nothing dependent; BLOCKED')
  check(
    'T052',
    'No hidden repair',
    assignmentDrift.run.insuranceMembershipId === null && assignmentDrift.run.providerContractId === null && coverageDrift.run.insuranceMembershipId === null,
    'the covering newer assignment and the drifted membership are never substituted into the run context',
  )
  check('T053', 'Deterministic FAIL HTTP', [noMembership, ineligible, missingAuth, noContract, evidenceMissing].every((c) => c.status === 201 && c.findings.some((f) => f.outcome === 'FAIL')), 'every FAIL scenario was a 201 execution with its findings persisted')
  check('T054', 'Deterministic RESTRICT HTTP', [stale, ambiguousEligibility, ambiguousContract, evidenceIncomplete].every((c) => c.status === 201 && c.findings.some((f) => f.outcome === 'RESTRICT') && !c.findings.some((f) => f.outcome === 'FAIL')), 'every RESTRICT scenario was a 201 execution with its findings persisted')
  // T055: forced failures inside the A5.8 transaction and the A5.9 transaction leave nothing behind.
  const rollbackEncounter = await govEncounter()
  const auditsBefore55 = await prisma.auditEvent.count()
  const provenanceBefore55 = await prisma.validationFindingRuleProvenance.count()
  failAt('pre_claim_validation.provenance_inserted', 'forced failure (acceptance)')
  const validationThrew = (await attemptAdversarial(() => executePreClaimValidation(rollbackEncounter.id, {}, actorUserId))) !== ''
  clearConcurrencyProbes()
  const auditsAfterValidation = await prisma.auditEvent.count()
  const rollbackReadinessRun = await recorded((await basic.encounter()).id, ['PASS'])
  const auditsBeforeReadiness = await prisma.auditEvent.count()
  failAt('pre_claim_readiness.recorded', 'forced failure (acceptance)')
  const readinessThrew = (await attemptAdversarial(() => recordReadinessAssessment(rollbackReadinessRun, {}, actorUserId))) !== ''
  clearConcurrencyProbes()
  check(
    'T055',
    'Integrity defect rollback',
    validationThrew && (await prisma.validationRun.count({ where: { encounterId: rollbackEncounter.id } })) === 0 && (await prisma.validationFindingRuleProvenance.count()) === provenanceBefore55 && auditsAfterValidation === auditsBefore55 &&
      readinessThrew && (await prisma.preClaimReadinessAssessment.count({ where: { validationRunId: rollbackReadinessRun } })) === 0 && (await prisma.auditEvent.count()) === auditsBeforeReadiness,
    'a failure after provenance left no run, finding, provenance or audit; a failure after the readiness audit left no assessment or audit',
  )
  check('T056', 'Unsupported effect metadata', !happy.findings.some((f) => f.ruleVersionId === otherEffect.version.id), 'a VERIFIED non-documentation rule for the same payer produced no finding')
  const assessmentReadBody = happyAssessmentRead.body as any
  const allDtos = [happy.handoff.body, assessmentReadBody, happy.assessment]
  check(
    'T057',
    'No payer acceptance',
    allDtos.every((dto) => ![...deepKeys(dto)].some((k) => /payerAccept|accepted|adjudicat/i.test(k))) && !(await prisma.validationRun.findUniqueOrThrow({ where: { id: happy.runId } }) as any).payerAccepted,
    'PASS and READY_FOR_REVIEW carry no payer-acceptance field anywhere',
  )
  const stateCheck = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'pre_claim_readiness_assessments_state_chk'`)[0]?.def ?? ''
  check(
    'T058',
    'No submission authority',
    /READY_FOR_REVIEW/.test(stateCheck) && !/APPROVED_FOR_SUBMISSION|SUBMITTED|APPROVED/.test(stateCheck.replace('READY_FOR_REVIEW', '')) && allDtos.every((dto) => !/APPROVED_FOR_SUBMISSION|approvedForSubmission|submissionAllowed/.test(JSON.stringify(dto))),
    'the readiness vocabulary is READY_FOR_REVIEW/RESTRICTED/BLOCKED only; nothing says approved for submission',
  )
  const a5Tables = ['evidence_artifacts', 'evidence_artifact_versions', 'eligibility_verifications', 'prior_authorizations', 'prior_authorization_versions', 'authorization_lines', 'evidence_requirements', 'encounter_evidence_links', 'validation_runs', 'validation_findings', 'validation_finding_rule_provenances', 'pre_claim_readiness_assessments']
  const a5Columns = (await prisma.$queryRaw<{ c: string }[]>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY(${a5Tables})`).map((row) => row.c)
  check(
    'T059',
    'No pricing',
    a5Columns.length > 50 && !a5Columns.some((c) => /\.(\w*(price|rate|fee|amount|allowed|reimburs|responsibility|copay|deductible)\w*)$/i.test(c)) && allDtos.every((dto) => pricingKeys(dto).length === 0),
    `no rate, fee, amount, allowed or patient-responsibility column across ${a5Columns.length} A5 columns or in any A5 response`,
  )
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  check('T060', 'No Claim', !tables.some((t) => /(^claims?$|claim_lines?|claim_submissions?)/.test(t)) && allDtos.every((dto) => ![...deepKeys(dto)].some((k) => /claim/i.test(k))), 'no Claim, ClaimLine or ClaimSubmission table, row or field')

  // ---------------------------------------------------------------- history and closure (T061–T068)
  section('Historical correction and immutability')
  check('T061', 'Evidence history', newerVersion.id !== report.versionId && versionRowAfter === versionRowBefore && oldVersionRead.status === 200, 'a newer version left the linked version byte-identical and retrievable')
  const correctionVerification = JSON.parse(correctionHistoryAfter).verification
  check('T062', 'Eligibility history', same(JSON.parse(correctionHistoryBefore).verification, correctionVerification), 'a later verification left the earlier stale verification unchanged')
  check('T063', 'Authorization history', amendHistoryBefore === amendHistoryAfter, 'the DENIED amendment left the earlier versions and their lines byte-identical')
  check(
    'T064',
    'Validation history',
    correctionAfter.runId !== correctionBefore.runId && same(JSON.parse(correctionHistoryBefore).run, JSON.parse(correctionHistoryAfter).run) && same(JSON.parse(correctionHistoryBefore).findings, JSON.parse(correctionHistoryAfter).findings),
    'the correction produced a new run; the earlier run, its findings and their provenance are unchanged',
  )
  check(
    'T065',
    'Readiness history',
    correctionBefore.assessment.state === 'RESTRICTED' && correctionAfter.assessment.state === 'READY_FOR_REVIEW' && same(JSON.parse(correctionHistoryBefore).assessment, JSON.parse(correctionHistoryAfter).assessment),
    'RESTRICTED stays RESTRICTED as history; the corrected run has its own READY_FOR_REVIEW assessment',
  )
  const lateFinding = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe(`INSERT INTO validation_findings (id, validation_run_id, sequence, layer, outcome, finding_code, message) VALUES (gen_random_uuid(), $1::uuid, 999, 'TECHNICAL', 'PASS', 'SYNTHETIC_LATE', 'Synthetic late.')`, happy.runId),
  )
  check('T066', 'Finding-set closure', /never added to an earlier run/.test(lateFinding) && (await prisma.validationFinding.count({ where: { validationRunId: happy.runId } })) === happy.findings.length, 'a committed run refused a later finding')
  const systemFinding = happy.findings.find((f) => f.ruleVersionId === null)!
  const lateProvenance = await attemptAdversarial(() =>
    prisma.validationFindingRuleProvenance.create({
      data: { validationFindingId: systemFinding.id, provenanceContractVersion: 'A3-PROV-1', precedencePolicyVersion: 'A3-PREC-1', rulePackVersionId: null, governingBindingId: happyRule.binding.id, governingSourceInterpretationId: governing.interpretation.id, businessDate: new Date(`${SERVICE_DATE}T00:00:00.000Z`), evaluationTimestamp: new Date(), historicalOnly: false },
    }),
  )
  check('T067', 'Provenance closure', /never added later/.test(lateProvenance) && systemFinding.ruleProvenance === null, 'a committed system finding refused later governed provenance')
  const readinessUpdate = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE pre_claim_readiness_assessments SET state = 'READY_FOR_REVIEW' WHERE id = $1::uuid`, noMembership.assessment.id))
  const readinessDelete = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM pre_claim_readiness_assessments WHERE id = $1::uuid`, noMembership.assessment.id))
  const readinessApi = [await send('PATCH', `/api/pre-claim-readiness-assessments/${noMembership.assessment.id}`), await send('DELETE', `/api/pre-claim-readiness-assessments/${noMembership.assessment.id}`)].map((r) => r.status)
  check('T068', 'Readiness immutability', /append-only/.test(readinessUpdate) && /append-only/.test(readinessDelete) && readinessApi.every((s) => s === 404) && (await prisma.preClaimReadinessAssessment.findUniqueOrThrow({ where: { id: noMembership.assessment.id } })).state === 'BLOCKED', `direct UPDATE and DELETE refused; PATCH/DELETE ${readinessApi.join('/')}`)

  // ---------------------------------------------------------------- readiness and handoff (T069–T085)
  section('A5-READY-1 precedence, supersession and the A6 handoff')
  check('T069', 'FAIL precedence', noMembership.findings.some((f) => f.outcome === 'RESTRICT') && noMembership.findings.some((f) => f.outcome === 'PASS') && noMembership.assessment.state === 'BLOCKED', 'FAIL with PASS and RESTRICT beside it is BLOCKED')
  check('T070', 'RESTRICT precedence', !stale.findings.some((f) => f.outcome === 'FAIL') && stale.findings.some((f) => f.outcome === 'RESTRICT') && stale.assessment.state === 'RESTRICTED', 'no FAIL and a RESTRICT is RESTRICTED')
  check('T071', 'Warning-only', warningAssessed.status === 201 && warningAssessed.body?.state === 'READY_FOR_REVIEW' && happy.assessment.state === 'READY_FOR_REVIEW', 'PASS/WARNING-only runs are READY_FOR_REVIEW, never APPROVED_FOR_SUBMISSION')
  check('T072', 'Unknown validator policy', incompatibleAssessed.status === 409 && errorCode(incompatibleAssessed.body) === 'READINESS_POLICY_INCOMPATIBLE' && (await prisma.preClaimReadinessAssessment.count({ where: { validationRunId: incompatibleRun } })) === 0, 'A5-VAL-2 is refused by A5-READY-1')
  const duplicate = await assessHttp(happy.runId, {})
  check('T073', 'Duplicate readiness', duplicate.status === 400 && (await prisma.preClaimReadinessAssessment.count({ where: { validationRunId: happy.runId } })) === 1, 'the same run and policy cannot be assessed twice')
  check(
    'T074',
    'Newer validation supersedes',
    noAuth.assessment.state === 'READY_FOR_REVIEW' && noAuth.handoff.status === 200 && noAuthAgain.assessment.state === 'READY_FOR_REVIEW' && noAuthAgain.handoff.status === 200 &&
      noAuthOldHandoff.status === 409 && errorCode(noAuthOldHandoff.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION',
    `the older READY assessment handed off (${noAuth.handoff.status}) until a newer READY run existed, then ${noAuthOldHandoff.status} ${errorCode(noAuthOldHandoff.body) ?? ''}; the newer one hands off (${noAuthAgain.handoff.status})`,
  )
  check('T075', 'Newer unassessed supersedes', happyRerun.status === 201 && happyAfterRerun.status === 409 && errorCode(happyAfterRerun.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION', 'after a newer unassessed run, the happy READY assessment no longer hands off')
  check('T076', 'Newer blocked supersedes', amendAfter.assessment.state === 'BLOCKED' && amendOldHandoff.status === 409 && errorCode(amendOldHandoff.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION', 'the older READY run cannot bypass the later BLOCKED run')
  check('T077', 'Recency evaluatedAt', noAuthAgain.run.evaluatedAt > noAuth.run.evaluatedAt && noAuthOldHandoff.status === 409 && correctionAfter.run.evaluatedAt > correctionBefore.run.evaluatedAt && correctionOldHandoff.status === 409, 'a later evaluatedAt supersedes the earlier run (and the corrected run supersedes the RESTRICTED one)')
  check('T078', 'Recency createdAt', laterCreated.handoff.status === 200 && laterCreatedHandoff.status === 409 && errorCode(laterCreatedHandoff.body) === 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION', 'at the same evaluatedAt a run created later supersedes')
  check(
    'T079',
    'Recency tie',
    tie.handoff.status === 200 && tieHandoff.status === 409 && errorCode(tieHandoff.body) === 'VALIDATION_RUN_RECENCY_AMBIGUOUS' && tieCopyAssessed.body?.state === 'BLOCKED' && tieCopyHandoff?.status === 409,
    'a run at the identical evaluatedAt and createdAt makes the READY run ambiguous; no UUID or outcome wins',
  )
  check('T080', 'Handoff restricted', stale.handoff.status === 409 && errorCode(stale.handoff.body) === 'PRECLAIM_NOT_READY_FOR_HANDOFF' && !('exactReferences' in (stale.handoff.body ?? {})), 'RESTRICTED -> 409, no contract')
  check('T081', 'Handoff blocked', ineligible.handoff.status === 409 && errorCode(ineligible.handoff.body) === 'PRECLAIM_NOT_READY_FOR_HANDOFF' && !('exactReferences' in (ineligible.handoff.body ?? {})), 'BLOCKED -> 409, no contract')
  const h = happy.handoff.body ?? {}
  const countOf = (outcome: string) => happy.findings.filter((f) => f.outcome === outcome).length
  check(
    'T082',
    'Handoff exact counts',
    same(h.findingSummary, { total: happy.findings.length, pass: countOf('PASS'), warning: countOf('WARNING'), restrict: countOf('RESTRICT'), fail: countOf('FAIL') }) && same(h.findingRefs, happy.findings.map((f) => ({ id: f.id, sequence: f.sequence, layer: f.layer, outcome: f.outcome, findingCode: f.findingCode }))),
    `total ${happy.findings.length}; every finding ref in sequence order`,
  )
  const field = (name: keyof StoredFinding) => sortedSet(happy.findings.map((f) => f[name] as string | null))
  const expectedRefs = {
    encounterActivityIds: field('encounterActivityId'),
    encounterDiagnosisIds: field('encounterDiagnosisId'),
    eligibilityVerificationIds: field('eligibilityVerificationId'),
    priorAuthorizationVersionIds: field('priorAuthorizationVersionId'),
    authorizationLineIds: field('authorizationLineId'),
    evidenceRequirementIds: field('evidenceRequirementId'),
    evidenceArtifactVersionIds: field('evidenceArtifactVersionId'),
    ruleVersionIds: field('ruleVersionId'),
    governingSourceVersionIds: field('governingSourceVersionId'),
    referenceDatasetVersionIds: sortedSet(happy.findings.flatMap((f) => [f.referenceDatasetVersionId, ...f.consumedDatasetVersions.map((d) => d.referenceDatasetVersionId)])),
  }
  check(
    'T083',
    'Handoff exact references',
    same(h.exactReferences, expectedRefs) && same(happyHandoffAgain.body, h) && h.exactReferences.encounterActivityIds.includes(happyActivity.id) && h.exactReferences.encounterDiagnosisIds.includes(happyDiagnosis.id) && h.exactReferences.ruleVersionIds.includes(happyRule.version.id),
    'all ten arrays equal the immutable findings and their A5.8 dataset rows, deduplicated and ascending, identical on a repeated read',
  )
  const handoffText = JSON.stringify(h)
  check(
    'T084',
    'Handoff no sensitive copies',
    ![...deepKeys(h)].some((k) => /^(givenName|familyName|dateOfBirth|memberIdentifier|policyIdentifier|authorizationReference|storageRef|contentHash|documentType|message|fieldPath)$/.test(k)) && !handoffText.includes(`${runId}-P`) && !handoffText.includes(happyWorld.memberIdentifier) && !handoffText.includes(report.storageRef) && !authorizationReferences.some((ref) => handoffText.includes(ref)),
    'no patient or member value, authorization reference, evidence metadata or finding message',
  )
  check('T085', 'Handoff no claim snapshot', ![...deepKeys(h)].some((k) => /(claim|price|amount|approv|submit|hash|payload|transaction)/i.test(k)), 'no Claim id, price, approver, payload hash or transaction identity')

  // ---------------------------------------------------------------- security (T086–T095)
  section('Tenant, permission and input safety')
  const failedWrites = ownerWrites.filter((w) => w.status >= 400 && !/\/close$/.test(w.what))
  check('T086', 'Admin own-org flow', failedWrites.length === 0 && ownerWrites.length > 100, failedWrites.length === 0 ? `${ownerWrites.length} owner writes across A4 and A5.1–A5.9 succeeded` : `refused: ${failedWrites.slice(0, 5).map((w) => `${w.what} ${w.status}`).join(', ')}`)
  const viewerReads = [
    await get(`/api/evidence-artifacts/${report.artifactId}`, asViewer),
    await get(`/api/eligibility-verifications/${happyEligibility.id}`, asViewer),
    await get(`/api/prior-authorizations/${happyAuth.authorizationId}`, asViewer),
    await get(`/api/prior-authorization-versions/${happyAuth.versionId}/authorization-lines`, asViewer),
    await get(`/api/prior-authorization-versions/${happyAuth.versionId}/scope-evaluation`, asViewer),
    await get(`/api/encounters/${happyEncounter.id}/pre-claim-commercial-context`, asViewer),
    await get(`/api/validation-runs/${happy.runId}`, asViewer),
    await get(`/api/encounters/${happyEncounter.id}/pre-claim-readiness-assessments`, asViewer),
    await get(`/api/pre-claim-readiness-assessments/${correctionAfter.assessment.id}/a6-handoff`, asViewer),
  ].map((r) => r.status)
  check('T087', 'Viewer approved reads', viewerReads.every((s) => s === 200), `evidence, eligibility, authorization, lines, scope, commercial, run, readiness and handoff reads: ${viewerReads.join('/')}`)
  const auditsBefore88 = await prisma.auditEvent.count()
  const runsBefore88 = await prisma.validationRun.count({ where: { encounterId: noAuth.encounterId } })
  const viewerExecute = await executeHttp(noAuth.encounterId, {}, asViewer)
  check('T088', 'Viewer validation execute denied', viewerExecute.status === 403 && (await prisma.validationRun.count({ where: { encounterId: noAuth.encounterId } })) === runsBefore88 && (await prisma.auditEvent.count()) === auditsBefore88, '403; no run and no audit')
  const viewerAssess = await assessHttp(warningRun, {}, asViewer)
  const viewerRecorded = await recorded((await basic.encounter()).id, ['PASS'])
  const viewerAssessFresh = await assessHttp(viewerRecorded, {}, asViewer)
  check('T089', 'Viewer readiness evaluate denied', viewerAssess.status === 403 && viewerAssessFresh.status === 403 && (await prisma.preClaimReadinessAssessment.count({ where: { validationRunId: viewerRecorded } })) === 0, '403; no assessment and no audit')
  const leaks = (body: unknown) => /storageRef|contentHash|documentType|memberIdentifier|policyIdentifier|authorizationReference|ELIGIBLE|APPROVED|findingCode|READY_FOR_REVIEW|RESTRICTED|BLOCKED|facilityId|payerId|exactReferences/.test(JSON.stringify(body ?? {}))
  const foreignArtifact = await prisma.evidenceArtifact.findFirst({ where: { organizationId: otherOrg }, select: { id: true, versions: { select: { id: true }, take: 1 } } })
  const foreignArtifactReads = foreignArtifact ? [await get(`/api/evidence-artifacts/${foreignArtifact.id}`), await get(`/api/evidence-artifact-versions/${foreignArtifact.versions[0]?.id ?? MISSING}`)] : []
  check('T090', 'Cross-tenant evidence denial', foreignArtifactReads.length === 2 && foreignArtifactReads.every((r) => r.status === 403 && !leaks(r.body)), foreignArtifact ? `${foreignArtifactReads.map((r) => r.status).join('/')}; no evidence metadata disclosed` : 'no foreign-tenant evidence exists to prove this')
  const foreignVerification = await prisma.eligibilityVerification.findFirst({ where: { encounter: { patient: { organizationId: otherOrg } } }, select: { id: true, encounterId: true } })
  const foreignEligibilityReads = foreignVerification ? [await get(`/api/eligibility-verifications/${foreignVerification.id}`), await get(`/api/encounters/${foreignVerification.encounterId}/eligibility-verifications`)] : []
  check('T091', 'Cross-tenant eligibility denial', foreignEligibilityReads.length === 2 && foreignEligibilityReads.every((r) => r.status === 403 && !leaks(r.body)), foreignVerification ? `${foreignEligibilityReads.map((r) => r.status).join('/')}; no verification or member value disclosed` : 'no foreign-tenant verification exists to prove this')
  const foreignLine = await prisma.authorizationLine.findFirst({ where: { priorAuthorizationVersion: { priorAuthorization: { encounter: { patient: { organizationId: otherOrg } } } } }, select: { id: true, priorAuthorizationVersionId: true, priorAuthorizationVersion: { select: { priorAuthorizationId: true } } } })
  const foreignAuthReads = foreignLine
    ? [await get(`/api/prior-authorizations/${foreignLine.priorAuthorizationVersion.priorAuthorizationId}`), await get(`/api/authorization-lines/${foreignLine.id}`), await get(`/api/prior-authorization-versions/${foreignLine.priorAuthorizationVersionId}/scope-evaluation`)]
    : []
  check('T092', 'Cross-tenant authorization denial', foreignAuthReads.length === 3 && foreignAuthReads.every((r) => r.status === 403 && !leaks(r.body)), foreignLine ? `${foreignAuthReads.map((r) => r.status).join('/')}; no reference or scope disclosed` : 'no foreign-tenant authorization exists to prove this')
  const foreignRun = await prisma.validationRun.findFirst({ where: { encounter: { patient: { organizationId: otherOrg } } }, select: { id: true, encounterId: true } })
  const foreignRunReads = foreignRun
    ? [await get(`/api/validation-runs/${foreignRun.id}`), await get(`/api/validation-runs/${foreignRun.id}/findings`), await executeHttp(foreignRun.encounterId, {})]
    : []
  check('T093', 'Cross-tenant run denial', foreignRunReads.length === 3 && foreignRunReads.every((r) => r.status === 403 && !leaks(r.body)), foreignRun ? `${foreignRunReads.map((r) => r.status).join('/')}; no finding, context or provenance disclosed; no foreign execution` : 'no foreign-tenant run exists to prove this')
  const foreignAssessment = await prisma.preClaimReadinessAssessment.findFirst({ where: { validationRun: { encounter: { patient: { organizationId: otherOrg } } } }, select: { id: true, validationRunId: true } })
  const foreignReadiness = foreignAssessment
    ? [await get(`/api/pre-claim-readiness-assessments/${foreignAssessment.id}`), await handoffHttp(foreignAssessment.id), await assessHttp(foreignAssessment.validationRunId, {})]
    : []
  check('T094', 'Cross-tenant readiness denial', foreignReadiness.length === 3 && foreignReadiness.every((r) => r.status === 403 && !leaks(r.body)), foreignAssessment ? `${foreignReadiness.map((r) => r.status).join('/')}; no state or handoff reference disclosed` : 'no foreign-tenant assessment exists to prove this')
  const malformed = [
    await get('/api/evidence-artifacts/not-a-uuid'),
    await get('/api/eligibility-verifications/not-a-uuid'),
    await get('/api/prior-authorizations/not-a-uuid'),
    await get('/api/prior-authorization-versions/not-a-uuid/scope-evaluation'),
    await get('/api/encounters/not-a-uuid/pre-claim-commercial-context'),
    await httpCall('/api/encounters/not-a-uuid/evidence-completeness/evaluate', asAdmin({ method: 'POST', body: '{}' })),
    await executeHttp('not-a-uuid', {}),
    await assessHttp('not-a-uuid', {}),
    await handoffHttp('not-a-uuid'),
    await executeHttp(happyEncounter.id, { findings: [] }),
    await assessHttp(happy.runId, { state: 'READY_FOR_REVIEW' }),
    await httpCall(`/api/encounters/${happyEncounter.id}/eligibility-verifications`, asAdmin({ method: 'POST', body: '{"status":' })),
    await executeHttp(MISSING, {}),
    await handoffHttp(MISSING),
  ]
  const rawError = (body: unknown) => /prisma|postgres|syntax error|invalid input|uuid_in|stack|SELECT |INSERT /i.test(JSON.stringify(body ?? {}))
  check('T095', 'Malformed input', malformed.every((r) => [400, 404, 409].includes(r.status) && !rawError(r.body)), `safe envelopes ${malformed.map((r) => r.status).join('/')}; no raw database or internal text`)

  // ---------------------------------------------------------------- audit (T096–T100)
  section('Business Audit truth')
  const auditFor = (entityId: string) => prisma.auditEvent.findMany({ where: { entityId }, select: { actionCode: true, entityType: true, afterState: true, beforeState: true } })
  const expectedAudits: [string, string][] = [
    [report.artifactId, 'evidence_artifact.created'],
    [happyEligibility.id, 'eligibility_verification.created'],
    [happyAuth.authorizationId, 'prior_authorization.created'],
    [happyAuth.lineIds[0], 'authorization_line.created'],
    [happyLink, 'encounter_evidence_link.created'],
    [happy.runId, 'validation_run.recorded'],
    [happy.assessment.id, 'pre_claim_readiness.recorded'],
  ]
  const ownerAudit = await Promise.all(expectedAudits.map(async ([id, action]) => (await auditFor(id)).filter((row) => row.actionCode === action).length === 1))
  check('T096', 'Owner audit truth', ownerAudit.every(Boolean), `evidence, eligibility, authorization, line, evidence link, run and readiness each have exactly their one safe event (${ownerAudit.filter(Boolean).length}/${ownerAudit.length})`)
  const runAudits = await prisma.auditEvent.findMany({ where: { entityId: { in: createdRunIds } }, select: { entityId: true, actionCode: true } })
  check('T097', 'Validation audit count', createdRunIds.length >= 25 && createdRunIds.every((id) => runAudits.filter((row) => row.entityId === id && row.actionCode === 'validation_run.recorded').length === 1), `exactly one validation_run.recorded per run across ${createdRunIds.length} executions`)
  const assessmentAudits = await prisma.auditEvent.findMany({ where: { entityId: { in: createdAssessmentIds } }, select: { entityId: true, actionCode: true } })
  check('T098', 'Readiness audit count', createdAssessmentIds.length >= 25 && createdAssessmentIds.every((id) => assessmentAudits.filter((row) => row.entityId === id && row.actionCode === 'pre_claim_readiness.recorded').length === 1), `exactly one pre_claim_readiness.recorded per assessment across ${createdAssessmentIds.length}`)
  const auditsBefore99 = await prisma.auditEvent.count()
  await executeHttp(happyEncounter.id, {}, asViewer)
  await assessHttp(happy.runId, {})
  await assessHttp('not-a-uuid', {})
  await executeHttp(happyEncounter.id, { serviceDate: '2026-01-01' })
  await get(`/api/encounters/${happyEncounter.id}/pre-claim-commercial-context`)
  await post(`/api/encounters/${happyEncounter.id}/evidence-completeness/evaluate`, {})
  await get(`/api/prior-authorization-versions/${happyAuth.versionId}/scope-evaluation`)
  await get(`/api/eligibility-verifications/${happyEligibility.id}`)
  await get(`/api/validation-runs/${happy.runId}/findings`)
  await handoffHttp(correctionAfter.assessment.id)
  check('T099', 'No false audit', (await prisma.auditEvent.count()) === auditsBefore99, 'denied, invalid, duplicate and read-only calls (freshness, scope, commercial, completeness, runs, handoff) wrote no AuditEvent')
  const runAuditText = JSON.stringify(await prisma.auditEvent.findMany({ where: { occurredAt: { gte: runStartedAt } }, select: { afterState: true, beforeState: true } }))
  const runSnapshotKeys = (await prisma.auditEvent.findMany({ where: { entityId: { in: [happy.runId, happy.assessment.id] } }, select: { entityType: true, afterState: true } })).map((row) => `${row.entityType}:${Object.keys((row.afterState ?? {}) as object).sort().join(',')}`).sort()
  check(
    'T100',
    'Audit minimization',
    !memberIdentifiers.some((m) => runAuditText.includes(m)) && !authorizationReferences.some((r) => runAuditText.includes(r)) && !runAuditText.includes('synthetic://evidence') && !runAuditText.includes('f'.repeat(64)) && !/findingCode|SYNTHETIC_FACT|Synthetic observation/.test(runAuditText) &&
      same(runSnapshotKeys, ['PRE_CLAIM_READINESS_ASSESSMENT:assessedAt,createdAt,id,readinessPolicyVersion,state', 'VALIDATION_RUN:createdAt,evaluatedAt,id,validatorVersion']),
    'no member, policy, authorization, evidence storage, clinical or finding content in any audit written by this run; run and readiness snapshots are minimal',
  )

  // ---------------------------------------------------------------- privacy scans (T101–T105)
  section('Logging, browser storage, URL, secret and synthetic-data scans')
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', [...A5_BACKEND, ...A5_FRONTEND].map((d) => `:/${d}`))
  const logReach = gitGrep('requireOrganizationPermission', A5_BACKEND.map((d) => `:/${d}`))
  check('T101', 'Logging scan', logReach.status === 0 && logScan.status === 1, 'no console output in any A5 backend or frontend module (search verified to reach the source)')
  const feCode = committedProductionCodeOf(A5_FRONTEND)
  check('T102', 'Browser storage scan', feCode.files.length >= 9 && feCode.code.includes('fetch(') && !/\b(localStorage|sessionStorage|indexedDB)\b/.test(feCode.code), `no browser storage across ${feCode.files.length} A5 frontend files`)
  const beCode = committedProductionCodeOf(A5_BACKEND)
  check('T103', 'URL scan', beCode.files.length > 40 && beCode.code.includes('requireOrganizationPermission') && !/req\.query/.test(beCode.code) && !/fetch\(`[^`]*\?/.test(feCode.code), 'no A5 route reads, and no A5 page sends, a query string')
  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [`:/${HARNESS_DIR}`, ...A5_BACKEND.map((d) => `:/${d}`), ...A5_FRONTEND.map((d) => `:/${d}`)],
  )
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [`:/${HARNESS_DIR}`])
  check('T104', 'Secret scan', secretReach.status === 0 && secretScan.status === 1, 'no credential, private key or payer secret in the harness or any A5 module; credentials come from the local environment only')
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  check('T105', 'Synthetic-data proof', harnessCode.length > 0 && harnessCode.match(realDataMarkers) === null && /familyName: `\$\{runId\}-P`/.test(harnessCode), 'fixtures are runId-keyed synthetic values; no real patient, member or claim marker')

  // ---------------------------------------------------------------- UAE-preserving guards (T106–T115)
  section('UAE-preserving multi-market guards (no US behaviour added)')
  const happyProfile = await prisma.facilityRegulatoryProfile.findUniqueOrThrow({ where: { id: happy.run.facilityRegulatoryProfileId } })
  check('T106', 'UAE canonical path', happyProfile.jurisdictionCode === UAE_JURISDICTION && happyProfile.regulatoryAuthorityCode === UAE_AUTHORITY && happy.assessment.state === 'READY_FOR_REVIEW' && happy.handoff.status === 200, `the complete chain on a ${UAE_JURISDICTION}/${UAE_AUTHORITY} facility profile reaches READY_FOR_REVIEW and the handoff`)
  const encounterProfile = (await prisma.encounter.findUniqueOrThrow({ where: { id: happyEncounter.id }, select: { facilityRegulatoryProfileId: true } })).facilityRegulatoryProfileId
  check('T107', 'Exact regulatory profile', happy.run.facilityRegulatoryProfileId === encounterProfile && encounterProfile === site.profile.id && h.validationRun?.context?.facilityRegulatoryProfileId === site.profile.id, 'the run and the handoff keep the exact facilityRegulatoryProfileId of the Encounter')
  const governedSource = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: governing.sourceVersion.id }, select: { source: { select: { jurisdictionCode: true } } } })
  const governedRule = await prisma.ruleVersion.findUniqueOrThrow({ where: { id: happyRule.version.id }, select: { rule: { select: { jurisdictionCode: true } } } })
  check(
    'T108',
    'Governed jurisdiction provenance',
    governedSource.source.jurisdictionCode === UAE_JURISDICTION && governedRule.rule.jurisdictionCode === UAE_JURISDICTION && governedHappy.every((f) => f.governingSourceVersionId === governing.sourceVersion.id && f.ruleProvenance !== null),
    'the governing source and rule of every governed finding reconstruct to the exact AE-DU jurisdiction',
  )
  const countryAttempts = [await executeHttp(noAuth.encounterId, { jurisdictionCode: 'US-CA' }), await executeHttp(noAuth.encounterId, { market: 'US' }), await assessHttp(viewerRecorded, { jurisdictionCode: 'US' })].map((r) => r.status)
  check('T109', 'No client country selector', countryAttempts.every((s) => s === 400) && (await prisma.validationRun.count({ where: { encounterId: noAuth.encounterId } })) === runsBefore88, `a client-supplied jurisdiction or market is refused (${countryAttempts.join('/')}); context comes from the Encounter and its profile`)
  const production = committedProductionCodeOf(['backend/src/modules', 'backend/src/shared'])
  const appCode = committedCode('backend/src/app.ts') + committedCode('backend/src/server.ts')
  const productionReached = production.files.length > 150 && production.code.includes('requireOrganizationPermission')
  check(
    'T110',
    'No global market switch',
    productionReached && !/process\.env\.\w*(MARKET|COUNTRY|JURISDICTION|REGION)\w*/i.test(production.code + appCode) && !/\b(MARKET_MODE|marketMode|countryMode)\b/.test(production.code + appCode) && productionChanged.length === 0,
    `no process-global UAE/US mode across ${production.files.length} production files; A5.10 changes no production file`,
  )
  const usColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* '(npi|cpt|hcpcs|medicare|medicaid|x12|clearinghouse)'`).map((row) => row.c)
  check('T111', 'No US core fields', usColumns.length === 0, usColumns.length === 0 ? 'no NPI, CPT, HCPCS, Medicare, Medicaid, X12 or clearinghouse column' : `unexpected: ${usColumns.join(', ')}`)
  check('T112', 'No US runtime', productionReached && !/\b(x12|clearinghouse|medicare|medicaid|hcpcs|npi)\b/i.test(production.code + appCode), 'no US payer, clearinghouse or X12 behaviour in production code')
  check('T113', 'No new UAE hard-code', productionReached && productionChanged.length === 0 && !/['"`](AE-DU|AE-AZ|DHA|DOH|AED)['"`]/.test(production.code + appCode), 'A5.10 adds no production branch, and no UAE jurisdiction, authority or currency literal decides anything in the shared core')
  const profileFk = (await prisma.$queryRaw<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'validation_runs_facility_regulatory_profile_id_fkey'`)[0]?.def ?? ''
  const profileNullable = (await prisma.$queryRaw<{ n: string }[]>`SELECT is_nullable AS n FROM information_schema.columns WHERE table_name = 'validation_runs' AND column_name = 'facility_regulatory_profile_id'`)[0]?.n
  check(
    'T114',
    'Historical jurisdiction safe',
    /ON DELETE RESTRICT/.test(profileFk) && profileNullable === 'NO' && /append-only/.test(await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE validation_runs SET facility_regulatory_profile_id = facility_regulatory_profile_id WHERE id = $1::uuid`, happy.runId))),
    'every run keeps a non-null RESTRICT reference to its exact profile and cannot be rewritten, so a later market pack cannot reinterpret UAE history',
  )
  check(
    'T115',
    'A6 extensibility contract',
    typeof h.validationRun?.context?.facilityRegulatoryProfileId === 'string' && h.exactReferences?.governingSourceVersionIds?.includes(governing.sourceVersion.id) && h.exactReferences?.ruleVersionIds?.includes(happyRule.version.id),
    'the handoff carries the exact profile and governed rule/source references A6 needs for jurisdiction-specific claim construction',
  )

  // ---------------------------------------------------------------- database structure (T116–T125)
  section('Critical A5 database structure')
  const constraints = (await prisma.$queryRaw<{ n: string; d: string }[]>`SELECT conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE connamespace = 'public'::regnamespace`)
  const constraintDef = new Map(constraints.map((row) => [row.n, row.d]))
  const triggers = new Set((await prisma.$queryRaw<{ n: string }[]>`SELECT t.tgname AS n FROM pg_trigger t WHERE NOT t.tgisinternal`).map((row) => row.n))
  const indexes = new Map((await prisma.$queryRaw<{ n: string; d: string }[]>`SELECT indexname AS n, indexdef AS d FROM pg_indexes WHERE schemaname = 'public'`).map((row) => [row.n, row.d]))
  const structure = (names: { constraints?: string[]; triggers?: string[]; unique?: string[] }) => {
    const missing = [
      ...(names.constraints ?? []).filter((n) => !constraintDef.has(n) || (n.endsWith('_fkey') && !/ON DELETE RESTRICT/.test(constraintDef.get(n)!))),
      ...(names.triggers ?? []).filter((n) => !triggers.has(n)),
      ...(names.unique ?? []).filter((n) => !/UNIQUE/i.test(indexes.get(n) ?? '')),
    ]
    return { ok: missing.length === 0, detail: missing.length === 0 ? 'present' : `missing: ${missing.join(', ')}` }
  }
  const s116 = structure({ constraints: ['evidence_artifact_versions_version_positive_chk', 'evidence_artifact_versions_storage_ref_nonblank_chk', 'evidence_artifact_versions_content_hash_nonblank_chk', 'evidence_artifact_versions_evidence_artifact_id_fkey'], triggers: ['evidence_artifact_versions_append_only_trg'], unique: ['evidence_artifact_versions_evidence_artifact_id_version_key'] })
  check('T116', 'A5.1 DB structure', s116.ok, `evidence version numbering, non-blank storage/hash, RESTRICT lineage and append-only trigger ${s116.detail}`)
  const s117 = structure({ constraints: ['eligibility_verifications_status_chk', 'eligibility_verifications_method_chk', 'eligibility_verifications_request_response_order_chk', 'eligibility_verifications_validity_order_chk', 'eligibility_verifications_response_evidence_version_id_fkey', 'eligibility_verifications_insurance_membership_id_fkey'], triggers: ['eligibility_verifications_append_only_trg'] })
  check('T117', 'A5.2 DB structure', s117.ok, `status/method vocabularies, chronology CHECKs, required response evidence and append-only trigger ${s117.detail}`)
  const s118 = structure({ constraints: ['prior_authorization_versions_version_positive_chk', 'prior_authorization_versions_status_chk', 'prior_authorization_versions_kind_chk', 'prior_authorization_versions_timing_order_chk', 'prior_authorization_versions_validity_order_chk', 'prior_authorization_versions_prior_authorization_id_fkey'], triggers: ['prior_authorizations_append_only_trg', 'prior_authorization_versions_append_only_trg', 'prior_authorization_version_evidence_append_only_trg'], unique: ['prior_authorization_versions_prior_authorization_id_version_key'] })
  check('T118', 'A5.3 DB structure', s118.ok, `stable case, unique immutable version chronology and RESTRICT lineage ${s118.detail}`)
  const s119 = structure({ constraints: ['authorization_lines_identity_chk', 'authorization_lines_sequence_positive_chk', 'authorization_lines_requested_qty_positive_chk', 'authorization_lines_approved_qty_nonnegative_chk', 'authorization_lines_approved_dates_order_chk', 'authorization_lines_status_chk', 'authorization_lines_prior_authorization_version_id_fkey'], triggers: ['authorization_lines_append_only_trg'], unique: ['authorization_lines_prior_authorization_version_id_sequence_key'] })
  check('T119', 'A5.4 DB structure', s119.ok, `version-owned lines, unique sequence and typed quantity/date/status CHECKs ${s119.detail}`)
  const s120 = structure({ constraints: ['evidence_requirements_minimum_count_chk', 'evidence_requirements_freshness_requires_date_chk', 'evidence_requirement_document_types_document_type_chk', 'evidence_requirements_rule_version_id_fkey', 'encounter_evidence_links_evidence_artifact_version_id_fkey'], triggers: ['evidence_requirements_append_only_trg', 'evidence_requirement_document_types_append_only_trg', 'encounter_evidence_links_guard_trg'], unique: ['evidence_requirements_rule_version_id_key', 'encounter_evidence_links_active_uq'] })
  const shadowTables = tables.filter((t) => /(commercial_context|pre_claim_commercial|resolved_contract)/.test(t))
  check('T120', 'A5.6 DB structure', s120.ok && shadowTables.length === 0, `requirement/document-type/link constraints, one-way link guard and active-link uniqueness ${s120.detail}; no A5.5 shadow table`)
  const s121 = structure({ constraints: ['validation_findings_sequence_positive_chk', 'validation_findings_layer_chk', 'validation_findings_outcome_chk', 'validation_runs_encounter_id_fkey'], triggers: ['validation_runs_append_only_trg', 'validation_findings_append_only_trg', 'validation_findings_same_transaction_trg', 'validation_runs_require_findings_trg'], unique: ['validation_findings_validation_run_id_sequence_key'] })
  check('T121', 'A5.7 DB structure', s121.ok, `append-only runs and findings, unique positive sequence, five layers / four outcomes, deferred non-empty run and same-transaction closure ${s121.detail}`)
  const s122 = structure({
    constraints: ['validation_finding_rule_provenances_contract_version_chk', 'validation_finding_rule_provenances_validation_finding_id_fkey', 'validation_finding_supporting_bindings_rule_source_binding_fkey', 'validation_finding_reference_dataset_versions_reference_da_fkey'],
    triggers: ['validation_finding_rule_provenances_append_only_trg', 'validation_finding_supporting_bindings_append_only_trg', 'validation_finding_matched_applicabilities_append_only_trg', 'validation_finding_reference_dataset_versions_append_only_trg', 'validation_finding_rule_provenances_same_transaction_trg', 'validation_finding_supporting_bindings_same_transaction_trg', 'validation_finding_matched_applicabilities_same_transaction_trg', 'validation_finding_ref_dataset_versions_same_transaction_trg'],
  })
  const provenanceJson = (await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_name LIKE 'validation_finding_%' AND data_type IN ('json', 'jsonb')`).length
  check('T122', 'A5.8 DB structure', s122.ok && provenanceJson === 0, `four normalized provenance tables with RESTRICT keys, append-only and same-transaction triggers ${s122.detail}; no JSON provenance`)
  const s123 = structure({ constraints: ['pre_claim_readiness_assessments_state_chk', 'pre_claim_readiness_assessments_policy_version_chk', 'pre_claim_readiness_assessments_validation_run_id_fkey', 'pre_claim_readiness_assessments_created_by_user_id_fkey'], triggers: ['pre_claim_readiness_assessments_append_only_trg'], unique: ['pre_claim_readiness_assessments_validation_run_id_readiness_key'] })
  check('T123', 'A5.9 DB structure', s123.ok, `unique per run and policy, state/policy CHECKs and UPDATE/DELETE rejection ${s123.detail}`)
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T124', 'No A5.10 DB drift', schemaChanged.length === 0 && validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'no schema or migration change; Prisma validate, generate and status PASS')
  const replay = run('npm run db:verify:replay')
  check('T125', 'Migration replay', replay.ok && /ALL CHECKS PASS/.test(replay.output) && /pre_claim_readiness_assessments_append_only_trg is present/.test(replay.output), (replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0])

  // ---------------------------------------------------------------- owner suites (T126–T135)
  section('Owner suites — A5.9 invoked, nesting A5.8 -> A1')
  await apiReady('the A5.9 and backward regression chain')
  const chainRun = run('npm run test:a5:readiness')
  await waitFor(databaseUp, 90_000)
  const rows = suiteLines(chainRun.output, 'A5.9')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A5.9] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A5.9 asserts facts about its own branch, its own migration and the paths it was allowed to change.
  const a59NonApplicable: Record<string, string> = {
    T01: "A5.9 'Start gate' requires the current branch to be the A5.9 feature branch; A5.10 is a different branch, branched from the merged A5.9 main",
    T03: "A5.9 'Migration scope' requires exactly one migration against main; A5.10 adds none, by design",
    T108: "A5.9 'Diff scope' lists the paths A5.9 was allowed to change; A5.10 changes only its own harness and package script",
    T110: "A5.9 'Exact head evidence' requires the upstream to be the A5.9 feature branch, which was deleted when PR #63 merged",
  }
  const undocumented = failing.filter((id) => !(id in a59NonApplicable))
  const counts = chainRun.output.match(/\[A5\.9\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T96') && rows.some((row) => row.id === 'T105')
  check(
    'T126',
    'A5.9 owner suite',
    ran && reconciled && undocumented.length === 0,
    !ran
      ? 'the A5.9 suite did not reach its regression checks'
      : !reconciled
        ? `A5.9 reports ${failedCount} failure(s) but ${failing.length} could be named`
        : undocumented.length > 0
          ? `undocumented A5.9 failures: ${undocumented.join(', ')}`
          : `${(chainRun.output.match(/\[A5\.9\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.9] automated summary: ', 'A5.9 ')}; all ${failedCount} failure(s) named and accounted for, and every readiness and handoff invariant still holds`,
  )
  for (const id of undocumented) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) console.log(`[A5.10]      ${row.line.slice(0, 400)}`)
  }
  for (const id of Object.keys(a59NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T126/${id}`, `A5.9 ${titleOf(row.line)}`, a59NonApplicable[id])
  }
  // The nested cause is never lost: whatever A5.9 printed about a failing child (its A5.8 and deeper
  // detail), and any abort or uncaught error in the chain, is shown in this run's output.
  if (!ran || !reconciled || undocumented.length > 0) {
    for (const text of chainRun.output.split(/\r?\n/).filter((l) => (l.startsWith('[A5.9]      [') || /RUN ABORTED|uncaught error|INVALID RUN/.test(l)) && !/ substantive checks /.test(l)))
      console.log(`[A5.10]      ${text.slice(0, 400)}`)
  }
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check('T127', 'A5.8 owner suite', verdictOf('T96') === 'PASS', `A5.9 T96 (A5.8) ${verdictOf('T96')}`)
  check('T128', 'A5.7 owner suite', verdictOf('T97') === 'PASS', `A5.9 T97 (A5.7) ${verdictOf('T97')}`)
  check('T129', 'A5.6 owner suite', verdictOf('T98') === 'PASS', `A5.9 T98 (A5.6) ${verdictOf('T98')}`)
  check('T130', 'A5.5 owner suite', verdictOf('T99') === 'PASS', `A5.9 T99 (A5.5) ${verdictOf('T99')}`)
  check('T131', 'A5.4 owner suite', verdictOf('T100') === 'PASS', `A5.9 T100 (A5.4) ${verdictOf('T100')}`)
  check('T132', 'A5.3 owner suite', verdictOf('T101') === 'PASS', `A5.9 T101 (A5.3) ${verdictOf('T101')}`)
  check('T133', 'A5.2/A5.1 owner suites', verdictOf('T102') === 'PASS', `A5.9 T102 (A5.2 and A5.1) ${verdictOf('T102')}`)
  check('T134', 'A4 regression', verdictOf('T103') === 'PASS', `A5.9 T103 (A4.10 and A4.9 to A1) ${verdictOf('T103')}`)
  check('T135', 'A3/A2/A1 regressions', verdictOf('T104') === 'PASS' && verdictOf('T105') === 'PASS', `A5.9 T104 (A3) ${verdictOf('T104')}, T105 (A2 and A1) ${verdictOf('T105')}`)
  for (const text of chainRun.output.split(/\r?\n/).filter((l) => l.startsWith('[A5.9]      ') && / substantive checks /.test(l))) console.log(`[A5.10]      ${text.replace('[A5.9]', '').trim().slice(0, 190)}`)

  // ---------------------------------------------------------------- closure (T136–T140)
  section('Build gates, database truth, repeatability and exact head')
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T136', 'Unit/typecheck/build', unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok && build.ok && lint.ok, `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]}, typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)

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
  check('T137', 'DB health truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  await waitFor(databaseUp, 60_000)
  const priorRunsNow = await prisma.validationRun.count({ where: { createdAt: { lt: runStartedAt } } })
  const priorAssessmentsNow = await prisma.preClaimReadinessAssessment.count({ where: { createdAt: { lt: runStartedAt } } })
  check(
    'T138',
    'Repeatability',
    priorRunsNow === priorRunsAtStart && priorAssessmentsNow === priorAssessmentsAtStart && createdRunIds.length >= 25,
    `fresh runId ${runId}: ${createdRunIds.length} executions and ${createdAssessmentIds.length} assessments added; all ${priorRunsNow} earlier runs and ${priorAssessmentsNow} earlier assessments retained as history (the second full run is the evidence of a repeat PASS)`,
  )
  const outOfScope = changedPaths.filter((p) => !p.startsWith(`${HARNESS_DIR}/`) && p !== 'backend/package.json')
  const packageDiff = git('diff origin/main...HEAD -- :/backend/package.json').split(/\r?\n/).filter((l) => /^[+-]\s/.test(l))
  check(
    'T139',
    'Diff scope',
    changedPaths.length > 0 && outOfScope.length === 0 && packageDiff.every((l) => /test:a5:(integration|readiness)/.test(l)),
    outOfScope.length === 0 ? `${changedPaths.length} path(s): the A5.10 runner and its one package script; no product, A6 or A9 code` : `unexpected: ${outOfScope.join(', ').slice(0, 220)}`,
  )
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T140',
    'Exact head evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a510Branch}`) && !/ahead|behind/.test(tracking),
    `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`,
  )

  console.log(`\n[A5.10] run ${runId} — HEAD ${headSha}`)
  console.log(`[A5.10] X01 ready chain: ValidationRun ${happy.runId}, readiness assessment ${happy.assessment.id}, PreClaimA6HandoffV1 ${happy.handoff.status}`)
  if (failures.length > 0) {
    console.log(`[A5.10] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.10] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A5.10] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A5.10] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.10] A5 INTEGRATION ACCEPTANCE / PHASE CLOSURE COMPLETE' : '[A5.10] A5.10 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A5.10] RUN ABORTED: ${error.message}`)
      console.log('[A5.10] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A5.10] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.10] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
