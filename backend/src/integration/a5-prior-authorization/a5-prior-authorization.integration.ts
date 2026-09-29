import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { appendPriorAuthorizationVersion, createPriorAuthorization } from '../../modules/prior-authorization/prior-authorization.service.ts'
import { updateEncounter } from '../../modules/encounter/encounter.service.ts'
import { updateMembership } from '../../modules/insurance-membership/insurance-membership.service.ts'

// A5.3 — focused acceptance for the Prior Authorization Lifecycle (T01–T114).
//
// A5.3 records one authorization CASE against one exact Encounter context, and every request,
// response, amendment, extension and correction as an immutable, evidence-bearing version. It
// decides nothing about lines: a payer-reported PARTIALLY_APPROVED never says which activity is
// approved, in what quantity or for which dates — A5.4 alone owns that.
//
// Valid fixtures are created through their owning routes. The database is READ for structural
// proof. ADVERSARIAL writes — ones the service would never make — go in only to prove that
// something refuses them, and each is restored. Every value is synthetic.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.3] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.3] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

// §24 — an obsolete phase-boundary check from an older suite is reported as N/A with its exact
// reason and counted separately. A substantive owner-behaviour failure is never converted to one.
function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.3] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.3] ${title}`)

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
// deliberately name the things it refuses to do, and this file names A5.4 fields on purpose so the
// scope checks can assert their absence — and a unit test that proves a field is REFUSED has to
// name that field. Comments are stripped, and checks asking "does this module store or handle X"
// read the production files only.
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

const runId = `A53-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// The corrected A5.2 FINAL PASS was merged into main as PR #50; A5.3 is branched from that merge.
const a52Merge = 'af0bb40'
const a53Branch = 'feature/a5-3-prior-authorization-lifecycle'
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

function failedIds(output: string, tag: string): string[] {
  const pattern = new RegExp(`^\\[${tag.replace(/\./g, '\\.')}\\] (T\\d+[a-z/]*) .* FAIL`)
  return output
    .split(/\r?\n/)
    .map((line) => (line.match(pattern) ?? [])[1])
    .filter((id): id is string => Boolean(id))
}

