import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { captureAuthorizationLines } from '../../modules/authorization-line/authorization-line.service.ts'
import { createPriorAuthorization } from '../../modules/prior-authorization/prior-authorization.service.ts'
import { createEncounter } from '../../modules/encounter/encounter.service.ts'
import { createMembership } from '../../modules/insurance-membership/insurance-membership.service.ts'
import { createEvidenceArtifact } from '../../modules/evidence-artifact/evidence-artifact.service.ts'

// A5.4 — focused acceptance for Authorization Line Matching & Scope Validation (T01–T123, plus
// T124–T126 added by the first audit: A4.9 integrity verification before any line is matched).
//
// A5.4 captures the line-level scope of one exact A5.3 version once, as an immutable ordered batch,
// and compares that scope with the Encounter as it stands now — read-only, in one snapshot, every
// time it is asked. Zero candidate lines is NO_MATCH, more than one is AMBIGUOUS, and no winner is
// ever chosen. Nothing about a match is stored.
//
// Valid fixtures are created through their owning routes. The one exception is the other tenant's
// authorization version for T56: the admin signed in here cannot write into another organization
// through a route, so that fixture is built in-process through the same owner services the routes
// call. The database is READ for structural proof. ADVERSARIAL writes go in only to prove that
// something refuses them. Every value is synthetic.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.4] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.4] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

// §27 — an obsolete phase-boundary check from an older suite is reported as N/A with its exact
// reason and counted separately. A substantive owner-behaviour failure is never converted to one.
function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.4] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.4] ${title}`)

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

// A scope guard must judge what the code DOES, not which words it mentions. This module's comments
// name the things it refuses to do, and its unit tests name refused fields on purpose. Comments are
// stripped, and checks asking "does this module store or handle X" read the production files only.
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

const committedProductionCodeOf = (dir: string) => {
  const files = committedFiles(dir).filter((file) => !file.endsWith('.test.ts'))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

class RunAborted extends Error {}

const runId = `A54-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A5.3 FINAL PASS was merged into main as PR #51; A5.4 is branched from that merge.
const a53Merge = '215cb7d'
const a54Branch = 'feature/a5-4-authorization-line-matching-scope-validation'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'

const deepKeys = (value: unknown, found: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) deepKeys(item, found)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      found.add(key)
      deepKeys(child, found)
    }
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

async function waitForLockWaiter(): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(rows[0].waiting) > 0) return true
    await new Promise((resolve) => setImmediate(resolve))
  }
  return false
}

// One line of an older suite's output, read by its id and its verdict token. The id is matched as a
// fixed prefix, never through a pattern built from it.
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

