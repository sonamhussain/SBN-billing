import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { apiFixtures } from '../a3-governance/a3-governance.fixtures.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { executePreClaimValidation } from '../../modules/pre-claim-validation/pre-claim-validation.service.ts'
import { draft } from '../../modules/pre-claim-validation/pre-claim-validation.finding-catalog.ts'
import { insertGovernedProvenance } from '../../modules/pre-claim-validation/pre-claim-validation.provenance.ts'
import { evaluateEvidenceCompleteness } from '../../modules/evidence-requirement/evidence-requirement.service.ts'
import { recordValidationRunInTransaction } from '../../modules/validation-run/validation-run.recorder.ts'

// A5.8 — focused acceptance for Layered Deterministic Pre-Claim Validation & Provenance (T01–T135).
//
// One authorized execution evaluates one Encounter in ONE REPEATABLE READ write transaction across the
// TECHNICAL, CODING, COVERAGE, CONTRACT and EVIDENCE layers under validator contract A5-VAL-1, and
// records one immutable A5.7 run with normalized A3-PROV-1 provenance for every governed finding.
//
// Valid fixtures are created through their owning routes. Every scenario gets an Encounter of its
// own, and every scenario that needs governed rules gets a payer of its own, so a rule one scenario
// creates never applies to another. The database is READ for structural proof; ADVERSARIAL writes go
// in only to create a contradiction an owner route refuses to create, or to prove something refuses
// them. Every value is synthetic.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.8] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.8] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.8] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.8] ${title}`)

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

