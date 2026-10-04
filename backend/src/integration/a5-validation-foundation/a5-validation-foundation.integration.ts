import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { apiFixtures } from '../a3-governance/a3-governance.fixtures.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'

// A5.7 — focused acceptance for the Validation Run & Finding Foundation (T01–T106).
//
// A5.7 persists one complete, immutable ValidationRun with its ordered ValidationFindings, recorded by
// an internal transaction-aware recorder, and exposes read-only GET routes. It executes no validation,
// composes no readiness and creates no claim state. There is no public create route, so — exactly as
// §10 prescribes — this suite calls the recorder in-process with synthetic server-owned drafts, the way
// A5.8 will.
//
// Valid fixtures are created through their owning routes. The database is READ for structural proof;
// ADVERSARIAL writes go in only to prove something refuses them, plus the few rows an owner route
// cannot make (a SYSTEM_SHARED and a foreign-tenant RuleVersion, and one run on a foreign Encounter so
// that cross-tenant reads can be proven). Every value is synthetic.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.7] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.7] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.7] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.7] ${title}`)

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
const committedCodeOf = (dir: string) => {
  const files = committedFiles(dir)
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}
const committedProductionCodeOf = (dirs: string[]) => {
  const files = dirs.flatMap((dir) => committedFiles(dir)).filter((file) => !file.endsWith('.test.ts'))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `A57-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A5.6 FINAL PASS was merged into main as PR #56; the A5.4 T109 correction (PR #57) merged after it.
// A5.7 is branched from that main.
const a56Merge = '68ec326'
const a54Correction = '21fac90'
const a57Branch = 'feature/a5-7-validation-run-finding-foundation'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const MODULE_DIR = 'backend/src/modules/validation-run'
const FRONTEND_DIR = 'frontend/src/modules/validation-run'

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

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A5.7] Validation run & finding foundation — run ${runId}`)
  console.log(`[A5.7] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

  const databaseReachable = await (async () => {
    const started = Date.now()
    while (Date.now() - started < 60_000) {
      try {
        await prisma.$queryRaw`SELECT 1`
        return true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    return false
  })()
  if (!databaseReachable)
    throw new RunAborted(`the database is not reachable, so no check can be judged. Start it with \`docker start ${dbContainer}\`, wait for it to report healthy, then run this suite again.`)

  const ready = async () => (await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status ?? 0
  const health = async () => (await fetch(`${baseUrl}/api/health`).catch(() => null))?.status ?? 0
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return false
  }
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 60_000)))
      throw new RunAborted(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // ---------------------------------------------------------------- gates (T01–T07)
  section('Start gate, migration, permission and internal-only recorder')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'Start gate',
    branch === a57Branch && gitOk(`merge-base --is-ancestor ${a56Merge} origin/main`) && gitOk(`merge-base --is-ancestor ${a54Correction} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the A5.6 merge ${a56Merge} (PR #56) and the A5.4 correction ${a54Correction} (PR #57) are on main, and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const createdTables = (statements.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).map((m) => m.replace(/CREATE TABLE "|"/g, '')).sort()
  const scopeProblems = [
    [JSON.stringify(createdTables) === JSON.stringify(['validation_findings', 'validation_runs']), `tables created: ${createdTables.join(', ')}`],
    [!/DROP INDEX/.test(statements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((m) => /"(validation_runs|validation_findings)"/.test(m)), 'a table outside A5.7 is altered'],
    [(statements.match(/ADD CONSTRAINT "[a-z_]*_chk"/g) ?? []).length === 7, 'the seven CHECKs are not all added'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 23, 'not all 23 foreign keys are ON DELETE RESTRICT'],
    [(statements.match(/CREATE TRIGGER [a-z_]+_trg/g) ?? []).length === 3, 'the three row triggers are not all created'],
    [/CREATE CONSTRAINT TRIGGER validation_runs_require_findings_trg\s+AFTER INSERT ON "validation_runs"\s+DEFERRABLE INITIALLY DEFERRED/.test(statements), 'the deferred non-empty-run constraint trigger is missing'],
    [!/\b(jsonb?|readiness|claim|submission|is_current|is_latest|overall_outcome|organization_id)\b/i.test(statements), 'a JSON, readiness, claim, current/latest, overall-outcome or organization column appears'],
  ].filter(([ok]) => !ok).map(([, reason]) => reason as string)
  check(
    'T03',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1 ? `expected exactly one migration, found ${migrationPaths.length}` : scopeProblems.length === 0 ? 'one migration; exactly validation_runs and validation_findings, seven CHECKs, 23 RESTRICT foreign keys, three row triggers and the deferred non-empty-run trigger, with no drift' : `out of scope: ${scopeProblems.join('; ')}`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'Migration replay',
    replay.ok &&
      /ALL CHECKS PASS/.test(replay.output) &&
      /the deferred non-empty-run trigger on validation runs is present/.test(replay.output) &&
      /the same-transaction trigger on validation findings is present/.test(replay.output) &&
      /validation_findings_evidence_artifact_version_id_fkey is present/.test(replay.output) &&
      /validation runs and findings carry no status, current\/latest, overall outcome, readiness, organization, sensitive identity, ClaimLine or JSON column/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; every A5.7 foreign key, CHECK, index and trigger survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const validationCodes = allCodes.filter((code) => /^validation/i.test(code)).sort()
  const readGrants = (await prisma.rolePermission.findMany({ where: { permission: { code: 'validationRun.read' } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort()
  check(
    'T06',
    'Permission scope',
    JSON.stringify(validationCodes) === JSON.stringify(['validationRun.read']) && readGrants.join(',') === 'ORG_ADMIN,ORG_VIEWER',
    `exactly validationRun.read for Admin and Viewer; no create, execute, update or delete permission (${validationCodes.join(', ')})`,
  )

  const moduleCode = committedProductionCodeOf([MODULE_DIR])
  const routeCode = committedCode(`${MODULE_DIR}/validation-run.route.ts`)
  const routeVerbs = [...routeCode.matchAll(/\b\w+Router\.(get|post|put|patch|delete|all)\(/g)].map((m) => m[1])
  const appCode = committedCode('backend/src/app.ts')

  // ---------------------------------------------------------------- fixtures
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
  const post = (path: string, body: unknown, who = asAdmin) => httpCall(path, who({ method: 'POST', body: JSON.stringify(body) }))
  const patchApi = (path: string, body: unknown, who = asAdmin) => httpCall(path, who({ method: 'PATCH', body: JSON.stringify(body) }))
  const del = (path: string, who = asAdmin) => httpCall(path, who({ method: 'DELETE' }))
  const get = (path: string, who = asAdmin) => httpCall(path, who())
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const fx = apiFixtures(baseUrl, admin.cookie, org, runId)
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  let serial = 0
  const key = (prefix: string) => `${runId}-${prefix}-${++serial}`

  const t07Posts = [
    (await post(`/api/encounters/${MISSING}/validation-runs`, {})).status,
    (await post('/api/validation-runs', {})).status,
    (await post(`/api/validation-runs/${MISSING}/execute`, {})).status,
    (await post(`/api/encounters/${MISSING}/validation-runs/execute`, {})).status,
  ]
  check(
    'T07',
    'Recorder internal-only',
    routeCode.length > 0 && routeVerbs.length === 4 && routeVerbs.every((verb) => verb === 'get') && !/\/execute/.test(routeCode) && !/recordValidationRun/.test(routeCode + appCode) && t07Posts.every((code) => code === 404),
    `${routeVerbs.length} routes, all GET; the recorder is not reachable over HTTP and every POST or /execute path is 404 (${t07Posts.join('/')})`,
  )

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const service = must('service', (await post(`/api/organizations/${org}/services`, { internalCode: key('S'), displayName: 'Synthetic service' })).body)
  const diagnosisCode = must('diagnosis code', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DX'), displayName: 'Synthetic diagnosis' })).body)
  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const memberIdentifier = `MEM-${key('M')}`
  const membership = must('membership', (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier, coverageFrom: '2025-01-01', coverageTo: null })).body)
  const contract = must('contract', (await post(`/api/organizations/${org}/provider-contracts`, { contractKey: key('C'), displayName: `${runId} contract`, payerId: payer.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  must('contract facility', (await post(`/api/provider-contracts/${contract.id}/contract-facilities`, { facilityId: facility.id })).body)
  const schedule = must('schedule', (await post(`/api/provider-contracts/${contract.id}/tariff-schedules`, { tariffKey: key('T'), displayName: `${runId} tariff` })).body)
  const tariffVersion = must('tariff version', (await post(`/api/tariff-schedules/${schedule.id}/versions`, { version: key('V'), effectiveFrom: '2026-01-01', effectiveTo: null })).body)
  const newEncounter = async (label: string) =>
    must(label, (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membership.id })).body) as { id: string }
  const encounter = await newEncounter('encounter')
  const otherEncounter = await newEncounter('other encounter')
  const stored = await prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id }, select: { facilityRegulatoryProfileId: true } })
  const evidence = async (label: string) => {
    const artifact = must(label, (await post(`/api/organizations/${org}/evidence-artifacts`, { storageRef: `synthetic://evidence/${key('E')}`, contentHash: 'c'.repeat(64), documentType: 'SYNTHETIC_REPORT', sourceDate: '2026-06-01', receivedAt: '2026-06-15T09:30:00.000Z' })).body) as any
    return { artifactId: artifact.id as string, versionId: artifact.latestVersion.id as string }
  }
  const evidenceA = await evidence('evidence A')
  const evidenceB = await evidence('evidence B')
  const targetsFor = async (encounterId: string) => {
    const activity = must('activity', (await post(`/api/encounters/${encounterId}/activities`, { serviceId: service.id, quantity: '1' })).body)
    const diagnosis = must('diagnosis', (await post(`/api/encounters/${encounterId}/diagnoses`, { diagnosisCodeId: diagnosisCode.id })).body)
    const eligibility = must('eligibility', (await post(`/api/encounters/${encounterId}/eligibility-verifications`, { verificationMethod: 'PORTAL', status: 'UNKNOWN', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z', validThrough: null, authorizationRequired: null, referralRequired: null, requestEvidenceVersionId: null, responseEvidenceVersionId: evidenceA.versionId })).body)
    const authorization = must('prior authorization', (await post(`/api/encounters/${encounterId}/prior-authorizations`, { versionKind: 'INITIAL', status: 'REQUESTED', authorizationReference: null, eligibilityVerificationId: null, requestedAt: null, respondedAt: null, validFrom: null, validThrough: null, evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: evidenceA.versionId }] })).body) as any
    const authorizationReference = `AUTH-${key('R')}`
    const approved = must('approved version', (await post(`/api/prior-authorizations/${authorization.id}/versions`, { versionKind: 'RESPONSE', status: 'APPROVED', authorizationReference, eligibilityVerificationId: null, requestedAt: null, respondedAt: '2026-06-10T09:00:00.000Z', validFrom: '2026-06-01', validThrough: '2026-06-30', evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: evidenceA.versionId }] })).body)
    const lines = (await post(`/api/prior-authorization-versions/${approved.id}/authorization-lines`, { lines: [{ serviceId: service.id, procedureCodeId: null, diagnosisCodeId: null, requestedQty: '1', approvedQty: '1', unitCode: null, approvedFrom: null, approvedThrough: null, status: 'APPROVED' }] })).body as any
    const lineId = lines?.items?.[0]?.id
    if (!lineId) throw new Error(`fixture authorization line could not be captured: ${JSON.stringify(lines).slice(0, 200)}`)
    return { activityId: activity.id, diagnosisId: diagnosis.id, eligibilityId: eligibility.id, paVersionId: approved.id as string, lineId: lineId as string, authorizationReference }
  }
  const own = await targetsFor(encounter.id)
  const other = await targetsFor(otherEncounter.id)

  const governing = await fx.verifiedSource('validation provenance', { activateOn: '2025-01-01' })
  const ownRule = await fx.ruleDefinition('validation provenance')
  const ruleV1 = await fx.draftRuleVersion(ownRule.id, '1', { effectType: 'DOCUMENTATION_REQUIREMENT_EFFECT' })
  const requirement = must('evidence requirement', (await post(`/api/rule-versions/${ruleV1.id}/evidence-requirement`, { documentTypes: ['SYNTHETIC_REPORT'], minimumCount: 1, sourceDateRequired: false, maxSourceAgeDays: null })).body)
  const ruleV2 = await fx.draftRuleVersion(ownRule.id, '2', { effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT' })
  // Rows an owner route cannot make for this tenant: a SYSTEM_SHARED and a foreign-tenant RuleVersion.
  // Neither carries a documentation effect, so no A5.6 evaluation ever discovers them.
  const sharedRule = await prisma.ruleDefinition.create({ data: { organizationId: null, ruleKey: key('SHARED'), displayName: 'Synthetic shared rule', jurisdictionCode: 'AE-DU', ownershipScope: 'SYSTEM_SHARED' } })
  const sharedVersion = await prisma.ruleVersion.create({ data: { ruleId: sharedRule.id, version: '1', effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT' } })
  const foreignRule = await prisma.ruleDefinition.create({ data: { organizationId: otherOrg, ruleKey: key('FOREIGN'), displayName: 'Synthetic foreign rule', jurisdictionCode: 'AE-DU', ownershipScope: 'ORGANIZATION' } })
  const foreignVersion = await prisma.ruleVersion.create({ data: { ruleId: foreignRule.id, version: '1', effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT' } })
  const foreignEvidence = await prisma.evidenceArtifactVersion.findFirst({ where: { evidenceArtifact: { organizationId: otherOrg } }, select: { id: true } })
  const datasetVersion = await prisma.referenceDatasetVersion.findFirst({ orderBy: { id: 'asc' }, select: { id: true } })
  console.log('[A5.7]      fixtures ready: patient, facility, profile, clinician, payer, membership, contract, tariff, two Encounters with activity, diagnosis, eligibility, authorization version and line, evidence, a governed source, own, shared and foreign rule versions')

  // ---------------------------------------------------------------- recorder helpers
  const contextOf = (overrides: Record<string, unknown> = {}) => ({
    serviceDate: SERVICE_DATE,
    facilityId: facility.id,
    facilityRegulatoryProfileId: stored.facilityRegulatoryProfileId,
    insuranceMembershipId: membership.id,
    payerId: payer.id,
    tpaId: null,
    networkId: null,
    insuranceProductId: null,
    providerContractId: contract.id,
    tariffScheduleId: schedule.id,
    tariffScheduleVersionId: tariffVersion.id,
    ...overrides,
  })
  const finding = (overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome: 'PASS', findingCode: 'SYNTHETIC_CHECK', message: 'Synthetic check recorded.', ...overrides })
  let versionSerial = 0
  const draftOf = (overrides: Record<string, unknown> = {}) => ({
    encounterId: encounter.id,
    contextSnapshot: contextOf(),
    validatorVersion: `${runId}-V${++versionSerial}`,
    findings: [finding()],
    ...overrides,
  })
  const record = (draft: unknown) => prisma.$transaction(async (tx) => recordValidationRunInTransaction(draft, actorUserId, tx))
  const recordedRunIds: string[] = []
  const recordOk = async (draft: Record<string, unknown>) => {
    const result = await record(draft)
    if (!result.ok) throw new Error(`a valid synthetic draft was refused: ${result.message}`)
    recordedRunIds.push(result.value.id)
    return result.value
  }
  const refusal = async (draft: unknown) => {
    const result = await record(draft)
    return result.ok ? null : result.message
  }
  const runsWithVersion = (validatorVersion: string) => prisma.validationRun.count({ where: { validatorVersion } })
  const runAudits = (runIds: string[]) => prisma.auditEvent.count({ where: { entityType: 'VALIDATION_RUN', entityId: { in: runIds } } })
  // An adversarial finding written straight to the database, inside the transaction that inserted its
  // run (so the same-transaction trigger is satisfied and the CHECK under test is what answers).
  const baseRunData = () => ({ encounterId: encounter.id, serviceDate: new Date(`${SERVICE_DATE}T00:00:00.000Z`), facilityId: facility.id, facilityRegulatoryProfileId: stored.facilityRegulatoryProfileId, validatorVersion: `${runId}-DB`, evaluatedAt: new Date(), createdByUserId: actorUserId })
  const dbFinding = (columns: Partial<{ sequence: number; layer: string; outcome: string; findingCode: string; message: string; fieldPath: string | null }>) =>
    attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        const runRow = await tx.validationRun.create({ data: baseRunData() })
        const c = { sequence: 1, layer: 'TECHNICAL', outcome: 'PASS', findingCode: 'DB_CHECK', message: 'Synthetic.', fieldPath: null, ...columns }
        await tx.$executeRawUnsafe(
          'INSERT INTO validation_findings (id, validation_run_id, sequence, layer, outcome, finding_code, message, field_path) VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7)',
          runRow.id,
          c.sequence,
          c.layer,
          c.outcome,
          c.findingCode,
          c.message,
          c.fieldPath,
        )
      }),
    )

  // ---------------------------------------------------------------- recording (T08–T12)
  section('Atomic recording through the internal recorder')
  const t08Draft = draftOf({ findings: [finding({ findingCode: 'FIRST' }), finding({ findingCode: 'SECOND', outcome: 'WARNING' }), finding({ findingCode: 'THIRD', outcome: 'FAIL', layer: 'COVERAGE' })] })
  const t08 = await recordOk(t08Draft)
  const t08Findings = await prisma.validationFinding.findMany({ where: { validationRunId: t08.id }, orderBy: { sequence: 'asc' } })
  check(
    'T08',
    'Run create atomic',
    t08.findingCount === 3 && t08Findings.length === 3 && (await runAudits([t08.id])) === 1,
    'one run, all three findings and exactly one safe audit event written together by the recorder',
  )
  const t09Version = `${runId}-EMPTY`
  const t09 = await refusal(draftOf({ validatorVersion: t09Version, findings: [] }))
  check('T09', 'Run zero findings', /at least one finding/.test(t09 ?? '') && (await runsWithVersion(t09Version)) === 0, 'the recorder refuses an empty finding set before writing anything')
  const t10Version = `${runId}-DB-EMPTY`
  const t10 = await attemptAdversarial(() => prisma.$transaction(async (tx) => tx.validationRun.create({ data: { ...baseRunData(), validatorVersion: t10Version } })))
  check('T10', 'DB empty-run guard', /at least one finding/.test(t10) && (await runsWithVersion(t10Version)) === 0, 'deferred constraint refused the commit of a direct run insert with no finding; nothing remains')
  const t11Refused = await refusal(draftOf({ findings: [finding({ sequence: 7 })] }))
  check(
    'T11',
    'Finding sequence',
    JSON.stringify(t08Findings.map((row) => row.sequence)) === '[1,2,3]' && JSON.stringify(t08Findings.map((row) => row.findingCode)) === '["FIRST","SECOND","THIRD"]' && /server-owned/.test(t11Refused ?? ''),
    'contiguous 1..N in the validator’s order, assigned by the recorder; a caller-supplied sequence is refused as server-owned',
  )
  const t12 = await recordOk(draftOf())
  check('T12', 'Repeat run', (await prisma.validationRun.count({ where: { encounterId: encounter.id, id: { in: [t08.id, t12.id] } } })) === 2, 'a second run for the same Encounter is a new row; the first is untouched')

  // ---------------------------------------------------------------- immutability (T13–T18)
  section('Immutability through the API and the database')
  const t13 = [(await patchApi(`/api/validation-runs/${t08.id}`, {})).status, (await del(`/api/validation-runs/${t08.id}`)).status]
  check('T13', 'Run immutable API', t13.every((code) => code === 404), `PATCH and DELETE are 404 (${t13.join('/')})`)
  const t14 = await attemptAdversarial(() => prisma.$executeRawUnsafe('UPDATE validation_runs SET validator_version = $1 WHERE id = $2::uuid', 'TAMPERED', t08.id))
  check('T14', 'Run DB UPDATE', /append-only/.test(t14), 'the trigger refused a direct UPDATE')
  const t15 = await attemptAdversarial(() => prisma.$executeRawUnsafe('DELETE FROM validation_runs WHERE id = $1::uuid', t08.id))
  check('T15', 'Run DB DELETE', /append-only/.test(t15) && (await prisma.validationRun.count({ where: { id: t08.id } })) === 1, 'the trigger refused a direct DELETE and the run survived')
  const t16 = [(await patchApi(`/api/validation-findings/${t08Findings[0].id}`, {})).status, (await del(`/api/validation-findings/${t08Findings[0].id}`)).status]
  check('T16', 'Finding immutable API', t16.every((code) => code === 404), `PATCH and DELETE are 404 (${t16.join('/')})`)
  const t17 = await attemptAdversarial(() => prisma.$executeRawUnsafe("UPDATE validation_findings SET outcome = 'PASS' WHERE id = $1::uuid", t08Findings[2].id))
  check('T17', 'Finding DB UPDATE', /append-only/.test(t17), 'the trigger refused a direct UPDATE')
  const t18 = await attemptAdversarial(() => prisma.$executeRawUnsafe('DELETE FROM validation_findings WHERE id = $1::uuid', t08Findings[2].id))
  check('T18', 'Finding DB DELETE', /append-only/.test(t18) && (await prisma.validationFinding.count({ where: { validationRunId: t08.id } })) === 3, 'the trigger refused a direct DELETE and all three findings survived')

  // ---------------------------------------------------------------- vocabularies (T19–T35)
  section('Controlled vocabularies and safe text')
  const layers = ['TECHNICAL', 'CODING', 'COVERAGE', 'CONTRACT', 'EVIDENCE']
  const layerRun = await recordOk(draftOf({ findings: layers.map((layer) => finding({ layer, findingCode: `LAYER_${layer}` })) }))
  const layerRows = await prisma.validationFinding.findMany({ where: { validationRunId: layerRun.id }, orderBy: { sequence: 'asc' } })
  layers.forEach((layer, index) => check(`T${19 + index}`, `Layer ${layer}`, layerRows[index]?.layer === layer, 'accepted and stored exactly'))
  const badLayerApp = await refusal(draftOf({ findings: [finding({ layer: 'READINESS' })] }))
  const badLayerDb = await dbFinding({ layer: 'READINESS' })
  check('T24', 'Bad layer', /layer/.test(badLayerApp ?? '') && /validation_findings_layer_chk/.test(badLayerDb), 'refused by the recorder and, for a direct insert, by the database CHECK')
  const outcomes = ['PASS', 'WARNING', 'RESTRICT', 'FAIL']
  const outcomeRun = await recordOk(draftOf({ findings: outcomes.map((outcome) => finding({ outcome, findingCode: `OUTCOME_${outcome}` })) }))
  const outcomeRows = await prisma.validationFinding.findMany({ where: { validationRunId: outcomeRun.id }, orderBy: { sequence: 'asc' } })
  outcomes.forEach((outcome, index) => check(`T${25 + index}`, `Outcome ${outcome}`, outcomeRows[index]?.outcome === outcome, 'accepted and stored exactly'))
  const badOutcomeApp = await refusal(draftOf({ findings: [finding({ outcome: 'BLOCK' })] }))
  const badOutcomeDb = await dbFinding({ outcome: 'BLOCK' })
  check('T29', 'Bad outcome', /outcome/.test(badOutcomeApp ?? '') && /validation_findings_outcome_chk/.test(badOutcomeDb), 'refused by the recorder and, for a direct insert, by the database CHECK')
  const longCode = `A${'B'.repeat(95)}`
  const codeRun = await recordOk(draftOf({ findings: [finding({ findingCode: 'A' }), finding({ findingCode: 'MISSING_MEMBERSHIP_2' }), finding({ findingCode: longCode })] }))
  const codeRows = (await prisma.validationFinding.findMany({ where: { validationRunId: codeRun.id }, orderBy: { sequence: 'asc' } })).map((row) => row.findingCode)
  check('T30', 'findingCode valid', JSON.stringify(codeRows) === JSON.stringify(['A', 'MISSING_MEMBERSHIP_2', longCode]), 'single-letter, underscored and 96-character uppercase tokens accepted')
  const badCodes = await Promise.all(['', 'missing_membership', 'ABC\u0007', `A${'B'.repeat(96)}`, '1ABC'].map(async (findingCode) => /findingCode/.test((await refusal(draftOf({ findings: [finding({ findingCode })] }))) ?? '')))
  const badCodeDb = await dbFinding({ findingCode: 'lowercase' })
  check('T31', 'findingCode invalid', badCodes.every(Boolean) && /validation_findings_finding_code_chk/.test(badCodeDb), 'blank, lowercase, control, oversize and digit-first codes refused by the recorder; the database CHECK refuses a direct lowercase insert')
  const badMessages = await Promise.all(['', '   ', 'x'.repeat(513), 'two\nlines'].map(async (message) => /message/.test((await refusal(draftOf({ findings: [finding({ message })] }))) ?? '')))
  const badMessageDb = await dbFinding({ message: ' padded ' })
  const okMessage = await recordOk(draftOf({ findings: [finding({ message: `  ${'é'.repeat(510)}  ` })] }))
  const okMessageRow = await prisma.validationFinding.findFirstOrThrow({ where: { validationRunId: okMessage.id } })
  check('T32', 'message required', badMessages.every(Boolean) && /validation_findings_message_chk/.test(badMessageDb) && okMessageRow.message === 'é'.repeat(510), 'blank, oversize and multi-line messages refused; a safe message is stored trimmed; the database refuses an untrimmed one')
  const pathRun = await recordOk(draftOf({ findings: [finding({ fieldPath: null }), finding({ fieldPath: ` encounter.activities[${own.activityId}].serviceId ` })] }))
  const pathRows = (await prisma.validationFinding.findMany({ where: { validationRunId: pathRun.id }, orderBy: { sequence: 'asc' } })).map((row) => row.fieldPath)
  check('T33', 'fieldPath optional', pathRows[0] === null && pathRows[1] === `encounter.activities[${own.activityId}].serviceId`, 'null accepted; a safe bounded path is stored trimmed')
  const badPaths = await Promise.all(['', '  ', 'a\u0000b', 'p'.repeat(257)].map(async (fieldPath) => /fieldPath/.test((await refusal(draftOf({ findings: [finding({ fieldPath })] }))) ?? '')))
  const badPathDb = await dbFinding({ fieldPath: '   ' })
  check('T34', 'fieldPath invalid', badPaths.every(Boolean) && /validation_findings_field_path_chk/.test(badPathDb), 'blank, control-character and oversize paths refused; the database refuses a blank one')
  const badVersions = await Promise.all(['', '  ', 'v'.repeat(97), 7].map(async (validatorVersion) => /validatorVersion/.test((await refusal(draftOf({ validatorVersion }))) ?? '')))
  const t35Version = `  ${runId}-BOUNDED  `
  const t35 = await recordOk(draftOf({ validatorVersion: t35Version }))
  check('T35', 'validatorVersion', badVersions.every(Boolean) && t35.validatorVersion === t35Version.trim(), 'blank, oversize and non-string labels refused; a bounded label is stored trimmed, supplied by the server-side caller')

  // ---------------------------------------------------------------- run context (T36–T42)
  section('Run context — exact, server-owned, nullable when unresolved')
  const t36 = await prisma.$transaction(async (tx) => {
    const started = (await tx.$queryRaw<{ ts: Date }[]>`SELECT transaction_timestamp() AS ts`)[0].ts
    await tx.$queryRaw`SELECT pg_sleep(0.3)::text AS slept`
    const appClock = new Date()
    const result = await recordValidationRunInTransaction(draftOf(), actorUserId, tx)
    return { started, appClock, result }
  })
  if (t36.result.ok) recordedRunIds.push(t36.result.value.id)
  const t36Row = t36.result.ok ? await prisma.validationRun.findUniqueOrThrow({ where: { id: t36.result.value.id } }) : null
  check(
    'T36',
    'evaluatedAt DB truth',
    t36Row !== null && t36Row.evaluatedAt.getTime() === t36.started.getTime() && t36.appClock.getTime() - t36Row.evaluatedAt.getTime() >= 250,
    `evaluatedAt is the transaction's own timestamp; the application clock had moved ${t36.appClock.getTime() - t36.started.getTime()} ms by the time the run was written`,
  )
  const t37 = [
    await refusal(draftOf({ evaluatedAt: '2020-01-01T00:00:00.000Z' })),
    await refusal(draftOf({ createdAt: '2020-01-01T00:00:00.000Z' })),
    await refusal(draftOf({ findings: [finding({ createdAt: '2020-01-01T00:00:00.000Z' })] })),
  ]
  check('T37', 'Client timestamps refused', t37.every((message) => /server-owned/.test(message ?? '')), 'evaluatedAt and createdAt on the run, and createdAt on a finding, are refused as server-owned')
  const t38Context = contextOf({ tpaId: null, networkId: null, insuranceProductId: null })
  const t38 = await recordOk(draftOf({ contextSnapshot: t38Context }))
  const t38Row = await prisma.validationRun.findUniqueOrThrow({ where: { id: t38.id } })
  const t38Stored = {
    serviceDate: t38Row.serviceDate.toISOString().slice(0, 10),
    facilityId: t38Row.facilityId,
    facilityRegulatoryProfileId: t38Row.facilityRegulatoryProfileId,
    insuranceMembershipId: t38Row.insuranceMembershipId,
    payerId: t38Row.payerId,
    tpaId: t38Row.tpaId,
    networkId: t38Row.networkId,
    insuranceProductId: t38Row.insuranceProductId,
    providerContractId: t38Row.providerContractId,
    tariffScheduleId: t38Row.tariffScheduleId,
    tariffScheduleVersionId: t38Row.tariffScheduleVersionId,
  }
  check('T38', 'Context exact storage', JSON.stringify(t38Stored) === JSON.stringify(t38Context) && JSON.stringify(t38.context) === JSON.stringify(t38Context), 'every context id and the service date read back exactly, in the row and in the DTO')
  const t39Context = contextOf({ insuranceMembershipId: null, payerId: null, providerContractId: null, tariffScheduleId: null, tariffScheduleVersionId: null })
  const t39 = await recordOk(draftOf({ contextSnapshot: t39Context, findings: [finding({ layer: 'COVERAGE', outcome: 'FAIL', findingCode: 'MISSING_MEMBERSHIP' })] }))
  const t39Row = await prisma.validationRun.findUniqueOrThrow({ where: { id: t39.id } })
  check('T39', 'Nullable membership context', t39Row.insuranceMembershipId === null && t39Row.payerId === null, 'a run records an absent membership as null although the Encounter has one — nothing is inferred')
  const t40Context = contextOf({ providerContractId: null, tariffScheduleId: null, tariffScheduleVersionId: null })
  const t40 = await recordOk(draftOf({ contextSnapshot: t40Context, findings: [finding({ layer: 'CONTRACT', outcome: 'FAIL', findingCode: 'COMMERCIAL_CONTEXT_UNRESOLVED' })] }))
  const t40Row = await prisma.validationRun.findUniqueOrThrow({ where: { id: t40.id } })
  check('T40', 'Nullable commercial context', t40Row.providerContractId === null && t40Row.tariffScheduleId === null && t40Row.tariffScheduleVersionId === null && t40Row.payerId === payer.id, 'an unresolved contract and tariff are recorded as null beside the known payer')
  const runColumns = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'validation_runs'`).map((row) => row.column_name)
  const findingColumns = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'validation_findings'`).map((row) => row.column_name)
  check('T41', 'No organization copy', runColumns.length === 17 && !runColumns.includes('organization_id') && !findingColumns.includes('organization_id'), `none of ${runColumns.length} run columns or ${findingColumns.length} finding columns is organization_id; ownership derives from Encounter -> Patient`)
  const runDto = (await get(`/api/validation-runs/${t38.id}`)).body
  const sensitiveColumns = [...runColumns, ...findingColumns].filter((name) => /(member_identifier|policy_identifier|given_name|family_name|patient_name|date_of_birth|authorization_reference|storage_ref|content_hash)/i.test(name))
  check(
    'T42',
    'No sensitive identity copy',
    sensitiveColumns.length === 0 && ![...deepKeys(runDto)].some((k) => /memberIdentifier|policyIdentifier|givenName|familyName|authorizationReference|storageRef|contentHash/.test(k)) && !JSON.stringify(runDto).includes(memberIdentifier),
    'no member, policy, patient-name, authorization-reference or evidence-storage column, DTO key or value',
  )

  // ---------------------------------------------------------------- reference integrity (T43–T62)
  section('Finding reference integrity — exact rows, no mixing, no inference')
  const withRef = (refs: Record<string, unknown>) => draftOf({ findings: [finding(refs)] })
  const accepted = async (refs: Record<string, unknown>) => {
    const result = await record(withRef(refs))
    if (result.ok) recordedRunIds.push(result.value.id)
    return result.ok
  }
  const refusedFor = async (refs: Record<string, unknown>) => {
    const before = await prisma.validationRun.count({ where: { encounterId: encounter.id } })
    const message = await refusal(withRef(refs))
    return message !== null && /not a usable reference/.test(message) && (await prisma.validationRun.count({ where: { encounterId: encounter.id } })) === before ? message : null
  }
  check('T43', 'Activity target own Encounter', await accepted({ encounterActivityId: own.activityId }), 'accepted')
  check('T44', 'Activity target foreign Encounter', (await refusedFor({ encounterActivityId: other.activityId })) !== null, 'another Encounter’s activity is refused; nothing written')
  check('T45', 'Diagnosis target own Encounter', await accepted({ encounterDiagnosisId: own.diagnosisId }), 'accepted')
  check('T46', 'Diagnosis target foreign Encounter', (await refusedFor({ encounterDiagnosisId: other.diagnosisId })) !== null, 'refused; nothing written')
  check('T47', 'Eligibility target own Encounter', await accepted({ eligibilityVerificationId: own.eligibilityId }), 'accepted')
  check('T48', 'Eligibility target foreign Encounter', (await refusedFor({ eligibilityVerificationId: other.eligibilityId })) !== null, 'refused; nothing written')
  check('T49', 'Prior auth version own Encounter', await accepted({ priorAuthorizationVersionId: own.paVersionId }), 'accepted through its parent PriorAuthorization')
  check('T50', 'Prior auth version foreign Encounter', (await refusedFor({ priorAuthorizationVersionId: other.paVersionId })) !== null, 'refused; nothing written')
  check('T51', 'Authorization line own Encounter', await accepted({ authorizationLineId: own.lineId }), 'accepted through its version and authorization')
  check('T52', 'Authorization line foreign Encounter', (await refusedFor({ authorizationLineId: other.lineId })) !== null, 'refused; nothing written')
  const t53Missing = await refusedFor({ evidenceRequirementId: MISSING })
  check('T53', 'Evidence requirement exact', (await accepted({ evidenceRequirementId: requirement.id })) && t53Missing !== null, 'the exact A5.6 requirement under a visible RuleVersion is accepted; a missing one is refused; no content is copied')
  check('T54', 'Evidence version same tenant', await accepted({ evidenceArtifactVersionId: evidenceB.versionId }), 'accepted')
  const t55Foreign = foreignEvidence ? await refusedFor({ evidenceArtifactVersionId: foreignEvidence.id }) : null
  const t55Missing = await refusedFor({ evidenceArtifactVersionId: MISSING })
  check(
    'T55',
    'Evidence version foreign tenant',
    foreignEvidence !== null && t55Foreign !== null && t55Foreign === t55Missing,
    foreignEvidence === null ? 'no foreign-tenant evidence version exists to prove this' : 'refused with exactly the message a missing version gets, so foreign evidence is never disclosed',
  )
  check('T56', 'RuleVersion visible', (await accepted({ ruleVersionId: ruleV1.id })) && (await accepted({ ruleVersionId: sharedVersion.id })), 'an own-organization and a SYSTEM_SHARED RuleVersion are both accepted (owner decision)')
  const t57Foreign = await refusedFor({ ruleVersionId: foreignVersion.id })
  check('T57', 'RuleVersion foreign', t57Foreign !== null && t57Foreign === (await refusedFor({ ruleVersionId: MISSING })), 'another tenant’s RuleVersion is refused exactly as a missing one')
  check('T58', 'Governing source version exact', (await accepted({ governingSourceVersionId: governing.sourceVersion.id })) && (await refusedFor({ governingSourceVersionId: MISSING })) !== null, 'the exact own-organization source version is accepted; a missing one is refused')
  check(
    'T59',
    'Reference dataset version exact',
    datasetVersion !== null && (await accepted({ referenceDatasetVersionId: datasetVersion.id })) && (await refusedFor({ referenceDatasetVersionId: MISSING })) !== null,
    datasetVersion === null ? 'no reference dataset version exists to prove this' : 'an existing exact dataset version is accepted; a missing one is refused',
  )
  const t60 = await recordOk(draftOf({ findings: [finding({ ruleVersionId: ruleV1.id }), finding()] }))
  const t60Rows = await prisma.validationFinding.findMany({ where: { validationRunId: t60.id }, orderBy: { sequence: 'asc' } })
  check(
    'T60',
    'No provenance inference',
    t60Rows[0]?.ruleVersionId === ruleV1.id && t60Rows[1]?.ruleVersionId === null && t60Rows[1]?.governingSourceVersionId === null && t60Rows[1]?.referenceDatasetVersionId === null &&
      !/orderBy[^)]*version/i.test(moduleCode.code) && !/\blatest\w*\s*\(/i.test(moduleCode.code),
    `the older v1 is stored exactly although v2 (${ruleV2.id.slice(0, 8)}…) is newer; a finding without provenance stays null; no "latest" selection exists in the module`,
  )
  const t61 = await recordOk(draftOf({ findings: [finding({ encounterActivityId: own.activityId, encounterDiagnosisId: own.diagnosisId, authorizationLineId: own.lineId, evidenceRequirementId: requirement.id, evidenceArtifactVersionId: evidenceB.versionId })] }))
  const t61Row = await prisma.validationFinding.findFirstOrThrow({ where: { validationRunId: t61.id } })
  check(
    'T61',
    'Multiple target refs',
    t61Row.encounterActivityId === own.activityId && t61Row.encounterDiagnosisId === own.diagnosisId && t61Row.authorizationLineId === own.lineId && t61Row.evidenceRequirementId === requirement.id && t61Row.evidenceArtifactVersionId === evidenceB.versionId && t61Row.priorAuthorizationVersionId === null && t61Row.eligibilityVerificationId === null,
    'five exact references persist together; the line’s version and eligibility are not inferred',
  )
  const findingDto = (await get(`/api/validation-findings/${t61Row.id}`)).body
  check('T62', 'No claimLineId', !findingColumns.some((name) => /claim/i.test(name)) && ![...deepKeys(findingDto)].some((k) => /claim/i.test(k)), 'neither the finding table nor the finding DTO carries a ClaimLine or claim relation')

  // ---------------------------------------------------------------- reads (T63–T71)
  section('Read-only retrieval, ownership and safe errors')
  const listRes = await get(`/api/encounters/${encounter.id}/validation-runs`)
  const listed = ((listRes.body as any)?.items ?? []) as any[]
  const ownRunCount = await prisma.validationRun.count({ where: { encounterId: encounter.id } })
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true, serviceDate: true, facilityId: true, facilityRegulatoryProfileId: true } })
  let foreignRun: { id: string } | null = null
  let foreignFindingId: string | null = null
  if (foreignEncounter) {
    // One synthetic run on another tenant's Encounter, recorded through the same internal recorder, so
    // that cross-tenant reads have something real to be refused.
    const foreignResult = await record({
      encounterId: foreignEncounter.id,
      contextSnapshot: { serviceDate: foreignEncounter.serviceDate.toISOString().slice(0, 10), facilityId: foreignEncounter.facilityId, facilityRegulatoryProfileId: foreignEncounter.facilityRegulatoryProfileId, insuranceMembershipId: null, payerId: null, tpaId: null, networkId: null, insuranceProductId: null, providerContractId: null, tariffScheduleId: null, tariffScheduleVersionId: null },
      validatorVersion: `${runId}-FOREIGN`,
      findings: [finding({ findingCode: 'FOREIGN_SECRET_CODE', message: 'Synthetic foreign finding.' })],
    })
    if (foreignResult.ok) {
      foreignRun = { id: foreignResult.value.id }
      foreignFindingId = (await prisma.validationFinding.findFirst({ where: { validationRunId: foreignResult.value.id }, select: { id: true } }))?.id ?? null
    }
  }
  const foreignList = foreignEncounter ? await get(`/api/encounters/${foreignEncounter.id}/validation-runs`) : null
  check(
    'T63',
    'Run list ownership',
    listRes.status === 200 && listed.length === ownRunCount && listed.every((item) => item.encounterId === encounter.id) && foreignList !== null && foreignList.status >= 400 && foreignList.status < 500,
    `${listed.length} run(s), all of this Encounter; another tenant’s Encounter list is ${foreignList?.status}`,
  )
  // Two runs recorded inside one transaction share their evaluatedAt, so the tie-breakers are exercised.
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < 2; i += 1) {
      const result = await recordValidationRunInTransaction(draftOf(), actorUserId, tx)
      if (result.ok) recordedRunIds.push(result.value.id)
    }
  })
  const ordered = ((await get(`/api/encounters/${encounter.id}/validation-runs`)).body as any)?.items as any[]
  const expectedOrder = [...ordered].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  const sharedInstant = ordered.filter((item) => ordered.some((otherItem) => otherItem.id !== item.id && otherItem.evaluatedAt === item.evaluatedAt)).length
  check('T64', 'Run list order', ordered.length >= 3 && JSON.stringify(ordered.map((i) => i.id)) === JSON.stringify(expectedOrder.map((i) => i.id)) && sharedInstant >= 2, `evaluatedAt DESC, createdAt DESC, id ASC across ${ordered.length} runs, ${sharedInstant} of them sharing one evaluation instant`)
  const t65a = await get(`/api/validation-runs/${t38.id}`)
  const t65b = await get(`/api/validation-runs/${t38.id}`)
  check(
    'T65',
    'Run GET',
    t65a.status === 200 && JSON.stringify(t65a.body) === JSON.stringify(t65b.body) && (t65a.body as any).evaluatedAt === t38Row.evaluatedAt.toISOString() && (t65a.body as any).findingCount === 1 && JSON.stringify((t65a.body as any).context) === JSON.stringify(t38Context),
    'the exact stored run, its context and finding count, byte-identical across two reads',
  )
  const t66 = await get(`/api/validation-runs/${t08.id}/findings`)
  const t66Items = ((t66.body as any)?.items ?? []) as any[]
  check('T66', 'Finding list', t66.status === 200 && JSON.stringify(t66Items.map((i) => i.sequence)) === '[1,2,3]' && t66Items.every((i) => i.validationRunId === t08.id) && t66Items[1].findingCode === 'SECOND', 'exactly this run’s findings, sequence ascending')
  const t67 = await get(`/api/validation-findings/${t61Row.id}`)
  const t67Body = t67.body as any
  check(
    'T67',
    'Finding GET',
    t67.status === 200 && t67Body.id === t61Row.id && t67Body.findingCode === t61Row.findingCode && t67Body.message === t61Row.message && t67Body.targets.authorizationLineId === own.lineId && t67Body.provenance.ruleVersionId === null && t67Body.createdAt === t61Row.createdAt.toISOString(),
    'the exact immutable finding with its provenance and target references',
  )
  const viewerReads = [
    (await get(`/api/encounters/${encounter.id}/validation-runs`, asViewer)).status,
    (await get(`/api/validation-runs/${t08.id}`, asViewer)).status,
    (await get(`/api/validation-runs/${t08.id}/findings`, asViewer)).status,
    (await get(`/api/validation-findings/${t08Findings[0].id}`, asViewer)).status,
  ]
  check('T68', 'Viewer reads', viewerReads.every((code) => code === 200), `a viewer reads runs and findings of its own organization (${viewerReads.join('/')})`)
  const foreignRunRead = foreignRun ? await get(`/api/validation-runs/${foreignRun.id}`) : null
  const foreignFindingsRead = foreignRun ? await get(`/api/validation-runs/${foreignRun.id}/findings`) : null
  const leaked = (body: unknown) => /FOREIGN_SECRET_CODE|Synthetic foreign finding|facilityId|evaluatedAt/.test(JSON.stringify(body ?? {}))
  check(
    'T69',
    'Cross-tenant run',
    foreignRunRead !== null && foreignRunRead.status >= 400 && foreignRunRead.status < 500 && foreignFindingsRead!.status >= 400 && foreignFindingsRead!.status < 500 && !leaked(foreignRunRead.body) && !leaked(foreignFindingsRead!.body),
    foreignRun === null ? 'no foreign-tenant Encounter exists to record a run on, so this could not be proven' : `refused ${foreignRunRead?.status}/${foreignFindingsRead?.status}; no code, message or context id leaks`,
  )
  const foreignFindingRead = foreignFindingId ? await get(`/api/validation-findings/${foreignFindingId}`) : null
  check(
    'T70',
    'Cross-tenant finding',
    foreignFindingRead !== null && foreignFindingRead.status >= 400 && foreignFindingRead.status < 500 && !leaked(foreignFindingRead.body),
    foreignFindingId === null ? 'no foreign finding could be recorded, so this could not be proven' : `refused ${foreignFindingRead?.status}; nothing disclosed`,
  )
  const malformed: number[] = []
  const malformedBodies: string[] = []
  for (const path of ['/api/encounters/not-a-uuid/validation-runs', '/api/validation-runs/not-a-uuid', '/api/validation-runs/not-a-uuid/findings', '/api/validation-findings/not-a-uuid', `/api/validation-runs/${MISSING}`, `/api/validation-findings/${MISSING}`]) {
    const res = await get(path)
    malformed.push(res.status)
    malformedBodies.push(JSON.stringify(res.body ?? {}))
  }
  check('T71', 'Malformed IDs', malformed.every((code) => code === 400 || code === 404) && malformedBodies.every((text) => !/prisma|postgres|syntax|invalid input|uuid/i.test(text)), `${malformed.join(', ')}; safe envelopes, never raw database text or a 500`)

  // ---------------------------------------------------------------- audit and atomicity (T72–T76)
  section('One safe audit per run; atomic, complete runs')
  const auditRows = await prisma.auditEvent.findMany({ where: { entityType: 'VALIDATION_RUN', entityId: { in: recordedRunIds } }, select: { entityId: true, actionCode: true, afterState: true, beforeState: true } })
  const perRun = recordedRunIds.map((id) => auditRows.filter((row) => row.entityId === id).length)
  check('T72', 'Audit count', recordedRunIds.length > 10 && perRun.every((n) => n === 1) && auditRows.every((row) => row.actionCode === 'validation_run.recorded'), `exactly one validation_run.recorded per complete run across ${recordedRunIds.length} runs, never one per finding`)
  const allRunAudits = await prisma.auditEvent.findMany({ where: { entityType: 'VALIDATION_RUN' }, select: { afterState: true, beforeState: true } })
  const auditNeedles = ['findingCode', 'message', 'fieldPath', 'layer', 'outcome', 'encounterId', 'facilityId', 'payerId', 'providerContractId', 'ruleVersionId', 'evidenceArtifactVersionId', 'SYNTHETIC_CHECK', encounter.id, payer.id, memberIdentifier]
  const auditLeaks = allRunAudits.filter((row) => row.beforeState !== null || JSON.stringify(Object.keys((row.afterState ?? {}) as object).sort()) !== '["createdAt","evaluatedAt","id","validatorVersion"]' || auditNeedles.some((needle) => JSON.stringify(row.afterState ?? {}).includes(needle)))
  check('T73', 'Audit minimization', allRunAudits.length > 0 && auditLeaks.length === 0, `every one of ${allRunAudits.length} run audit rows holds { id, evaluatedAt, validatorVersion, createdAt } only — no finding, context, target or provenance content`)
  const rollback = async (probe: string) => {
    const validatorVersion = `${runId}-ROLLBACK-${probe}`
    const auditBefore = await prisma.auditEvent.count({ where: { entityType: 'VALIDATION_RUN' } })
    failAt(probe, 'forced failure (acceptance)')
    let threw = false
    try {
      await record(draftOf({ validatorVersion, findings: [finding(), finding({ findingCode: 'SECOND' })] }))
    } catch {
      threw = true
    }
    clearConcurrencyProbes()
    return threw && (await runsWithVersion(validatorVersion)) === 0 && (await prisma.validationFinding.count({ where: { validationRun: { validatorVersion } } })) === 0 && (await prisma.auditEvent.count({ where: { entityType: 'VALIDATION_RUN' } })) === auditBefore
  }
  check('T74', 'Atomic rollback', await rollback('validation_run.recorded'), 'a forced failure after the audit left no run, no finding and no audit')
  check('T75', 'No partial finding batch', (await rollback('validation_run.findings_inserted')) && (await rollback('validation_run.run_inserted')), 'a failure after the findings, or after the run but before any finding, rolls the whole run back')
  const emptyRuns = Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM validation_runs r WHERE NOT EXISTS (SELECT 1 FROM validation_findings f WHERE f.validation_run_id = r.id)`)[0].n)
  const lateInsert = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe("INSERT INTO validation_findings (id, validation_run_id, sequence, layer, outcome, finding_code, message) VALUES (gen_random_uuid(), $1::uuid, 99, 'TECHNICAL', 'PASS', 'LATE_ADDITION', 'Synthetic late addition.')", t08.id),
  )
  check(
    'T76',
    'Run complete after commit',
    emptyRuns === 0 && /never added to an earlier run/.test(lateInsert) && (await prisma.validationFinding.count({ where: { validationRunId: t08.id } })) === 3,
    'no committed run has zero findings, and a committed run’s finding set is closed: a later insert into it is refused (owner-approved trigger)',
  )

  // ---------------------------------------------------------------- scope guards (T77–T92)
  section('Scope guards — persistence only; no engine, readiness, claim or transport')
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).map((row) => row.table_name)
  const dtoKeys = [...deepKeys(runDto), ...deepKeys(findingDto), ...deepKeys(listRes.body), ...deepKeys(t66.body)]
  check('T77', 'PASS not payer acceptance', !dtoKeys.some((k) => /payerAccepted|submissionAllowed|approvedForSubmission/i.test(k)) && ![...runColumns, ...findingColumns].some((c) => /payer_accepted|submission|approved_for/i.test(c)) && !/payerAccepted|submissionAllowed/.test(moduleCode.code.replace(/serverOwned\w*\s*=\s*\[[\s\S]*?\]/g, '')), 'no payerAccepted or submissionAllowed field in any table, DTO or decision path')
  check('T78', 'No overall run outcome', !runColumns.some((c) => /outcome|status|readiness|ready|result/i.test(c)) && !Object.keys((runDto ?? {}) as object).some((k) => /outcome|status|readiness|result/i.test(k)), 'the run carries no PASS/FAIL, status or readiness column or field; outcomes exist only per finding')
  check('T79', 'No current/latest', ![...runColumns, ...findingColumns].some((c) => /current|latest|winner|best|approved/i.test(c)) && !dtoKeys.some((k) => /isCurrent|isLatest|current|latest|winner/i.test(k)), 'no current, latest or winner pointer in any column or DTO')
  check(
    'T80',
    'No validation engine',
    moduleCode.files.length >= 7 && !/(layer|outcome)\s*===?\s*['"]|outcome\s*:\s*['"](PASS|WARNING|RESTRICT|FAIL)['"]|function\s+(execute|run|evaluate)\w*(Layer|Technical|Coding|Coverage|Contract|Evidence)/.test(moduleCode.code),
    `across ${moduleCode.files.length} production files no layer is executed and no outcome is computed — the recorder only stores what the validator produced`,
  )
  const importsOf = (pattern: RegExp) => [...moduleCode.code.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((path) => pattern.test(path))
  check('T81', 'No A3 resolver execution', importsOf(/rule-(resolution|provenance|applicability|source-binding|pack)/).length === 0 && !/evaluateRuleResolution|composeRuleDecisionProvenance|resolveApplicab|precedence/i.test(moduleCode.code), 'no applicability, precedence or provenance selection path is imported or called')
  check('T82', 'No eligibility execution', importsOf(/eligibility-verification/).length === 0 && !/\b(FRESH|STALE|freshness|validThrough)\b/.test(moduleCode.code), 'no eligibility freshness or status decision')
  check('T83', 'No authorization execution', importsOf(/(authorization-line|prior-authorization)/).length === 0 && !/scope-evaluation|evaluateAuthorizationScope|matchLine|MATCHED/.test(moduleCode.code), 'no authorization matching or satisfaction decision')
  check('T84', 'No commercial resolution', importsOf(/pre-claim-commercial-context|commercial-coverage|provider-contract|tariff/).length === 0 && !/resolvePreClaimCommercialContext|providerContract\.findMany|tariffScheduleVersion\.findMany/.test(moduleCode.code), 'no contract or tariff candidate is resolved; context ids are only checked for tenancy')
  check('T85', 'No evidence completeness execution', importsOf(/evidence-requirement|encounter-evidence/).length === 0 && !/classifyCandidate|evaluateRequirement|evaluateEvidenceCompleteness|documentType|sourceDate/.test(moduleCode.code), 'no document-requirement matching or staleness evaluation')
  // A5.9 legitimately creates pre_claim_readiness_assessments; A5.7 must never carry or compose readiness
  // itself, so its own run and finding columns, its DTOs and its code are what is judged.
  check(
    'T86',
    'No readiness',
    runColumns.length > 0 && findingColumns.length > 0 && ![...runColumns, ...findingColumns].some((c) => /ready|readiness/i.test(c)) && !dtoKeys.some((k) => /ready|readiness/i.test(k)) && !/readyForClaim|composeReadiness|readinessState/.test(moduleCode.code),
    'no ready, restrict or block aggregate on a run, a finding, a DTO or in the module',
  )
  check('T87', 'No Claim', !tables.some((t) => /(^claims?$|claim_lines?|claim_submissions?)/.test(t)) && !/(prisma|tx|db)\.(claim|claimLine|claimSubmission)\b/.test(moduleCode.code), 'no Claim, ClaimLine or ClaimSubmission table or access')
  check('T88', 'No real integration', !/\b(fetch|axios|https?\.request|dhpo|eclaimlink|apiKey|clientSecret)\b/i.test(moduleCode.code), 'no payer, DHPO or eClaimLink network call or credential')
  const jsonColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('validation_runs','validation_findings') AND data_type IN ('json','jsonb')`).map((row) => row.c)
  const schemaModels = (git('show HEAD:backend/prisma/schema.prisma').match(/model Validation(Run|Finding) \{[\s\S]*?\n\}/g) ?? []).join('\n')
  check('T89', 'No JSON blobs', schemaModels.length > 0 && jsonColumns.length === 0 && !/\bJson\b/.test(schemaModels), 'no JSON/JSONB column or Prisma Json field for context, findings or provenance')
  const feCode = committedCodeOf(FRONTEND_DIR)
  check(
    'T90',
    'Frontend read-only',
    feCode.files.length > 0 && feCode.code.includes('listRuns') && !/method\s*:\s*['"](POST|PATCH|PUT|DELETE)['"]|recordValidationRun|\/execute/.test(feCode.code),
    'the developer check only reads; no create, execute, update or delete call (search verified to reach the source)',
  )
  check(
    'T91',
    'Frontend privacy',
    feCode.files.length > 0 && !/\b(localStorage|sessionStorage|indexedDB)\s*\.\s*[A-Za-z]+\s*\(/.test(feCode.code) && !/item\.(message|fieldPath|context)|insuranceMembershipId|memberIdentifier|provenance/.test(feCode.code),
    'nothing in browser storage; no message, field path, context id or provenance is rendered',
  )
  const scanPaths = [`:/${MODULE_DIR}`, `:/${FRONTEND_DIR}`]
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const urlScan = gitGrep('[?&](encounterId|findingCode|message|fieldPath|payerId|memberIdentifier)=', scanPaths)
  const reach = gitGrep('validationRun', scanPaths)
  check('T92', 'Logging scan', reach.status === 0 && logScan.status === 1 && urlScan.status === 1, 'no console output and no finding, context or member value in a query string (search verified to reach the source)')

  // ---------------------------------------------------------------- gates and regressions (T93–T102)
  section('Build gates, regressions and database truth')
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T93', 'Unit/typecheck/build', unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok && build.ok && lint.ok, `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]}, typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)

  // §24: the owner suites are INVOKED, never reimplemented. A5.6's suite nests A5.5 -> A5.4 -> A5.3 ->
  // A5.2 -> A5.1 -> A4 -> A3 -> A2 -> A1, so one invocation covers T94 to T101.
  await apiReady('the A5.6 and backward regression chain')
  const chain = run('npm run test:a5:evidence-completeness')
  const rows = suiteLines(chain.output, 'A5.6')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A5.6] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A5.6 asserts facts about its own branch and migration, and one of its scope proofs asserts that no
  // validation table exists. A5.7 creates exactly validation_runs and validation_findings, which is the
  // boundary this package exists to cross. Each is listed with its own reason; any other id is a
  // genuine regression.
  const a56NonApplicable: Record<string, string> = {
    T01: "A5.6 'Start gate' requires the current branch to be the A5.6 feature branch; A5.7 is a different branch, branched from the merged A5.6 main",
    T03: "A5.6 'Migration scope' judges the single migration this branch adds against main; on A5.7 that migration is A5.7's own, which creates no A5.6 table",
    T104: "A5.6 'No ValidationRun/Finding' forbids any validation_run/validation_finding table; A5.7 creates exactly those two, which is the boundary this package crosses",
    T121: "A5.6 'Diff scope' lists the paths A5.6 was allowed to change; A5.7 legitimately changes different ones",
    T123: "A5.6 'Exact head evidence' requires the upstream to be the A5.6 feature branch, which was deleted when PR #56 merged",
  }
  const undocumented = failing.filter((id) => !(id in a56NonApplicable))
  const counts = chain.output.match(/\[A5\.6\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T112') && rows.some((row) => row.id === 'T118')
  check(
    'T94',
    'A5.6 regression',
    ran && reconciled && undocumented.length === 0,
    !ran ? 'the A5.6 suite did not reach its regression checks' : !reconciled ? `A5.6 reports ${failedCount} failure(s) but ${failing.length} could be named` : undocumented.length > 0 ? `undocumented A5.6 failures: ${undocumented.join(', ')}` : `${(chain.output.match(/\[A5\.6\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.6] automated summary: ', 'A5.6 ')}; all ${failedCount} failure(s) named and accounted for, and every evidence requirement and completeness invariant still holds`,
  )
  // A failing child suite is never hidden behind its id: every undocumented A5.6 failure is printed
  // with the detail A5.6 itself gave, so the nested cause is visible in this run's own output.
  for (const id of undocumented) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) console.log(`[A5.7]      ${row.line.slice(0, 400)}`)
  }
  for (const id of Object.keys(a56NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T94/${id}`, `A5.6 ${titleOf(row.line)}`, a56NonApplicable[id])
  }
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check('T95', 'A5.5 regression', verdictOf('T112') === 'PASS', `A5.6 T112 (A5.5) ${verdictOf('T112')}`)
  check('T96', 'A5.4 regression', verdictOf('T113') === 'PASS', `A5.6 T113 (A5.4) ${verdictOf('T113')}`)
  check('T97', 'A5.3 regression', verdictOf('T114') === 'PASS', `A5.6 T114 (A5.3) ${verdictOf('T114')}`)
  check('T98', 'A5.2/A5.1 regressions', verdictOf('T115') === 'PASS', `A5.6 T115 (A5.2 and A5.1) ${verdictOf('T115')}`)
  check('T99', 'A4 regressions', verdictOf('T116') === 'PASS', `A5.6 T116 (A4.10 and A4.9 to A1) ${verdictOf('T116')}`)
  for (const text of chain.output.split(/\r?\n/).filter((l) => l.startsWith('[A5.6]      ') && / substantive checks /.test(l))) console.log(`[A5.7]      ${text.replace('[A5.6]', '').trim().slice(0, 190)}`)
  check('T100', 'A3 regressions', verdictOf('T117') === 'PASS', `A5.6 T117 (A3) ${verdictOf('T117')}: only the two A3-era no-A5 guards remain tolerated`)
  check('T101', 'A2/A1 regressions', verdictOf('T118') === 'PASS', `A5.6 T118 (A2 and A1) ${verdictOf('T118')}`)

  await apiReady('the DB truth check')
  const upHealth = await health()
  const upReady = await ready()
  const stopped = spawnSync('docker', ['stop', dbContainer], { encoding: 'utf8' }).status === 0
  const downReady = await waitFor(async () => (await ready()) === 503, 30_000)
  const downSamples: number[] = []
  for (let i = 0; i < 5; i += 1) {
    downSamples.push(await health())
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const restarted = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  check('T102', 'DB truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- closure (T103–T106)
  section('Repeatability, diff scope and exact head')
  await waitFor(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return true
    } catch {
      return false
    }
  }, 60_000)
  const priorRuns = await prisma.validationRun.count({ where: { validatorVersion: { startsWith: 'A57-' }, createdAt: { lt: runStartedAt } } })
  const thisRun = await prisma.validationRun.count({ where: { validatorVersion: { startsWith: runId } } })
  check('T103', 'Repeatability', thisRun > 10, `this run used a fresh synthetic runId (${runId}) and recorded ${thisRun} run(s) of its own; ${priorRuns} run(s) from earlier runs retained as history, none deleted or patched`)
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.types.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith(`${MODULE_DIR}/`) &&
      !file.startsWith('backend/src/integration/a5-validation-foundation/') &&
      !file.startsWith(`${FRONTEND_DIR}/`) &&
      !file.includes('a5_7_validation_run_finding_foundation') &&
      !allowed.includes(file),
  )
  const futureImport = moduleCode.code.match(/from '[^']*modules\/(readiness|claim|claim-line|submission|remittance|pricing|validation-execution)/)
  check(
    'T104',
    'Diff scope',
    outOfScope.length === 0 && futureImport === null,
    outOfScope.length === 0 && futureImport === null ? `${changedPaths.length} path(s): the validation-run module, its migration, harness and check page, the replay verifier, and wiring; no A5.8+, A6 or A9 domain and no validation execution` : `unexpected: ${[...outOfScope, futureImport?.[0]].filter(Boolean).join(', ').slice(0, 220)}`,
  )
  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [':/backend/src/integration/a5-validation-foundation', `:/${MODULE_DIR}`, `:/${FRONTEND_DIR}`],
  )
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git('show HEAD:backend/src/integration/a5-validation-foundation/a5-validation-foundation.integration.ts')
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [':/backend/src/integration/a5-validation-foundation'])
  check(
    'T105',
    'Secret/PHI scan',
    secretReach.status === 0 && /Synthetic|synthetic/.test(harnessSource) && secretScan.status === 1 && harnessSource.match(realDataMarkers) === null,
    secretReach.status !== 0 ? 'the scan did not reach the committed harness source, so this absence is unproven' : 'no credential, real patient, member or evidence content is committed; every credential is read from the local environment at run time',
  )
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T106', 'Exact head evidence', headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a57Branch}`), `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`)

  console.log(`\n[A5.7] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A5.7] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.7] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A5.7] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A5.7] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.7] A5.7 VALIDATION RUN / FINDING FOUNDATION ACCEPTANCE COMPLETE' : '[A5.7] A5.7 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A5.7] RUN ABORTED: ${error.message}`)
      console.log('[A5.7] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A5.7] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.7] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