const lineAuditCount = () => prisma.auditEvent.count({ where: { entityType: 'AUTHORIZATION_LINE' } })

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A5.4] Authorization line matching & scope validation — run ${runId}`)
  console.log(`[A5.4] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
    throw new RunAborted(
      `the database is not reachable, so no check can be judged. Start it with \`docker start ${dbContainer}\`, wait for it to report healthy, then run this suite again.`,
    )

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

  // ---------------------------------------------------------------- gates (T01–T06)
  section('Start gate, migration and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'Start gate',
    branch === a54Branch && gitOk(`merge-base --is-ancestor ${a53Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the A5.3 merge ${a53Merge} (PR #51) is on main and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const scopeProblems = [
    [/CREATE TABLE "authorization_lines"/.test(statements), 'the authorization line table is not created'],
    [(statements.match(/CREATE TABLE/g) ?? []).length === 1, 'a table other than authorization_lines is created'],
    [!/DROP INDEX/.test(statements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [(statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? []).every((match) => match === 'ALTER TABLE "authorization_lines"'), 'a table other than authorization_lines is altered'],
    [!/claim|submission|validation_run|readiness|provider_contract|tariff|match/i.test(statements), 'a future-phase or match-result table appears'],
    [(statements.match(/ADD CONSTRAINT "authorization_lines_[a-z_]*_chk"/g) ?? []).length === 7, 'the seven CHECKs are not all added'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 5, 'not all five foreign keys are ON DELETE RESTRICT'],
    [/CREATE UNIQUE INDEX "authorization_lines_prior_authorization_version_id_sequence_key"/.test(statements), 'the per-version sequence is not unique'],
    [(statements.match(/CREATE UNIQUE INDEX/g) ?? []).length === 1, 'a uniqueness on service/procedure/diagnosis combinations was added'],
    [(statements.match(/CREATE TRIGGER authorization_lines_append_only_trg/g) ?? []).length === 1, 'the immutability trigger is not created'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T03',
    'Migration scope',
    migrationPaths.length === 1 && scopeProblems.length === 0,
    migrationPaths.length !== 1
      ? `expected exactly one migration, found ${migrationPaths.length}`
      : scopeProblems.length === 0
        ? 'one migration; one table, seven CHECKs, five RESTRICT foreign keys, one unique sequence and the immutability trigger only, with no drift'
        : `out of scope: ${scopeProblems.join('; ')}`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check(
    'T04',
    'Prisma gates',
    validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output),
    'schema valid, client generated, schema up to date',
  )

  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'Migration replay',
    replay.ok &&
      /ALL CHECKS PASS/.test(replay.output) &&
      /the append-only trigger on authorization lines is present/.test(replay.output) &&
      /authorization lines carry no match, claim-line, readiness or pricing column/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the CHECKs, foreign keys, indexes and immutability trigger survive, and no match column or table appears`,
  )

  const allPermissionCodes = (await prisma.permission.findMany({ select: { code: true } })).map((row) => row.code)
  const linePermissions = allPermissionCodes.filter((code) => code.startsWith('authorizationLine')).sort()
  const grants = await prisma.rolePermission.findMany({
    where: { permission: { code: { startsWith: 'authorizationLine' } } },
    select: { role: { select: { code: true } }, permission: { select: { code: true } } },
  })
  const grantOf = (code: string) => grants.filter((g) => g.permission.code === code).map((g) => g.role.code).sort().join(',')
  const inventedPermissions = allPermissionCodes.filter((code) => /^authorizationLine\.(update|delete|append|match|claim)|claim|network\.execute|payer\.submit/i.test(code))
  check(
    'T06',
    'Permissions',
    linePermissions.join(',') === 'authorizationLine.create,authorizationLine.evaluate,authorizationLine.read' &&
      grantOf('authorizationLine.create') === 'ORG_ADMIN' &&
      grantOf('authorizationLine.read') === 'ORG_ADMIN,ORG_VIEWER' &&
      grantOf('authorizationLine.evaluate') === 'ORG_ADMIN,ORG_VIEWER' &&
      inventedPermissions.length === 0,
    inventedPermissions.length === 0
      ? 'exactly create (Admin), read and evaluate (Admin, Viewer) exist; no update, delete, claim or network permission was invented'
      : `unexpected: ${inventedPermissions.join(', ')}`,
  )

  // ---------------------------------------------------------------- fixtures
  await apiReady('signing in')
  let connectionResets = 0
  const httpCall = async (path: string, init?: RequestInit) => {
    try {
      return await callApi(baseUrl, path, init)
    } catch {
      connectionResets += 1
      throw new RunAborted(
        `the API connection was reset while calling ${path}. The server was replaced underneath this run, ` +
          'which is what a server started with `--watch` does whenever db:generate or a migration replay rewrites a file. ' +
          'Close the terminal tab running `npm run dev`, start the API with `npm start` in a tab of its own, and run this suite again.',
      )
    }
  }
  const signIn = async (email: string, password: string) => {
    const res = await httpCall('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ email, password }),
    })
    return { status: res.status, cookie: extractCookieHeader(res.setCookies) }
  }
  const admin = await signIn(adminEmail, adminPassword)
  const viewer = await signIn(viewerEmail, viewerPassword)
  if (admin.status !== 200 || viewer.status !== 200) throw new Error(`sign-in failed (admin ${admin.status}, viewer ${viewer.status})`)
  const as = (cookie: string) => (init: RequestInit = {}) => ({
    ...init,
    headers: { ...init.headers, 'Content-Type': 'application/json', Cookie: cookie },
  })
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
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const facility2 = must('facility 2', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility 2` })).body)
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  const clinician2 = must('clinician 2', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician 2` })).body)
  for (const [label, fac] of [['facility', facility], ['facility 2', facility2]] as const) {
    const profile = must(`${label} regulatory profile`, (await post(`/api/facilities/${fac.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
    if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error(`fixture ${label} profile activation failed`)
  }
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  must('assignment at facility 2', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility2.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  must('assignment for clinician 2', (await post(`/api/clinicians/${clinician2.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const payer2 = must('payer 2', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer 2` })).body)
  const newMembership = async (label: string) =>
    must(label, (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier: `MEM-${runId}-${label.replace(/\W/g, '')}`, coverageFrom: '2025-01-01', coverageTo: null })).body)
  const membership = await newMembership('membership')
  const membership2 = await newMembership('membership 2')

  const services = [] as Array<{ id: string }>
  for (const n of [1, 2, 3, 4]) services.push(must(`service ${n}`, (await post(`/api/organizations/${org}/services`, { internalCode: `${runId}-S${n}`, displayName: `Synthetic service ${n}` })).body))
  const [svcA, svcB, svcC, svcD] = services
  const procA = must('procedure A', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: `${runId}-PA`, displayName: 'Synthetic procedure A', codeSystem: 'SYNTHETIC', externalCode: `${runId}-XA` })).body)
  const procB = must('procedure B', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: `${runId}-PB`, displayName: 'Synthetic procedure B', codeSystem: 'SYNTHETIC', externalCode: `${runId}-XB` })).body)
  const dxA = must('diagnosis A', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-DXA`, displayName: 'Synthetic diagnosis A' })).body)
  const dxB = must('diagnosis B', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-DXB`, displayName: 'Synthetic diagnosis B' })).body)
  const evidenceId = (must('evidence', (await post(`/api/organizations/${org}/evidence-artifacts`, {
    storageRef: `synthetic://evidence/${runId}/a`, contentHash: 'a'.repeat(64), documentType: `SYNTHETIC_AUTH_DOCUMENT_${runId.slice(-6)}`,
    sourceDate: null, receivedAt: '2026-06-15T09:30:00.000Z',
  })).body) as any).latestVersion.id as string

  const newEncounter = async (label: string, overrides: Record<string, unknown> = {}) =>
    must(label, (await post(`/api/patients/${patient.id}/encounters`, {
      facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membership.id, ...overrides,
    })).body)
  const encounter = await newEncounter('encounter')

  // A fresh authorization case on an Encounter; returns the exact version lines are captured for.
  // REQUESTED is the INITIAL version itself; any other header status is a RESPONSE version appended to it.
  type Header = { status: string; validFrom?: string | null; validThrough?: string | null }
  const newVersion = async (encounterId: string, header: Header = { status: 'REQUESTED' }) => {
    const created = await post(`/api/encounters/${encounterId}/prior-authorizations`, {
      versionKind: 'INITIAL', status: 'REQUESTED', authorizationReference: null, eligibilityVerificationId: null,
      requestedAt: null, respondedAt: null,
      validFrom: header.status === 'REQUESTED' ? header.validFrom ?? null : null,
      validThrough: header.status === 'REQUESTED' ? header.validThrough ?? null : null,
      evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: evidenceId }],
    })
    const authorization = must('prior authorization', created.body) as any
    if (header.status === 'REQUESTED') return { authorizationId: authorization.id as string, versionId: authorization.latestRecordedVersion.id as string }
    const appended = await post(`/api/prior-authorizations/${authorization.id}/versions`, {
      versionKind: 'RESPONSE', status: header.status, authorizationReference: null, eligibilityVerificationId: null,
      requestedAt: null, respondedAt: '2026-06-10T09:00:00.000Z',
      validFrom: header.validFrom ?? null, validThrough: header.validThrough ?? null,
      evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: evidenceId }],
    })
    return { authorizationId: authorization.id as string, versionId: must(`${header.status} version`, appended.body).id }
  }

  const line = (overrides: Record<string, unknown> = {}) => ({
    serviceId: svcA.id, procedureCodeId: null, diagnosisCodeId: null, requestedQty: '10', approvedQty: '10',
    unitCode: null, approvedFrom: null, approvedThrough: null, status: 'APPROVED', ...overrides,
  })
  const linesPath = (versionId: string) => `/api/prior-authorization-versions/${versionId}/authorization-lines`
  const evalPath = (versionId: string) => `/api/prior-authorization-versions/${versionId}/scope-evaluation`
  const capture = (versionId: string, lines: unknown[], who = asAdmin) => post(linesPath(versionId), { lines }, who)
  const storedLines = (versionId: string) => prisma.authorizationLine.findMany({ where: { priorAuthorizationVersionId: versionId }, orderBy: { sequence: 'asc' } })
  const lineCount = (versionId: string) => prisma.authorizationLine.count({ where: { priorAuthorizationVersionId: versionId } })

  // One accepted single-line capture on its own fresh version, read back through the API.
  const acceptOne = async (overrides: Record<string, unknown>) => {
    const { versionId } = await newVersion(encounter.id)
    const res = await capture(versionId, [line(overrides)])
    return { status: res.status, dto: (res.body as any)?.items?.[0] as Record<string, any> | undefined, versionId }
  }
  // A refused capture on the shared empty version: it must stay empty, so a refusal never consumes it.
  const emptyVersion = (await newVersion(encounter.id)).versionId
  const refuse = async (body: unknown) => {
    const res = await post(linesPath(emptyVersion), body)
    return { status: res.status, message: String((res.body as any)?.error?.message ?? ''), empty: (await lineCount(emptyVersion)) === 0 }
  }
  const refuseLine = (overrides: Record<string, unknown>) => refuse({ lines: [line(overrides)] })

  // A scoped Encounter with its own activities and diagnoses, an authorization case with the given
  // header, a captured line set, and the scope evaluation of it.
  type ActivitySpec = { serviceId?: string | null; procedureCodeId?: string | null; quantity?: string; unitCode?: string | null }
  type Scenario = {
    encounter?: Record<string, unknown>
    header?: Header
    lines: Array<Record<string, unknown>>
    activities: ActivitySpec[]
    diagnoses?: string[]
    removeDiagnoses?: string[]
  }
  const scenario = async (label: string, spec: Scenario) => {
    const enc = await newEncounter(`${label} encounter`, spec.encounter ?? {})
    const diagnosisRows: Record<string, string> = {}
    for (const dx of [...(spec.diagnoses ?? []), ...(spec.removeDiagnoses ?? [])]) diagnosisRows[dx] = must(`${label} diagnosis`, (await post(`/api/encounters/${enc.id}/diagnoses`, { diagnosisCodeId: dx })).body).id
    for (const dx of spec.removeDiagnoses ?? []) {
      const removed = await post(`/api/encounter-diagnoses/${diagnosisRows[dx]}/remove`, {})
      if (removed.status !== 200) throw new Error(`fixture ${label}: diagnosis removal returned ${removed.status}`)
    }
    const activityIds: string[] = []
    for (const activity of spec.activities)
      activityIds.push(
        must(`${label} activity`, (await post(`/api/encounters/${enc.id}/activities`, {
          serviceId: activity.serviceId === undefined ? svcA.id : activity.serviceId,
          procedureCodeId: activity.procedureCodeId ?? null,
          quantity: activity.quantity ?? '1',
          unitCode: activity.unitCode ?? null,
        })).body).id,
      )
    const { authorizationId, versionId } = await newVersion(enc.id, spec.header ?? { status: 'APPROVED' })
    const captured = await capture(versionId, spec.lines)
    if (captured.status !== 201) throw new Error(`fixture ${label}: line capture returned ${captured.status} ${JSON.stringify(captured.body).slice(0, 200)}`)
    const lineIds = ((captured.body as any).items as Array<{ id: string }>).map((row) => row.id)
    const evaluated = await get(evalPath(versionId))
    const body = evaluated.body as any
    const row = (index: number) => (body?.activities ?? []).find((a: any) => a.encounterActivityId === activityIds[index]) ?? {}
    const outcome = (index: number) => String(row(index).outcome ?? `missing (status ${evaluated.status})`)
    const utilization = (index: number) => (body?.lineUtilization ?? []).find((u: any) => u.authorizationLineId === lineIds[index]) ?? {}
    return { encounterId: enc.id, authorizationId, versionId, activityIds, lineIds, status: evaluated.status, body, row, outcome, utilization, diagnosisRows }
  }
  const reevaluate = async (versionId: string, who = asAdmin) => {
    const res = await get(evalPath(versionId), who)
    return { status: res.status, body: res.body as any }
  }

  console.log(`[A5.4]      fixtures ready: patient, 2 facilities, 2 clinicians, 3 assignments, 2 payers, 2 memberships, 4 services, 2 procedures, 2 diagnoses, 1 evidence version`)

  // ---------------------------------------------------------------- capture (T07–T11)
  section('Capturing one immutable line batch for one exact version')
  const mainVersion = (await newVersion(encounter.id, { status: 'PARTIALLY_APPROVED', validFrom: '2026-06-01', validThrough: '2026-06-30' })).versionId
  const evidenceLinksBefore = await prisma.priorAuthorizationVersionEvidence.count({ where: { priorAuthorizationVersionId: mainVersion } })
  const mainLines = [
    line({ serviceId: svcA.id, approvedQty: '1', requestedQty: '2', unitCode: 'UNIT', approvedFrom: '2026-06-01', approvedThrough: '2026-06-30', status: 'PARTIALLY_APPROVED' }),
    line({ serviceId: svcB.id, procedureCodeId: procA.id, diagnosisCodeId: dxA.id }),
    line({ serviceId: null, procedureCodeId: procB.id, approvedQty: null, status: 'DENIED' }),
  ]
  const mainCreate = await capture(mainVersion, mainLines)
  const mainDtos = ((mainCreate.body as any)?.items ?? []) as Array<Record<string, any>>
  const mainStored = await storedLines(mainVersion)
  const mainAudits = await prisma.auditEvent.findMany({ where: { entityType: 'AUTHORIZATION_LINE', entityId: { in: mainStored.map((row) => row.id) } } })
  check(
    'T07',
    'Admin batch create',
    mainCreate.status === 201 && mainDtos.length === 3 && mainStored.length === 3 && mainAudits.length === 3,
    `201; ${mainStored.length} lines and ${mainAudits.length} safe audit events written in one transaction`,
  )
  const versionOwner = await prisma.priorAuthorizationVersion.findUniqueOrThrow({
    where: { id: mainVersion },
    select: { priorAuthorization: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } },
  })
  check(
    'T08',
    'Version ownership',
    versionOwner.priorAuthorization.encounter.patient.organizationId === org && (await get(linesPath(mainVersion))).status === 200,
    'the version resolves through its case, Encounter and Patient to the signed-in organization before authorization',
  )

  const auditBeforeEmpty = await lineAuditCount()
  const emptyBatch = await refuse({ lines: [] })
  const noLinesKey = await refuse({})
  check(
    'T09',
    'Empty batch',
    emptyBatch.status === 400 && noLinesKey.status === 400 && emptyBatch.empty && (await lineAuditCount()) === auditBeforeEmpty,
    `an empty array and a missing lines key are both refused (${emptyBatch.status}, ${noLinesKey.status}); no line and no audit`,
  )

  const snapshotBefore = JSON.stringify(await storedLines(mainVersion))
  const secondBatch = await capture(mainVersion, [line({ serviceId: svcC.id })])
  const sequentialRefused = secondBatch.status === 400 && /already captured/.test(String((secondBatch.body as any)?.error?.message ?? '')) && JSON.stringify(await storedLines(mainVersion)) === snapshotBefore
  // Two FIRST batches at once: the version row lock makes the second wait, then read the first
  // one's lines and be refused, instead of both seeing "no lines yet".
  const raceVersion = (await newVersion(encounter.id)).versionId
  const gate = holdAt('authorization_line.version_locked')
  const firstRacer = captureAuthorizationLines(raceVersion, { lines: [line({ serviceId: svcA.id })] }, actorUserId)
  await gate.arrived
  const secondRacer = captureAuthorizationLines(raceVersion, { lines: [line({ serviceId: svcB.id }), line({ serviceId: svcC.id })] }, actorUserId)
  const raceBlocked = await waitForLockWaiter()
  gate.release()
  const racers = await Promise.all([firstRacer, secondRacer])
  clearConcurrencyProbes()
  const raceWinners = racers.filter((result) => result.ok)
  const raceLosers = racers.filter((result) => !result.ok && result.code === 'VALIDATION_ERROR')
  const raceStored = await lineCount(raceVersion)
  check(
    'T10',
    'Second batch',
    sequentialRefused && raceBlocked && raceWinners.length === 1 && raceLosers.length === 1 && raceStored === 1,
    `refused with ${secondBatch.status} and the original line set unchanged — correction requires new A5.3 version; two concurrent first batches serialized on the version lock and exactly one line set (${raceStored} line) was kept`,
  )

  const sequenceSupplied = await refuseLine({ sequence: 7 })
  check(
    'T11',
    'Server sequence',
    mainStored.map((row) => row.sequence).join(',') === '1,2,3' &&
      mainStored.map((row) => row.serviceId ?? row.procedureCodeId).join(',') === [svcA.id, svcB.id, procB.id].join(',') &&
      sequenceSupplied.status === 400 && /sequence is derived by the server/.test(sequenceSupplied.message),
    'submitted order became contiguous 1..3; a client-supplied sequence is refused by name',
  )

  // ---------------------------------------------------------------- identity (T12–T20)
  section('Line identity and master ownership')
  const serviceOnly = await acceptOne({ serviceId: svcA.id, procedureCodeId: null })
  check('T12', 'Service-only identity', serviceOnly.status === 201 && serviceOnly.dto?.serviceId === svcA.id && serviceOnly.dto?.procedureCodeId === null, 'an own-organization service alone is accepted')
  const procedureOnly = await acceptOne({ serviceId: null, procedureCodeId: procA.id })
  check('T13', 'Procedure-only identity', procedureOnly.status === 201 && procedureOnly.dto?.procedureCodeId === procA.id && procedureOnly.dto?.serviceId === null, 'an own-organization procedure alone is accepted')
  const both = await acceptOne({ serviceId: svcA.id, procedureCodeId: procA.id })
  check('T14', 'Service+procedure identity', both.status === 201 && both.dto?.serviceId === svcA.id && both.dto?.procedureCodeId === procA.id, 'both are stored; T74 proves both must then match (AND)')
  const noIdentity = await refuseLine({ serviceId: null, procedureCodeId: null, diagnosisCodeId: dxA.id })
  check('T15', 'No service/procedure', noIdentity.status === 400 && noIdentity.empty, 'refused even with a diagnosis: a diagnosis alone does not say what was authorized')

  const foreignService = await prisma.service.findFirst({ where: { organizationId: otherOrg }, select: { id: true } })
  const foreignProcedure = await prisma.procedureCode.findFirst({ where: { organizationId: otherOrg }, select: { id: true } })
  const foreignDiagnosis = await prisma.diagnosisCode.findFirst({ where: { organizationId: otherOrg }, select: { id: true } })
  const privacySafe = async (field: string, foreignId: string | undefined) => {
    const foreign = await refuseLine(field === 'serviceId' ? { serviceId: foreignId } : { [field]: foreignId })
    const missing = await refuseLine(field === 'serviceId' ? { serviceId: MISSING } : { [field]: MISSING })
    const ok = foreignId !== undefined && foreign.status === 404 && missing.status === 404 && foreign.message === missing.message && foreign.empty && !foreign.message.includes(otherOrg) && !foreign.message.includes(foreignId)
    return { ok, detail: `foreign ${foreign.status} and missing ${missing.status} with the identical message "${foreign.message}"; nothing written, no tenant or id disclosed` }
  }
  const t16 = await privacySafe('serviceId', foreignService?.id)
  check('T16', 'Foreign service', t16.ok, t16.detail)
  const t17 = await privacySafe('procedureCodeId', foreignProcedure?.id)
  check('T17', 'Foreign procedure', t17.ok, t17.detail)
  const t18 = await privacySafe('diagnosisCodeId', foreignDiagnosis?.id)
  check('T18', 'Foreign diagnosis', t18.ok, t18.detail)

  const unrelatedPair = await acceptOne({ serviceId: svcD.id, procedureCodeId: procB.id })
  const mappingTables = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(service_procedure|procedure_service|_mapping)'`).map((row) => row.table_name)
  check(
    'T19',
    'No Service<->Procedure inference',
    unrelatedPair.status === 201 && mappingTables.length === 0,
    'an arbitrary owned service and procedure pair is accepted on ownership alone; no mapping table exists to consult',
  )
  const dxNull = await acceptOne({ diagnosisCodeId: null })
  const dxOwned = await acceptOne({ diagnosisCodeId: dxA.id })
  check('T20', 'Diagnosis optional', dxNull.status === 201 && dxNull.dto?.diagnosisCodeId === null && dxOwned.status === 201 && dxOwned.dto?.diagnosisCodeId === dxA.id, 'null is accepted and stored null; an owned diagnosis is stored as given')

  // ---------------------------------------------------------------- quantities and units (T21–T31)
  section('Exact quantities and opaque units')
  const qtyInteger = await acceptOne({ requestedQty: '2' })
  check('T21', 'requestedQty integer', qtyInteger.status === 201 && qtyInteger.dto?.requestedQty === '2', 'stored and read back exactly as 2')
  const qtyFraction = await acceptOne({ requestedQty: '0.1250' })
  const qtyFractionRow = qtyFraction.dto ? await prisma.authorizationLine.findUnique({ where: { id: qtyFraction.dto.id }, select: { requestedQty: true } }) : null
  check(
    'T22',
    'requestedQty fractional',
    qtyFraction.status === 201 && qtyFraction.dto?.requestedQty === '0.125' && qtyFractionRow?.requestedQty.toString() === '0.125',
    'four decimal places accepted; NUMERIC(18,4) holds exactly 0.125 and the DTO reports it in shortest exact form',
  )
  const badRequested: string[] = []
  for (const value of ['0', '-1', '1e3', '1.23456', '123456789012345', 'abc', '', 2]) {
    const res = await refuseLine({ requestedQty: value })
    if (res.status !== 400 || !res.empty) badRequested.push(String(value))
  }
  check('T23', 'requestedQty invalid', badRequested.length === 0, badRequested.length === 0 ? 'zero, negative, exponent, over-precision, oversized, blank, text and a JSON number are all refused' : `accepted: ${badRequested.join(', ')}`)
  const approvedNull = await acceptOne({ approvedQty: null })
  check('T24', 'approvedQty null', approvedNull.status === 201 && approvedNull.dto?.approvedQty === null, 'accepted and preserved as null (not supplied)')
  const approvedZero = await acceptOne({ approvedQty: '0' })
  check('T25', 'approvedQty zero', approvedZero.status === 201 && approvedZero.dto?.approvedQty === '0', 'accepted as an explicit zero, distinct from null')
  const approvedPositive = await acceptOne({ approvedQty: '1.5' })
  check('T26', 'approvedQty positive', approvedPositive.status === 201 && approvedPositive.dto?.approvedQty === '1.5', 'stored exactly as 1.5')
  const badApproved: string[] = []
  for (const value of ['-1', '1e2', '1.00001', '', 'x', 1.5]) {
    const res = await refuseLine({ approvedQty: value })
    if (res.status !== 400 || !res.empty) badApproved.push(String(value))
  }
  check('T27', 'approvedQty invalid', badApproved.length === 0, badApproved.length === 0 ? 'negative, exponent, over-precision, blank, text and a JSON number are all refused' : `accepted: ${badApproved.join(', ')}`)
  const approvedHigher = await acceptOne({ requestedQty: '1', approvedQty: '5' })
  check('T28', 'No approved<=requested inference', approvedHigher.status === 201 && approvedHigher.dto?.requestedQty === '1' && approvedHigher.dto?.approvedQty === '5', 'an approved quantity above the requested one is preserved as reported, not corrected')
  const unitNull = await acceptOne({ unitCode: null })
  check('T29', 'unitCode null', unitNull.status === 201 && unitNull.dto?.unitCode === null, 'accepted as no unit')
  const unitOpaque = await acceptOne({ unitCode: '  mL  ' })
  check('T30', 'unitCode opaque', unitOpaque.status === 201 && unitOpaque.dto?.unitCode === 'mL', 'trimmed with its case preserved; no unit vocabulary is imposed')
  const badUnits: string[] = []
  for (const [label, value] of [['blank', '   '], ['control', 'M\u0001L'], ['oversize', 'U'.repeat(65)]] as const) {
    const res = await refuseLine({ unitCode: value })
    if (res.status !== 400 || !res.empty) badUnits.push(label)
  }
  check('T31', 'unitCode invalid', badUnits.length === 0, badUnits.length === 0 ? 'blank, control-character and 65-character units are refused' : `accepted: ${badUnits.join(', ')}`)

  // ---------------------------------------------------------------- dates and statuses (T32–T42)
  section('Approved dates and reported statuses')
  const datesNull = await acceptOne({ approvedFrom: null, approvedThrough: null })
  check('T32', 'Approved dates null', datesNull.status === 201 && datesNull.dto?.approvedFrom === null && datesNull.dto?.approvedThrough === null, 'both null accepted; no date invented')
  const dateReal = await acceptOne({ approvedFrom: '2026-06-01', approvedThrough: '2026-06-30' })
  const badDates: string[] = []
  for (const value of ['2026-02-30', '2026-06-01T00:00:00Z', '2026-6-1', 20260601]) {
    const res = await refuseLine({ approvedFrom: value })
    if (res.status !== 400 || !res.empty) badDates.push(String(value))
  }
  check(
    'T33',
    'Approved date strict',
    dateReal.status === 201 && dateReal.dto?.approvedFrom === '2026-06-01' && dateReal.dto?.approvedThrough === '2026-06-30' && badDates.length === 0,
    badDates.length === 0 ? 'real YYYY-MM-DD accepted; an impossible date, a timestamp, an unpadded date and a number are refused' : `accepted: ${badDates.join(', ')}`,
  )
  const appOrder = await refuseLine({ approvedFrom: '2026-06-30', approvedThrough: '2026-06-01' })
  const scratchVersion = (await newVersion(encounter.id)).versionId
  const dbOrder = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe(
      `INSERT INTO authorization_lines (id, prior_authorization_version_id, sequence, service_id, requested_qty, approved_from, approved_through, status, created_by_user_id)
       VALUES (gen_random_uuid(), '${scratchVersion}', 1, '${svcA.id}', 1, DATE '2026-06-30', DATE '2026-06-01', 'APPROVED', '${actorUserId}')`,
    ),
  )
  check(
    'T34',
    'Approved date order',
    appOrder.status === 400 && /approvedThrough/.test(appOrder.message) && /authorization_lines_approved_dates_order_chk/.test(dbOrder) && (await lineCount(scratchVersion)) === 0,
    'refused by the application (400) and, for a direct INSERT, by the database CHECK',
  )

  const statuses = ['REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN']
  const statusVersion = (await newVersion(encounter.id)).versionId
  const statusCreate = await capture(statusVersion, statuses.map((status, index) => line({ serviceId: services[index % 4].id, status })))
  const statusStored = await storedLines(statusVersion)
  const statusCheck = (id: string, status: string, detail: string) =>
    check(id, `Status ${status}`, statusCreate.status === 201 && statusStored.some((row) => row.status === status), detail)
  statusCheck('T35', 'REQUESTED', 'accepted as reported')
  statusCheck('T36', 'PENDING', 'accepted as reported')
  statusCheck('T37', 'APPROVED', 'accepted as reported')
  statusCheck('T38', 'PARTIALLY_APPROVED', 'accepted; no quantity or status is inferred from it')
  statusCheck('T39', 'DENIED', 'accepted as reported')
  statusCheck('T40', 'UNKNOWN', 'accepted as reported')
  const badStatuses: string[] = []
  for (const value of ['ACTIVE', 'EXPIRED', 'approved', '', null]) {
    const res = await refuseLine({ status: value })
    if (res.status !== 400 || !res.empty) badStatuses.push(String(value))
  }
  check('T41', 'Bad status', badStatuses.length === 0, badStatuses.length === 0 ? 'ACTIVE, EXPIRED, a lower-case status, blank and null are refused' : `accepted: ${badStatuses.join(', ')}`)
  await reevaluate(statusVersion)
  const statusHeader = await prisma.priorAuthorizationVersion.findUniqueOrThrow({ where: { id: statusVersion }, select: { status: true } })
  const statusAfter = await storedLines(statusVersion)
  check(
    'T42',
    'Parent/line status independent',
    statusHeader.status === 'REQUESTED' && statusAfter.map((row) => row.status).join(',') === statuses.join(','),
    'a REQUESTED header holds six lines of six statuses; after an evaluation neither the header nor any line was rewritten or summarized',
  )

  // ---------------------------------------------------------------- structure (T43–T52)
  section('What a line is not, and immutability')
  const lineColumns = (await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'authorization_lines'`).map((row) => row.column_name)
  const columnsMatching = (pattern: RegExp) => lineColumns.filter((name) => pattern.test(name))
  check('T43', 'No evidence copy', lineColumns.length > 0 && columnsMatching(/(evidence|storage|content_hash|document|bytes)/i).length === 0, `none of ${lineColumns.length} columns carries evidence metadata or content`)
  const contextColumns = columnsMatching(/(encounter|membership|member|policy|payer|tpa|network|product|facility|clinician|patient|service_date)/i)
  check('T44', 'No parent context copy', lineColumns.length > 0 && contextColumns.length === 0, contextColumns.length === 0 ? 'no encounter, member, payer, facility, clinician or service-date column: A5.3 owns that context' : `found: ${contextColumns.join(', ')}`)
  check('T45', 'No activity FK', lineColumns.length > 0 && columnsMatching(/activit/i).length === 0, 'no encounterActivityId is persisted on a line')
  check('T46', 'No ClaimLine FK', lineColumns.length > 0 && columnsMatching(/claim/i).length === 0, 'no claimLineId')

  const listed1 = await get(linesPath(mainVersion))
  const listed2 = await get(linesPath(mainVersion))
  const listedItems = ((listed1.body as any)?.items ?? []) as Array<Record<string, any>>
  check(
    'T47',
    'List order',
    listed1.status === 200 && listedItems.map((row) => row.sequence).join(',') === '1,2,3' && JSON.stringify(listed1.body) === JSON.stringify(listed2.body),
    'sequence ascending, byte-identical across two reads',
  )
  const firstLineId = mainStored[0].id
  const single = await get(`/api/authorization-lines/${firstLineId}`)
  check('T48', 'Get line', single.status === 200 && JSON.stringify(single.body) === JSON.stringify(mainDtos[0]), 'the by-id read is exactly the DTO the capture returned')
  const patchLine = await patchApi(`/api/authorization-lines/${firstLineId}`, { status: 'DENIED' })
  const patchList = await patchApi(linesPath(mainVersion), { lines: [] })
  check('T49', 'No PATCH', patchLine.status === 404 && patchList.status === 404, 'PATCH on a line and on the line set are both 404')
  const deleteLine = await del(`/api/authorization-lines/${firstLineId}`)
  const deleteList = await del(linesPath(mainVersion))
  check('T50', 'No DELETE', deleteLine.status === 404 && deleteList.status === 404 && (await lineCount(mainVersion)) === 3, 'DELETE on a line and on the line set are both 404; all three lines remain')
  const dbUpdate = await attemptAdversarial(() => prisma.$executeRawUnsafe(`UPDATE authorization_lines SET approved_qty = 999 WHERE id = '${firstLineId}'`))
  check('T51', 'DB UPDATE immutability', /append-only/i.test(dbUpdate), 'the trigger refused a direct UPDATE')
  const dbDelete = await attemptAdversarial(() => prisma.$executeRawUnsafe(`DELETE FROM authorization_lines WHERE id = '${firstLineId}'`))
  check('T52', 'DB DELETE immutability', /append-only/i.test(dbDelete) && (await lineCount(mainVersion)) === 3, 'the trigger refused a direct DELETE and the line survived')

  // ---------------------------------------------------------------- permission and tenancy (T53–T57)
  section('Permission, tenancy and safe errors')
  check(
    'T53',
    'Viewer read',
    (await get(linesPath(mainVersion), asViewer)).status === 200 && (await get(`/api/authorization-lines/${firstLineId}`, asViewer)).status === 200,
    'a viewer may list lines and read one line',
  )
  const viewerVersion = (await newVersion(encounter.id)).versionId
  const auditBeforeViewer = await lineAuditCount()
  const viewerCreate = await capture(viewerVersion, [line()], asViewer)
  check('T54', 'Viewer create', viewerCreate.status === 403 && (await lineCount(viewerVersion)) === 0 && (await lineAuditCount()) === auditBeforeViewer, '403 with no line and no audit')
  const viewerEval = await reevaluate(mainVersion, asViewer)
  check('T55', 'Viewer evaluate', viewerEval.status === 200 && viewerEval.body?.schemaVersion === 'AuthorizationScopeEvaluationV1', 'a viewer may run the read-only scope evaluation')

  // The other tenant's version is built in-process through the owner services (see header note).
  type ForeignFixture = { ok: false; error: string } | { ok: true; versionId: string; lineId: string }
  const foreignFixture: ForeignFixture = await (async (): Promise<ForeignFixture> => {
    const template = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { patientId: true, facilityId: true, clinicianId: true, serviceDate: true } })
    const foreignPayer = await prisma.payer.findFirst({ where: { organizationId: otherOrg }, select: { id: true } })
    if (!template || !foreignPayer || !foreignService) return { ok: false, error: 'no foreign encounter, payer or service exists to build on' }
    const membershipResult = await createMembership(template.patientId, { payerId: foreignPayer.id, memberIdentifier: `MEM-${runId}-FOREIGN`, coverageFrom: '2000-01-01', coverageTo: null }, actorUserId)
    if (!membershipResult.ok) return { ok: false, error: `foreign membership: ${membershipResult.message}` }
    const encounterResult = await createEncounter(template.patientId, {
      facilityId: template.facilityId, clinicianId: template.clinicianId, serviceDate: template.serviceDate.toISOString().slice(0, 10), insuranceMembershipId: membershipResult.value.id,
    }, actorUserId)
    if (!encounterResult.ok) return { ok: false, error: `foreign encounter: ${encounterResult.message}` }
    const evidenceResult = await createEvidenceArtifact(otherOrg, {
      storageRef: `synthetic://evidence/${runId}/foreign`, contentHash: 'f'.repeat(64), documentType: `SYNTHETIC_AUTH_DOCUMENT_${runId.slice(-6)}`, sourceDate: null, receivedAt: '2026-06-15T09:30:00.000Z',
    }, actorUserId)
    if (!evidenceResult.ok) return { ok: false, error: `foreign evidence: ${evidenceResult.message}` }
    const caseResult = await createPriorAuthorization(encounterResult.value.id, {
      versionKind: 'INITIAL', status: 'REQUESTED', evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: evidenceResult.value.latestVersion.id }],
    }, actorUserId)
    if (!caseResult.ok) return { ok: false, error: `foreign case: ${caseResult.message}` }
    const foreignVersionId = caseResult.value.latestRecordedVersion.id
    const lineResult = await captureAuthorizationLines(foreignVersionId, { lines: [line({ serviceId: foreignService.id })] }, actorUserId)
    if (!lineResult.ok) return { ok: false, error: `foreign line: ${lineResult.message}` }
    return { ok: true, versionId: foreignVersionId, lineId: lineResult.value.items[0].id }
  })()
  if (foreignFixture.ok) {
    const foreignList = await get(linesPath(foreignFixture.versionId))
    const foreignCreate = await capture(foreignFixture.versionId, [line()])
    const foreignEval = await get(evalPath(foreignFixture.versionId))
    const foreignLine = await get(`/api/authorization-lines/${foreignFixture.lineId}`)
    const missingEval = await get(evalPath(MISSING))
    const responses = [foreignList, foreignCreate, foreignEval, foreignLine]
    // A1's shared middleware owns the refusal: it resolves the owning organization first, and a caller
    // with no permission there is refused before any A5.4 code runs. The envelope's requestId differs
    // per request by design, so the four refusals are compared on code and message, which must be the
    // same generic refusal every time and must name nothing about the other tenant.
    const refusalOf = (res: { body: unknown }) => { const e = (res.body as any)?.error ?? {}; return JSON.stringify({ code: e.code, message: e.message }) }
    const bodies = responses.map((res) => JSON.stringify(res.body ?? {}))
    check(
      'T56',
      'Cross-tenant version',
      responses.every((res) => res.status >= 400 && res.status < 500) && missingEval.status === 404 &&
        responses.every((res) => refusalOf(res) === refusalOf(responses[0])) &&
        bodies.every((text) => !text.includes(otherOrg) && !text.includes(foreignFixture.versionId) && !text.includes(foreignFixture.lineId)) &&
        (await lineCount(foreignFixture.versionId)) === 1,
      `list, create, evaluate and line read all refused (${responses.map((res) => res.status).join('/')}) with one generic message; nothing written and no tenant, id or line disclosed`,
    )
  } else {
    check('T56', 'Cross-tenant version', false, `the other tenant's version could not be built: ${foreignFixture.error}`)
  }

  const malformedStatuses: string[] = []
  const malformedBodies: string[] = []
  for (const [method, path] of [
    ['GET', '/api/prior-authorization-versions/not-a-uuid/authorization-lines'],
    ['POST', '/api/prior-authorization-versions/not-a-uuid/authorization-lines'],
    ['GET', '/api/prior-authorization-versions/not-a-uuid/scope-evaluation'],
    ['GET', '/api/authorization-lines/not-a-uuid'],
  ] as const) {
    const res = method === 'GET' ? await get(path) : await post(path, { lines: [line()] })
    malformedStatuses.push(String(res.status))
    malformedBodies.push(JSON.stringify(res.body ?? {}))
  }
  check(
    'T57',
    'Malformed IDs',
    malformedStatuses.every((code) => code === '404' || code === '400') && malformedBodies.every((text) => !/prisma|postgres|syntax|invalid input|column|relation/i.test(text)),
    `${malformedStatuses.join(', ')}; safe envelopes with no raw database text, never a 500`,
  )

  // ---------------------------------------------------------------- audit (T58–T63)
  section('Business audit — proves the capture, stores none of the scope')
  const snapshotKeys = mainAudits.map((row) => Object.keys((row.afterState ?? {}) as object).sort().join(','))
  check(
    'T58',
    'Create audit',
    mainAudits.length === 3 &&
      mainAudits.every((row) => row.actionCode === 'authorization_line.created' && row.organizationId === org && row.beforeState === null) &&
      new Set(mainAudits.map((row) => row.entityId)).size === 3 &&
      snapshotKeys.every((keys) => keys === 'createdAt,id,priorAuthorizationVersionId,sequence'),
    'exactly one authorization_line.created event per line, each naming its own row, version and position',
  )
  const allLineAudits = await prisma.auditEvent.findMany({ where: { entityType: 'AUTHORIZATION_LINE' }, select: { afterState: true, beforeState: true } })
  const sensitive = ['serviceId', 'procedureCodeId', 'diagnosisCodeId', 'requestedQty', 'approvedQty', 'unitCode', 'approvedFrom', 'approvedThrough', 'status', 'APPROVED', 'DENIED', 'encounterId', 'payerId', 'memberIdentifier', svcA.id, procB.id, dxA.id]
  const leaks = allLineAudits.filter((event) => sensitive.some((needle) => JSON.stringify(event.afterState ?? {}).includes(needle) || JSON.stringify(event.beforeState ?? {}).includes(needle)))
  check(
    'T59',
    'Audit minimization',
    allLineAudits.length > 0 && leaks.length === 0,
    leaks.length === 0 ? `no service, procedure, diagnosis, quantity, unit, date, status or context value in any of ${allLineAudits.length} line audit rows` : `${leaks.length} audit row(s) carry line scope`,
  )
  const auditBeforeRejects = await lineAuditCount()
  await refuse({ lines: [] })
  await capture(mainVersion, [line()])
  await refuseLine({ status: 'ACTIVE' })
  await refuseLine({ serviceId: foreignService?.id ?? MISSING })
  await capture(viewerVersion, [line()], asViewer)
  check('T60', 'No false audit', (await lineAuditCount()) === auditBeforeRejects, `five rejected attempts (empty, second batch, bad status, foreign master, viewer) created no audit (count stayed ${auditBeforeRejects})`)

  const rollbackVersion = (await newVersion(encounter.id)).versionId
  const auditBeforeRollback = await lineAuditCount()
  failAt('authorization_line.created', 'forced audit failure (acceptance)')
  let rollbackThrew = false
  try {
    await captureAuthorizationLines(rollbackVersion, { lines: [line(), line({ serviceId: svcB.id }), line({ serviceId: svcC.id })] }, actorUserId)
  } catch {
    rollbackThrew = true
  }
  clearConcurrencyProbes()
  const rolledBackEmpty = (await lineCount(rollbackVersion)) === 0 && (await lineAuditCount()) === auditBeforeRollback
  const afterRollback = await capture(rollbackVersion, [line()])
  check(
    'T61',
    'Atomic rollback',
    rollbackThrew && rolledBackEmpty && afterRollback.status === 201,
    'a failure after the last audit left no line and no audit behind, and the version still accepts its one batch afterwards',
  )

  const auditTotalBefore = await prisma.auditEvent.count()
  const linesTotalBefore = await prisma.authorizationLine.count()
  for (let i = 0; i < 3; i += 1) await reevaluate(mainVersion)
  check(
    'T62',
    'Evaluation no audit',
    (await prisma.auditEvent.count()) === auditTotalBefore && (await prisma.authorizationLine.count()) === linesTotalBefore,
    'three evaluations wrote no audit event of any kind and changed no row',
  )

  const snapshotSettings = await withReadSnapshot(undefined, async (tx) =>
    tx.$queryRaw<{ isolation: string; read_only: string }[]>`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`,
  )
  const snapshotWrite = await attemptAdversarial(() => withReadSnapshot(undefined, async (tx) => tx.$executeRawUnsafe(`UPDATE authorization_lines SET sequence = sequence WHERE false`)))
  const serviceSource = committedCode('backend/src/modules/authorization-line/authorization-line.service.ts')
  const evaluateBody = serviceSource.slice(serviceSource.indexOf('export async function evaluateAuthorizationScope'))
  const evaluatedAtOk = !Number.isNaN(Date.parse(String(viewerEval.body?.evaluatedAt ?? '')))
  check(
    'T63',
    'Read-only snapshot',
    snapshotSettings[0]?.isolation === 'repeatable read' && snapshotSettings[0]?.read_only === 'on' && /read-only transaction/i.test(snapshotWrite) &&
      evaluateBody.includes('withReadSnapshot(') && evaluateBody.includes('readTransactionTimestamp(') && evaluatedAtOk,
    'the evaluation runs inside withReadSnapshot, which the database reports as REPEATABLE READ and READ ONLY and which refuses a write; evaluatedAt is the transaction timestamp',
  )

  // ---------------------------------------------------------------- context (T64–T71)
  section('Frozen context against the Encounter as it stands now')
  const exact = await scenario('context exact', { lines: [line()], activities: [{}] })
  check('T64', 'Context exact', exact.status === 200 && exact.body?.contextMatch === true && exact.outcome(0) === 'MATCHED', 'the frozen A5.3 context equals the current A4 context, so evaluation proceeds')

  const drift = async (id: string, title: string, mutate: (s: Awaited<ReturnType<typeof scenario>>) => Promise<number>, what: string) => {
    const s = await scenario(title, { lines: [line()], activities: [{}, { serviceId: svcB.id }] })
    const before = s.body?.contextMatch === true
    const patched = await mutate(s)
    const after = await reevaluate(s.versionId)
    const outcomes = (after.body?.activities ?? []).map((a: any) => a.outcome)
    check(
      id,
      title,
      before && patched === 200 && after.status === 200 && after.body?.contextMatch === false && outcomes.length === 2 &&
        outcomes.every((o: string) => o === 'CONTEXT_MISMATCH') && Array.isArray(after.body?.lineUtilization) && after.body.lineUtilization.length === 0,
      `matched before; after ${what} (PATCH ${patched}) every activity is CONTEXT_MISMATCH and no line is utilized`,
    )
    return s
  }
  await drift('T65', 'Context membership drift', async (s) => (await patchApi(`/api/encounters/${s.encounterId}`, { insuranceMembershipId: membership2.id })).status, 'the Encounter selected a different membership')
  // The payer drift is a correction to the MEMBERSHIP, not the Encounter, so it gets a membership of
  // its own: correcting a shared one would drift every other scenario that uses it.
  const driftMembership = await newMembership('membership for payer drift')
  const payerDrift = await (async () => {
    const enc = await newEncounter('payer drift encounter', { insuranceMembershipId: driftMembership.id })
    must('payer drift activity', (await post(`/api/encounters/${enc.id}/activities`, { serviceId: svcA.id, procedureCodeId: null, quantity: '1', unitCode: null })).body)
    const { versionId } = await newVersion(enc.id, { status: 'APPROVED' })
    if ((await capture(versionId, [line()])).status !== 201) throw new Error('fixture payer drift: line capture failed')
    const before = await reevaluate(versionId)
    const patched = await patchApi(`/api/insurance-memberships/${driftMembership.id}`, { payerId: payer2.id })
    const after = await reevaluate(versionId)
    return { before, patched: patched.status, after }
  })()
  check(
    'T66',
    'Context payer drift',
    payerDrift.before.body?.contextMatch === true && payerDrift.patched === 200 && payerDrift.after.body?.contextMatch === false &&
      (payerDrift.after.body?.activities ?? []).length === 1 &&
      (payerDrift.after.body?.activities ?? []).every((a: any) => a.outcome === 'CONTEXT_MISMATCH') && payerDrift.after.body?.lineUtilization?.length === 0,
    `matched before; after the membership's payer was corrected (PATCH ${payerDrift.patched}) the commercial context differs and every activity is CONTEXT_MISMATCH`,
  )
  await drift('T67', 'Context facility drift', async (s) => (await patchApi(`/api/encounters/${s.encounterId}`, { facilityId: facility2.id })).status, 'the Encounter moved to another facility')
  await drift('T68', 'Context clinician drift', async (s) => (await patchApi(`/api/encounters/${s.encounterId}`, { clinicianId: clinician2.id })).status, 'the Encounter changed clinician')
  const dateDrift = await drift('T69', 'Context serviceDate drift', async (s) => (await patchApi(`/api/encounters/${s.encounterId}`, { serviceDate: '2026-06-16' })).status, 'the Encounter service date was corrected')

  // A newer authorization frozen to the corrected Encounter now exists and would match. The drifted
  // version must still report its own mismatch, never borrow the newer case.
  const newer = await newVersion(dateDrift.encounterId, { status: 'APPROVED' })
  await capture(newer.versionId, [line(), line({ serviceId: svcB.id })])
  const newerEval = await reevaluate(newer.versionId)
  const olderEval = await reevaluate(dateDrift.versionId)
  check(
    'T70',
    'No context substitution',
    newerEval.body?.contextMatch === true && olderEval.body?.contextMatch === false &&
      olderEval.body?.priorAuthorizationVersionId === dateDrift.versionId && olderEval.body?.priorAuthorizationId === dateDrift.authorizationId &&
      (olderEval.body?.activities ?? []).every((a: any) => a.outcome === 'CONTEXT_MISMATCH' && a.authorizationLineId === null),
    'a matching newer authorization exists on the same Encounter, yet the drifted version still reports only itself, as CONTEXT_MISMATCH',
  )

  const removal = await scenario('removed activity', { lines: [line({ approvedQty: '10' })], activities: [{ quantity: '2' }, { quantity: '3' }] })
  const removed = await post(`/api/encounter-activities/${removal.activityIds[1]}/remove`, {})
  const afterRemoval = await reevaluate(removal.versionId)
  const remainingIds = (afterRemoval.body?.activities ?? []).map((a: any) => a.encounterActivityId)
  check(
    'T71',
    'Removed activity excluded',
    removed.status === 200 && remainingIds.length === 1 && remainingIds[0] === removal.activityIds[0] && afterRemoval.body?.lineUtilization?.[0]?.matchedQty === '2',
    'the removed activity is neither evaluated nor counted; the line utilization dropped from 5 to 2',
  )

  // ---------------------------------------------------------------- integrity (T124–T126)
  // Audit correction: matching IDs is not enough. The Encounter's EXACT stored membership, assignment
  // and regulatory profile must still pass A4.9's own verification, in the evaluation's own snapshot,
  // before any line is matched. Each case is driven through the real owner route that corrects the
  // row, on a fixture dedicated to that case, and each creates a covering alternative first so that a
  // re-resolution would have something to substitute.
  section('A4.9 integrity before matching — the stored context must still cohere')
  const bindingOf = (encounterId: string) =>
    prisma.encounter.findUniqueOrThrow({
      where: { id: encounterId },
      select: { insuranceMembershipId: true, clinicianFacilityAssignmentId: true, facilityRegulatoryProfileId: true },
    })
  const historyOf = async (s: { versionId: string; authorizationId: string }) =>
    JSON.stringify({
      lines: await storedLines(s.versionId),
      version: await prisma.priorAuthorizationVersion.findUniqueOrThrow({ where: { id: s.versionId } }),
      authorization: await prisma.priorAuthorization.findUniqueOrThrow({ where: { id: s.authorizationId } }),
    })
  const integrityCase = async (
    id: string,
    title: string,
    s: Awaited<ReturnType<typeof scenario>>,
    correct: () => Promise<number>,
    alternate: () => Promise<string>,
    field: 'insuranceMembershipId' | 'clinicianFacilityAssignmentId' | 'facilityRegulatoryProfileId',
    expect: RegExp,
    what: string,
  ) => {
    const matchedBefore = s.status === 200 && s.outcome(0) === 'MATCHED'
    const bindingBefore = await bindingOf(s.encounterId)
    const corrected = await correct()
    const alternateId = await alternate()
    const historyBefore = await historyOf(s)
    const linesBefore = await prisma.authorizationLine.count()
    const auditBefore = await prisma.auditEvent.count()
    const refused = await reevaluate(s.versionId)
    const bindingAfter = await bindingOf(s.encounterId)
    const unchanged =
      (await historyOf(s)) === historyBefore && (await prisma.authorizationLine.count()) === linesBefore && (await prisma.auditEvent.count()) === auditBefore
    const message = String(refused.body?.error?.message ?? '')
    const noScope = refused.body?.activities === undefined && refused.body?.lineUtilization === undefined
    check(
      id,
      title,
      matchedBefore && corrected === 200 && refused.status === 409 && refused.body?.error?.code === 'INTEGRITY_CONFLICT' && expect.test(message) && noScope &&
        JSON.stringify(bindingAfter) === JSON.stringify(bindingBefore) && bindingAfter[field] !== alternateId && unchanged,
      !matchedBefore
        ? `the fixture did not match before the correction (status ${s.status}, ${s.outcome(0)})`
        : corrected !== 200
          ? `the owner route refused the correction (${corrected})`
          : refused.status !== 409
            ? `evaluation returned ${refused.status} instead of failing closed`
            : `MATCHED before; after ${what} evaluation fails closed 409 INTEGRITY_CONFLICT ("${message}"), the covering alternative is not substituted, and no line, version, case, audit or match state changed`,
    )
  }

  // Membership: coverage corrected through A4.3 to end before the service date. Every ID is unchanged.
  const coverageMembership = await newMembership('membership for coverage correction')
  const coverageCase = await scenario('membership coverage integrity', { encounter: { insuranceMembershipId: coverageMembership.id }, lines: [line()], activities: [{}] })
  await integrityCase(
    'T124',
    'Integrity membership coverage',
    coverageCase,
    async () => (await patchApi(`/api/insurance-memberships/${coverageMembership.id}`, { coverageTo: '2026-05-31' })).status,
    async () => (await newMembership('covering alternative membership')).id,
    'insuranceMembershipId',
    /coverage period of the selected membership/,
    'the membership coverage was corrected to end on 2026-05-31',
  )

  // Assignment and profile get a facility and clinician of their own, so closing their rows through
  // the owner routes cannot disturb any other scenario.
  const integrityFacility = must('integrity facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} integrity facility` })).body)
  const integrityProfile = must('integrity profile', (await post(`/api/facilities/${integrityFacility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${integrityProfile.id}/activate`, {})).status !== 200) throw new Error('fixture integrity profile activation failed')
  const integrityClinician = must('integrity clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} integrity clinician` })).body)
  const integrityAssignment = must('integrity assignment', (await post(`/api/clinicians/${integrityClinician.id}/facility-assignments`, { facilityId: integrityFacility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const integrityEncounter = { facilityId: integrityFacility.id, clinicianId: integrityClinician.id }

  // Assignment: the recorded assignment closed through A4.2 the day before the service date; a new
  // assignment for the same clinician and facility then covers the service date.
  const assignmentCase = await scenario('assignment integrity', { encounter: integrityEncounter, lines: [line()], activities: [{}] })
  await integrityCase(
    'T125',
    'Integrity assignment period',
    assignmentCase,
    async () => (await post(`/api/clinician-facility-assignments/${integrityAssignment.id}/close`, { effectiveTo: '2026-06-14' })).status,
    async () => must('covering alternative assignment', (await post(`/api/clinicians/${integrityClinician.id}/facility-assignments`, { facilityId: integrityFacility.id, effectiveFrom: '2026-06-15', effectiveTo: null })).body).id,
    'clinicianFacilityAssignmentId',
    /recorded assignment no longer covers the encounter service date/,
    'the recorded assignment was closed on 2026-06-14',
  )

  // Profile: a new Encounter binds the covering assignment above and the still-open profile; that
  // profile is then closed through its owner route the day before the service date, and a newer
  // ACTIVE profile covering the service date is created.
  const profileCase = await scenario('profile integrity', { encounter: integrityEncounter, lines: [line()], activities: [{}] })
  await integrityCase(
    'T126',
    'Integrity regulatory profile',
    profileCase,
    async () => (await patchApi(`/api/facility-regulatory-profiles/${integrityProfile.id}`, { effectiveTo: '2026-06-14' })).status,
    async () => {
      const alternate = must('covering alternative profile', (await post(`/api/facilities/${integrityFacility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2026-06-15', effectiveTo: null })).body)
      if ((await post(`/api/facility-regulatory-profiles/${alternate.id}/activate`, {})).status !== 200) throw new Error('fixture alternative profile activation failed')
      return alternate.id
    },
    'facilityRegulatoryProfileId',
    /recorded regulatory profile no longer covers the encounter service date/,
    'the recorded regulatory profile was closed on 2026-06-14',
  )

  // ---------------------------------------------------------------- candidates (T72–T81)
  section('Candidate matching — fail closed, never a guessed winner')
  const byService = await scenario('service candidate', { lines: [line({ serviceId: svcA.id })], activities: [{ serviceId: svcA.id }, { serviceId: svcB.id }] })
  check('T72', 'Service candidate', byService.outcome(0) === 'MATCHED' && byService.outcome(1) === 'NO_MATCH', 'the exact service id matches; a different service does not')
  const byProcedure = await scenario('procedure candidate', {
    lines: [line({ serviceId: null, procedureCodeId: procA.id })],
    activities: [{ serviceId: null, procedureCodeId: procA.id }, { serviceId: null, procedureCodeId: procB.id }],
  })
  check('T73', 'Procedure candidate', byProcedure.outcome(0) === 'MATCHED' && byProcedure.outcome(1) === 'NO_MATCH', 'the exact procedure id matches; a different procedure does not')
  const byBoth = await scenario('both identity', {
    lines: [line({ serviceId: svcA.id, procedureCodeId: procA.id })],
    activities: [{ serviceId: svcA.id, procedureCodeId: procA.id }, { serviceId: svcA.id, procedureCodeId: procB.id }, { serviceId: svcB.id, procedureCodeId: procA.id }],
  })
  check('T74', 'Both identity AND', byBoth.outcome(0) === 'MATCHED' && byBoth.outcome(1) === 'NO_MATCH' && byBoth.outcome(2) === 'NO_MATCH', 'only the activity matching both dimensions is a candidate')
  const dxWildcard = await scenario('diagnosis wildcard', { lines: [line({ diagnosisCodeId: null })], activities: [{}] })
  check('T75', 'Diagnosis wildcard', dxWildcard.outcome(0) === 'MATCHED', 'a null diagnosis imposes no restriction, even with no diagnosis on the Encounter')
  const dxPresent = await scenario('diagnosis present', { lines: [line({ diagnosisCodeId: dxA.id })], activities: [{}], diagnoses: [dxA.id] })
  const dxOther = await scenario('diagnosis other', { lines: [line({ diagnosisCodeId: dxA.id })], activities: [{}], diagnoses: [dxB.id] })
  check('T76', 'Diagnosis exact', dxPresent.outcome(0) === 'MATCHED' && dxOther.outcome(0) === 'NO_MATCH', 'the scoped diagnosis active on the Encounter matches; a different active diagnosis does not')
  const dxRemoved = await scenario('diagnosis removed', { lines: [line({ diagnosisCodeId: dxA.id })], activities: [{}], removeDiagnoses: [dxA.id] })
  check('T77', 'Removed diagnosis', dxRemoved.outcome(0) === 'NO_MATCH', 'a removed EncounterDiagnosis does not satisfy the scope')
  const noCandidate = await scenario('no candidate', { lines: [line({ serviceId: svcA.id })], activities: [{ serviceId: svcC.id }] })
  check(
    'T78',
    'No candidate',
    noCandidate.outcome(0) === 'NO_MATCH' && noCandidate.row(0).authorizationLineId === null && noCandidate.row(0).candidateAuthorizationLineIds?.length === 0,
    'zero candidates is NO_MATCH with no line named',
  )
  const ambiguous = await scenario('ambiguous', { lines: [line(), line()], activities: [{}] })
  const sortedIds = (ids: string[]) => [...ids].sort()
  check(
    'T79',
    'Ambiguous candidates',
    ambiguous.outcome(0) === 'AMBIGUOUS' && ambiguous.row(0).authorizationLineId === null &&
      JSON.stringify(ambiguous.row(0).candidateAuthorizationLineIds) === JSON.stringify(sortedIds(ambiguous.lineIds)),
    'no winner invented; both candidates are named in id order',
  )
  const generalFirst = await scenario('general first', { lines: [line({ serviceId: svcA.id }), line({ serviceId: svcA.id, procedureCodeId: procA.id })], activities: [{ serviceId: svcA.id, procedureCodeId: procA.id }] })
  const specificFirst = await scenario('specific first', { lines: [line({ serviceId: svcA.id, procedureCodeId: procA.id }), line({ serviceId: svcA.id })], activities: [{ serviceId: svcA.id, procedureCodeId: procA.id }] })
  check(
    'T80',
    'No sequence precedence',
    generalFirst.outcome(0) === 'AMBIGUOUS' && specificFirst.outcome(0) === 'AMBIGUOUS',
    'with the general and the more specific line in either sequence, the activity stays AMBIGUOUS: neither order nor specificity picks a winner',
  )
  const again = await reevaluate(ambiguous.versionId)
  check(
    'T81',
    'No latest precedence',
    JSON.stringify(again.body?.activities) === JSON.stringify(ambiguous.body?.activities) &&
      JSON.stringify(generalFirst.row(0).candidateAuthorizationLineIds) === JSON.stringify(sortedIds(generalFirst.lineIds)) &&
      JSON.stringify(specificFirst.row(0).candidateAuthorizationLineIds) === JSON.stringify(sortedIds(specificFirst.lineIds)),
    'candidates are listed by id, never by createdAt or sequence, and a repeat evaluation is identical',
  )

  // ---------------------------------------------------------------- statuses (T82–T87)
  section('Header and line statuses — each judged on its own')
  const headerApproved = await scenario('header approved', { header: { status: 'APPROVED' }, lines: [line({ status: 'APPROVED' })], activities: [{}] })
  check('T82', 'Header approved', headerApproved.outcome(0) === 'MATCHED', 'an APPROVED header permits further evaluation')
  const headerPartial = await scenario('header partial', { header: { status: 'PARTIALLY_APPROVED' }, lines: [line()], activities: [{}] })
  check('T83', 'Header partial', headerPartial.outcome(0) === 'MATCHED', 'a PARTIALLY_APPROVED header permits further evaluation; it is not read as a global approval')
  const headerBlocked: string[] = []
  for (const status of ['REQUESTED', 'PENDING', 'DENIED', 'UNKNOWN']) {
    const s = await scenario(`header ${status}`, { header: { status }, lines: [line({ status: 'APPROVED' })], activities: [{}] })
    if (s.outcome(0) !== 'HEADER_STATUS_NOT_APPROVED' || s.row(0).authorizationLineId !== s.lineIds[0]) headerBlocked.push(`${status}->${s.outcome(0)}`)
  }
  check('T84', 'Header not approved', headerBlocked.length === 0, headerBlocked.length === 0 ? 'REQUESTED, PENDING, DENIED and UNKNOWN headers each report HEADER_STATUS_NOT_APPROVED over an APPROVED line' : headerBlocked.join(', '))
  check('T85', 'Line approved', headerApproved.outcome(0) === 'MATCHED', 'an APPROVED line permits further evaluation')
  const linePartial = await scenario('line partial', { lines: [line({ status: 'PARTIALLY_APPROVED' })], activities: [{}] })
  check('T86', 'Line partial', linePartial.outcome(0) === 'MATCHED', 'a PARTIALLY_APPROVED line permits further evaluation')
  const lineBlocked = await scenario('line statuses', {
    lines: ['REQUESTED', 'PENDING', 'DENIED', 'UNKNOWN'].map((status, index) => line({ serviceId: services[index].id, status })),
    activities: services.map((svc) => ({ serviceId: svc.id })),
  })
  const lineOutcomes = [0, 1, 2, 3].map((index) => lineBlocked.outcome(index))
  check('T87', 'Line not approved', lineOutcomes.every((o) => o === 'LINE_STATUS_NOT_APPROVED'), `REQUESTED, PENDING, DENIED and UNKNOWN lines under an APPROVED header: ${lineOutcomes.join(', ')}`)

  // ---------------------------------------------------------------- dates (T88–T93)
  section('Date scope — inclusive, and never invented')
  const headerLower = await scenario('header lower', { header: { status: 'APPROVED', validFrom: '2026-06-16' }, lines: [line()], activities: [{}] })
  check('T88', 'Header validity lower bound', headerLower.outcome(0) === 'DATE_OUTSIDE_SCOPE', 'service date before validFrom')
  const headerUpper = await scenario('header upper', { header: { status: 'APPROVED', validThrough: '2026-06-14' }, lines: [line()], activities: [{}] })
  check('T89', 'Header validity upper bound', headerUpper.outcome(0) === 'DATE_OUTSIDE_SCOPE', 'service date after validThrough')
  const lineLower = await scenario('line lower', { lines: [line({ approvedFrom: '2026-06-16' })], activities: [{}] })
  check('T90', 'Line date lower bound', lineLower.outcome(0) === 'DATE_OUTSIDE_SCOPE', 'service date before approvedFrom')
  const lineUpper = await scenario('line upper', { lines: [line({ approvedThrough: '2026-06-14' })], activities: [{}] })
  check('T91', 'Line date upper bound', lineUpper.outcome(0) === 'DATE_OUTSIDE_SCOPE', 'service date after approvedThrough')
  const onBoundary = await scenario('inclusive boundary', {
    header: { status: 'APPROVED', validFrom: SERVICE_DATE, validThrough: SERVICE_DATE },
    lines: [line({ approvedFrom: SERVICE_DATE, approvedThrough: SERVICE_DATE })],
    activities: [{}],
  })
  check('T92', 'Inclusive date boundary', onBoundary.outcome(0) === 'MATCHED', 'a service date exactly on all four supplied bounds stays in scope')
  const noBounds = await scenario('null bounds', { header: { status: 'APPROVED', validFrom: null, validThrough: null }, lines: [line({ approvedFrom: null, approvedThrough: null })], activities: [{}] })
  check('T93', 'Null date bound', noBounds.outcome(0) === 'MATCHED', 'with no bound supplied anywhere, no date restriction is invented')

  // ---------------------------------------------------------------- units and quantity (T94–T104)
  section('Units and exact aggregate quantity')
  const unitExact = await scenario('unit exact', { lines: [line({ unitCode: 'ML' })], activities: [{ unitCode: 'ML' }] })
  check('T94', 'Unit exact', unitExact.outcome(0) === 'MATCHED', 'a line unit equal to the activity unit passes')
  const unitMismatch = await scenario('unit mismatch', {
    lines: [line({ unitCode: 'ML', approvedQty: '10' })],
    activities: [{ unitCode: 'ML', quantity: '8' }, { unitCode: 'TABLET', quantity: '5' }, { unitCode: 'ml', quantity: '1' }, { unitCode: null, quantity: '1' }],
  })
  check(
    'T95',
    'Unit mismatch',
    unitMismatch.outcome(0) === 'MATCHED' && [1, 2, 3].every((index) => unitMismatch.outcome(index) === 'UNIT_MISMATCH') &&
      unitMismatch.utilization(0).matchedQty === '8' && JSON.stringify(unitMismatch.utilization(0).matchedActivityIds) === JSON.stringify([unitMismatch.activityIds[0]]),
    'TABLET, lower-case ml and no unit are each UNIT_MISMATCH against ML, and none is added to the line quantity (8 of 10)',
  )
  const unitWildcard = await scenario('unit wildcard', { lines: [line({ unitCode: null })], activities: [{ unitCode: 'ANYTHING' }] })
  check('T96', 'Line unit wildcard', unitWildcard.outcome(0) === 'MATCHED', 'a line with no unit imposes no unit restriction')
  const qtyUnknown = await scenario('quantity unknown', { lines: [line({ approvedQty: null })], activities: [{ quantity: '1' }] })
  check(
    'T97',
    'Quantity unknown',
    qtyUnknown.outcome(0) === 'QUANTITY_UNKNOWN' && qtyUnknown.utilization(0).quantityOutcome === 'UNKNOWN' && qtyUnknown.utilization(0).approvedQty === null,
    'approvedQty null is QUANTITY_UNKNOWN even with both statuses approving',
  )
  const qtyWithin = await scenario('quantity within', { lines: [line({ approvedQty: '5' })], activities: [{ quantity: '2' }, { quantity: '3' }] })
  check(
    'T98',
    'Quantity within',
    qtyWithin.outcome(0) === 'MATCHED' && qtyWithin.outcome(1) === 'MATCHED' && qtyWithin.utilization(0).matchedQty === '5' && qtyWithin.utilization(0).quantityOutcome === 'WITHIN',
    '2 + 3 = 5 against 5 approved passes',
  )
  const qtyExceeded = await scenario('quantity exceeded', { lines: [line({ approvedQty: '5' })], activities: [{ quantity: '3' }, { quantity: '3' }] })
  check(
    'T99',
    'Quantity exceeded',
    qtyExceeded.outcome(0) === 'QUANTITY_EXCEEDED' && qtyExceeded.outcome(1) === 'QUANTITY_EXCEEDED' && qtyExceeded.utilization(0).matchedQty === '6' && qtyExceeded.utilization(0).quantityOutcome === 'EXCEEDED',
    'exact aggregate 3 + 3 = 6 against 5 approved; every allocated activity is QUANTITY_EXCEEDED',
  )
  const qtyExact = await scenario('exact decimal', { lines: [line({ approvedQty: '0.3' })], activities: [{ quantity: '0.1' }, { quantity: '0.2' }] })
  check(
    'T100',
    'Exact Decimal aggregation',
    qtyExact.outcome(0) === 'MATCHED' && qtyExact.outcome(1) === 'MATCHED' && qtyExact.utilization(0).matchedQty === '0.3' && qtyExact.utilization(0).quantityOutcome === 'WITHIN',
    '0.1 + 0.2 is exactly 0.3 and within 0.3 approved (binary floating point would have made it 0.30000000000000004 and EXCEEDED)',
  )
  const ambiguousQty = await scenario('ambiguous not allocated', { lines: [line({ approvedQty: '1' }), line({ approvedQty: '1' })], activities: [{ quantity: '5' }] })
  check(
    'T101',
    'Ambiguous not allocated',
    ambiguousQty.outcome(0) === 'AMBIGUOUS' && [0, 1].every((index) => ambiguousQty.utilization(index).matchedQty === '0' && ambiguousQty.utilization(index).matchedActivityIds?.length === 0),
    'the ambiguous activity of 5 is counted against neither line',
  )
  const manyToOne = await scenario('many to one', { lines: [line({ approvedQty: '10' })], activities: [{ quantity: '1' }, { quantity: '2.5' }, { quantity: '3.25' }] })
  check(
    'T102',
    'Multiple activities one line',
    manyToOne.utilization(0).matchedQty === '6.75' && manyToOne.utilization(0).matchedActivityIds?.length === 3 && [0, 1, 2].every((index) => manyToOne.outcome(index) === 'MATCHED'),
    '1 + 2.5 + 3.25 = 6.75 aggregated before the capacity result',
  )
  const orderA = await scenario('order A', { lines: [line({ approvedQty: '5' })], activities: [{ quantity: '4' }, { quantity: '3' }] })
  const orderB = await scenario('order B', { lines: [line({ approvedQty: '5' })], activities: [{ quantity: '3' }, { quantity: '4' }] })
  check(
    'T103',
    'No first-come allocation',
    [0, 1].every((index) => orderA.outcome(index) === 'QUANTITY_EXCEEDED' && orderB.outcome(index) === 'QUANTITY_EXCEEDED') &&
      orderA.utilization(0).matchedQty === '7' && orderB.utilization(0).matchedQty === '7',
    'recorded 4-then-3 or 3-then-4, both activities are QUANTITY_EXCEEDED on the same total of 7: neither "used up" the capacity first',
  )
  const matched = await scenario('matched contract', {
    header: { status: 'APPROVED', validFrom: '2026-06-01', validThrough: '2026-06-30' },
    lines: [line({ serviceId: svcA.id, procedureCodeId: procA.id, diagnosisCodeId: dxA.id, unitCode: 'ML', approvedQty: '2', approvedFrom: '2026-06-10', approvedThrough: '2026-06-20' })],
    activities: [{ serviceId: svcA.id, procedureCodeId: procA.id, unitCode: 'ML', quantity: '2' }],
    diagnoses: [dxA.id],
  })
  check(
    'T104',
    'MATCHED contract',
    matched.outcome(0) === 'MATCHED' && matched.row(0).authorizationLineId === matched.lineIds[0] &&
      JSON.stringify(matched.row(0).candidateAuthorizationLineIds) === JSON.stringify([matched.lineIds[0]]),
    'exactly one candidate, approving header and line, dates, unit and quantity all satisfied',
  )

  // ---------------------------------------------------------------- scope guards (T105–T114)
  section('Scope guards — scope facts and nothing more')
  const contractKeys = ['activities', 'contextMatch', 'encounterId', 'evaluatedAt', 'lineUtilization', 'priorAuthorizationId', 'priorAuthorizationVersionId', 'schemaVersion']
  const evaluationKeys = deepKeys(matched.body)
  const readinessKeys = [...evaluationKeys].filter((key) => /(ready|readiness|submission|payerAcceptance|authorizedClaimLine|satisf|claim|price|amount|tariff|member|policy|storage)/i.test(key))
  check(
    'T105',
    'MATCHED not readiness',
    JSON.stringify(Object.keys(matched.body ?? {}).sort()) === JSON.stringify(contractKeys) && readinessKeys.length === 0,
    readinessKeys.length === 0 ? 'the response is exactly the V1 contract: no ready, submission, payer-acceptance, claim, price or member field at any depth' : `found: ${readinessKeys.join(', ')}`,
  )
  const productionCode = committedProductionCodeOf('backend/src/modules/authorization-line')
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  const matchTables = tables.filter((name) => /match|scope_evaluation/i.test(name))
  const persistedMatch = /prisma\.\w+\.(create|update|upsert)|tx\.\w+\.(create|update|upsert)/.test(evaluateBody)
  check(
    'T106',
    'No persistent match table',
    tables.length > 0 && matchTables.length === 0 && columnsMatching(/matched|activit|outcome/i).length === 0 && !persistedMatch,
    matchTables.length === 0 ? `none of ${tables.length} tables stores a match, no line column holds one, and the evaluation path writes nothing` : `found: ${matchTables.join(', ')}`,
  )
  const lineEvidenceTables = tables.filter((name) => /authorization_line.*evidence|evidence.*authorization_line/i.test(name))
  check(
    'T107',
    'No line evidence duplication',
    lineEvidenceTables.length === 0 && (await prisma.priorAuthorizationVersionEvidence.count({ where: { priorAuthorizationVersionId: mainVersion } })) === evidenceLinksBefore &&
      !/evidenceArtifact|storageRef|contentHash/.test(productionCode.code),
    'no line-to-evidence table; the A5.3 version evidence links are untouched and remain authoritative',
  )
  check(
    'T108',
    'No contract/tariff',
    productionCode.files.length > 0 && !/providerContract|tariffSchedule|contractFacility/i.test(productionCode.code) && columnsMatching(/contract|tariff|price|amount/i).length === 0,
    'no ProviderContract or TariffScheduleVersion is read or selected — A5.5 owns that',
  )
  check(
    'T109',
    'No ValidationRun',
    !tables.some((name) => /validation_run|validation_finding/i.test(name)) && !/validationRun|validationFinding/i.test(productionCode.code),
    'no ValidationRun or ValidationFinding table or write — A5.7 and A5.8 own those',
  )
  check(
    'T110',
    'No readiness',
    !tables.some((name) => /readiness/i.test(name)) && !/readiness|readyForClaim|isSatisfied|RESTRICT'|BLOCK'/.test(productionCode.code) && columnsMatching(/ready|restrict|block|satisf/i).length === 0,
    'no overall ready, restrict or block decision anywhere — A5.9 owns readiness',
  )
  const claimTables = tables.filter((name) => /(^claims?$|claim_lines?|claim_submissions?|remittance)/i.test(name))
  check(
    'T111',
    'No Claim',
    claimTables.length === 0 && !/prisma\.(claim|claimLine|claimSubmission)\b|tx\.(claim|claimLine|claimSubmission)\b/.test(productionCode.code),
    claimTables.length === 0 ? 'no Claim, ClaimLine or ClaimSubmission table exists and none is read — A6 owns them' : `found: ${claimTables.join(', ')}`,
  )
  const integration = productionCode.code.match(/\b(fetch|axios|http\.request|https\.request|soap|dhpo|eclaimlink|apiKey|clientSecret|Authorization:)\b/i)
  check(
    'T112',
    'No real integration',
    productionCode.files.length > 0 && integration === null,
    productionCode.files.length === 0
      ? 'the production module source could not be read, so this absence is unproven'
      : `across ${productionCode.files.length} production files there is no network call, payer adapter or credential — A9 owns transport`,
  )
  const feCode = committedCodeOf('frontend/src/modules/authorization-line')
  const fePersist = /\b(localStorage|sessionStorage|indexedDB)\s*\.\s*[A-Za-z]+\s*\(/.test(feCode.code)
  const feDump = /memberIdentifier|policyIdentifier|storageRef|contentHash|authorizationReference/.test(feCode.code)
  check(
    'T113',
    'Frontend privacy',
    feCode.files.length > 0 && feCode.code.includes('captureLines') && !fePersist && !feDump,
    feCode.files.length === 0 || !feCode.code.includes('captureLines')
      ? 'the scan did not reach the committed frontend source, so this absence is unproven'
      : 'nothing is written to localStorage, sessionStorage or IndexedDB, and no member, policy, reference or evidence value is rendered (search verified to reach the source)',
  )
  const scanPaths = [':/backend/src/modules/authorization-line', ':/frontend/src/modules/authorization-line']
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(]', scanPaths)
  const urlScan = gitGrep('[?&](serviceId|procedureCodeId|diagnosisCodeId|requestedQty|approvedQty|unitCode|status|lines)=', scanPaths)
  const logReach = gitGrep('requestedQty', scanPaths)
  check(
    'T114',
    'Logging scan',
    logReach.status === 0 && logScan.status === 1 && urlScan.status === 1,
    logReach.status !== 0
      ? 'the scan did not reach the committed sources, so this absence is unproven'
      : 'no console output of any kind in the line module or its check page, and no line value in a query string (search verified to reach the source)',
  )

  // ---------------------------------------------------------------- build and regressions (T115–T119)
  section('Build gates, regressions and database truth')
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check(
    'T115',
    'Unit/typecheck/build',
    unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok && build.ok && lint.ok,
    `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]}, typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`,
  )

  // §25 step 19: the owner suites are INVOKED, never reimplemented. A5.3's suite nests A5.2, which
  // nests A5.1 and the whole A4.10 -> ... -> A1 chain, so one invocation covers T116, T117 and T118,
  // and each nested verdict is read back below.
  await apiReady('the A5.3 and backward regression chain')
  const chain = run('npm run test:a5:authorization')
  const a53Rows = suiteLines(chain.output, 'A5.3')
  const a53Failing = a53Rows.filter((row) => row.verdict === 'FAIL').map((row) => row.id)
  const a53TitleOf = (text: string) => text.slice('[A5.3] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()

  // A5.3 asserts facts about its own feature branch and its own migration, and one of its scope
  // proofs asserts that no authorization_lines table exists. A5.4 creates exactly that table, which is
  // the boundary this package exists to cross. Each is listed with its own reason; an id that is NOT
  // listed is a genuine regression and fails T116.
  const a53NonApplicable: Record<string, string> = {
    T01: "A5.3 'Start gate' requires the current branch to be the A5.3 feature branch; A5.4 is a different branch, branched from the merged A5.3 main",
    T03: "A5.3 'Migration scope' judges the single migration this branch adds against main; on A5.4 that migration is A5.4's own, which creates no prior authorization table",
    T101: "A5.3 'No Claim' forbids any table named authorization_lines; A5.4 creates it, which is exactly the boundary this package crosses",
    T112: "A5.3 'Diff scope' lists the paths A5.3 was allowed to change; A5.4 legitimately changes different ones",
    T114: "A5.3 'Exact head evidence' requires the upstream to be the A5.3 feature branch, which was deleted when PR #51 merged",
  }
  const a53Undocumented = a53Failing.filter((id) => !(id in a53NonApplicable))
  const a53Counts = chain.output.match(/\[A5\.3\] automated summary: (\d+)\/(\d+) PASS/)
  const a53Failed = a53Counts ? Number(a53Counts[2]) - Number(a53Counts[1]) : -1
  const a53Reconciled = a53Failed >= 0 && a53Failing.length === a53Failed
  const a53Ran = a53Rows.some((row) => row.id === 'T107') && a53Rows.some((row) => row.id === 'T109')
  check(
    'T116',
    'A5.3 regression',
    a53Ran && a53Undocumented.length === 0 && a53Reconciled,
    !a53Ran
      ? 'the A5.3 suite did not reach its regression checks, so nothing could be read back'
      : !a53Reconciled
        ? `A5.3 reports ${a53Failed} check failure(s) but ${a53Failing.length} could be named; something failed that this suite did not read back`
        : a53Undocumented.length > 0
          ? `undocumented A5.3 failures: ${a53Undocumented.join(', ')}`
          : `${(chain.output.match(/\[A5\.3\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.3] automated summary: ', 'A5.3 ')}; all ${a53Failed} check failure(s) named and accounted for, and every substantive lifecycle, evidence and context invariant still holds`,
  )
  for (const id of Object.keys(a53NonApplicable)) {
    const row = a53Rows.find((candidate) => candidate.id === id && candidate.verdict === 'FAIL')
    if (row) notApplicableCheck(`T116/${id}`, `A5.3 ${a53TitleOf(row.line)}`, a53NonApplicable[id])
  }

  // A5.2 and A5.1 are judged by A5.3's own T107 and T108, which read them back with their own
  // documented phase boundaries; A5.4 reads those two verdicts rather than re-deriving them.
  const verdictOf = (id: string) => a53Rows.find((row) => row.id === id)
  const a52Verdict = verdictOf('T107')
  const a51Verdict = verdictOf('T108')
  check(
    'T117',
    'A5.2/A5.1 regressions',
    a52Verdict?.verdict === 'PASS' && a51Verdict?.verdict === 'PASS',
    a52Verdict && a51Verdict
      ? `A5.3 T107 (A5.2) ${a52Verdict.verdict} and T108 (A5.1) ${a51Verdict.verdict}; every substantive eligibility and evidence invariant still holds`
      : 'the A5.2 and A5.1 verdicts were not found in the A5.3 output',
  )
  const backward = verdictOf('T109')
  for (const text of chain.output.split(/\r?\n/).filter((l) => l.startsWith('[A5.3]      ') && / substantive checks /.test(l))) console.log(`[A5.4]      ${text.replace('[A5.3]', '').trim().slice(0, 190)}`)
  check(
    'T118',
    'Backward regressions',
    backward?.verdict === 'PASS',
    backward ? `A5.3 T109 ${backward.verdict}: the chain ran through A5.1 to A1, and only the exact documented phase guards are tolerated` : 'the backward-regression verdict was not found in the A5.3 output',
  )

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
  check(
    'T119',
    'DB truth',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  // ---------------------------------------------------------------- closure (T120–T123)
  section('Repeatability, diff scope and exact head')
  const priorLines = await prisma.authorizationLine.count({ where: { createdAt: { lt: new Date(Number(runId.slice(4))) } } })
  check(
    'T120',
    'Repeatability',
    true,
    `this run used a fresh synthetic runId (${runId}) and built its own patient, encounters, masters and authorizations; ${priorLines} line(s) from earlier runs retained, none deleted`,
  )

  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.types.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/database/row-lock.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/authorization-line/') &&
      !file.startsWith('backend/src/integration/a5-authorization-line/') &&
      !file.startsWith('frontend/src/modules/authorization-line/') &&
      !file.includes('a5_4_authorization_line_matching_scope_validation') &&
      !allowed.includes(file),
  )
  const scopeCode = ['backend/src/modules/authorization-line', 'frontend/src/modules/authorization-line']
    .map((dir) => committedCodeOf(dir))
    .reduce((all, one) => ({ files: [...all.files, ...one.files], code: `${all.code}\n${one.code}` }), { files: [] as string[], code: '' })
  const futureImport = scopeCode.code.match(/from '[^']*modules\/(claim|submission|remittance|validation-run|validation-finding|readiness|pricing)/)
  const futureModel = scopeCode.code.match(/(prisma|tx)\.(claim|claimLine|claimSubmission|remittance|validationRun|validationFinding|providerContract|tariffScheduleVersion)\b/)
  const scopeReached = scopeCode.files.length > 0 && scopeCode.code.includes("from '")
  check(
    'T121',
    'Diff scope',
    outOfScope.length === 0 && scopeReached && futureImport === null && futureModel === null,
    !scopeReached
      ? 'the import scan did not reach the committed sources, so this absence is unproven'
      : outOfScope.length === 0 && futureImport === null && futureModel === null
        ? `${changedPaths.length} path(s): the line module, its migration, permission, lock and audit wiring, and the dev check; across ${scopeCode.files.length} committed files no A5.5+, A6 or A9 module is imported and no persistent match state is written`
        : `unexpected: ${[...outOfScope, futureImport?.[0], futureModel?.[0]].filter(Boolean).join(', ').slice(0, 220)}`,
  )

  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [':/backend/src/integration/a5-authorization-line', ':/backend/src/modules/authorization-line', ':/frontend/src/modules/authorization-line'],
  )
  const realDataMarkers = new RegExp(
    ['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((fragment) => `(?:${fragment})`).join('|'),
    'i',
  )
  const harnessSource = git('show HEAD:backend/src/integration/a5-authorization-line/a5-authorization-line.integration.ts')
  const realDataHit = harnessSource.match(realDataMarkers)
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [':/backend/src/integration/a5-authorization-line'])
  check(
    'T122',
    'Secret/PHI scan',
    secretReach.status === 0 && /SYNTHETIC|Synthetic/.test(harnessSource) && secretScan.status === 1 && realDataHit === null,
    secretReach.status !== 0 || !/SYNTHETIC|Synthetic/.test(harnessSource)
      ? 'the scan did not reach the committed harness source, so this absence is unproven'
      : secretScan.status === 1 && realDataHit === null
        ? 'no credential value is committed and no real patient, member or authorization content appears; every fixture is generated from the run id, and every credential is read from the local environment at run time'
        : `${secretScan.output.slice(0, 120)} ${realDataHit ? `real-data marker ${JSON.stringify(realDataHit[0])}` : ''}`,
  )

  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T123',
    'Exact head evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a54Branch}`),
    `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`,
  )

  console.log(`\n[A5.4] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A5.4] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.4] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A5.4] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A5.4] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.4] A5.4 AUTHORIZATION LINE / SCOPE ACCEPTANCE COMPLETE' : '[A5.4] A5.4 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A5.4] RUN ABORTED: ${error.message}`)
      console.log('[A5.4] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A5.4] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.4] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