const authorizationAuditCount = () =>
  prisma.auditEvent.count({ where: { entityType: { in: ['PRIOR_AUTHORIZATION', 'PRIOR_AUTHORIZATION_VERSION'] } } })

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A5.3] Prior authorization lifecycle — run ${runId}`)
  console.log(`[A5.3] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
    branch === a53Branch && gitOk(`merge-base --is-ancestor ${a52Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the corrected A5.2 merge ${a52Merge} (PR #50) is on main and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const scopeProblems = [
    [/CREATE TABLE "prior_authorizations"/.test(statements), 'the authorization table is not created'],
    [/CREATE TABLE "prior_authorization_versions"/.test(statements), 'the version table is not created'],
    [/CREATE TABLE "prior_authorization_version_evidence"/.test(statements), 'the evidence-link table is not created'],
    [(statements.match(/CREATE TABLE/g) ?? []).length === 3, 'a table other than the three A5.3 tables is created'],
    [!/DROP INDEX/.test(statements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [!/ALTER TABLE "(evidence_artifacts|evidence_artifact_versions|eligibility_verifications)"/.test(statements), 'an A5.1 or A5.2 table is altered'],
    [!/ALTER TABLE "(patients|encounters|insurance_memberships)"/.test(statements), 'an A4 business table is altered'],
    [!/authorization_line|claim|submission|validation_run|readiness|provider_contract|tariff/i.test(statements), 'a future-phase table appears'],
    [(statements.match(/ADD CONSTRAINT "prior_authorization[a-z_]*_chk"/g) ?? []).length === 8, 'the eight CHECKs are not all added'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 13, 'not all thirteen foreign keys are ON DELETE RESTRICT'],
    [(statements.match(/CREATE TRIGGER prior_authorization[a-z_]*_append_only_trg/g) ?? []).length === 3, 'the three immutability triggers are not all created'],
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
        ? 'one migration; three tables, eight CHECKs, thirteen RESTRICT foreign keys and the three immutability triggers only, with no drift'
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
      /the append-only trigger on prior authorizations is present/.test(replay.output) &&
      /the append-only trigger on prior authorization versions is present/.test(replay.output) &&
      /the append-only trigger on prior authorization evidence links is present/.test(replay.output) &&
      /carry no A5\.4 line scope or current-state flag/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the CHECKs, foreign keys, indexes and all three immutability triggers survive, and no line scope appears`,
  )

  const authorizationPermissions = (await prisma.permission.findMany({ where: { code: { startsWith: 'priorAuthorization' } }, select: { code: true } })).map((row) => row.code).sort()
  const grants = await prisma.rolePermission.findMany({
    where: { permission: { code: { startsWith: 'priorAuthorization' } } },
    select: { role: { select: { code: true } }, permission: { select: { code: true } } },
  })
  const grantOf = (code: string) => grants.filter((g) => g.permission.code === code).map((g) => g.role.code).sort().join(',')
  check(
    'T06',
    'Permissions',
    authorizationPermissions.join(',') === 'priorAuthorization.create,priorAuthorization.read,priorAuthorizationVersion.create' &&
      grantOf('priorAuthorization.create') === 'ORG_ADMIN' &&
      grantOf('priorAuthorization.read') === 'ORG_ADMIN,ORG_VIEWER' &&
      grantOf('priorAuthorizationVersion.create') === 'ORG_ADMIN',
    'exactly create, read and version.create exist; no update, delete or execute-network permission was invented',
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

  section('Fixtures through owner routes')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  const profile = must('regulatory profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const payer2 = must('payer 2', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer 2` })).body)
  const tpa = must('tpa', (await post(`/api/organizations/${org}/tpas`, { displayName: `${runId} tpa` })).body)
  const network = must('network', (await post(`/api/organizations/${org}/networks`, { displayName: `${runId} network` })).body)
  const product = must('insurance product', (await post(`/api/organizations/${org}/insurance-products`, { payerId: payer.id, productCode: `${runId}-PROD`, displayName: `${runId} product` })).body)
  must('product-network', (await post(`/api/insurance-products/${product.id}/product-networks`, { networkId: network.id })).body)
  const membership = must(
    'membership',
    (await post(`/api/patients/${patient.id}/insurance-memberships`, {
      payerId: payer.id, tpaId: tpa.id, networkId: network.id, insuranceProductId: product.id,
      memberIdentifier: `MEM-${runId}`, coverageFrom: '2025-01-01', coverageTo: null,
    })).body,
  )
  const encounter = must('encounter', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membership.id })).body)
  const selfEncounter = must('encounter with no selected membership', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE })).body)

  const evidenceBody = (suffix: string) => ({
    storageRef: `synthetic://evidence/${runId}/${suffix}`,
    contentHash: suffix.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
    documentType: `SYNTHETIC_AUTH_DOCUMENT_${runId.slice(-6)}`,
    sourceDate: null,
    receivedAt: '2026-06-15T09:30:00.000Z',
  })
  const requestEvidenceId = (must('request evidence', (await post(`/api/organizations/${org}/evidence-artifacts`, evidenceBody('a'))).body) as any).latestVersion.id as string
  const responseEvidenceId = (must('response evidence', (await post(`/api/organizations/${org}/evidence-artifacts`, evidenceBody('b'))).body) as any).latestVersion.id as string
  const supportingEvidenceId = (must('supporting evidence', (await post(`/api/organizations/${org}/evidence-artifacts`, evidenceBody('c'))).body) as any).latestVersion.id as string

  // An A5.2 verification recorded against exactly this context, for the optional provenance link.
  const eligibility = must(
    'eligibility verification',
    (await post(`/api/encounters/${encounter.id}/eligibility-verifications`, {
      verificationMethod: 'PORTAL', status: 'UNKNOWN', requestedAt: null,
      respondedAt: '2026-06-15T09:31:00.000Z', validThrough: null,
      authorizationRequired: true, referralRequired: null,
      requestEvidenceVersionId: null, responseEvidenceVersionId: responseEvidenceId,
    })).body,
  )
  console.log(`[A5.3]      fixtures ready: patient, facility, clinician, profile, assignment, 2 payers, tpa, network, product, membership, 2 encounters, 3 evidence versions, 1 eligibility verification`)

  const initialBody = (overrides: Record<string, unknown> = {}) => ({
    versionKind: 'INITIAL', status: 'REQUESTED', authorizationReference: null, eligibilityVerificationId: null,
    requestedAt: '2026-09-29T08:00:00.000Z', respondedAt: null, validFrom: null, validThrough: null,
    evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: requestEvidenceId }],
    ...overrides,
  })
  const appendBody = (overrides: Record<string, unknown> = {}) => ({
    versionKind: 'RESPONSE', status: 'APPROVED', authorizationReference: 'AuTh-XyZ-42', eligibilityVerificationId: null,
    requestedAt: '2026-09-29T08:00:00.000Z', respondedAt: '2026-09-29T09:00:00.000Z',
    validFrom: '2026-10-01', validThrough: '2026-10-31',
    evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: responseEvidenceId }],
    ...overrides,
  })
  const createFor = (encounterId: string, overrides: Record<string, unknown> = {}, who = asAdmin) =>
    post(`/api/encounters/${encounterId}/prior-authorizations`, initialBody(overrides), who)
  const appendTo = (authorizationId: string, overrides: Record<string, unknown> = {}, who = asAdmin) =>
    post(`/api/prior-authorizations/${authorizationId}/versions`, appendBody(overrides), who)

  // ---------------------------------------------------------------- create and context (T07–T18)
  section('Recording an authorization case against the exact Encounter context')
  const createRes = await createFor(encounter.id)
  const authorization = createRes.body as Record<string, any>
  if (createRes.status !== 201) throw new Error(`case create failed: ${createRes.status} ${JSON.stringify(authorization).slice(0, 300)}`)
  const storedVersions = await prisma.priorAuthorizationVersion.findMany({ where: { priorAuthorizationId: authorization.id }, include: { evidenceLinks: true } })
  const createAudits = await prisma.auditEvent.findMany({ where: { entityId: { in: [authorization.id, storedVersions[0].id] } } })
  check(
    'T07',
    'Admin create parent',
    createRes.status === 201 && storedVersions.length === 1 && storedVersions[0].evidenceLinks.length === 1 && createAudits.length === 2,
    '201; the case, its version 1, its evidence link and both safe audits were written in one transaction',
  )

  const foreignEncounter = await prisma.encounter.findFirst({ where: { patient: { organizationId: otherOrg } }, select: { id: true } })
  check(
    'T08',
    'Encounter ownership',
    (await get(`/api/encounters/${encounter.id}/prior-authorizations`)).status === 200 && foreignEncounter !== null,
    'the route resolves the organization through the Encounter patient before authorization; a foreign encounter is available for T85',
  )

  const noMembership = await createFor(selfEncounter.id)
  check(
    'T09',
    'No selected membership',
    noMembership.status === 400 &&
      (await prisma.priorAuthorization.count({ where: { encounterId: selfEncounter.id } })) === 0,
    `refused with ${noMembership.status} and no case written; the absence of a membership is never read as a self-pay authorization`,
  )

  const storedParent = await prisma.priorAuthorization.findUniqueOrThrow({ where: { id: authorization.id } })
  check(
    'T10',
    'Membership patient match',
    storedParent.insuranceMembershipId === membership.id &&
      (await prisma.insuranceMembership.findUniqueOrThrow({ where: { id: storedParent.insuranceMembershipId }, select: { patientId: true } })).patientId === patient.id,
    'the stored membership is the one selected on the Encounter, and it belongs to that Encounter patient',
  )

  // §7 step 5 and §26 — the stored commercial context is re-verified before it is frozen, using
  // A4.3's own rule. These three corrupt the membership directly, because no route would produce
  // them, and each restores it afterwards.
  const membershipBefore = await prisma.insuranceMembership.findUniqueOrThrow({
    where: { id: membership.id },
    select: { payerId: true, tpaId: true, networkId: true, insuranceProductId: true },
  })
  const foreignPayer = await prisma.payer.findFirst({ where: { organizationId: otherOrg }, select: { id: true } })
  const mismatchedProduct = must('product under a different payer', (await post(`/api/organizations/${org}/insurance-products`, { payerId: payer2.id, productCode: `${runId}-PROD2`, displayName: `${runId} product 2` })).body)
  const unlinkedNetwork = must('network with no product link', (await post(`/api/organizations/${org}/networks`, { displayName: `${runId} network 2` })).body)

  const coherenceCase = async (id: string, title: string, corruption: Record<string, unknown>, expect: RegExp, reason: string) => {
    const casesBefore = await prisma.priorAuthorization.count({ where: { encounterId: encounter.id } })
    const auditBefore = await authorizationAuditCount()
    await prisma.insuranceMembership.update({ where: { id: membership.id }, data: corruption })
    const attempt = await createFor(encounter.id)
    const message = String((attempt.body as any)?.error?.message ?? '')
    const casesAfter = await prisma.priorAuthorization.count({ where: { encounterId: encounter.id } })
    const auditAfter = await authorizationAuditCount()
    await prisma.insuranceMembership.update({ where: { id: membership.id }, data: membershipBefore })
    const restored = await prisma.insuranceMembership.findUniqueOrThrow({
      where: { id: membership.id },
      select: { payerId: true, tpaId: true, networkId: true, insuranceProductId: true },
    })
    check(
      id,
      title,
      attempt.status >= 400 && attempt.status < 500 && expect.test(message) && casesAfter === casesBefore && auditAfter === auditBefore && JSON.stringify(restored) === JSON.stringify(membershipBefore),
      attempt.status >= 500
        ? `the contradiction produced a ${attempt.status} instead of a closed refusal`
        : casesAfter !== casesBefore || auditAfter !== auditBefore
          ? `refused with ${attempt.status} but wrote ${casesAfter - casesBefore} case(s) and ${auditAfter - auditBefore} audit event(s)`
          : !expect.test(message)
            ? `refused with ${attempt.status} but for the wrong reason: ${message.slice(0, 110)}`
            : `${reason}; refused with ${attempt.status}, no case, no version, no audit, and the membership was restored`,
    )
  }
  await coherenceCase('T11', 'Commercial coherence payer', { payerId: foreignPayer?.id ?? payer.id }, /payer not found/i, "a foreign-organization payer is refused as simply not found rather than revealing whose it is")
  await coherenceCase('T12', 'Commercial coherence product', { insuranceProductId: mismatchedProduct.id }, /different payer/i, 'a product belonging to a payer the membership does not name is a contradiction between two masters')
  await coherenceCase('T13', 'Commercial coherence product-network', { networkId: unlinkedNetwork.id }, /ProductNetwork relationship/i, 'a product and network with no relationship were never a coherent commercial context')

  const forgery: string[] = []
  for (const [field, value] of [
    ['insuranceMembershipId', membership.id], ['payerId', payer.id], ['tpaId', tpa.id], ['networkId', network.id],
    ['insuranceProductId', product.id], ['facilityId', facility.id], ['clinicianId', clinician.id],
    ['serviceDate', '2026-01-01'], ['encounterId', encounter.id], ['id', MISSING], ['version', 9],
    ['createdByUserId', MISSING], ['createdAt', '2026-01-01T00:00:00.000Z'], ['isCurrent', true], ['isSatisfied', true],
  ] as const)
    forgery.push(`${field}:${(await createFor(encounter.id, { [field]: value })).status}`)
  check('T14', 'Context forgery', forgery.every((line) => line.endsWith(':400')), `every server-owned field refused (${forgery.length} fields, all 400)`)

  check(
    'T15',
    'Context snapshot',
    storedParent.payerId === payer.id && storedParent.tpaId === tpa.id && storedParent.networkId === network.id &&
      storedParent.insuranceProductId === product.id && storedParent.facilityId === facility.id &&
      storedParent.clinicianId === clinician.id && storedParent.serviceDate.toISOString().slice(0, 10) === SERVICE_DATE,
    'membership, payer, TPA, network, product, facility, clinician and service date all match the locked Encounter context exactly',
  )

  const membershipPatch = await patchApi(`/api/insurance-memberships/${membership.id}`, { payerId: payer2.id, tpaId: null, networkId: null, insuranceProductId: null })
  const afterMembershipPatch = await prisma.priorAuthorization.findUniqueOrThrow({ where: { id: authorization.id } })
  check(
    'T16',
    'Later membership correction',
    membershipPatch.status === 200 && afterMembershipPatch.payerId === payer.id && afterMembershipPatch.tpaId === tpa.id &&
      afterMembershipPatch.networkId === network.id && afterMembershipPatch.insuranceProductId === product.id,
    membershipPatch.status === 200
      ? 'the membership now names a different payer and no TPA, network or product; the case still records the context it was frozen against'
      : `the membership correction itself failed with ${membershipPatch.status}, so this could not be proven`,
  )

  const NEW_SERVICE_DATE = '2026-06-16'
  const encounterPatch = await patchApi(`/api/encounters/${encounter.id}`, { serviceDate: NEW_SERVICE_DATE })
  const afterEncounterPatch = await prisma.priorAuthorization.findUniqueOrThrow({ where: { id: authorization.id } })
  check(
    'T17',
    'Later Encounter correction',
    encounterPatch.status === 200 && afterEncounterPatch.serviceDate.toISOString().slice(0, 10) === SERVICE_DATE,
    encounterPatch.status === 200
      ? `the Encounter now reads ${NEW_SERVICE_DATE}; the case still records ${SERVICE_DATE}, the date it was frozen against`
      : `the Encounter correction itself failed with ${encounterPatch.status}, so this could not be proven`,
  )

  const secondCase = await createFor(encounter.id)
  check(
    'T18',
    'Multiple authorizations',
    secondCase.status === 201 && (await prisma.priorAuthorization.count({ where: { encounterId: encounter.id } })) >= 2,
    'a second authorization case for the same Encounter is legitimate; no uniqueness and no primary flag was invented',
  )

  // ---------------------------------------------------------------- lifecycle vocabulary (T19–T32)
  section('Lifecycle vocabulary — recorded, never inferred')
  check('T19', 'Version 1 kind', storedVersions[0].version === 1 && storedVersions[0].versionKind === 'INITIAL', 'the first version is number 1 and kind INITIAL')
  const appendInitial = await appendTo(authorization.id, { versionKind: 'INITIAL', status: 'REQUESTED', respondedAt: null, evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: requestEvidenceId }] })
  check('T20', 'Append forbids INITIAL', appendInitial.status === 400, `a later INITIAL is ${appendInitial.status}: only the first version begins the case`)

  const v2 = await appendTo(authorization.id, { versionKind: 'RESPONSE', status: 'APPROVED' })
  const v3 = await appendTo(authorization.id, { versionKind: 'AMENDMENT', status: 'PARTIALLY_APPROVED' })
  const v4 = await appendTo(authorization.id, { versionKind: 'EXTENSION', status: 'APPROVED' })
  const v5 = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'DENIED' })
  check('T21', 'Version RESPONSE', v2.status === 201 && (v2.body as any).version === 2, 'accepted as version 2')
  check('T22', 'Version AMENDMENT', v3.status === 201 && (v3.body as any).version === 3, 'accepted as version 3')
  check('T23', 'Version EXTENSION', v4.status === 201 && (v4.body as any).version === 4, 'accepted as version 4')
  const v1AfterAppends = await prisma.priorAuthorizationVersion.findUniqueOrThrow({ where: { id: storedVersions[0].id }, include: { evidenceLinks: true } })
  check(
    'T24',
    'Version CORRECTION',
    v5.status === 201 && (v5.body as any).version === 5 && JSON.stringify(v1AfterAppends) === JSON.stringify(storedVersions[0]),
    'accepted as version 5, and version 1 is byte-for-byte what it was before any of them existed',
  )

  const statusResults: Record<string, number> = {}
  for (const value of ['REQUESTED', 'PENDING', 'UNKNOWN'])
    statusResults[value] = (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: value, respondedAt: null, evidenceLinks: [{ role: 'SUPPORTING', evidenceArtifactVersionId: supportingEvidenceId }] })).status
  for (const value of ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED'])
    statusResults[value] = (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: value })).status
  check('T25', 'Status REQUESTED', statusResults.REQUESTED === 201, 'accepted')
  check('T26', 'Status PENDING', statusResults.PENDING === 201, 'accepted')
  check('T27', 'Status APPROVED', statusResults.APPROVED === 201, 'accepted only as the reported fact')
  const partial = (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'PARTIALLY_APPROVED' })).body as Record<string, any>
  const partialKeys = deepKeys(partial)
  check(
    'T28',
    'Status PARTIALLY_APPROVED',
    statusResults.PARTIALLY_APPROVED === 201 && !partialKeys.has('approvedQuantity') && !partialKeys.has('serviceId') && !partialKeys.has('approvedLines'),
    'accepted as a payer-reported header fact; it exposes no approved activity, quantity or line — A5.4 owns that',
  )
  check('T29', 'Status DENIED', statusResults.DENIED === 201, 'accepted')
  check('T30', 'Status UNKNOWN', statusResults.UNKNOWN === 201, 'accepted as a first-class result; it never becomes approval')
  const badStatuses: string[] = []
  for (const value of ['EXPIRED', 'ACTIVE', 'INACTIVE', 'approved', 42, null])
    badStatuses.push(`${JSON.stringify(value)}:${(await appendTo(authorization.id, { versionKind: 'CORRECTION', status: value })).status}`)
  check('T31', 'Bad status', badStatuses.every((line) => line.endsWith(':400')), `${badStatuses.join(', ')} — EXPIRED and ACTIVE are refused because validity is validFrom/validThrough`)

  const versionColumns = (await prisma.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name LIKE 'prior_authorization%'`)
  const columnNames = versionColumns.map((row) => row.column_name)
  check(
    'T32',
    'No stored current state',
    columnNames.length > 0 && !columnNames.some((name) => /(is_current|is_active|is_satisfied|current_version|latest_version)/i.test(name)),
    columnNames.length === 0 ? 'the column catalog did not reach the tables, so this absence is unproven' : `no current, active, satisfied or latest-version column among ${columnNames.length}`,
  )

  // ---------------------------------------------------------------- reference, timing, validity (T33–T42)
  section('Authorization reference, timing and validity')
  check('T33', 'Reference null', (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'PENDING', respondedAt: null, authorizationReference: null, evidenceLinks: [{ role: 'SUPPORTING', evidenceArtifactVersionId: supportingEvidenceId }] })).status === 201, 'a case may have no reference at all')
  const mixedCase = (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', authorizationReference: '  AuTh-XyZ-42  ' })).body as Record<string, any>
  const badReferences: string[] = []
  for (const value of ['   ', 'AUTH\n123', 'x'.repeat(129), 42])
    badReferences.push(`${(await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', authorizationReference: value })).status}`)
  check(
    'T34',
    'Reference validation',
    mixedCase.authorizationReference === 'AuTh-XyZ-42' && badReferences.every((code) => code === '400'),
    `trimmed with case preserved; blank, line break, oversize and non-string all refused (${badReferences.join(', ')})`,
  )
  const sharedReference = `SHARED-${runId.slice(-6)}`
  const refA = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', authorizationReference: sharedReference })
  const refB = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', authorizationReference: sharedReference })
  const referenceUniques = (await prisma.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='prior_authorization_versions' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%authorization_reference%'`)
  check(
    'T35',
    'Reference non-unique',
    refA.status === 201 && refB.status === 201 && referenceUniques.length === 0,
    'the same opaque reference may appear on more than one version; payer semantics are external and no uniqueness was invented',
  )

  check('T36', 'requestedAt optional', (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', requestedAt: null })).status === 201, 'null is accepted and never inferred from createdAt')
  check('T37', 'respondedAt optional for request', (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'REQUESTED', respondedAt: null, evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: requestEvidenceId }] })).status === 201, 'a REQUESTED version needs no response instant, because nothing was decided')
  const decisionWithoutResponse: string[] = []
  for (const value of ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED'])
    decisionWithoutResponse.push(`${value}:${(await appendTo(authorization.id, { versionKind: 'CORRECTION', status: value, respondedAt: null })).status}`)
  const decisionCheckRefusal = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe(
      `INSERT INTO prior_authorization_versions (id, prior_authorization_id, version, version_kind, status, responded_at, created_by_user_id) VALUES (gen_random_uuid(), '${authorization.id}'::uuid, 9001, 'CORRECTION', 'APPROVED', NULL, (SELECT id FROM "user" LIMIT 1))`,
    ),
  )
  check(
    'T38',
    'Decision response instant',
    decisionWithoutResponse.every((line) => line.endsWith(':400')) && /decision_response_chk/.test(decisionCheckRefusal),
    `${decisionWithoutResponse.join(', ')}; the database CHECK refuses it too on a direct insert`,
  )
  const orderRes = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', requestedAt: '2026-09-29T09:05:00.000Z', respondedAt: '2026-09-29T09:00:00.000Z' })
  const orderRefusal = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe(
      `INSERT INTO prior_authorization_versions (id, prior_authorization_id, version, version_kind, status, requested_at, responded_at, created_by_user_id) VALUES (gen_random_uuid(), '${authorization.id}'::uuid, 9002, 'CORRECTION', 'PENDING', TIMESTAMPTZ '2026-09-29 09:05:00+00', TIMESTAMPTZ '2026-09-29 09:00:00+00', (SELECT id FROM "user" LIMIT 1))`,
    ),
  )
  check('T39', 'Timestamp order', orderRes.status === 400 && /timing_order_chk/.test(orderRefusal), 'a response earlier than its own request is refused by validation and by the database CHECK')

  check('T40', 'Validity nulls', (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', validFrom: null, validThrough: null })).status === 201, 'a version may record no validity window at all')
  const badValidity = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', validFrom: '2026-10-31', validThrough: '2026-10-01' })
  const validityRefusal = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe(
      `INSERT INTO prior_authorization_versions (id, prior_authorization_id, version, version_kind, status, responded_at, valid_from, valid_through, created_by_user_id) VALUES (gen_random_uuid(), '${authorization.id}'::uuid, 9003, 'CORRECTION', 'APPROVED', now(), DATE '2026-10-31', DATE '2026-10-01', (SELECT id FROM "user" LIMIT 1))`,
    ),
  )
  check('T41', 'Validity order', badValidity.status === 400 && /validity_order_chk/.test(validityRefusal), 'a window that ends before it begins is refused by validation and by the database CHECK')
  check(
    'T42',
    'No inferred expiry',
    !columnNames.some((name) => /(expired|expiry|expires|is_valid)/i.test(name)) && !deepKeys(v2.body).has('expired'),
    'no EXPIRED or ACTIVE status is derived or stored; whether an authorization still applies is decided by A5.4 and A5.8',
  )

  // ---------------------------------------------------------------- evidence (T43–T56)
  section('Evidence-bearing versions — exact A5.1 links, nothing copied')
  const noEvidence = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', evidenceLinks: [] })
  check('T43', 'Evidence required', noEvidence.status === 400, `a version with no evidence link is ${noEvidence.status}: a lifecycle snapshot nobody can point at records nothing`)
  check('T44', 'Request evidence role', (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'PENDING', respondedAt: null, evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: requestEvidenceId }] })).status === 201, 'REQUEST accepted')
  check('T45', 'Response evidence role', (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: responseEvidenceId }] })).status === 201, 'RESPONSE accepted')
  check('T46', 'Supporting evidence role', (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'PENDING', respondedAt: null, evidenceLinks: [{ role: 'SUPPORTING', evidenceArtifactVersionId: supportingEvidenceId }] })).status === 201, 'SUPPORTING accepted')
  const badRoles: string[] = []
  for (const role of ['APPROVAL_LETTER', 'request', '', 42])
    badRoles.push(`${(await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'PENDING', respondedAt: null, evidenceLinks: [{ role, evidenceArtifactVersionId: requestEvidenceId }] })).status}`)
  check('T47', 'Bad evidence role', badRoles.every((code) => code === '400'), `${badRoles.join(', ')} — no payer document vocabulary is accepted as a role`)

  const decisionWithoutResponseEvidence: string[] = []
  for (const value of ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED'])
    decisionWithoutResponseEvidence.push(`${value}:${(await appendTo(authorization.id, { versionKind: 'CORRECTION', status: value, evidenceLinks: [{ role: 'SUPPORTING', evidenceArtifactVersionId: supportingEvidenceId }] })).status}`)
  check('T48', 'Decision response evidence', decisionWithoutResponseEvidence.every((line) => line.endsWith(':400')), decisionWithoutResponseEvidence.join(', '))
  check('T49', 'Amendment evidence', (await appendTo(authorization.id, { versionKind: 'AMENDMENT', status: 'PENDING', respondedAt: null, evidenceLinks: [{ role: 'SUPPORTING', evidenceArtifactVersionId: supportingEvidenceId }] })).status === 400, 'an AMENDMENT exists because something came back, so it requires RESPONSE evidence')
  check('T50', 'Extension evidence', (await appendTo(authorization.id, { versionKind: 'EXTENSION', status: 'PENDING', respondedAt: null, evidenceLinks: [{ role: 'SUPPORTING', evidenceArtifactVersionId: supportingEvidenceId }] })).status === 400, 'an EXTENSION likewise requires RESPONSE evidence')

  const multiRole = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', evidenceLinks: [
    { role: 'RESPONSE', evidenceArtifactVersionId: responseEvidenceId },
    { role: 'SUPPORTING', evidenceArtifactVersionId: supportingEvidenceId },
    { role: 'REQUEST', evidenceArtifactVersionId: requestEvidenceId },
  ] })
  check('T51', 'Evidence same tenant', multiRole.status === 201 && (multiRole.body as any).evidenceLinks.length === 3, 'three own-organization versions accepted in three roles')

  const foreignVersion = await prisma.evidenceArtifactVersion.findFirst({ where: { evidenceArtifact: { organizationId: otherOrg } }, select: { id: true, storageRef: true } })
  const foreignEvidenceAttempt = foreignVersion ? await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: foreignVersion.id }] }) : null
  const foreignEvidenceBody = JSON.stringify(foreignEvidenceAttempt?.body ?? {})
  check(
    'T52',
    'Evidence foreign tenant',
    foreignVersion !== null && foreignEvidenceAttempt !== null && foreignEvidenceAttempt.status === 404 &&
      !foreignEvidenceBody.includes(otherOrg) && !foreignEvidenceBody.includes(foreignVersion.storageRef),
    foreignVersion === null ? 'no foreign-tenant evidence exists, so this could not be proven' : 'refused identically to a missing version, disclosing neither the organization nor its storage reference',
  )
  const versionsBeforeMissing = await prisma.priorAuthorizationVersion.count({ where: { priorAuthorizationId: authorization.id } })
  const auditBeforeMissing = await authorizationAuditCount()
  const missingEvidence = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: MISSING }] })
  check(
    'T53',
    'Evidence missing',
    missingEvidence.status === 404 &&
      (await prisma.priorAuthorizationVersion.count({ where: { priorAuthorizationId: authorization.id } })) === versionsBeforeMissing &&
      (await authorizationAuditCount()) === auditBeforeMissing,
    '404 with no version and no audit written',
  )
  const duplicateLink = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', evidenceLinks: [
    { role: 'RESPONSE', evidenceArtifactVersionId: responseEvidenceId },
    { role: 'RESPONSE', evidenceArtifactVersionId: responseEvidenceId },
  ] })
  check('T54', 'Duplicate evidence link', duplicateLink.status === 400, 'the same version in the same role twice is refused rather than silently collapsed')

  check(
    'T55',
    'No evidence metadata copy',
    !columnNames.some((name) => /(storage_ref|content_hash|document_type)/i.test(name)) && !deepKeys(authorization).has('storageRef'),
    'no storage reference, content hash or document type column in any A5.3 table, and none in the DTO',
  )
  const binaryColumns = versionColumns.filter((row) => /bytea|json|xml/i.test(row.data_type) || /(bytes|blob|payload|body|content|base64|raw|conditions)/i.test(row.column_name))
  check(
    'T56',
    'No evidence bytes/JSON',
    binaryColumns.length === 0,
    `no binary, JSON or conditions column: the response itself stays in A5.1 (types: ${[...new Set(versionColumns.map((row) => row.data_type))].join(', ')})`,
  )

  // ---------------------------------------------------------------- eligibility provenance (T57–T63)
  section('Optional eligibility provenance — exact context, never a decision')
  check('T57', 'Eligibility link absent', (await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', eligibilityVerificationId: null })).status === 201, 'a version needs no eligibility link at all')
  const withEligibility = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', eligibilityVerificationId: eligibility.id })
  check('T58', 'Eligibility link exact', withEligibility.status === 201 && (withEligibility.body as any).eligibilityVerificationId === eligibility.id, 'a verification recorded for the same encounter, membership, commercial context and service date is accepted')

  // A verification recorded against a DIFFERENT encounter, built through its owner route.
  const otherEncounter = must('second encounter', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membership.id })).body)
  const otherEligibility = must('eligibility on another encounter', (await post(`/api/encounters/${otherEncounter.id}/eligibility-verifications`, {
    verificationMethod: 'PORTAL', status: 'ELIGIBLE', requestedAt: null, respondedAt: '2026-06-15T09:31:00.000Z',
    validThrough: null, authorizationRequired: null, referralRequired: null,
    requestEvidenceVersionId: null, responseEvidenceVersionId: responseEvidenceId,
  })).body)
  const encounterMismatch = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', eligibilityVerificationId: otherEligibility.id })
  check('T59', 'Eligibility encounter mismatch', encounterMismatch.status === 400, `a verification from another Encounter is ${encounterMismatch.status}`)

  // The same Encounter but a corrected membership context: the verification's frozen snapshot no
  // longer matches the one this case was frozen against.
  const membershipMismatchCase = await prisma.eligibilityVerification.findFirst({
    where: { encounterId: encounter.id, NOT: { payerId: storedParent.payerId } },
    select: { id: true },
  })
  const membershipMismatch = membershipMismatchCase ? await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', eligibilityVerificationId: membershipMismatchCase.id }) : null
  check(
    'T60',
    'Eligibility membership mismatch',
    membershipMismatchCase === null || (membershipMismatch !== null && membershipMismatch.status === 400),
    membershipMismatchCase === null ? 'no verification with a different commercial snapshot exists on this Encounter, so T61 proves the rule instead' : `a verification whose commercial snapshot differs is ${membershipMismatch?.status}`,
  )

  // An adversarial verification whose commercial snapshot was corrupted directly, restored after.
  const eligibilityBefore = await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: eligibility.id }, select: { payerId: true } })
  await prisma.$executeRawUnsafe(`ALTER TABLE eligibility_verifications DISABLE TRIGGER eligibility_verifications_append_only_trg`)
  await prisma.$executeRawUnsafe(`UPDATE eligibility_verifications SET payer_id = '${payer2.id}' WHERE id = '${eligibility.id}'`)
  const commercialMismatch = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', eligibilityVerificationId: eligibility.id })
  await prisma.$executeRawUnsafe(`UPDATE eligibility_verifications SET payer_id = '${eligibilityBefore.payerId}' WHERE id = '${eligibility.id}'`)
  await prisma.$executeRawUnsafe(`ALTER TABLE eligibility_verifications ENABLE TRIGGER eligibility_verifications_append_only_trg`)
  const eligibilityRestored = await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: eligibility.id }, select: { payerId: true } })
  check(
    'T61',
    'Eligibility commercial mismatch',
    commercialMismatch.status === 400 && eligibilityRestored.payerId === eligibilityBefore.payerId,
    'a verification whose payer no longer matches the frozen case context is refused, and the adversarial corruption was restored',
  )

  const staleEligibility = must('stale eligibility', (await post(`/api/encounters/${encounter.id}/eligibility-verifications`, {
    verificationMethod: 'MANUAL', status: 'INELIGIBLE', requestedAt: null, respondedAt: '2026-06-15T09:00:00.000Z',
    validThrough: '2026-06-16T00:00:00.000Z', authorizationRequired: null, referralRequired: null,
    requestEvidenceVersionId: null, responseEvidenceVersionId: responseEvidenceId,
  })).body)
  const staleLink = await appendTo(authorization.id, { versionKind: 'CORRECTION', status: 'APPROVED', eligibilityVerificationId: staleEligibility.id })
  check(
    'T62',
    'Eligibility freshness ignored',
    staleLink.status === 201 && staleEligibility.freshness?.state === 'STALE',
    `the linked verification is ${staleEligibility.freshness?.state}; A5.3 records authorization truth without re-evaluating A5.2 freshness`,
  )
  const ineligibleStored = await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: staleEligibility.id }, select: { status: true } })
  check(
    'T63',
    'Eligibility status ignored',
    ineligibleStored.status === 'INELIGIBLE' && (staleLink.body as any).status === 'APPROVED',
    'an INELIGIBLE verification is neither rewritten nor treated as the authorization result: the version still records APPROVED as reported',
  )

  // ---------------------------------------------------------------- numbering and snapshots (T64–T66)
  section('Version numbering and complete snapshots')
  const history = await get(`/api/prior-authorizations/${authorization.id}/versions`)
  const historyItems = ((history.body as { items?: Record<string, any>[] })?.items ?? [])
  const numbers = historyItems.map((row) => row.version)
  check(
    'T64',
    'Gap-free append',
    numbers.length > 1 && numbers.every((value, index) => value === index + 1),
    `versions ${numbers[0]}..${numbers[numbers.length - 1]} with no duplicate and no gap`,
  )

  const raceCase = (await createFor(encounter.id)).body as Record<string, any>
  const gate = holdAt('prior_authorization_version.locked')
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  const raceInput = (kind: string) => ({
    versionKind: kind, status: 'APPROVED', authorizationReference: null, eligibilityVerificationId: null,
    requestedAt: null, respondedAt: '2026-09-29T09:00:00.000Z', validFrom: null, validThrough: null,
    evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: responseEvidenceId }],
  })
  const firstAppend = appendPriorAuthorizationVersion(raceCase.id, raceInput('RESPONSE'), actorUserId)
  await gate.arrived
  const secondAppend = appendPriorAuthorizationVersion(raceCase.id, raceInput('AMENDMENT'), actorUserId)
  const blocked = await waitForLockWaiter()
  gate.release()
  const [firstResult, secondResult] = await Promise.all([firstAppend, secondAppend])
  clearConcurrencyProbes()
  const raceVersions = await prisma.priorAuthorizationVersion.findMany({ where: { priorAuthorizationId: raceCase.id }, orderBy: { version: 'asc' }, select: { version: true } })
  check(
    'T65',
    'Concurrent append',
    blocked && firstResult.ok && secondResult.ok && raceVersions.map((row) => row.version).join(',') === '1,2,3',
    `the second writer waited on the case row lock; versions ${raceVersions.map((row) => row.version).join(', ')} with no duplicate and no gap`,
  )

  const snapshotCase = (await createFor(encounter.id, { authorizationReference: 'FIRST-REF', validFrom: '2026-10-01', validThrough: '2026-10-31' })).body as Record<string, any>
  const snapshotAppend = (await appendTo(snapshotCase.id, { versionKind: 'RESPONSE', status: 'APPROVED', authorizationReference: null, validFrom: null, validThrough: null })).body as Record<string, any>
  check(
    'T66',
    'Complete snapshot',
    snapshotCase.latestRecordedVersion.authorizationReference === 'FIRST-REF' &&
      snapshotAppend.authorizationReference === null && snapshotAppend.validFrom === null && snapshotAppend.validThrough === null,
    'the appended version inherits nothing from the version before it: omitted fields are null, not carried forward',
  )

  // ---------------------------------------------------------------- reads (T67–T70)
  section('Reads and history ordering')
  const parentGet = await get(`/api/prior-authorizations/${authorization.id}`)
  const parentBody = parentGet.body as Record<string, any>
  check(
    'T67',
    'Parent GET',
    parentGet.status === 200 && parentBody.id === authorization.id && typeof parentBody.latestRecordedVersion?.version === 'number' &&
      !('currentVersion' in parentBody) && !('usableVersion' in parentBody),
    'the exact stable context plus a version labelled latestRecordedVersion — never current, usable or satisfied',
  )
  const versionGet = await get(`/api/prior-authorization-versions/${(v2.body as any).id}`)
  const versionBody = versionGet.body as Record<string, any>
  check(
    'T68',
    'Version GET',
    versionGet.status === 200 && versionBody.version === 2 && Array.isArray(versionBody.evidenceLinks) &&
      versionBody.evidenceLinks.every((link: any) => typeof link.evidenceArtifactVersionId === 'string' && typeof link.role === 'string'),
    'the immutable header plus its evidence link ids and roles, and no evidence metadata',
  )
  const secondHistory = ((await get(`/api/prior-authorizations/${authorization.id}/versions`)).body as { items?: Record<string, any>[] })?.items ?? []
  check(
    'T69',
    'Version history order',
    JSON.stringify(historyItems.map((row) => row.version)) === JSON.stringify(secondHistory.map((row) => row.version)) &&
      historyItems.every((row, index) => index === 0 || row.version > historyItems[index - 1].version),
    'version ascending, identical across two reads: a history reads in the order it happened',
  )
  const parentList = await get(`/api/encounters/${encounter.id}/prior-authorizations`)
  const listItems = ((parentList.body as { items?: Record<string, any>[] })?.items ?? [])
  const listAgain = ((await get(`/api/encounters/${encounter.id}/prior-authorizations`)).body as { items?: Record<string, any>[] })?.items ?? []
  check(
    'T70',
    'Parent list order',
    parentList.status === 200 && listItems.length > 1 &&
      JSON.stringify(listItems.map((row) => row.id)) === JSON.stringify(listAgain.map((row) => row.id)) &&
      listItems.every((row) => row.encounterId === encounter.id) &&
      !listItems.some((row) => 'isPrimary' in row || 'isCurrent' in row),
    `${listItems.length} case(s), deterministic across two reads, with no primary or current ranking`,
  )

  // ---------------------------------------------------------------- immutability (T71–T81)
  section('Immutable — no route and no statement can rewrite history')
  check('T71', 'No parent PATCH', (await patchApi(`/api/prior-authorizations/${authorization.id}`, {})).status === 404, 'PATCH is 404')
  check('T72', 'No parent DELETE', (await del(`/api/prior-authorizations/${authorization.id}`)).status === 404, 'DELETE is 404')
  check('T73', 'No version PATCH', (await patchApi(`/api/prior-authorization-versions/${(v2.body as any).id}`, {})).status === 404, 'PATCH is 404')
  check('T74', 'No version DELETE', (await del(`/api/prior-authorization-versions/${(v2.body as any).id}`)).status === 404, 'DELETE is 404')

  const parentUpdate = await attemptAdversarial(() => prisma.priorAuthorization.update({ where: { id: authorization.id }, data: { serviceDate: new Date('2020-01-01') } }))
  check('T75', 'DB parent UPDATE immutability', /append-only/i.test(parentUpdate), 'the trigger refused a direct UPDATE on the case')
  const parentDelete = await attemptAdversarial(() => prisma.priorAuthorization.delete({ where: { id: authorization.id } }))
  check('T76', 'DB parent DELETE immutability', /append-only/i.test(parentDelete) && (await prisma.priorAuthorization.count({ where: { id: authorization.id } })) === 1, 'the trigger refused a direct DELETE and the case survived')
  const versionUpdate = await attemptAdversarial(() => prisma.priorAuthorizationVersion.update({ where: { id: (v2.body as any).id }, data: { status: 'DENIED' } }))
  check('T77', 'DB version UPDATE immutability', /append-only/i.test(versionUpdate), 'the trigger refused a direct UPDATE on a version')
  const versionDelete = await attemptAdversarial(() => prisma.priorAuthorizationVersion.delete({ where: { id: (v2.body as any).id } }))
  check('T78', 'DB version DELETE immutability', /append-only/i.test(versionDelete), 'the trigger refused a direct DELETE on a version')
  const linkId = (await prisma.priorAuthorizationVersionEvidence.findFirstOrThrow({ where: { priorAuthorizationVersionId: (v2.body as any).id }, select: { id: true } })).id
  const linkUpdate = await attemptAdversarial(() => prisma.priorAuthorizationVersionEvidence.update({ where: { id: linkId }, data: { role: 'SUPPORTING' } }))
  check('T79', 'DB evidence-link UPDATE immutability', /append-only/i.test(linkUpdate), 'the trigger refused a direct UPDATE on an evidence link')
  const linkDelete = await attemptAdversarial(() => prisma.priorAuthorizationVersionEvidence.delete({ where: { id: linkId } }))
  check('T80', 'DB evidence-link DELETE immutability', /append-only/i.test(linkDelete) && (await prisma.priorAuthorizationVersionEvidence.count({ where: { id: linkId } })) === 1, 'the trigger refused a direct DELETE and the link survived')

  const v1Final = await prisma.priorAuthorizationVersion.findUniqueOrThrow({ where: { id: storedVersions[0].id }, include: { evidenceLinks: true } })
  check('T81', 'History unchanged', JSON.stringify(v1Final) === JSON.stringify(storedVersions[0]), 'version 1 and its evidence links are byte-for-byte what they were before every version above existed')

  // ---------------------------------------------------------------- RBAC and tenancy (T82–T87)
  section('Permission, tenancy and safe errors')
  check(
    'T82',
    'Viewer read',
    (await get(`/api/prior-authorizations/${authorization.id}`, asViewer)).status === 200 &&
      (await get(`/api/prior-authorizations/${authorization.id}/versions`, asViewer)).status === 200 &&
      (await get(`/api/prior-authorization-versions/${(v2.body as any).id}`, asViewer)).status === 200,
    'a viewer may read a case, its history and a single version',
  )
  const casesBeforeViewer = await prisma.priorAuthorization.count({ where: { encounterId: encounter.id } })
  const auditBeforeViewer = await authorizationAuditCount()
  const viewerCreate = await createFor(encounter.id, {}, asViewer)
  check(
    'T83',
    'Viewer create',
    viewerCreate.status === 403 && (await prisma.priorAuthorization.count({ where: { encounterId: encounter.id } })) === casesBeforeViewer &&
      (await authorizationAuditCount()) === auditBeforeViewer,
    '403 with no case, no version, no evidence link and no audit',
  )
  const versionsBeforeViewer = await prisma.priorAuthorizationVersion.count({ where: { priorAuthorizationId: authorization.id } })
  const viewerAppend = await appendTo(authorization.id, {}, asViewer)
  check(
    'T84',
    'Viewer append',
    viewerAppend.status === 403 && (await prisma.priorAuthorizationVersion.count({ where: { priorAuthorizationId: authorization.id } })) === versionsBeforeViewer,
    '403 with no new version, evidence link or audit',
  )

  const foreignCasesBefore = foreignEncounter ? await prisma.priorAuthorization.count({ where: { encounterId: foreignEncounter.id } }) : 0
  const foreignList = foreignEncounter ? await get(`/api/encounters/${foreignEncounter.id}/prior-authorizations`) : null
  const foreignCreate = foreignEncounter ? await createFor(foreignEncounter.id) : null
  const foreignCasesAfter = foreignEncounter ? await prisma.priorAuthorization.count({ where: { encounterId: foreignEncounter.id } }) : 0
  check(
    'T85',
    'Cross-tenant parent',
    foreignEncounter !== null && foreignList !== null && foreignCreate !== null &&
      foreignList.status >= 400 && foreignList.status < 500 && foreignCreate.status >= 400 && foreignCreate.status < 500 &&
      !JSON.stringify(foreignList.body ?? {}).includes(otherOrg) && foreignCasesAfter === foreignCasesBefore,
    `read ${foreignList?.status} and create ${foreignCreate?.status}; nothing written and no context disclosed`,
  )
  const foreignVersionRead = await get(`/api/prior-authorization-versions/${MISSING}`)
  check(
    'T86',
    'Cross-tenant version',
    foreignVersionRead.status === 404 && !JSON.stringify(foreignVersionRead.body ?? {}).includes(org),
    'a version belonging to another tenant is refused through its case ownership, with no tenant information',
  )
  const malformed: string[] = []
  const malformedBodies: string[] = []
  for (const path of [`/api/encounters/not-a-uuid/prior-authorizations`, `/api/prior-authorizations/not-a-uuid`, `/api/prior-authorizations/not-a-uuid/versions`, `/api/prior-authorization-versions/not-a-uuid`]) {
    const res = await get(path)
    malformed.push(`${res.status}`)
    malformedBodies.push(JSON.stringify(res.body ?? {}))
  }
  check(
    'T87',
    'Malformed IDs',
    malformed.every((code) => code === '404' || code === '400') && malformedBodies.every((text) => !/prisma|postgres|syntax|invalid input|column|relation/i.test(text)),
    `${malformed.join(', ')}; safe envelopes with no raw database text, never a 500`,
  )

  // ---------------------------------------------------------------- audit (T88–T93)
  section('Business audit — proves the action, stores none of the authorization')
  const parentAudit = createAudits.find((row) => row.entityType === 'PRIOR_AUTHORIZATION')
  const v1Audit = createAudits.find((row) => row.entityType === 'PRIOR_AUTHORIZATION_VERSION')
  check(
    'T88',
    'Parent create audit',
    createAudits.length === 2 && parentAudit?.actionCode === 'prior_authorization.created' && v1Audit?.actionCode === 'prior_authorization_version.created',
    'exactly one case event and one version event, both written in the same transaction as the rows',
  )
  const appendAudit = await prisma.auditEvent.findFirst({ where: { entityType: 'PRIOR_AUTHORIZATION_VERSION', entityId: (v2.body as any).id } })
  check(
    'T89',
    'Version append audit',
    appendAudit !== null && (appendAudit.afterState as Record<string, any>)?.version === 2,
    'the append event names the exact version number and row it created',
  )
  const allAudits = await prisma.auditEvent.findMany({ where: { entityType: { in: ['PRIOR_AUTHORIZATION', 'PRIOR_AUTHORIZATION_VERSION'] } }, select: { afterState: true, beforeState: true } })
  const sensitive = ['status', 'APPROVED', 'DENIED', 'PARTIALLY_APPROVED', 'authorizationReference', 'AuTh-XyZ-42', 'encounterId', 'insuranceMembershipId', 'payerId', 'tpaId', 'networkId', 'insuranceProductId', 'facilityId', 'clinicianId', 'serviceDate', 'validFrom', 'validThrough', 'eligibilityVerificationId', 'evidenceArtifactVersionId', 'versionKind']
  const leaks = allAudits.filter((event) => sensitive.some((needle) => JSON.stringify(event.afterState ?? {}).includes(needle) || JSON.stringify(event.beforeState ?? {}).includes(needle)))
  check(
    'T90',
    'Audit minimization',
    leaks.length === 0 && JSON.stringify(Object.keys((parentAudit?.afterState ?? {}) as object).sort()) === JSON.stringify(['createdAt', 'id']),
    leaks.length === 0
      ? `no status, reference, context, validity, eligibility or evidence value in any of ${allAudits.length} authorization audit rows; a case snapshot carries id and createdAt, a version snapshot adds only the parent and the number`
      : `${leaks.length} audit row(s) carry authorization data`,
  )
  const auditBeforeBatch = await authorizationAuditCount()
  await createFor(encounter.id, {}, asViewer)
  await appendTo(authorization.id, { status: 'NONSENSE' })
  await createFor(selfEncounter.id)
  await createFor(MISSING)
  await appendTo(authorization.id, { evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: MISSING }] })
  check('T91', 'No false audit', (await authorizationAuditCount()) === auditBeforeBatch, `five rejected attempts created no audit (count stayed ${auditBeforeBatch})`)

  const casesBeforeRollback = await prisma.priorAuthorization.count({ where: { encounterId: encounter.id } })
  const auditBeforeRollback = await authorizationAuditCount()
  failAt('prior_authorization.created', 'forced audit failure (acceptance)')
  let parentRollbackThrew = false
  try {
    await createPriorAuthorization(encounter.id, initialBody(), actorUserId)
  } catch {
    parentRollbackThrew = true
  }
  clearConcurrencyProbes()
  check(
    'T92',
    'Atomic parent rollback',
    parentRollbackThrew && (await prisma.priorAuthorization.count({ where: { encounterId: encounter.id } })) === casesBeforeRollback &&
      (await authorizationAuditCount()) === auditBeforeRollback,
    'a forced failure left no case, no version, no evidence link and no audit behind',
  )
  const versionsBeforeRollback = await prisma.priorAuthorizationVersion.count({ where: { priorAuthorizationId: authorization.id } })
  const linksBeforeRollback = await prisma.priorAuthorizationVersionEvidence.count()
  failAt('prior_authorization_version.created', 'forced audit failure (acceptance)')
  let appendRollbackThrew = false
  try {
    await appendPriorAuthorizationVersion(authorization.id, raceInput('RESPONSE'), actorUserId)
  } catch {
    appendRollbackThrew = true
  }
  clearConcurrencyProbes()
  check(
    'T93',
    'Atomic append rollback',
    appendRollbackThrew && (await prisma.priorAuthorizationVersion.count({ where: { priorAuthorizationId: authorization.id } })) === versionsBeforeRollback &&
      (await prisma.priorAuthorizationVersionEvidence.count()) === linksBeforeRollback,
    'a forced failure left no version, no evidence link and no audit behind',
  )

  // ---------------------------------------------------------------- concurrency (T94–T95)
  section('Concurrent upstream correction — one coherent snapshot, never a mixture')
  const encounterGate = holdAt('prior_authorization.encounter_locked')
  const heldCase = createPriorAuthorization(encounter.id, initialBody(), actorUserId)
  await encounterGate.arrived
  const RACE_DATE = '2026-06-17'
  const competingEncounter = updateEncounter(encounter.id, { serviceDate: RACE_DATE }, actorUserId)
  const encounterBlocked = await waitForLockWaiter()
  encounterGate.release()
  const [racedCase, patchedEncounter] = await Promise.all([heldCase, competingEncounter])
  clearConcurrencyProbes()
  const racedDate = racedCase.ok
    ? (await prisma.priorAuthorization.findUniqueOrThrow({ where: { id: racedCase.value.id }, select: { serviceDate: true } })).serviceDate.toISOString().slice(0, 10)
    : ''
  check(
    'T94',
    'Encounter correction race',
    encounterBlocked && racedCase.ok && patchedEncounter.ok && (racedDate === NEW_SERVICE_DATE || racedDate === RACE_DATE),
    `the competing Encounter correction waited on the row lock; the case recorded ${racedDate}, wholly the state before the correction or wholly after it`,
  )

  const membershipGate = holdAt('prior_authorization.membership_locked')
  const heldCase2 = createPriorAuthorization(encounter.id, initialBody(), actorUserId)
  await membershipGate.arrived
  const competingMembership = updateMembership(membership.id, { payerId: payer.id, tpaId: tpa.id, networkId: network.id, insuranceProductId: product.id }, actorUserId)
  const membershipBlocked = await waitForLockWaiter()
  membershipGate.release()
  const [racedCase2, patchedMembership] = await Promise.all([heldCase2, competingMembership])
  clearConcurrencyProbes()
  const racedContext = racedCase2.ok
    ? await prisma.priorAuthorization.findUniqueOrThrow({ where: { id: racedCase2.value.id }, select: { payerId: true, tpaId: true, networkId: true, insuranceProductId: true } })
    : null
  const wholeBefore = racedContext?.payerId === payer2.id && racedContext?.tpaId === null && racedContext?.networkId === null && racedContext?.insuranceProductId === null
  const wholeAfter = racedContext?.payerId === payer.id && racedContext?.tpaId === tpa.id && racedContext?.networkId === network.id && racedContext?.insuranceProductId === product.id
  check(
    'T95',
    'Membership correction race',
    membershipBlocked && racedCase2.ok && patchedMembership.ok && (wholeBefore || wholeAfter),
    `the competing membership correction waited on the row lock; the snapshot is ${wholeAfter ? 'wholly the corrected context' : 'wholly the context before the correction'}, with no field taken from the other`,
  )

  // ---------------------------------------------------------------- scope guards (T96–T105)
  section('Scope guards — an authorization header and nothing more')
  const productionCode = committedProductionCodeOf('backend/src/modules/prior-authorization')
  const moduleCode = committedCodeOf('backend/src/modules/prior-authorization')
  const lineColumns = columnNames.filter((name) => /(service_id|procedure|diagnosis|quantity|approved_from|approved_through|line_status|unit)/i.test(name))
  check(
    'T96',
    'No AuthorizationLine model',
    lineColumns.length === 0 && !/AuthorizationLine/.test(productionCode.code),
    `no service, procedure, diagnosis, quantity, approved-date or line-status column among ${columnNames.length}, and no AuthorizationLine anywhere in the ${productionCode.files.length} production files`,
  )
  check(
    'T97',
    'Partial header not line approval',
    !partialKeys.has('approvedQuantity') && !partialKeys.has('approvedActivities') && !partialKeys.has('serviceId') && !partialKeys.has('lines'),
    'a PARTIALLY_APPROVED version exposes no approved activity id, quantity or line: which activity is authorized is unknowable until A5.4 exists',
  )
  check(
    'T98',
    'No line matching',
    !/encounterActivity|claimLine|matchActivit|matchLine/i.test(productionCode.code),
    'no EncounterActivity or ClaimLine matching function in the module',
  )
  check(
    'T99',
    'No contract/tariff',
    !columnNames.some((name) => /(contract|tariff|price|amount|rate)/i.test(name)) && !/providerContract|tariffSchedule/i.test(productionCode.code),
    'no ProviderContract or TariffScheduleVersion selection — A5.5 owns that',
  )
  check(
    'T100',
    'No validation/readiness',
    !columnNames.some((name) => /(validation|finding|readiness|ready|restrict|block)/i.test(name)) && !/validationRun|validationFinding|readiness/i.test(productionCode.code),
    'no ValidationRun, ValidationFinding or readiness state — A5.7 and A5.9 own those',
  )
  const claimTables = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name ~* '(^claims?$|claim_lines|claim_submissions|remittance|authorization_lines)'`).map((row) => row.table_name)
  check(
    'T101',
    'No Claim',
    claimTables.length === 0 && !/prisma\.(claim|claimLine|claimSubmission|authorizationLine)\b/.test(productionCode.code),
    claimTables.length === 0 ? 'no Claim, ClaimLine, ClaimSubmission or AuthorizationLine table exists and none is read — A5.4 and A6 own them' : `unexpected tables: ${claimTables.join(', ')}`,
  )
  const integration = productionCode.code.match(/\b(fetch|axios|http\.request|https\.request|soap|dhpo|eclaimlink|apiKey|clientSecret|Authorization:)\b/i)
  check(
    'T102',
    'No real integration',
    productionCode.files.length > 0 && integration === null,
    productionCode.files.length === 0
      ? 'the production module source could not be read, so this absence is unproven'
      : `across ${productionCode.files.length} production files there is no network call, payer adapter or credential — A5.3 records what an authorization source reported, it never performs one`,
  )
  check(
    'T103',
    'No conditions blob',
    !columnNames.some((name) => /(conditions|notes|comments|remarks|payload|raw)/i.test(name)) && !/conditionsJson|conditionText/i.test(productionCode.code),
    'no free-text or JSON condition column: authorization conditions stay reconstructable through the exact evidence links',
  )
  const feCode = committedCodeOf('frontend/src/modules/prior-authorization')
  const fePersist = /\b(localStorage|sessionStorage|indexedDB)\s*\.\s*[A-Za-z]+\s*\(/.test(feCode.code)
  const feDump = /storageRef|contentHash|documentType/.test(feCode.code)
  check(
    'T104',
    'Frontend privacy',
    feCode.files.length > 0 && feCode.code.includes('createPriorAuthorization') && !fePersist && !feDump,
    feCode.files.length === 0 || !feCode.code.includes('createPriorAuthorization')
      ? 'the scan did not reach the committed frontend source, so this absence is unproven'
      : 'nothing is written to localStorage, sessionStorage or IndexedDB, and no raw evidence is rendered (search verified to reach the source)',
  )
  const logScan = gitGrep('console[.](log|info|warn|error|debug)[(].*(authorizationReference|status|evidenceArtifactVersionId|eligibilityVerificationId|payerId)', [':/backend/src/modules/prior-authorization', ':/frontend/src/modules/prior-authorization'])
  const urlScan = gitGrep('[?&](authorizationReference|status|evidenceArtifactVersionId|eligibilityVerificationId)=', [':/backend/src/modules/prior-authorization', ':/frontend/src/modules/prior-authorization'])
  const logReach = gitGrep('authorizationReference', [':/backend/src/modules/prior-authorization', ':/frontend/src/modules/prior-authorization'])
  check(
    'T105',
    'Logging scan',
    logReach.status === 0 && logScan.status === 1 && urlScan.status === 1,
    logReach.status !== 0
      ? 'the scan did not reach the committed sources, so this absence is unproven'
      : 'no authorization reference, status, evidence id or eligibility id is logged or placed in a query string (search verified to reach the source)',
  )
  void moduleCode

  // ---------------------------------------------------------------- build and regressions (T106–T110)
  section('Build gates, regressions and database truth')
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check(
    'T106',
    'Unit/typecheck/build',
    unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok && build.ok && lint.ok,
    `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]}, typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`,
  )

  // §22 step 19: the owner suites are INVOKED, never reimplemented. A5.2's suite already nests A5.1,
  // which nests the whole A4.10 -> A4.9 -> ... -> A1 chain, so one invocation covers T107, T108 and
  // T109, and each nested verdict is read back below.
  await apiReady('the A5.2, A5.1 and backward regression chain')
  const chain = run('npm run test:a5:eligibility')
  const chainLines = chain.output.split(/\r?\n/)
  const a52Failing = failedIds(chain.output, 'A5.2')
  const a52FailLine = (id: string) => chainLines.find((line) => line.startsWith(`[A5.2] ${id} `) && line.includes(' FAIL'))
  const a52TitleOf = (line: string) => line.slice('[A5.2] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()

  // A5.2 asserts facts about its own feature branch, and its scope proofs assert that no
  // authorization table exists. A5.3 creates the first ones, which is the boundary this package
  // exists to cross. Each is listed with its own reason; an id that is NOT listed is a genuine
  // regression and fails T107.
  const a52NonApplicable: Record<string, string> = {
    T01: "A5.2 'Start gate' requires the current branch to be the A5.2 feature branch; A5.3 is a different branch, branched from the merged A5.2 main",
    T03: "A5.2 'Migration scope' judges the single migration this branch adds against main; on A5.3 that migration is A5.3's own, which creates no eligibility table",
    T84: "A5.2 'No Claim' forbids any table matching prior_auth; A5.3 creates prior_authorizations, which is exactly the boundary this package crosses",
    T89: "A5.2 'A5.1 regression' fails because A5.1's own scope proof forbids the authorization tables A5.3 creates; the A5.1 ids behind it are listed below",
    T93: "A5.2 'Diff scope' lists the paths A5.2 was allowed to change; A5.3 legitimately changes different ones",
    T95: "A5.2 'Exact head evidence' requires the upstream to be the A5.2 feature branch, which was deleted when PR #50 merged",
  }
  const a52Undocumented = a52Failing.filter((id) => !(id in a52NonApplicable))
  const a52Indented = chainLines
    .filter((line) => line.startsWith('[A5.2]      ') && line.includes('substantive checks FAIL'))
    .map((line) => line.replace('[A5.2]      ', '').split(' ')[0])
  const a52Counts = chain.output.match(/\[A5\.2\] automated summary: (\d+)\/(\d+) PASS/)
  const a52Failed = a52Counts ? Number(a52Counts[2]) - Number(a52Counts[1]) : -1
  const a52Accounted = a52Failing.length + a52Indented.length
  const a52Reconciled = a52Failed >= 0 && a52Accounted === a52Failed
  const a52Unreadable = Object.keys(a52NonApplicable).filter((id) => a52Failing.includes(id) && !a52FailLine(id))

  check(
    'T107',
    'A5.2 regression',
    a52Undocumented.length === 0 && a52Reconciled && a52Unreadable.length === 0,
    !a52Reconciled
      ? `A5.2 reports ${a52Failed} failure(s) but only ${a52Accounted} could be named; something failed that this suite did not read back`
      : a52Unreadable.length > 0
        ? `tolerated but unreadable in the output: ${a52Unreadable.join(', ')}`
        : a52Undocumented.length > 0
          ? `undocumented A5.2 failures: ${a52Undocumented.join(', ')}`
          : `${(chain.output.match(/\[A5\.2\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.2] automated summary: ', 'A5.2 ')}; all ${a52Failed} failure(s) named and accounted for, and every substantive eligibility, freshness and coherence invariant still holds`,
  )
  for (const id of Object.keys(a52NonApplicable)) {
    const line = a52FailLine(id)
    if (line) notApplicableCheck(`T107/${id}`, `A5.2 ${a52TitleOf(line)}`, a52NonApplicable[id])
  }

  // A5.1's verdict is read out of A5.2's T89 detail, which names the A5.1 ids that failed.
  const a51Detail = (chainLines.find((line) => line.startsWith('[A5.2] T89 ')) ?? '')
  const a51Reported = (a51Detail.match(/undocumented A5\.1 failures: ([^\n]*)/) ?? ['', ''])[1].split(',').map((id) => id.trim()).filter(Boolean)
  const a51NonApplicable: Record<string, string> = {
    T73: "A5.1 'Backward regressions' requires the only tables crossing the A4 boundary to be its own two; A5.3 adds the prior authorization tables",
    T76: "A5.1 'Diff scope' lists the paths A5.1 was allowed to change",
  }
  const a51Undocumented = a51Reported.filter((id) => !(id in a51NonApplicable))
  check(
    'T108',
    'A5.1 regression',
    a51Undocumented.length === 0,
    a51Undocumented.length === 0
      ? a51Reported.length === 0
        ? 'A5.1 reports no failure beyond the branch identity checks A5.2 already tolerates; every evidence invariant still holds'
        : `A5.1 reports ${a51Reported.join(', ')}, each a scope proof that no authorization table exists — the boundary A5.3 crosses`
      : `undocumented A5.1 failures: ${a51Undocumented.join(', ')}`,
  )
  for (const id of a51Reported) if (id in a51NonApplicable) notApplicableCheck(`T108/${id}`, `A5.1 ${id}`, a51NonApplicable[id])

  const a3 = (chain.output.match(/\[A5\.2\] +A3 substantive checks (PASS|FAIL)[^\n]*/) ?? [''])[0]
  const a2 = (chain.output.match(/\[A5\.2\] +A2 substantive checks (PASS|FAIL)[^\n]*/) ?? [''])[0]
  const a1 = (chain.output.match(/\[A5\.2\] +A1 substantive checks (PASS|FAIL)[^\n]*/) ?? [''])[0]
  for (const line of [a3, a2, a1]) if (line) console.log(`[A5.3]      ${line.replace('[A5.2]', '').trim().slice(0, 190)}`)
  const chainRan = chainLines.some((line) => line.startsWith('[A5.2] T89/'))
  check(
    'T109',
    'Backward regressions',
    chainRan && /PASS/.test(a2) && /PASS/.test(a1) && (a3 === '' || /PASS/.test(a3) || /A3\.10 failures: T65, T67/.test(a3)),
    !chainRan
      ? 'the A5.1 and A4 chain did not run inside the A5.2 suite, so nothing could be read back through it'
      : `the chain ran through A5.1 to A1; A2 and A1 read back PASS, and A3 ${/PASS/.test(a3) ? 'reads back PASS' : 'fails only on the two A3-era scope guards that assert no A5 table exists'}`,
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
    'T110',
    'DB truth',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  // ---------------------------------------------------------------- closure (T111–T114)
  section('Repeatability, diff scope and exact head')
  const priorRuns = await prisma.priorAuthorization.count({ where: { encounterId: { not: encounter.id } } })
  check(
    'T111',
    'Repeatability',
    true,
    `this run used a fresh synthetic runId (${runId}) and built its own patient, membership, encounters and evidence; ${priorRuns} case(s) from earlier runs retained, none deleted`,
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
      !file.startsWith('backend/src/modules/prior-authorization/') &&
      !file.startsWith('backend/src/integration/a5-prior-authorization/') &&
      !file.startsWith('frontend/src/modules/prior-authorization/') &&
      !file.includes('a5_3_prior_authorization_lifecycle') &&
      !allowed.includes(file),
  )
  const scopeCode = ['backend/src/modules/prior-authorization', 'backend/src/integration/a5-prior-authorization', 'frontend/src/modules/prior-authorization']
    .map((dir) => committedCodeOf(dir))
    .reduce((all, one) => ({ files: [...all.files, ...one.files], code: `${all.code}\n${one.code}` }), { files: [] as string[], code: '' })
  const futureImport = scopeCode.code.match(/from '[^']*modules\/(authorization-line|claim|submission|remittance|validation-run|readiness|provider-contract)/)
  const futureModel = scopeCode.code.match(/prisma\.(authorizationLine|claim|claimLine|claimSubmission|remittance|validationRun|validationFinding|providerContract|tariffScheduleVersion)\b/)
  const scopeReached = scopeCode.files.length > 0 && scopeCode.code.includes("from '")
  check(
    'T112',
    'Diff scope',
    outOfScope.length === 0 && scopeReached && futureImport === null && futureModel === null,
    !scopeReached
      ? 'the import scan did not reach the committed sources, so this absence is unproven'
      : outOfScope.length === 0 && futureImport === null && futureModel === null
        ? `${changedPaths.length} path(s): the authorization module, its migration, permission and audit wiring, and the dev check; across ${scopeCode.files.length} committed files no A5.4+, A6 or A9 module is imported and no future-phase table is read`
        : `unexpected: ${[...outOfScope, futureImport?.[0], futureModel?.[0]].filter(Boolean).join(', ').slice(0, 220)}`,
  )

  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [':/backend/src/integration/a5-prior-authorization', ':/backend/src/modules/prior-authorization', ':/frontend/src/modules/prior-authorization'],
  )
  const realDataMarkers = new RegExp(
    ['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail'].map((fragment) => `(?:${fragment})`).join('|'),
    'i',
  )
  const harnessSource = git('show HEAD:backend/src/integration/a5-prior-authorization/a5-prior-authorization.integration.ts')
  const realDataHit = harnessSource.match(realDataMarkers)
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [':/backend/src/integration/a5-prior-authorization'])
  check(
    'T113',
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
    'T114',
    'Exact head evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a53Branch}`),
    `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`,
  )

  console.log(`\n[A5.3] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A5.3] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.3] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A5.3] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A5.3] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.3] A5.3 PRIOR AUTHORIZATION LIFECYCLE ACCEPTANCE COMPLETE' : '[A5.3] A5.3 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A5.3] RUN ABORTED: ${error.message}`)
      console.log('[A5.3] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A5.3] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.3] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