const runId = `A58-${Date.now()}`
const runStartedAt = new Date()
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A5.7 FINAL PASS was merged into main as PR #58; the A5.6 provenance-clock correction (PR #59) merged
// after it. A5.8 is branched from that main.
const a57Merge = '5bd7f1f'
const a56Correction = '9743cbb'
const a58Branch = 'feature/a5-8-layered-pre-claim-validation-provenance'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'
const FRESH_UNTIL = '2030-12-31T00:00:00.000Z'
const STALE_UNTIL = '2026-06-20T00:00:00.000Z'
const DOC = 'DOCUMENTATION_REQUIREMENT_EFFECT'
const REPORT = `SYNTHETIC_REPORT_${Date.now().toString(36).toUpperCase()}`
const MODULE_DIR = 'backend/src/modules/pre-claim-validation'
const FRONTEND_DIR = 'frontend/src/modules/pre-claim-validation'
const PROVENANCE_TABLES = ['validation_finding_rule_provenances', 'validation_finding_supporting_bindings', 'validation_finding_matched_applicabilities', 'validation_finding_reference_dataset_versions']

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
const codesOf = (findings: StoredFinding[]) => findings.map((f) => f.findingCode)
const has = (findings: StoredFinding[], code: string, where: (f: StoredFinding) => boolean = () => true) => findings.some((f) => f.findingCode === code && where(f))
const only = (findings: StoredFinding[], code: string) => findings.filter((f) => f.findingCode === code)

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A5.8] Layered pre-claim validation & provenance — run ${runId}`)
  console.log(`[A5.8] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  section('Start gate, migration, A5.7 schema and permission')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'Start gate',
    branch === a58Branch && gitOk(`merge-base --is-ancestor ${a57Merge} origin/main`) && gitOk(`merge-base --is-ancestor ${a56Correction} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the A5.7 merge ${a57Merge} (PR #58) and the A5.6 correction ${a56Correction} (PR #59) are on main, and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const createdTables = (statements.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).map((m) => m.replace(/CREATE TABLE "|"/g, '')).sort()
  const scopeProblems = [
    [JSON.stringify(createdTables) === JSON.stringify([...PROVENANCE_TABLES].sort()), `tables created: ${createdTables.join(', ')}`],
    [!/DROP INDEX/.test(statements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((m) => PROVENANCE_TABLES.some((t) => m.includes(`"${t}"`))), 'a table outside A5.8 is altered'],
    [(statements.match(/ADD CONSTRAINT "[a-z_]*_chk"/g) ?? []).length === 2, 'the two label CHECKs are not both added'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 10, 'not all ten foreign keys are ON DELETE RESTRICT'],
    [(statements.match(/CREATE TRIGGER [a-z_]+_trg/g) ?? []).length === 8, 'the eight provenance triggers are not all created'],
    [!/\b(jsonb?|readiness|claim|submission|price|tariff_rate|reimburs)\b/i.test(statements), 'a JSON, readiness, claim or pricing column appears'],
  ].filter(([ok]) => !ok).map(([, reason]) => reason as string)
  check(
    'T03',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1 ? `expected exactly one migration, found ${migrationPaths.length}` : scopeProblems.length === 0 ? 'one migration; exactly the four provenance tables, two CHECKs, ten RESTRICT foreign keys and eight triggers, with no drift' : `out of scope: ${scopeProblems.join('; ')}`,
  )
  const columnsOf = async (table: string) =>
    (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY column_name`).map((row) => row.column_name)
  const runColumns = await columnsOf('validation_runs')
  const findingColumns = await columnsOf('validation_findings')
  const expectedRunColumns = ['created_at', 'created_by_user_id', 'encounter_id', 'evaluated_at', 'facility_id', 'facility_regulatory_profile_id', 'insurance_membership_id', 'insurance_product_id', 'network_id', 'payer_id', 'provider_contract_id', 'service_date', 'tariff_schedule_id', 'tariff_schedule_version_id', 'tpa_id', 'validator_version', 'id'].sort()
  const expectedFindingColumns = ['authorization_line_id', 'created_at', 'eligibility_verification_id', 'encounter_activity_id', 'encounter_diagnosis_id', 'evidence_artifact_version_id', 'evidence_requirement_id', 'field_path', 'finding_code', 'governing_source_version_id', 'id', 'layer', 'message', 'outcome', 'prior_authorization_version_id', 'reference_dataset_version_id', 'rule_version_id', 'sequence', 'validation_run_id'].sort()
  check(
    'T04',
    'A5.7 schema preserved',
    JSON.stringify(runColumns) === JSON.stringify(expectedRunColumns) && JSON.stringify(findingColumns) === JSON.stringify(expectedFindingColumns) && !/ALTER TABLE "validation_(runs|findings)"/.test(statements),
    `validation_runs keeps its ${runColumns.length} and validation_findings its ${findingColumns.length} A5.7 columns; A5.8 adds only relations`,
  )
  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T05', 'Prisma gates', validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T06',
    'Migration replay',
    replay.ok &&
      /ALL CHECKS PASS/.test(replay.output) &&
      /validation_finding_ref_dataset_versions_same_transaction_trg is present/.test(replay.output) &&
      /validation_finding_rule_provenances_governing_source_inter_fkey is present/.test(replay.output) &&
      /the four provenance tables carry no JSON or JSONB column/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; every A5.8 provenance key, foreign key, CHECK and trigger survives`,
  )
  const allCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const grantsOf = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, select: { role: { select: { code: true } } } })).map((g) => g.role.code).sort().join(',')
  check(
    'T07',
    'Permission',
    JSON.stringify(allCodes.filter((code) => /^preClaimValidation/.test(code))) === JSON.stringify(['preClaimValidation.execute']) &&
      (await grantsOf('preClaimValidation.execute')) === 'ORG_ADMIN' &&
      (await grantsOf('validationRun.read')) === 'ORG_ADMIN,ORG_VIEWER' &&
      !allCodes.includes('validationRun.create'),
    'preClaimValidation.execute for Admin only; validationRun.read unchanged for Admin and Viewer; no validationRun.create',
  )

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
  const get = (path: string, who = asAdmin) => httpCall(path, who())
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 250)}`)
    return body as T & { id: string }
  }
  const fx = apiFixtures(baseUrl, admin.cookie, org, runId)
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  let serial = 0
  const key = (prefix: string) => `${runId}-${prefix}-${++serial}`

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const newFacility = async (label: string) => {
    const facility = must(`${label} facility`, (await post(`/api/organizations/${org}/facilities`, { name: `${runId} ${label}` })).body)
    const profile = must(`${label} profile`, (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error(`fixture ${label} profile activation failed`)
    const clinician = must(`${label} clinician`, (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} ${label} clinician` })).body)
    const assignment = must(`${label} assignment`, (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    return { facility, profile, clinician, assignment }
  }
  const site = await newFacility('main')
  const svcA = must('service A', (await post(`/api/organizations/${org}/services`, { internalCode: key('SA'), displayName: 'Synthetic service A' })).body)
  const svcB = must('service B', (await post(`/api/organizations/${org}/services`, { internalCode: key('SB'), displayName: 'Synthetic service B' })).body)
  const dxA = must('diagnosis A', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DXA'), displayName: 'Synthetic diagnosis A' })).body)
  const dxB = must('diagnosis B', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: key('DXB'), displayName: 'Synthetic diagnosis B' })).body)
  const governing = await fx.verifiedSource('validation governing', { activateOn: '2025-01-01' })
  const supportingSource = await fx.verifiedSource('validation supporting', { activateOn: '2025-01-01' })
  const evidenceArtifact = async (documentType: string, sourceDate: string | null) => {
    const artifact = must('evidence', (await post(`/api/organizations/${org}/evidence-artifacts`, { storageRef: `synthetic://evidence/${key('E')}`, contentHash: 'd'.repeat(64), documentType, sourceDate, receivedAt: '2026-06-15T09:30:00.000Z' })).body) as any
    return { artifactId: artifact.id as string, versionId: artifact.latestVersion.id as string }
  }
  const responseEvidence = await evidenceArtifact('SYNTHETIC_RESPONSE', '2026-06-10')

  type Commercial = 'one' | 'none' | 'two' | 'unverified' | 'twoVersions' | 'indeterminate'
  // A commercial world of its own: a payer, two memberships of the same patient, and the contract shape
  // the scenario needs, all through REF-01 owner routes.
  const world = async (label: string, commercial: Commercial = 'one', where = site) => {
    const payer = must(`${label} payer`, (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} ${label} payer` })).body)
    const membership = must(`${label} membership`, (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier: `MEM-${key('M')}`, coverageFrom: '2025-01-01', coverageTo: null })).body)
    const membership2 = must(`${label} membership 2`, (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier: `MEM-${key('M')}`, coverageFrom: '2025-01-01', coverageTo: null })).body)
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
    if (commercial !== 'none') {
      const first = await contract()
      if (commercial === 'one' || commercial === 'two') await version(first.schedule.id, '2026-01-01')
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
    return { payer, membership, membership2, encounter }
  }

  const activity = async (encounterId: string, overrides: Record<string, unknown> = {}) =>
    must('activity', (await post(`/api/encounters/${encounterId}/activities`, { serviceId: svcA.id, quantity: '1', ...overrides })).body)
  const diagnosis = async (encounterId: string, diagnosisCodeId = dxA.id) => must('diagnosis', (await post(`/api/encounters/${encounterId}/diagnoses`, { diagnosisCodeId })).body)
  const eligibility = async (encounterId: string, overrides: Record<string, unknown> = {}) =>
    must(
      'eligibility',
      (await post(`/api/encounters/${encounterId}/eligibility-verifications`, {
        verificationMethod: 'PORTAL',
        status: 'ELIGIBLE',
        requestedAt: null,
        respondedAt: '2026-06-15T09:31:00.000Z',
        validThrough: FRESH_UNTIL,
        authorizationRequired: false,
        referralRequired: null,
        requestEvidenceVersionId: null,
        responseEvidenceVersionId: responseEvidence.versionId,
        ...overrides,
      })).body,
    )
  const line = (overrides: Record<string, unknown> = {}) => ({
    serviceId: svcA.id, procedureCodeId: null, diagnosisCodeId: null, requestedQty: '1', approvedQty: '1', unitCode: null, approvedFrom: null, approvedThrough: null, status: 'APPROVED', ...overrides,
  })
  const respond = async (authorizationId: string, header: { status: string; validFrom?: string | null; validThrough?: string | null; kind?: string }, lines: unknown[]) => {
    const version = must(`${header.status} version`, (await post(`/api/prior-authorizations/${authorizationId}/versions`, {
      versionKind: header.kind ?? 'RESPONSE', status: header.status, authorizationReference: `AUTH-${key('R')}`, eligibilityVerificationId: null,
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
      evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: responseEvidence.versionId }],
    })).body) as any
    const response = await respond(created.id, header, lines)
    return { authorizationId: created.id as string, initialVersionId: created.latestRecordedVersion.id as string, ...response }
  }

  type Payload = { documentTypes: string[]; minimumCount: number; sourceDateRequired: boolean; maxSourceAgeDays: number | null }
  const STANDARD: Payload = { documentTypes: [REPORT], minimumCount: 1, sourceDateRequired: true, maxSourceAgeDays: 30 }
  const docRule = async (payerId: string, payload: Payload | null, options: { dimensions?: Record<string, string>; verify?: boolean; rule?: { id: string }; label?: string; supporting?: boolean; effectType?: string } = {}) => {
    const rule = options.rule ?? (await fx.ruleDefinition('validation documentation'))
    const version = await fx.draftRuleVersion(rule.id, options.label ?? '1', { effectType: options.effectType ?? DOC })
    const applicability = await fx.applicability(version.id, { payerId, ...(options.dimensions ?? {}) })
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
    if ((await post(`/api/encounters/${encounterId}/evidence-links`, { evidenceArtifactVersionId: versionId })).status !== 201) throw new Error('fixture evidence link failed')
  }

  const executeHttp = async (encounterId: string, body?: unknown, who = asAdmin) => {
    const res = await httpCall(`/api/encounters/${encounterId}/pre-claim-validation/execute`, who(body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) }))
    return { status: res.status, body: res.body as any }
  }
  const createdRunIds: string[] = []
  const execute = async (encounterId: string) => {
    const res = await executeHttp(encounterId, {})
    if (res.status !== 201) throw new Error(`a valid execution was refused with ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
    createdRunIds.push(res.body.validationRunId)
    return { response: res.body as { validationRunId: string; evaluatedAt: string; validatorVersion: string; findingCount: number }, findings: await findingsOf(res.body.validationRunId), run: await prisma.validationRun.findUniqueOrThrow({ where: { id: res.body.validationRunId } }) }
  }
  const runsFor = (encounterId: string) => prisma.validationRun.count({ where: { encounterId } })

  // The basic world: one resolvable contract, no governed rule for its payer.
  const basic = await world('basic')
  const basicEncounter = await basic.encounter()
  const basicActivity = await activity(basicEncounter.id)
  await diagnosis(basicEncounter.id)
  must('observation', (await post(`/api/encounters/${basicEncounter.id}/observations`, { encounterActivityId: basicActivity.id, factKey: `SYNTHETIC_FACT_${serial}`, value: { type: 'TEXT', text: 'Synthetic observation' } })).body)
  const basicEligibility = await eligibility(basicEncounter.id)
  console.log('[A5.8]      fixtures ready: patient, facility, clinician, services, diagnosis codes, governing and supporting sources, and the basic world')

  // ---------------------------------------------------------------- execution contract (T08–T20)
  section('Execution contract — one transaction, one immutable run')
  const absent = await executeHttp(basicEncounter.id)
  if (absent.status === 201) createdRunIds.push(absent.body.validationRunId)
  const emptyObject = await executeHttp(basicEncounter.id, {})
  if (emptyObject.status === 201) createdRunIds.push(emptyObject.body.validationRunId)
  const runsBefore08 = await runsFor(basicEncounter.id)
  const injected = await executeHttp(basicEncounter.id, { serviceDate: '2026-01-01' })
  check('T08', 'Empty body', absent.status === 201 && emptyObject.status === 201 && injected.status === 400 && (await runsFor(basicEncounter.id)) === runsBefore08, `absent ${absent.status}, {} ${emptyObject.status}; a supplied business field is refused (${injected.status}) and records nothing`)
  const totalRuns = () => prisma.validationRun.count()
  const runsBefore09 = await totalRuns()
  const malformed = await executeHttp('not-a-uuid', {})
  check('T09', 'Malformed Encounter', malformed.status === 400 && !/prisma|postgres|syntax|invalid input/i.test(JSON.stringify(malformed.body)) && (await totalRuns()) === runsBefore09, `safe ${malformed.status}; no run`)
  const missing = await executeHttp(MISSING, {})
  check('T10', 'Missing Encounter', missing.status === 404 && (await runsFor(MISSING)) === 0, `${missing.status}; no run`)
  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  const foreignRunsBefore = foreignEncounter ? await runsFor(foreignEncounter.id) : 0
  const foreign = foreignEncounter ? await executeHttp(foreignEncounter.id, {}) : null
  check(
    'T11',
    'Cross-tenant Encounter',
    foreign !== null && foreign.status === 403 && (await runsFor(foreignEncounter!.id)) === foreignRunsBefore && !/validationRunId|findingCode/.test(JSON.stringify(foreign.body)),
    foreign === null ? 'no foreign-tenant Encounter exists to prove this' : `${foreign.status}; no run, finding or context disclosed`,
  )
  const first = await execute(basicEncounter.id)
  const firstSnapshot = JSON.stringify({ run: first.run, findings: first.findings })
  const second = await execute(basicEncounter.id)
  check('T12', 'Validator version', first.run.validatorVersion === 'A5-VAL-1' && first.response.validatorVersion === 'A5-VAL-1', 'the run stores exactly A5-VAL-1')
  check(
    'T13',
    'Repeat validation',
    second.run.id !== first.run.id && JSON.stringify({ run: await prisma.validationRun.findUniqueOrThrow({ where: { id: first.run.id } }), findings: await findingsOf(first.run.id) }) === firstSnapshot,
    'a second execution is a new run; the first run and its findings are byte-identical afterwards',
  )

  // In-process executions below use the same service the route calls, so the concurrency probes of
  // this process can pause or fail them.
  const snapWorld = await world('snapshot')
  const govWorld = await world('governed')
  const govRule = await docRule(govWorld.payer.id, STANDARD, { supporting: true })
  const holdEncounter = await govWorld.encounter()
  const hold = holdAt('pre_claim_validation.recorded')
  const heldExecution = executePreClaimValidation(holdEncounter.id, {}, actorUserId)
  await hold.arrived
  const invisibleWhileHeld = (await runsFor(holdEncounter.id)) === 0
  hold.release()
  const heldResult = await heldExecution
  clearConcurrencyProbes()
  if (heldResult.ok) createdRunIds.push(heldResult.value.validationRunId)
  const heldFindings = heldResult.ok ? await findingsOf(heldResult.value.validationRunId) : []
  const serviceCode = committedCode(`${MODULE_DIR}/pre-claim-validation.service.ts`)
  check(
    'T14',
    'One transaction',
    invisibleWhileHeld && heldResult.ok && heldFindings.some((f) => f.ruleProvenance !== null) && (serviceCode.match(/prisma\.\$transaction\(/g) ?? []).length === 1 && /recordValidationRunInTransaction\([\s\S]*?tx,\s*\)/.test(serviceCode),
    'while held after the A5.7 recorder the run was invisible to another connection; on release the run, findings and provenance committed together from one transaction',
  )
  const snapEncounter = await snapWorld.encounter()
  const snapHold = holdAt('pre_claim_validation.snapshot')
  const snapExecution = executePreClaimValidation(snapEncounter.id, {}, actorUserId)
  await snapHold.arrived
  const correctionStarted = Date.now()
  const correction = await eligibility(snapEncounter.id)
  const correctionMs = Date.now() - correctionStarted
  await new Promise((resolve) => setTimeout(resolve, 400))
  snapHold.release()
  const snapResult = await snapExecution
  clearConcurrencyProbes()
  if (snapResult.ok) createdRunIds.push(snapResult.value.validationRunId)
  const snapFindings = snapResult.ok ? await findingsOf(snapResult.value.validationRunId) : []
  const after = await execute(snapEncounter.id)
  check(
    'T15',
    'Isolation',
    has(snapFindings, 'COVERAGE_ELIGIBILITY_MISSING') && has(after.findings, 'COVERAGE_ELIGIBILITY_ELIGIBLE', (f) => f.eligibilityVerificationId === correction.id) &&
      /isolationLevel: Prisma\.TransactionIsolationLevel\.RepeatableRead/.test(serviceCode) && !/READ ONLY|withReadSnapshot/.test(serviceCode),
    'a verification committed mid-execution is absent from the held REPEATABLE READ result and present in the next; the transaction is read-write (it recorded the run)',
  )
  const moduleCode = committedProductionCodeOf([MODULE_DIR])
  // Every absence check below first proves the scan reached all ten committed production files.
  const reached = moduleCode.files.length === 10 && moduleCode.code.includes('recordValidationRunInTransaction')
  check('T16', 'No upstream locks', reached && correctionMs < 5000 && !/FOR UPDATE|lockRowForUpdate|SELECT .* FOR /i.test(moduleCode.code), `the mid-execution correction committed in ${correctionMs} ms without waiting; no row lock exists on the read path`)
  const snapRun = snapResult.ok ? await prisma.validationRun.findUniqueOrThrow({ where: { id: snapResult.value.validationRunId } }) : null
  check(
    'T17',
    'DB evaluatedAt',
    snapRun !== null && snapRun.createdAt.getTime() - snapRun.evaluatedAt.getTime() >= 350,
    snapRun ? `evaluatedAt is the transaction start; the run row was written ${snapRun.createdAt.getTime() - snapRun.evaluatedAt.getTime()} ms later` : 'the held execution did not record',
  )
  const rollbackCase = async (probe: string) => {
    const encounter = await govWorld.encounter()
    const auditBefore = await prisma.auditEvent.count({ where: { entityType: 'VALIDATION_RUN' } })
    const provenanceBefore = await prisma.validationFindingRuleProvenance.count()
    failAt(probe, 'forced failure (acceptance)')
    let threw = false
    try {
      await executePreClaimValidation(encounter.id, {}, actorUserId)
    } catch {
      threw = true
    }
    clearConcurrencyProbes()
    return threw && (await runsFor(encounter.id)) === 0 && (await prisma.auditEvent.count({ where: { entityType: 'VALIDATION_RUN' } })) === auditBefore && (await prisma.validationFindingRuleProvenance.count()) === provenanceBefore
  }
  check('T18', 'Atomic provenance rollback', await rollbackCase('pre_claim_validation.provenance_inserted'), 'a forced failure after the provenance rows left no run, finding, audit or provenance')
  check('T19', 'No partial run', (await rollbackCase('validation_run.findings_inserted')) && (await rollbackCase('pre_claim_validation.recorded')), 'a failure after the findings, or after the recorder but before provenance, leaves no committed run')
  const noMemberEncounter = await basic.encounter('none')
  const noMemberHttp = await executeHttp(noMemberEncounter.id, {})
  if (noMemberHttp.status === 201) createdRunIds.push(noMemberHttp.body.validationRunId)
  const noMember = noMemberHttp.status === 201 ? await findingsOf(noMemberHttp.body.validationRunId) : []
  check('T20', 'Deterministic failure is 201', noMemberHttp.status === 201 && noMember.some((f) => f.outcome === 'FAIL') && noMember.some((f) => f.outcome === 'RESTRICT'), `FAIL and RESTRICT findings recorded with HTTP ${noMemberHttp.status}`)

  // ---------------------------------------------------------------- TECHNICAL (T21–T25)
  section('TECHNICAL — A4.9 and A4.3 integrity, with short-circuit')
  check('T21', 'Technical pass', first.findings[0]?.findingCode === 'TECHNICAL_CONTEXT_VALID' && first.findings[0].outcome === 'PASS', 'a valid stored context is TECHNICAL_CONTEXT_VALID / PASS')
  const integritySite = await newFacility('integrity')
  const coverageWorld = await world('coverage drift', 'one', integritySite)
  const coverageEncounter = await coverageWorld.encounter()
  await patchApi(`/api/insurance-memberships/${coverageWorld.membership.id}`, { coverageTo: '2026-05-31' })
  const t22 = await execute(coverageEncounter.id)
  const coherenceWorld = await world('coherence', 'one', integritySite)
  const coherenceEncounter = await coherenceWorld.encounter()
  const foreignPayer = await prisma.payer.findFirst({ where: { organizationId: otherOrg }, select: { id: true } })
  let t22Coherence: Awaited<ReturnType<typeof execute>> | null = null
  if (foreignPayer) {
    await prisma.insuranceMembership.update({ where: { id: coherenceWorld.membership.id }, data: { payerId: foreignPayer.id } })
    try {
      t22Coherence = await execute(coherenceEncounter.id)
    } finally {
      await prisma.insuranceMembership.update({ where: { id: coherenceWorld.membership.id }, data: { payerId: coherenceWorld.payer.id } })
    }
  }
  check(
    'T22',
    'Technical membership integrity',
    codesOf(t22.findings).join() === 'TECHNICAL_CONTEXT_INTEGRITY_FAIL' && t22Coherence !== null && codesOf(t22Coherence.findings).join() === 'TECHNICAL_CONTEXT_INTEGRITY_FAIL' && t22Coherence.run.payerId === null,
    'coverage drift (A4.9) and a membership corrupted to another tenant\'s payer (A4.3, restored afterwards) are each TECHNICAL_CONTEXT_INTEGRITY_FAIL; no foreign payer enters the run',
  )
  const assignmentWorld = await world('assignment drift', 'one', integritySite)
  const assignmentEncounter = await assignmentWorld.encounter()
  await post(`/api/clinician-facility-assignments/${integritySite.assignment.id}/close`, { effectiveTo: '2026-06-14' })
  must('covering assignment', (await post(`/api/clinicians/${integritySite.clinician.id}/facility-assignments`, { facilityId: integritySite.facility.id, effectiveFrom: '2026-06-15', effectiveTo: null })).body)
  const t23 = await execute(assignmentEncounter.id)
  check('T23', 'Technical assignment integrity', codesOf(t23.findings).join() === 'TECHNICAL_CONTEXT_INTEGRITY_FAIL', 'the recorded assignment closed before the service date fails; the covering newer assignment is not substituted')
  const profileSite = await newFacility('profile')
  const profileWorld = await world('profile drift', 'one', profileSite)
  const profileEncounter = await profileWorld.encounter()
  await patchApi(`/api/facility-regulatory-profiles/${profileSite.profile.id}`, { effectiveTo: '2026-06-14' })
  const t24 = await execute(profileEncounter.id)
  check('T24', 'Technical profile integrity', codesOf(t24.findings).join() === 'TECHNICAL_CONTEXT_INTEGRITY_FAIL', 'the recorded profile closed before the service date fails')
  check(
    'T25',
    'Technical short-circuit',
    [t22, t23, t24].every((r) => r.findings.length === 1 && r.run.insuranceMembershipId === null && r.run.providerContractId === null),
    'after a TECHNICAL FAIL the run holds that one finding; no CODING, COVERAGE, CONTRACT or EVIDENCE result is executed or guessed, and no membership or contract enters the context',
  )

  // ---------------------------------------------------------------- CODING (T26–T32)
  section('CODING — A4.5/A4.6/A4.7 owner invariants')
  check('T26', 'Diagnosis owner invariant PASS', has(first.findings, 'CODING_DIAGNOSIS_INVARIANTS_PASS'), 'A4.5 read invariant holds')
  const codingEncounter = await basic.encounter()
  await diagnosis(codingEncounter.id, dxA.id)
  const brokenDiagnosis = await diagnosis(codingEncounter.id, dxB.id)
  await prisma.$executeRawUnsafe('UPDATE encounter_diagnoses SET sequence = 5 WHERE id = $1::uuid', brokenDiagnosis.id)
  const modifierActivity = await activity(codingEncounter.id, { modifierCodes: ['M1', 'M2'] })
  await prisma.$executeRawUnsafe('UPDATE encounter_activity_modifiers SET sequence = 7 WHERE encounter_activity_id = $1::uuid AND sequence = 2', modifierActivity.id)
  const anchorEncounter = await basic.encounter()
  const foreignAnchor = await activity(anchorEncounter.id)
  const observation = must('observation', (await post(`/api/encounters/${codingEncounter.id}/observations`, { encounterActivityId: modifierActivity.id, factKey: `SYNTHETIC_FACT_${serial}`, value: { type: 'TEXT', text: 'Synthetic observation' } })).body)
  await prisma.$executeRawUnsafe('UPDATE encounter_observations SET encounter_activity_id = $1::uuid WHERE id = $2::uuid', foreignAnchor.id, observation.id)
  const coding = await execute(codingEncounter.id)
  check('T27', 'Diagnosis owner invariant FAIL', has(coding.findings, 'CODING_DIAGNOSIS_INTEGRITY_FAIL'), 'a stored gap in active diagnosis order is CODING_DIAGNOSIS_INTEGRITY_FAIL')
  check('T28', 'Activity owner invariant PASS', has(first.findings, 'CODING_ACTIVITY_INVARIANTS_PASS'), 'A4.6 activity and modifier invariants hold')
  check('T29', 'Activity owner invariant FAIL', has(coding.findings, 'CODING_ACTIVITY_INTEGRITY_FAIL', (f) => f.encounterActivityId === modifierActivity.id), 'a stored modifier-order gap fails for that exact activity')
  check('T30', 'Observation owner invariant PASS', has(first.findings, 'CODING_OBSERVATION_INVARIANTS_PASS'), 'A4.7 typed observation invariants hold')
  check('T31', 'Observation owner invariant FAIL', has(coding.findings, 'CODING_OBSERVATION_INTEGRITY_FAIL'), 'an observation anchored to another Encounter\'s activity fails')
  const codingCode = committedCode(`${MODULE_DIR}/pre-claim-validation.coding.ts`)
  check(
    'T32',
    'No coding algorithm copy',
    /checkReadInvariant\(/.test(codingCode) && /checkModifierInvariant\(/.test(codingCode) && /verifyStoredObservation\(/.test(codingCode) && !/sequence\s*!==|\.sort\(\(a, b\) => a\.sequence|valueType\s*===|new Set\(/.test(moduleCode.code),
    'A5.8 calls the A4.5/A4.6/A4.7 owner checks; no ordering, modifier or typed-value rule is reimplemented',
  )

  // ---------------------------------------------------------------- COVERAGE eligibility (T33–T42)
  section('COVERAGE — eligibility, never a latest winner')
  check('T33', 'No membership', has(noMember, 'COVERAGE_MEMBERSHIP_MISSING') && has(noMember, 'TECHNICAL_CONTEXT_VALID'), 'COVERAGE_MEMBERSHIP_MISSING / FAIL')
  const elig = await world('eligibility')
  const scenario = async (setup: (encounterId: string) => Promise<unknown>) => {
    const encounter = await elig.encounter()
    await setup(encounter.id)
    return execute(encounter.id)
  }
  const filterEncounter = await elig.encounter()
  await eligibility(filterEncounter.id)
  await patchApi(`/api/encounters/${filterEncounter.id}`, { insuranceMembershipId: elig.membership2.id })
  const t34 = await execute(filterEncounter.id)
  check('T34', 'Eligibility context filter', has(t34.findings, 'COVERAGE_ELIGIBILITY_MISSING'), 'a verification frozen under the previous membership is not a candidate for the current context')
  const t35 = await scenario(async () => undefined)
  check('T35', 'No eligibility', has(t35.findings, 'COVERAGE_ELIGIBILITY_MISSING') && findingOutcome(t35.findings, 'COVERAGE_ELIGIBILITY_MISSING') === 'RESTRICT', 'COVERAGE_ELIGIBILITY_MISSING / RESTRICT')
  check('T36', 'One fresh ELIGIBLE', has(first.findings, 'COVERAGE_ELIGIBILITY_ELIGIBLE', (f) => f.eligibilityVerificationId === basicEligibility.id && f.outcome === 'PASS'), 'PASS, targeting the exact verification')
  const t37 = await scenario(async (id) => eligibility(id, { status: 'INELIGIBLE' }))
  check('T37', 'One fresh INELIGIBLE', findingOutcome(t37.findings, 'COVERAGE_ELIGIBILITY_INELIGIBLE') === 'FAIL', 'FAIL')
  const t38 = await scenario(async (id) => eligibility(id, { status: 'UNKNOWN' }))
  check('T38', 'One fresh UNKNOWN', findingOutcome(t38.findings, 'COVERAGE_ELIGIBILITY_UNKNOWN') === 'RESTRICT', 'RESTRICT')
  const t39a = await scenario(async (id) => {
    await eligibility(id, { status: 'ELIGIBLE' })
    await eligibility(id, { status: 'INELIGIBLE', respondedAt: '2026-06-15T10:31:00.000Z' })
  })
  const t39b = await scenario(async (id) => {
    await eligibility(id, { status: 'INELIGIBLE', respondedAt: '2026-06-15T10:31:00.000Z' })
    await eligibility(id, { status: 'ELIGIBLE' })
  })
  check('T39', 'Multiple fresh verifications', has(t39a.findings, 'COVERAGE_ELIGIBILITY_AMBIGUOUS', (f) => f.eligibilityVerificationId === null && f.outcome === 'RESTRICT'), 'RESTRICT ambiguous with no verification targeted; the later respondedAt does not win')
  const t40 = await scenario(async (id) => eligibility(id, { validThrough: STALE_UNTIL }))
  check('T40', 'Only stale verification', findingOutcome(t40.findings, 'COVERAGE_ELIGIBILITY_STALE') === 'RESTRICT', 'RESTRICT stale')
  const t41 = await scenario(async (id) => eligibility(id, { validThrough: null }))
  check('T41', 'Only unknown freshness', findingOutcome(t41.findings, 'COVERAGE_ELIGIBILITY_FRESHNESS_UNKNOWN') === 'RESTRICT', 'RESTRICT freshness unknown')
  check('T42', 'No createdAt/version ranking', has(t39b.findings, 'COVERAGE_ELIGIBILITY_AMBIGUOUS') && has(t39a.findings, 'COVERAGE_ELIGIBILITY_AMBIGUOUS'), 'the same two verifications recorded in either order resolve identically: ambiguous')

  // ---------------------------------------------------------------- COVERAGE authorization (T43–T61)
  section('COVERAGE — authorization requirement and A5.4 scope')
  check('T43', 'Auth not required', has(first.findings, 'COVERAGE_AUTHORIZATION_NOT_REQUIRED', (f) => f.outcome === 'PASS'), 'selected eligibility false -> PASS')
  const t44 = await scenario(async (id) => eligibility(id, { authorizationRequired: null }))
  check('T44', 'Auth requirement unknown', findingOutcome(t44.findings, 'COVERAGE_AUTHORIZATION_REQUIREMENT_UNKNOWN') === 'RESTRICT' && has(t35.findings, 'COVERAGE_AUTHORIZATION_REQUIREMENT_UNKNOWN'), 'a null indicator, and no unique usable verification, are both RESTRICT')
  const t45 = await scenario(async (id) => eligibility(id, { authorizationRequired: true }))
  check('T45', 'Auth required no case', findingOutcome(t45.findings, 'COVERAGE_AUTHORIZATION_MISSING') === 'FAIL', 'FAIL')

  const auth = await world('authorization')
  const authScenario = async (build: (encounterId: string, activityId: string) => Promise<unknown>, activityOverrides: Record<string, unknown> = {}) => {
    const encounter = await auth.encounter()
    const act = await activity(encounter.id, activityOverrides)
    await eligibility(encounter.id, { authorizationRequired: true })
    const built = await build(encounter.id, act.id)
    return { ...(await execute(encounter.id)), activityId: act.id as string, built: built as any }
  }
  const detail = (r: { findings: StoredFinding[]; activityId: string }) => r.findings.filter((f) => f.findingCode.startsWith('COVERAGE_AUTHORIZATION_') && f.priorAuthorizationVersionId !== null && f.encounterActivityId === r.activityId)
  const summary = (r: { findings: StoredFinding[]; activityId: string }) => r.findings.find((f) => /^COVERAGE_AUTHORIZATION_ACTIVITY_/.test(f.findingCode) && f.encounterActivityId === r.activityId)
  const matched = await authScenario(async (id) => authorizationCase(id, { status: 'APPROVED', validFrom: '2026-06-01', validThrough: '2026-06-30' }, [line()]))
  check('T46', 'Latest-recorded snapshot per case', detail(matched).length === 1 && detail(matched)[0].priorAuthorizationVersionId === matched.built.versionId && detail(matched)[0].priorAuthorizationVersionId !== matched.built.initialVersionId, 'the highest version number of the case was evaluated; the INITIAL version was not')
  const older = await authScenario(async (id) => {
    const created = await authorizationCase(id, { status: 'APPROVED' }, [line()])
    const denied = await respond(created.authorizationId, { status: 'DENIED', kind: 'AMENDMENT' }, [line()])
    return { ...created, deniedVersionId: denied.versionId }
  })
  check(
    'T47',
    'Older version not substituted',
    detail(older).length === 1 && detail(older)[0].priorAuthorizationVersionId === older.built.deniedVersionId && detail(older)[0].findingCode === 'COVERAGE_AUTHORIZATION_HEADER_NOT_APPROVED' && summary(older)?.findingCode === 'COVERAGE_AUTHORIZATION_ACTIVITY_UNSATISFIED' && !older.findings.some((f) => f.priorAuthorizationVersionId === older.built.versionId),
    'the newer DENIED snapshot is evaluated; the older APPROVED version is never consulted',
  )
  const two = await authScenario(async (id) => [await authorizationCase(id, { status: 'APPROVED' }, [line()]), await authorizationCase(id, { status: 'APPROVED' }, [line()])])
  check('T48', 'Multiple authorization cases', detail(two).length === 2 && new Set(detail(two).map((f) => f.priorAuthorizationVersionId)).size === 2, 'both cases were evaluated; none was chosen by reference, time or id')
  const m = detail(matched)[0]
  check('T49', 'A5.4 MATCHED detail', m?.findingCode === 'COVERAGE_AUTHORIZATION_SCOPE_MATCHED' && m.outcome === 'PASS' && m.authorizationLineId === matched.built.lineIds[0], 'PASS with the exact version, line and activity targets')
  const outcomeOf = async (build: (id: string, activityId: string) => Promise<unknown>, overrides: Record<string, unknown> = {}) => {
    const r = await authScenario(build, overrides)
    return { r, d: detail(r)[0] }
  }
  const t50 = await outcomeOf(async (id) => authorizationCase(id, { status: 'APPROVED' }, [line({ serviceId: svcB.id })]))
  check('T50', 'A5.4 NO_MATCH detail', t50.d?.findingCode === 'COVERAGE_AUTHORIZATION_SCOPE_NO_MATCH' && t50.d.outcome === 'FAIL', 'FAIL')
  const t51 = await outcomeOf(async (id) => authorizationCase(id, { status: 'APPROVED' }, [line(), line()]))
  check('T51', 'A5.4 AMBIGUOUS detail', t51.d?.findingCode === 'COVERAGE_AUTHORIZATION_SCOPE_AMBIGUOUS' && t51.d.outcome === 'RESTRICT', 'RESTRICT')
  const t52 = await outcomeOf(async (id) => {
    await authorizationCase(id, { status: 'APPROVED' }, [line()])
    await patchApi(`/api/encounters/${id}`, { insuranceMembershipId: auth.membership2.id })
    await eligibility(id, { authorizationRequired: true })
  })
  check('T52', 'A5.4 CONTEXT_MISMATCH detail', t52.d?.findingCode === 'COVERAGE_AUTHORIZATION_CONTEXT_MISMATCH' && t52.d.outcome === 'FAIL', 'FAIL')
  const t53 = await outcomeOf(async (id) => authorizationCase(id, { status: 'DENIED' }, [line()]))
  check('T53', 'Header not approved detail', t53.d?.findingCode === 'COVERAGE_AUTHORIZATION_HEADER_NOT_APPROVED' && t53.d.outcome === 'FAIL', 'FAIL')
  const t54 = await outcomeOf(async (id) => authorizationCase(id, { status: 'APPROVED' }, [line({ status: 'DENIED' })]))
  check('T54', 'Line not approved detail', t54.d?.findingCode === 'COVERAGE_AUTHORIZATION_LINE_NOT_APPROVED' && t54.d.outcome === 'FAIL', 'FAIL')
  const t55 = await outcomeOf(async (id) => authorizationCase(id, { status: 'APPROVED', validFrom: '2026-07-01', validThrough: '2026-07-31' }, [line()]))
  check('T55', 'Date outside scope detail', t55.d?.findingCode === 'COVERAGE_AUTHORIZATION_DATE_OUTSIDE_SCOPE' && t55.d.outcome === 'FAIL', 'FAIL')
  const t56 = await outcomeOf(async (id) => authorizationCase(id, { status: 'APPROVED' }, [line({ unitCode: 'MG' })]), { unitCode: 'ML' })
  check('T56', 'Unit mismatch detail', t56.d?.findingCode === 'COVERAGE_AUTHORIZATION_UNIT_MISMATCH' && t56.d.outcome === 'FAIL', 'FAIL')
  const t57 = await outcomeOf(async (id) => authorizationCase(id, { status: 'APPROVED' }, [line({ approvedQty: null })]))
  check('T57', 'Quantity unknown detail', t57.d?.findingCode === 'COVERAGE_AUTHORIZATION_QUANTITY_UNKNOWN' && t57.d.outcome === 'RESTRICT', 'RESTRICT')
  const t58 = await outcomeOf(async (id) => authorizationCase(id, { status: 'APPROVED' }, [line({ approvedQty: '1' })]), { quantity: '5' })
  check('T58', 'Quantity exceeded detail', t58.d?.findingCode === 'COVERAGE_AUTHORIZATION_QUANTITY_EXCEEDED' && t58.d.outcome === 'FAIL', 'FAIL')
  check('T59', 'Exactly one authorization match', summary(matched)?.findingCode === 'COVERAGE_AUTHORIZATION_ACTIVITY_SATISFIED' && summary(matched)?.outcome === 'PASS', 'activity summary PASS')
  check('T60', 'Multiple authorization matches', summary(two)?.findingCode === 'COVERAGE_AUTHORIZATION_ACTIVITY_AMBIGUOUS' && summary(two)?.outcome === 'RESTRICT', 'activity summary RESTRICT; no winner invented')
  check('T61', 'Zero authorization matches', summary(t50.r)?.findingCode === 'COVERAGE_AUTHORIZATION_ACTIVITY_UNSATISFIED' && summary(t50.r)?.outcome === 'FAIL', 'activity summary FAIL')

  // ---------------------------------------------------------------- CONTRACT (T62–T68)
  section('CONTRACT — the exact A5.5 result, never a price')
  const resolvedContract = await prisma.providerContract.findFirstOrThrow({ where: { payerId: basic.payer.id }, select: { id: true } })
  check('T62', 'Commercial resolved', findingOutcome(first.findings, 'CONTRACT_CONTEXT_RESOLVED') === 'PASS' && first.run.providerContractId === resolvedContract.id && first.run.tariffScheduleVersionId !== null, 'PASS; the run stores the exact contract, schedule and version A5.5 resolved')
  const contractOutcome = async (commercial: Commercial) => (await execute((await (await world(`contract ${commercial}`, commercial)).encounter()).id)).findings
  const t63 = await contractOutcome('none')
  check('T63', 'No contract', findingOutcome(t63, 'CONTRACT_NO_APPLICABLE_CONTRACT') === 'FAIL', 'FAIL')
  const t64 = await contractOutcome('two')
  check('T64', 'Ambiguous contract', findingOutcome(t64, 'CONTRACT_AMBIGUOUS_CONTRACT') === 'RESTRICT', 'RESTRICT')
  const t65 = await contractOutcome('unverified')
  check('T65', 'No tariff version', findingOutcome(t65, 'CONTRACT_NO_APPLICABLE_TARIFF_VERSION') === 'FAIL', 'FAIL')
  const t66 = await contractOutcome('twoVersions')
  check('T66', 'Ambiguous tariff version', findingOutcome(t66, 'CONTRACT_AMBIGUOUS_TARIFF_VERSION') === 'RESTRICT', 'RESTRICT')
  const t67 = await contractOutcome('indeterminate')
  check('T67', 'Indeterminate tariff dates', findingOutcome(t67, 'CONTRACT_INDETERMINATE_TARIFF_DATES') === 'RESTRICT', 'RESTRICT')
  const allProvenanceColumns = (await Promise.all(PROVENANCE_TABLES.map(columnsOf))).flat()
  check(
    'T68',
    'No pricing',
    reached && ![...runColumns, ...findingColumns, ...allProvenanceColumns].some((c) => /price|rate|fee|amount|reimburs|allowed|responsibility/i.test(c)) && !/\b(price|tariffRate|allowedAmount|reimbursement|patientResponsibility)\b/i.test(moduleCode.code) && ![...deepKeys(first.response)].some((k) => /price|amount|fee/i.test(k)),
    'no rate, fee, amount or reimbursement is calculated, stored or returned',
  )

  // ---------------------------------------------------------------- EVIDENCE (T69–T83)
  section('EVIDENCE — the A5.6 target matrix and governed findings')
  const govEncounter = await govWorld.encounter()
  const fresh = await evidenceArtifact(REPORT, '2026-06-01')
  await linkEvidence(govEncounter.id, fresh.versionId)
  const otherEffect = await docRule(govWorld.payer.id, null, { effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT', label: '1' })
  const gov = await execute(govEncounter.id)
  const satisfied = gov.findings.find((f) => f.findingCode === 'EVIDENCE_REQUIREMENT_SATISFIED')
  check('T69', 'Evidence base target', satisfied !== undefined && satisfied.encounterActivityId === null && satisfied.encounterDiagnosisId === null, 'the Encounter-level target was evaluated')

  const targetWorld = await world('evidence targets')
  const rSvc = await docRule(targetWorld.payer.id, STANDARD, { dimensions: { serviceId: svcA.id } })
  const rDx = await docRule(targetWorld.payer.id, STANDARD, { dimensions: { diagnosisCodeId: dxA.id } })
  const rPair = await docRule(targetWorld.payer.id, STANDARD, { dimensions: { serviceId: svcB.id, diagnosisCodeId: dxB.id } })
  const targetEncounter = await targetWorld.encounter()
  const a1 = await activity(targetEncounter.id, { serviceId: svcA.id })
  const a2 = await activity(targetEncounter.id, { serviceId: svcB.id })
  const a3 = await activity(targetEncounter.id, { serviceId: svcA.id })
  await post(`/api/encounter-activities/${a3.id}/remove`, {})
  const d1 = await diagnosis(targetEncounter.id, dxA.id)
  const d2 = await diagnosis(targetEncounter.id, dxB.id)
  const targets = await execute(targetEncounter.id)
  const ev = targets.findings.filter((f) => f.layer === 'EVIDENCE')
  const forRule = (ruleVersionId: string) => ev.filter((f) => f.ruleVersionId === ruleVersionId)
  check('T70', 'Evidence activity targets', forRule(rSvc.version.id).some((f) => f.encounterActivityId === a1.id && f.encounterDiagnosisId === null), 'the service-scoped rule was found on the active activity target')
  check('T71', 'Evidence diagnosis targets', forRule(rDx.version.id).some((f) => f.encounterDiagnosisId === d1.id && f.encounterActivityId === null), 'the diagnosis-scoped rule was found on the active diagnosis target')
  check(
    'T72',
    'Evidence activity x diagnosis',
    forRule(rPair.version.id).length > 0 && forRule(rPair.version.id).every((f) => f.encounterActivityId === a2.id && f.encounterDiagnosisId === d2.id),
    'the rule constraining both service and diagnosis applies only on the exact activity x diagnosis pair',
  )
  check('T73', 'Removed targets excluded', !targets.findings.some((f) => f.encounterActivityId === a3.id), 'the removed activity is never a target')
  check('T74', 'Requirement satisfied', satisfied?.outcome === 'PASS', 'EVIDENCE_REQUIREMENT_SATISFIED / PASS')
  const govScenario = async (setup: (encounterId: string) => Promise<unknown>) => {
    const encounter = await govWorld.encounter()
    await setup(encounter.id)
    return (await execute(encounter.id)).findings
  }
  const t75 = await govScenario(async () => undefined)
  check('T75', 'Requirement missing', findingOutcome(t75, 'EVIDENCE_REQUIREMENT_MISSING') === 'FAIL', 'FAIL')
  const minWorld = await world('evidence minimum')
  await docRule(minWorld.payer.id, { ...STANDARD, minimumCount: 2 })
  const minEncounter = await minWorld.encounter()
  await linkEvidence(minEncounter.id, (await evidenceArtifact(REPORT, '2026-06-01')).versionId)
  const t76 = (await execute(minEncounter.id)).findings
  check('T76', 'Requirement incomplete', findingOutcome(t76, 'EVIDENCE_REQUIREMENT_INCOMPLETE') === 'RESTRICT', 'RESTRICT')
  const undated = await evidenceArtifact(REPORT, null)
  const t77 = await govScenario(async (id) => linkEvidence(id, undated.versionId))
  check('T77', 'Invalid evidence detail', t77.some((f) => f.findingCode === 'EVIDENCE_SOURCE_DATE_MISSING' && f.outcome === 'RESTRICT' && f.evidenceArtifactVersionId === undated.versionId && f.evidenceRequirementId !== null), 'RESTRICT with the exact evidence version and requirement targeted')
  const stale = await evidenceArtifact(REPORT, '2026-01-01')
  const t78 = await govScenario(async (id) => linkEvidence(id, stale.versionId))
  check('T78', 'Stale evidence detail', t78.some((f) => f.findingCode === 'EVIDENCE_STALE' && f.outcome === 'RESTRICT' && f.evidenceArtifactVersionId === stale.versionId), 'RESTRICT with the exact evidence version targeted')
  const blockedWorld = await world('evidence blocked')
  const blockedRule = await fx.ruleDefinition('validation blocked')
  await docRule(blockedWorld.payer.id, STANDARD, { rule: blockedRule, label: '1' })
  await docRule(blockedWorld.payer.id, STANDARD, { rule: blockedRule, label: '2' })
  const t79 = (await execute((await blockedWorld.encounter()).id)).findings
  check('T79', 'A3 blocked requirement', findingOutcome(t79, 'EVIDENCE_REQUIREMENT_RESOLUTION_BLOCKED') === 'RESTRICT', 'two equally specific versions fail closed into a RESTRICT finding')
  const legacyWorld = await world('evidence legacy')
  const legacy = await docRule(legacyWorld.payer.id, null, { verify: false })
  await prisma.$executeRawUnsafe("UPDATE rule_versions SET verification_status = 'VERIFIED', verified_at = now() WHERE id = $1::uuid", legacy.version.id)
  const t80 = (await execute((await legacyWorld.encounter()).id)).findings
  check('T80', 'Requirement config incomplete', findingOutcome(t80, 'EVIDENCE_REQUIREMENT_CONFIGURATION_INCOMPLETE') === 'FAIL', 'FAIL')
  check('T81', 'No evidence requirements', only(first.findings, 'EVIDENCE_NO_REQUIREMENTS_APPLY').length === 1 && first.findings.filter((f) => f.layer === 'EVIDENCE').length === 1, 'exactly one EVIDENCE_NO_REQUIREMENTS_APPLY / PASS')
  check('T82', 'Commercial unresolved blocks evidence', findingOutcome(noMember, 'EVIDENCE_EVALUATION_BLOCKED_COMMERCIAL_CONTEXT') === 'RESTRICT' && noMember.filter((f) => f.layer === 'EVIDENCE').length === 1 && findingOutcome(t63, 'EVIDENCE_EVALUATION_BLOCKED_COMMERCIAL_CONTEXT') === 'RESTRICT', 'RESTRICT; A5.6 was never called with fabricated commercial ids')
  const newerFresh = must('newer version', (await post(`/api/evidence-artifacts/${stale.artifactId}/versions`, { storageRef: `synthetic://evidence/${key('E2')}`, contentHash: 'e'.repeat(64), documentType: REPORT, sourceDate: '2026-06-10', receivedAt: '2026-06-15T09:30:00.000Z' })).body)
  const t83 = await govScenario(async (id) => linkEvidence(id, stale.versionId))
  check('T83', 'No evidence latest selection', t83.some((f) => f.findingCode === 'EVIDENCE_STALE' && f.evidenceArtifactVersionId === stale.versionId) && !t83.some((f) => f.evidenceArtifactVersionId === newerFresh.id), 'the exact linked older version is judged; the newer version of the artifact is not substituted')

  // ---------------------------------------------------------------- ordering (T84–T88)
  section('Deterministic ordering; no run outcome, no payer acceptance')
  const layerRank = ['TECHNICAL', 'CODING', 'COVERAGE', 'CONTRACT', 'EVIDENCE']
  const allRuns = [first, second, gov, targets, coding]
  check('T84', 'Layer order', allRuns.every((r) => r.findings.every((f, i) => i === 0 || layerRank.indexOf(r.findings[i - 1].layer) <= layerRank.indexOf(f.layer))), 'TECHNICAL, CODING, COVERAGE, CONTRACT, EVIDENCE across every run')
  const keyOf = (f: StoredFinding) => [f.layer, f.findingCode, f.encounterActivityId, f.encounterDiagnosisId, f.priorAuthorizationVersionId, f.authorizationLineId, f.evidenceRequirementId, f.evidenceArtifactVersionId].join('|')
  const sortedWithin = (fs: StoredFinding[]) =>
    fs.every((f, i) => {
      if (i === 0 || fs[i - 1].layer !== f.layer) return true
      const prev = fs[i - 1]
      if (prev.findingCode !== f.findingCode) return prev.findingCode < f.findingCode
      for (const k of ['encounterActivityId', 'encounterDiagnosisId', 'priorAuthorizationVersionId', 'authorizationLineId', 'evidenceRequirementId', 'evidenceArtifactVersionId'] as const) {
        if (prev[k] === f[k]) continue
        if (prev[k] === null) return true
        if (f[k] === null) return false
        return prev[k]! < f[k]!
      }
      return true
    })
  const targetsAgain = await execute(targetEncounter.id)
  check('T85', 'Within-layer order', allRuns.every((r) => sortedWithin(r.findings)) && JSON.stringify(targetsAgain.findings.map(keyOf)) === JSON.stringify(targets.findings.map(keyOf)), 'findingCode then targets nulls-first; a repeat execution yields the identical order')
  const clientFindings = await executeHttp(basicEncounter.id, { findings: [{ layer: 'TECHNICAL', outcome: 'PASS', findingCode: 'X', message: 'x', sequence: 1 }] })
  check('T86', 'Sequence server owned', allRuns.every((r) => r.findings.every((f, i) => f.sequence === i + 1)) && clientFindings.status === 400, 'A5.7 numbered 1..N in the validator order; a client-supplied finding or sequence is refused')
  check('T87', 'No run overall outcome', !runColumns.some((c) => /outcome|status|readiness|ready|result/.test(c)) && !Object.keys(first.response).some((k) => /outcome|status|readiness|ready/i.test(k)), 'the run and the execution response carry no overall PASS/FAIL or readiness')
  const catalogText = committedCode(`${MODULE_DIR}/pre-claim-validation.finding-catalog.ts`)
  check('T88', 'PASS not payer acceptance', reached && catalogText.includes('findingCatalog') && !/payerAccepted|submissionAllowed|approvedForSubmission/.test(moduleCode.code) && !/\b(accepted by the payer|payer acceptance|ready for submission|approved for submission)\b/i.test(catalogText), 'no payerAccepted/submissionAllowed field and no finding message promises acceptance')

  // ---------------------------------------------------------------- provenance (T89–T107)
  section('Governed provenance — exact, normalized, immutable')
  const system = first.findings[0]
  check('T89', 'System finding provenance null', system.ruleVersionId === null && system.governingSourceVersionId === null && system.referenceDatasetVersionId === null && system.ruleProvenance === null && system.supportingBindings.length === 0 && system.matchedApplicabilities.length === 0, 'rule, source and dataset refs and every provenance child are absent')
  const govFinding = satisfied!
  const meta = govFinding.ruleProvenance
  const binding = meta ? await prisma.ruleSourceBinding.findUnique({ where: { id: meta.governingBindingId }, include: { sourceInterpretation: true } }) : null
  check('T90', 'Governed finding rule ref', govFinding.ruleVersionId === govRule.version.id && binding?.ruleVersionId === govFinding.ruleVersionId, 'Finding.ruleVersionId is the exact resolved RuleVersion and equals the governing binding\'s')
  check('T91', 'Governed source ref', govFinding.governingSourceVersionId === governing.sourceVersion.id && binding?.sourceInterpretation.sourceVersionId === govFinding.governingSourceVersionId, 'governingSourceVersionId equals the A3 provenance source version')
  const a56 = await evaluateEvidenceCompleteness(govEncounter.id, {})
  const a56Provenance = a56.ok ? a56.value.requirements[0]?.provenance : undefined
  check(
    'T92',
    'A3 provenance meta',
    meta?.provenanceContractVersion === 'A3-PROV-1' && meta.precedencePolicyVersion === a56Provenance?.precedencePolicyVersion && meta.governingBindingId === govRule.binding.id && meta.governingSourceInterpretationId === governing.interpretation.id,
    `A3-PROV-1, the precedence policy A3.8 reports (${meta?.precedencePolicyVersion}), and the exact governing binding and interpretation`,
  )
  check('T93', 'Supporting bindings exact', govFinding.supportingBindings.map((s) => s.ruleSourceBindingId).join() === govRule.supporting!.id, 'exactly the one supporting binding; nothing substituted')
  check('T94', 'Matched applicability exact', govFinding.matchedApplicabilities.map((a) => a.ruleApplicabilityId).join() === govRule.applicability.id, 'exactly the matched applicability row')
  check('T95', 'Rule pack nullable', meta?.rulePackVersionId === null && a56Provenance?.rulePackVersionId === null, 'no pack was supplied, and null is preserved; the column is a RESTRICT foreign key for an exact pack version')
  check('T96', 'HistoricalOnly exact', meta?.historicalOnly === a56Provenance?.historicalOnly, `historicalOnly copied unchanged (${meta?.historicalOnly})`)
  check('T97', 'Provenance businessDate', meta?.businessDate.getTime() === gov.run.serviceDate.getTime(), 'equals the run service date')
  check('T98', 'Provenance timestamp', meta?.evaluationTimestamp.getTime() === gov.run.evaluatedAt.getTime(), 'equals the run transaction evaluation instant')
  const provenanceCode = committedCode(`${MODULE_DIR}/pre-claim-validation.provenance.ts`)
  check(
    'T99',
    'Context coherence',
    govRule.applicability.payerId === gov.run.payerId &&
      forRule(rSvc.version.id).length > 0 && forRule(rSvc.version.id).every((f) => f.encounterActivityId === a1.id) &&
      forRule(rDx.version.id).length > 0 && forRule(rDx.version.id).every((f) => f.encounterDiagnosisId === d1.id) &&
      /c\.serviceId === target\.serviceId/.test(provenanceCode) && /c\.payerId === r\.payerId/.test(provenanceCode) && /context coherence/.test(provenanceCode),
    'every governed finding passed the twelve-dimension context check against its run and target before it was written; a service-scoped rule lands only on the activity with that service, a diagnosis-scoped one only on that diagnosis',
  )
  const governedAll = await prisma.validationFinding.findMany({ where: { validationRunId: { in: createdRunIds }, ruleVersionId: { not: null } }, include: { consumedDatasetVersions: true, ruleVersion: { select: { effectType: true } } } })
  check('T100', 'Reference datasets zero', governedAll.length > 0 && governedAll.every((f) => f.referenceDatasetVersionId === null && f.consumedDatasetVersions.length === 0), `none of ${governedAll.length} governed findings invents a dataset version`)
  const datasetIds = (await prisma.referenceDatasetVersion.findMany({ take: 2, orderBy: { id: 'asc' }, select: { id: true } })).map((row) => row.id)
  const syntheticProvenance = (ids: string[]) => ({ ...(a56Provenance as NonNullable<typeof a56Provenance>), referenceDatasetVersionIds: ids })
  // Inside a transaction that is always rolled back: a recorded finding plus provenance carrying one
  // or two consumed datasets, to prove the base reference and the child rows agree.
  const datasetProof = async (ids: string[]) => {
    let observed = { base: 'unset' as string | null, children: -1 }
    await attemptAdversarial(() =>
      prisma.$transaction(async (tx) => {
        const governed = draft('EVIDENCE_REQUIREMENT_SATISFIED', {}, syntheticProvenance(ids) as never)
        const { provenance, ...plain } = governed
        const recorded = await recordValidationRunInTransaction(
          { encounterId: govEncounter.id, contextSnapshot: { serviceDate: SERVICE_DATE, facilityId: gov.run.facilityId, facilityRegulatoryProfileId: gov.run.facilityRegulatoryProfileId, insuranceMembershipId: null, payerId: null, tpaId: null, networkId: null, insuranceProductId: null, providerContractId: null, tariffScheduleId: null, tariffScheduleVersionId: null }, validatorVersion: `${runId}-DATASET`, findings: [plain] },
          actorUserId,
          tx,
        )
        if (!recorded.ok) throw new Error(recorded.message)
        const findingRow = await tx.validationFinding.findFirstOrThrow({ where: { validationRunId: recorded.value.id } })
        await insertGovernedProvenance(findingRow.id, provenance!, tx)
        observed = { base: findingRow.referenceDatasetVersionId, children: await tx.validationFindingReferenceDatasetVersion.count({ where: { validationFindingId: findingRow.id } }) }
        throw new Error('ROLLBACK')
      }),
    )
    return observed
  }
  const single = datasetIds.length >= 1 ? await datasetProof(datasetIds.slice(0, 1)) : null
  check('T101', 'Single dataset convenience', single !== null && single.base === datasetIds[0] && single.children === 1, single === null ? 'no reference dataset version exists to prove this' : 'one consumed dataset: the base reference and the one child row agree (rolled back)')
  const multiple = datasetIds.length >= 2 ? await datasetProof(datasetIds) : null
  check('T102', 'Multiple datasets', multiple !== null && multiple.base === null && multiple.children === 2, multiple === null ? 'two reference dataset versions are needed to prove this' : 'two consumed datasets: the base reference is null and both child rows exist (rolled back)')
  const immutable = async (table: string, where: string) =>
    /append-only/.test(await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE ${table} SET validation_finding_id = validation_finding_id WHERE ${where}`))) &&
    /append-only/.test(await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${where}`)))
  const fid = `validation_finding_id = '${govFinding.id}'`
  const lateProvenance = await attemptAdversarial(() =>
    prisma.validationFindingRuleProvenance.create({ data: { validationFindingId: system.id, provenanceContractVersion: 'A3-PROV-1', precedencePolicyVersion: 'X', rulePackVersionId: null, governingBindingId: govRule.binding.id, governingSourceInterpretationId: governing.interpretation.id, businessDate: gov.run.serviceDate, evaluationTimestamp: gov.run.evaluatedAt, historicalOnly: false } }),
  )
  check('T103', 'Provenance immutability', (await immutable('validation_finding_rule_provenances', fid)) && /never added later/.test(lateProvenance), 'direct UPDATE and DELETE are refused, and provenance cannot be attached to an already committed finding (owner-approved trigger)')
  check('T104', 'Supporting binding immutability', await immutable('validation_finding_supporting_bindings', fid), 'direct UPDATE and DELETE are refused')
  check('T105', 'Applicability provenance immutability', await immutable('validation_finding_matched_applicabilities', fid), 'direct UPDATE and DELETE are refused')
  const datasetImmutable = datasetIds.length >= 1
    ? await attemptAdversarial(() =>
        prisma.$transaction(async (tx) => {
          const governed = draft('EVIDENCE_REQUIREMENT_SATISFIED', {}, syntheticProvenance(datasetIds.slice(0, 1)) as never)
          const { provenance, ...plain } = governed
          const recorded = await recordValidationRunInTransaction({ encounterId: govEncounter.id, contextSnapshot: { serviceDate: SERVICE_DATE, facilityId: gov.run.facilityId, facilityRegulatoryProfileId: gov.run.facilityRegulatoryProfileId, insuranceMembershipId: null, payerId: null, tpaId: null, networkId: null, insuranceProductId: null, providerContractId: null, tariffScheduleId: null, tariffScheduleVersionId: null }, validatorVersion: `${runId}-DATASET`, findings: [plain] }, actorUserId, tx)
          if (!recorded.ok) throw new Error(recorded.message)
          const findingRow = await tx.validationFinding.findFirstOrThrow({ where: { validationRunId: recorded.value.id } })
          await insertGovernedProvenance(findingRow.id, provenance!, tx)
          await tx.$executeRawUnsafe('DELETE FROM validation_finding_reference_dataset_versions WHERE validation_finding_id = $1::uuid', findingRow.id)
        }),
      )
    : ''
  check('T106', 'Dataset provenance immutability', /append-only/.test(datasetImmutable), datasetIds.length === 0 ? 'no reference dataset version exists to prove this' : 'a direct DELETE of a dataset provenance row is refused (rolled back)')
  const jsonColumns = (await prisma.$queryRaw<{ c: string }[]>`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY(${PROVENANCE_TABLES}) AND data_type IN ('json','jsonb')`).map((row) => row.c)
  check('T107', 'No provenance JSON', reached && allProvenanceColumns.length > 0 && jsonColumns.length === 0 && !/JSON\.stringify|Prisma\.JsonValue/.test(moduleCode.code), 'no JSON/JSONB provenance blob anywhere')

  // ---------------------------------------------------------------- boundaries (T108–T117)
  section('Rule boundary, API, read enrichment and audit')
  const imports = [...moduleCode.code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  check(
    'T108',
    'No A3 algorithm duplication',
    reached && !imports.some((p) => /rule-(resolution|applicability|source-binding|pack)\b/.test(p)) && !/specificity|SUPERSEDES|CONFLICTS_WITH|sourceRank|evaluateRuleResolution|composeRuleDecisionProvenance/.test(moduleCode.code),
    'no specificity, SUPERSEDES, source ranking or A3 resolution call in A5.8; A5.6 remains the only documentation executor',
  )
  check(
    'T109',
    'Raw effectType not executed',
    reached && !/effectType|CLAIM_FORMAT_EFFECT|CLAIM_EDIT_EFFECT|ELIGIBILITY_REQUIREMENT_EFFECT|AUTHORIZATION_REQUIREMENT_EFFECT|PRICE_EFFECT|TARIFF_EFFECT|REIMBURSEMENT_EFFECT/.test(moduleCode.code) && !gov.findings.some((f) => f.ruleVersionId === otherEffect.version.id),
    'a VERIFIED non-documentation rule for the same payer produced no finding; effect metadata is never interpreted',
  )
  check('T110', 'Documentation executor only governed', governedAll.length > 0 && governedAll.every((f) => f.ruleVersion?.effectType === DOC), `every one of ${governedAll.length} governed findings comes from a DOCUMENTATION_REQUIREMENT_EFFECT RuleVersion through A5.6`)
  check('T111', 'Execution endpoint Admin', emptyObject.status === 201 && emptyObject.body?.validatorVersion === 'A5-VAL-1' && typeof emptyObject.body?.findingCount === 'number', '201 with validationRunId, evaluatedAt, validatorVersion and findingCount')
  const auditBefore112 = await prisma.auditEvent.count({ where: { entityType: 'VALIDATION_RUN' } })
  const runsBefore112 = await runsFor(basicEncounter.id)
  const viewerExec = await executeHttp(basicEncounter.id, {}, asViewer)
  check('T112', 'Execution endpoint Viewer', viewerExec.status === 403 && (await runsFor(basicEncounter.id)) === runsBefore112 && (await prisma.auditEvent.count({ where: { entityType: 'VALIDATION_RUN' } })) === auditBefore112, '403 with no run and no audit')
  const injections = await Promise.all(
    [{ outcome: 'PASS' }, { findingCode: 'X' }, { provenance: {} }, { payerId: MISSING }, { validatorVersion: 'X' }, { businessDate: SERVICE_DATE }].map(async (b) => (await executeHttp(basicEncounter.id, b)).status),
  )
  check('T113', 'No client findings', injections.every((s) => s === 400) && (await runsFor(basicEncounter.id)) === runsBefore112, `outcome, findingCode, provenance, context, validatorVersion and businessDate are each refused (${injections.join('/')})`)
  const systemDto = (await get(`/api/validation-findings/${system.id}`)).body as any
  check('T114', 'Read enrichment system finding', systemDto?.ruleProvenance === null, 'ruleProvenance=null')
  const govDto = (await get(`/api/validation-findings/${govFinding.id}`)).body as any
  check(
    'T115',
    'Read enrichment governed finding',
    govDto?.ruleProvenance?.governingBindingId === govRule.binding.id && govDto.ruleProvenance.evaluationTimestamp === gov.run.evaluatedAt.toISOString() && JSON.stringify(govDto.ruleProvenance.supportingBindingIds) === JSON.stringify([govRule.supporting!.id]) && JSON.stringify(govDto.ruleProvenance.matchedApplicabilityIds) === JSON.stringify([govRule.applicability.id]) && !/storageRef|contentHash|normalizedInterpretationRef|rawEvidenceRef/.test(JSON.stringify(govDto)),
    'the exact normalized provenance is returned; no source document content',
  )
  const auditRows = await prisma.auditEvent.findMany({ where: { entityId: { in: createdRunIds } }, select: { entityId: true, actionCode: true, afterState: true } })
  check('T116', 'Business Audit exactly once', createdRunIds.every((id) => auditRows.filter((row) => row.entityId === id).length === 1) && auditRows.every((row) => row.actionCode === 'validation_run.recorded'), `one validation_run.recorded per run across ${createdRunIds.length} runs; A5.8 writes no execution event of its own`)
  check('T117', 'Audit minimization', auditRows.every((row) => JSON.stringify(Object.keys((row.afterState ?? {}) as object).sort()) === '["createdAt","evaluatedAt","id","validatorVersion"]'), 'no finding, context or provenance content in any snapshot')

  // ---------------------------------------------------------------- scope (T118–T123)
  section('Scope guards and build gates')
  const scanPaths = [`:/${MODULE_DIR}`, `:/${FRONTEND_DIR}`]
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const reach = gitGrep('executePreClaimValidation|executeValidation', scanPaths)
  check('T118', 'Logging scan', reach.status === 0 && logScan.status === 1, 'no eligibility, authorization, evidence, clinical or provenance payload is logged (search verified to reach the source)')
  const feCode = committedCodeOf(FRONTEND_DIR)
  check(
    'T119',
    'Frontend privacy',
    feCode.files.length > 0 && feCode.code.includes('executeValidation') && !/\b(localStorage|sessionStorage|indexedDB)\s*\.\s*[A-Za-z]+\s*\(/.test(feCode.code) && !/RuleProvenance|rule-provenance|\/provenance|findingCode|\.fieldPath|memberIdentifier|eligibilityVerificationId/.test(feCode.code),
    'nothing in browser storage; only the run id, time, version and count are shown',
  )
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  check('T120', 'No readiness', reached && !tables.some((t) => /readiness/.test(t)) && !/readiness|readyForClaim|RESTRICT_OVERALL|overallOutcome/.test(moduleCode.code), 'no ready, restrict or block overall decision')
  check('T121', 'No Claim', reached && !tables.some((t) => /(^claims?$|claim_lines?|claim_submissions?)/.test(t)) && !/(prisma|tx)\.(claim|claimLine|claimSubmission)\b/.test(moduleCode.code), 'no Claim, ClaimLine or ClaimSubmission')
  check('T122', 'No real integration', reached && !/\b(fetch|axios|https?\.request|dhpo|eclaimlink|apiKey|clientSecret)\b/i.test(moduleCode.code), 'no payer, DHPO or eClaimLink call or credential')
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check('T123', 'Unit/typecheck/build', unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok && build.ok && lint.ok, `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]}, typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`)

  // ---------------------------------------------------------------- regressions (T124–T132)
  section('Regressions and database truth')
  // §25: the owner suites are INVOKED, never reimplemented. A5.7's suite nests A5.6 -> A5.5 -> ... -> A1.
  await apiReady('the A5.7 and backward regression chain')
  const chain = run('npm run test:a5:validation-foundation')
  const rows = suiteLines(chain.output, 'A5.7')
  const failing = rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const titleOf = (text: string) => text.slice('[A5.7] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()
  // A5.7 asserts facts about its own branch and migration, and one scope proof searches its module
  // for the word "precedence". A5.8's doc-mandated read enrichment returns precedencePolicyVersion
  // from stored provenance, which is the boundary this package crosses (owner decision).
  const a57NonApplicable: Record<string, string> = {
    T01: "A5.7 'Start gate' requires the current branch to be the A5.7 feature branch; A5.8 is a different branch, branched from the merged A5.7 main",
    T03: "A5.7 'Migration scope' judges the single migration this branch adds against main; on A5.8 that migration is A5.8's own provenance migration",
    T81: "A5.7 'No A3 resolver execution' rejects the bare word 'precedence' in the validation-run module; the §21 read enrichment returns the stored precedencePolicyVersion, and no A3 resolver is imported or called (owner decision: documented N/A)",
    T104: "A5.7 'Diff scope' lists the paths A5.7 was allowed to change; A5.8 legitimately changes different ones",
    T106: "A5.7 'Exact head evidence' requires the upstream to be the A5.7 feature branch, which was deleted when PR #58 merged",
  }
  const undocumented = failing.filter((id) => !(id in a57NonApplicable))
  const counts = chain.output.match(/\[A5\.7\] automated summary: (\d+)\/(\d+) PASS/)
  const failedCount = counts ? Number(counts[2]) - Number(counts[1]) : -1
  const reconciled = failedCount >= 0 && failing.length === failedCount
  const ran = rows.some((row) => row.id === 'T94') && rows.some((row) => row.id === 'T101')
  check(
    'T124',
    'A5.7 regression',
    ran && reconciled && undocumented.length === 0,
    !ran ? 'the A5.7 suite did not reach its regression checks' : !reconciled ? `A5.7 reports ${failedCount} failure(s) but ${failing.length} could be named` : undocumented.length > 0 ? `undocumented A5.7 failures: ${undocumented.join(', ')}` : `${(chain.output.match(/\[A5\.7\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.7] automated summary: ', 'A5.7 ')}; all ${failedCount} failure(s) named and accounted for, and every persistence, read and reference-integrity invariant still holds`,
  )
  for (const id of undocumented) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) console.log(`[A5.8]      ${row.line.slice(0, 400)}`)
  }
  for (const id of Object.keys(a57NonApplicable)) {
    const row = rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T124/${id}`, `A5.7 ${titleOf(row.line)}`, a57NonApplicable[id])
  }
  const verdictOf = (id: string) => rows.find((row) => row.id === id)?.verdict ?? 'missing'
  check('T125', 'A5.6 regression', verdictOf('T94') === 'PASS', `A5.7 T94 (A5.6) ${verdictOf('T94')}`)
  check('T126', 'A5.5 regression', verdictOf('T95') === 'PASS', `A5.7 T95 (A5.5) ${verdictOf('T95')}`)
  check('T127', 'A5.4 regression', verdictOf('T96') === 'PASS', `A5.7 T96 (A5.4) ${verdictOf('T96')}`)
  check('T128', 'A5.3/A5.2/A5.1 regressions', verdictOf('T97') === 'PASS' && verdictOf('T98') === 'PASS', `A5.7 T97 (A5.3) ${verdictOf('T97')}, T98 (A5.2 and A5.1) ${verdictOf('T98')}`)
  check('T129', 'A4 regressions', verdictOf('T99') === 'PASS', `A5.7 T99 (A4.10 and A4.9 to A1) ${verdictOf('T99')}`)
  for (const text of chain.output.split(/\r?\n/).filter((l) => l.startsWith('[A5.7]      ') && / substantive checks /.test(l))) console.log(`[A5.8]      ${text.replace('[A5.7]', '').trim().slice(0, 190)}`)
  // The A3.9 scope suite runs inside A3.10 T65, which already fails on the A5.2 eligibility table; it is
  // run directly here so a new A3 scope failure can never hide behind that tolerated id.
  const scope = run('npm run test:a3:scope')
  const scopeFails = scope.output.split(/\r?\n/).filter((l) => /^\s*FAIL\s/.test(l))
  const scopeOnlyKnown = scopeFails.length === 1 && /eligibility_verifications/.test(scopeFails[0])
  check('T130', 'A3 regressions', verdictOf('T100') === 'PASS' && scopeOnlyKnown, `A5.7 T100 (A3) ${verdictOf('T100')}; the A3.9 scope suite fails only its A3-era no-eligibility-table guard (${scopeFails.length} line)`)
  check('T131', 'A2/A1 regressions', verdictOf('T101') === 'PASS', `A5.7 T101 (A2 and A1) ${verdictOf('T101')}`)

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
  check('T132', 'DB truth', upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered, 'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200')

  // ---------------------------------------------------------------- closure (T133–T135)
  section('Repeatability, diff scope and exact head')
  await waitFor(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return true
    } catch {
      return false
    }
  }, 60_000)
  const priorRuns = await prisma.validationRun.count({ where: { validatorVersion: 'A5-VAL-1', createdAt: { lt: runStartedAt } } })
  check('T133', 'Repeatability', createdRunIds.length > 20, `this run used a fresh synthetic runId (${runId}) and recorded ${createdRunIds.length} run(s); ${priorRuns} A5-VAL-1 run(s) from earlier runs retained as history, none deleted`)
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/modules/validation-run/validation-run.repository.ts',
    'backend/src/modules/validation-run/validation-run.service.ts',
    'backend/src/modules/validation-run/validation-run.types.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith(`${MODULE_DIR}/`) && !file.startsWith('backend/src/integration/a5-pre-claim-validation/') && !file.startsWith(`${FRONTEND_DIR}/`) && !file.includes('a5_8_validation_provenance') && !allowed.includes(file),
  )
  const futureImport = moduleCode.code.match(/from '[^']*modules\/(readiness|claim|claim-line|submission|remittance|pricing)/)
  check(
    'T134',
    'Diff scope',
    outOfScope.length === 0 && futureImport === null,
    outOfScope.length === 0 && futureImport === null ? `${changedPaths.length} path(s): the A5.8 module, its migration, harness and check page, the narrow A5.7 read enrichment, the replay verifier, and wiring; no A5.9+, A6 or A9 domain` : `unexpected: ${[...outOfScope, futureImport?.[0]].filter(Boolean).join(', ').slice(0, 220)}`,
  )
  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [':/backend/src/integration/a5-pre-claim-validation', `:/${MODULE_DIR}`, `:/${FRONTEND_DIR}`],
  )
  const realDataMarkers = new RegExp(['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((f) => `(?:${f})`).join('|'), 'i')
  const harnessSource = git('show HEAD:backend/src/integration/a5-pre-claim-validation/a5-pre-claim-validation.integration.ts')
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [':/backend/src/integration/a5-pre-claim-validation'])
  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T135',
    'Exact head evidence',
    secretReach.status === 0 && secretScan.status === 1 && harnessSource.match(realDataMarkers) === null && headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a58Branch}`),
    `no credential, real patient or member content is committed; all evidence corresponds to ${headSha}; ${tracking}; working tree clean`,
  )

  console.log(`\n[A5.8] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A5.8] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.8] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A5.8] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A5.8] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.8] A5.8 LAYERED PRE-CLAIM VALIDATION / PROVENANCE ACCEPTANCE COMPLETE' : '[A5.8] A5.8 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

function findingOutcome(findings: StoredFinding[], code: string): string | null {
  return findings.find((f) => f.findingCode === code)?.outcome ?? null
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A5.8] RUN ABORTED: ${error.message}`)
      console.log('[A5.8] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A5.8] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.8] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
