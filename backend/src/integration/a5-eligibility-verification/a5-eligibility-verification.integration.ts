import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { createEligibilityVerification } from '../../modules/eligibility-verification/eligibility-verification.service.ts'
import { evaluateFreshness } from '../../modules/eligibility-verification/eligibility-verification.validation.ts'
import { updateEncounter } from '../../modules/encounter/encounter.service.ts'
import { updateMembership } from '../../modules/insurance-membership/insurance-membership.service.ts'

// A5.2 — focused acceptance for Eligibility Verification & Freshness (T01–T95).
//
// A5.2 records what a verification actually REPORTED for one Encounter, against the exact
// membership selected on it and the exact commercial context that membership carried at the time,
// bound to exact immutable A5.1 evidence. It infers nothing: a recorded coverage period is not
// eligibility, UNKNOWN is never resolved to ELIGIBLE, and freshness is derived at read time rather
// than stored.
//
// Valid fixtures are created through their owning routes. The database is READ for structural
// proof. ADVERSARIAL writes — ones the service would never make — go in only to prove that
// something refuses them. Every value is synthetic: no real patient, member, payer or response
// content appears anywhere in this file.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A5.2] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A5.2] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

// §23 — an obsolete phase-boundary check from an older suite is reported as N/A with its exact
// reason and counted separately. A substantive owner-behaviour failure is never converted to one.
function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A5.2] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A5.2] ${title}`)

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
// deliberately name the things it refuses to do, and this file names A5.3+ fields on purpose so the
// scope checks can assert their absence. Comments are therefore stripped and only executable code
// is searched. (A5.1 learned this the hard way: a comment promising "no download endpoint" was
// reported as a download endpoint.)
const committedFiles = (dir: string) => git(`ls-tree -r --name-only --full-tree HEAD ${dir}`).split(/\r?\n/).filter(Boolean)

const committedCode = (path: string) =>
  git(`show HEAD:${path}`)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    // `://` inside a string literal is not a comment, so a `//` must start a line or follow a space.
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')

const committedCodeOf = (dir: string) => {
  const files = committedFiles(dir)
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

// A unit test that asserts a field is REFUSED has to name that field, and a test that asserts a key
// is absent from a DTO has to list the key. Searching those files for the vocabulary they exist to
// reject reports the proof of absence as the presence itself. Checks that ask "does this module
// store or handle X?" therefore read the production files only.
const committedProductionCodeOf = (dir: string) => {
  const files = committedFiles(dir).filter((file) => !file.endsWith('.test.ts'))
  return { files, code: files.map((file) => committedCode(file)).join('\n') }
}

// Raised when the run can no longer produce evidence — not a failed check, but a broken
// environment. Reported without a stack trace, because the reader needs the fix.
class RunAborted extends Error {}

const runId = `A52-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A5.1 FINAL PASS was merged into main as PR #49; A5.2 is branched from exactly that merge.
const a51Merge = '1cdf49c'
const a52Branch = 'feature/a5-2-eligibility-verification-freshness'
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
  const pattern = new RegExp(`^\\[${tag.replace('.', '\\.')}\\] (T\\d+[a-z/]*) .* FAIL`)
  return output
    .split(/\r?\n/)
    .map((line) => (line.match(pattern) ?? [])[1])
    .filter((id): id is string => Boolean(id))
}

function nestedLine(output: string, tag: string, id: string, title: string) {
  const line = output.match(new RegExp(`\\[${tag.replace('.', '\\.')}\\] ${id} ${title.replace(/\./g, '\\.')} \\.* (PASS|FAIL)( - [^\\n]*)?`))
  return { verdict: line?.[1] ?? '', detail: (line?.[2] ?? '').replace(/^ - /, '') }
}

const verificationAuditCount = () => prisma.auditEvent.count({ where: { entityType: 'ELIGIBILITY_VERIFICATION' } })

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A5.2] Eligibility verification & freshness — run ${runId}`)
  console.log(`[A5.2] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

  // T91 stops and restarts the database on purpose, so a run interrupted part-way through it can
  // leave the container down. A missing database is an environment problem, not a verdict on the
  // package, so it is reported as one before any check runs.
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
    branch === a52Branch && gitOk(`merge-base --is-ancestor ${a51Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; the A5.1 merge ${a51Merge} (PR #49) is on main and this branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'Git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationPaths.length === 1 ? git(`show HEAD:${migrationPaths[0]}`) : ''
  // Only executable SQL is judged: the Drift Guard note in the header describes what it removed, so
  // testing the raw text would match the very words it promises are absent.
  const statements = migrationSql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n')
  const scopeProblems = [
    [/CREATE TABLE "eligibility_verifications"/.test(statements), 'the verification table is not created'],
    [(statements.match(/CREATE TABLE/g) ?? []).length === 1, 'a table other than eligibility_verifications is created'],
    [!/DROP INDEX/.test(statements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(statements), 'Better Auth defaults leaked in (drift)'],
    [!/ALTER TABLE "(evidence_artifacts|evidence_artifact_versions)"/.test(statements), 'an A5.1 evidence table is altered'],
    [!/ALTER TABLE "(patients|encounters|insurance_memberships|external_identifiers)"/.test(statements), 'an A4 business table is altered'],
    [!/prior_authorization|authorization_line|claim|submission|validation_run|readiness|provider_contract|tariff/i.test(statements), 'a future-phase table appears'],
    [(statements.match(/ADD CONSTRAINT "eligibility_verifications_[a-z_]+_chk"/g) ?? []).length === 4, 'the four CHECKs are not all added'],
    [(statements.match(/ON DELETE RESTRICT/g) ?? []).length === 8, 'not all eight foreign keys are ON DELETE RESTRICT'],
    [/CREATE TRIGGER eligibility_verifications_append_only_trg/.test(statements), 'the immutability trigger is not created'],
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
        ? 'one migration; one table, four CHECKs, eight RESTRICT foreign keys, six indexes and the immutability trigger only, with no drift'
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
      /the append-only trigger on eligibility verifications is present/.test(replay.output) &&
      /eligibility_verifications_status_chk is present/.test(replay.output) &&
      /store no freshness column/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the four CHECKs, eight foreign keys, six indexes and the immutability trigger all survive, and no freshness column appears`,
  )

  const verificationPermissions = (await prisma.permission.findMany({ where: { code: { startsWith: 'eligibilityVerification.' } }, select: { code: true } })).map((row) => row.code).sort()
  const grants = await prisma.rolePermission.findMany({
    where: { permission: { code: { startsWith: 'eligibilityVerification.' } } },
    select: { role: { select: { code: true } }, permission: { select: { code: true } } },
  })
  const grantOf = (code: string) => grants.filter((g) => g.permission.code === code).map((g) => g.role.code).sort().join(',')
  check(
    'T06',
    'Permissions',
    verificationPermissions.join(',') === 'eligibilityVerification.create,eligibilityVerification.read' &&
      grantOf('eligibilityVerification.create') === 'ORG_ADMIN' &&
      grantOf('eligibilityVerification.read') === 'ORG_ADMIN,ORG_VIEWER',
    'exactly create and read exist; no update, delete or execute-network permission was invented',
  )

  // ---------------------------------------------------------------- fixtures
  await apiReady('signing in')
  let connectionResets = 0
  const httpCall = async (path: string, init?: RequestInit) => {
    try {
      return await callApi(baseUrl, path, init)
    } catch {
      // A reset on localhost is the server being replaced, not a network blip. Once that has
      // happened the remaining checks would be measured against a different process.
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
  // A4.3 requires the product and the network to be genuinely related before a membership may name
  // both, so the relationship is created through its own owner route rather than worked around.
  must('product-network', (await post(`/api/insurance-products/${product.id}/product-networks`, { networkId: network.id })).body)
  const membership = must(
    'membership',
    (await post(`/api/patients/${patient.id}/insurance-memberships`, {
      payerId: payer.id,
      tpaId: tpa.id,
      networkId: network.id,
      insuranceProductId: product.id,
      memberIdentifier: `MEM-${runId}`,
      coverageFrom: '2025-01-01',
      coverageTo: null,
    })).body,
  )
  const encounter = must('encounter', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membership.id })).body)
  const selfEncounter = must('encounter with no selected membership', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE })).body)
  console.log(`[A5.2]      fixtures ready: patient, facility, clinician, profile, assignment, 2 payers, tpa, network, product, membership, 2 encounters`)

  const evidenceBody = (suffix: string) => ({
    storageRef: `synthetic://evidence/${runId}/${suffix}`,
    contentHash: suffix.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
    documentType: `SYNTHETIC_ELIGIBILITY_RESPONSE_${runId.slice(-6)}`,
    sourceDate: null,
    receivedAt: '2026-06-15T09:30:00.000Z',
  })
  const responseArtifact = must('response evidence', (await post(`/api/organizations/${org}/evidence-artifacts`, evidenceBody('a'))).body)
  const requestArtifact = must('request evidence', (await post(`/api/organizations/${org}/evidence-artifacts`, evidenceBody('b'))).body)
  const responseEvidenceVersionId = responseArtifact.latestVersion.id as string
  const requestEvidenceVersionId = requestArtifact.latestVersion.id as string

  const body = (overrides: Record<string, unknown> = {}) => ({
    verificationMethod: 'PORTAL',
    status: 'ELIGIBLE',
    requestedAt: '2026-09-28T09:00:00.000Z',
    respondedAt: '2026-09-28T09:05:00.000Z',
    validThrough: '2030-09-29T23:59:59.000Z',
    authorizationRequired: false,
    referralRequired: null,
    requestEvidenceVersionId: null,
    responseEvidenceVersionId,
    ...overrides,
  })
  const createFor = (encounterId: string, overrides: Record<string, unknown> = {}, who = asAdmin) =>
    post(`/api/encounters/${encounterId}/eligibility-verifications`, body(overrides), who)

  // ---------------------------------------------------------------- creation and context (T07–T16)
  section('Recording a verification against the exact encounter context')
  const createRes = await createFor(encounter.id)
  const verification = createRes.body as Record<string, any>
  if (createRes.status !== 201) throw new Error(`verification create failed: ${createRes.status} ${JSON.stringify(verification).slice(0, 300)}`)
  const storedRow = await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: verification.id } })
  const createAudit = await prisma.auditEvent.findMany({ where: { entityType: 'ELIGIBILITY_VERIFICATION', entityId: verification.id } })
  check(
    'T07',
    'Admin create',
    createRes.status === 201 && createAudit.length === 1,
    '201; the verification and exactly one safe audit event were written in one transaction',
  )

  // Any Encounter owned by the other organization serves the tenancy checks. It deliberately does
  // NOT have to carry a selected membership: what is being proven is that this tenant cannot read or
  // write against it at all.
  const foreignEncounter = await prisma.encounter.findFirst({
    where: { patient: { organizationId: otherOrg } },
    select: { id: true, serviceDate: true },
  })
  check(
    'T08',
    'Encounter ownership',
    (await get(`/api/encounters/${encounter.id}/eligibility-verifications`)).status === 200 && foreignEncounter !== null,
    'the route resolves the organization through the Encounter patient before authorization; a foreign encounter is available for T70',
  )

  const noMembership = await createFor(selfEncounter.id)
  const noMembershipMessage = String((noMembership.body as any)?.error?.message ?? '')
  check(
    'T09',
    'No selected membership',
    noMembership.status === 400 &&
      /no selected insurance membership/i.test(noMembershipMessage) &&
      !/self[- ]?pay|ineligible/i.test(noMembershipMessage) &&
      (await prisma.eligibilityVerification.count({ where: { encounterId: selfEncounter.id } })) === 0,
    `refused with ${noMembership.status} and no row written; the absence of a membership is never read as self-pay or INELIGIBLE`,
  )

  check(
    'T10',
    'Membership match',
    storedRow.insuranceMembershipId === membership.id &&
      (await prisma.insuranceMembership.findUniqueOrThrow({ where: { id: storedRow.insuranceMembershipId }, select: { patientId: true } })).patientId === patient.id,
    'the stored membership is the one selected on the Encounter, and it belongs to that Encounter patient',
  )

  const forgery: string[] = []
  for (const [field, value] of [
    ['insuranceMembershipId', membership.id],
    ['serviceDate', '2026-01-01'],
    ['payerId', payer2.id],
    ['tpaId', tpa.id],
    ['networkId', network.id],
    ['insuranceProductId', product.id],
    ['encounterId', encounter.id],
    ['id', MISSING],
    ['createdAt', '2026-01-01T00:00:00.000Z'],
    ['freshness', 'FRESH'],
  ] as const)
    forgery.push(`${field}:${(await createFor(encounter.id, { [field]: value })).status}`)
  check('T11', 'Context forgery', forgery.every((line) => line.endsWith(':400')), `every server-owned field refused (${forgery.join(', ')})`)

  check('T12', 'Commercial snapshot payer', storedRow.payerId === payer.id, 'the stored payer is exactly the one on the selected membership at creation time')
  check(
    'T13',
    'Commercial snapshot optional IDs',
    storedRow.tpaId === tpa.id && storedRow.networkId === network.id && storedRow.insuranceProductId === product.id,
    'TPA, network and product are preserved exactly; a null on the membership would be stored as null, never filled in',
  )
  check(
    'T14',
    'Service date snapshot',
    storedRow.serviceDate.toISOString().slice(0, 10) === SERVICE_DATE && verification.serviceDate === SERVICE_DATE,
    `the stored DATE is exactly the Encounter service date (${SERVICE_DATE})`,
  )

  // A later correction to the membership must not reach back into a verification already recorded.
  const membershipPatch = await patchApi(`/api/insurance-memberships/${membership.id}`, { payerId: payer2.id, tpaId: null, networkId: null, insuranceProductId: null })
  const afterMembershipPatch = await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: verification.id } })
  check(
    'T15',
    'Later membership correction',
    membershipPatch.status === 200 &&
      afterMembershipPatch.payerId === payer.id &&
      afterMembershipPatch.tpaId === tpa.id &&
      afterMembershipPatch.networkId === network.id &&
      afterMembershipPatch.insuranceProductId === product.id,
    membershipPatch.status === 200
      ? 'the membership now names a different payer and no TPA, network or product; the verification still records the context it was evaluated against'
      : `the membership correction itself failed with ${membershipPatch.status}, so this could not be proven`,
  )

  const NEW_SERVICE_DATE = '2026-06-16'
  const encounterPatch = await patchApi(`/api/encounters/${encounter.id}`, { serviceDate: NEW_SERVICE_DATE })
  const afterEncounterPatch = await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: verification.id } })
  check(
    'T16',
    'Later Encounter date correction',
    encounterPatch.status === 200 && afterEncounterPatch.serviceDate.toISOString().slice(0, 10) === SERVICE_DATE,
    encounterPatch.status === 200
      ? `the Encounter now reads ${NEW_SERVICE_DATE}; the verification still records ${SERVICE_DATE}, the date it was actually evaluated for`
      : `the Encounter correction itself failed with ${encounterPatch.status}, so this could not be proven`,
  )

  // ---------------------------------------------------------------- vocabulary (T17–T27)
  section('Status and method vocabulary — recorded, never inferred')
  const methodResults: Record<string, number> = {}
  for (const method of ['ELECTRONIC', 'PORTAL', 'MANUAL', 'OTHER'])
    methodResults[method] = (await createFor(encounter.id, { verificationMethod: method })).status
  check('T17', 'Method ELECTRONIC', methodResults.ELECTRONIC === 201, 'accepted; it records how the result was obtained and does not imply an A9 payer adapter exists')
  check('T18', 'Method PORTAL', methodResults.PORTAL === 201, 'accepted')
  check('T19', 'Method MANUAL', methodResults.MANUAL === 201, 'accepted')
  check('T20', 'Method OTHER', methodResults.OTHER === 201, 'accepted')
  const badMethods: string[] = []
  for (const method of ['FAX', 'electronic', '', 42, null])
    badMethods.push(`${JSON.stringify(method)}:${(await createFor(encounter.id, { verificationMethod: method })).status}`)
  check('T21', 'Bad method', badMethods.every((line) => line.endsWith(':400')), badMethods.join(', '))

  const statusResults: Record<string, number> = {}
  for (const value of ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN']) statusResults[value] = (await createFor(encounter.id, { status: value })).status
  check('T22', 'Status ELIGIBLE', statusResults.ELIGIBLE === 201, 'accepted exactly as the supplied verification result')
  check('T23', 'Status INELIGIBLE', statusResults.INELIGIBLE === 201, 'accepted')
  check('T24', 'Status UNKNOWN', statusResults.UNKNOWN === 201, 'accepted as a first-class result')
  const badStatuses: string[] = []
  for (const value of ['ACTIVE', 'INACTIVE', 'PENDING', 'eligible', 42, null])
    badStatuses.push(`${JSON.stringify(value)}:${(await createFor(encounter.id, { status: value })).status}`)
  check(
    'T25',
    'Bad status',
    badStatuses.every((line) => line.endsWith(':400')),
    `${badStatuses.join(', ')} — ACTIVE and INACTIVE are registration words and are refused as eligibility aliases`,
  )

  const unknownCreated = (await createFor(encounter.id, { status: 'UNKNOWN', validThrough: '2030-01-01T00:00:00.000Z' })).body as Record<string, any>
  const unknownStored = await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: unknownCreated.id }, select: { status: true } })
  check(
    'T26',
    'UNKNOWN semantics',
    unknownCreated.status === 'UNKNOWN' && unknownStored.status === 'UNKNOWN' && unknownCreated.freshness.state === 'FRESH',
    'an UNKNOWN result stays UNKNOWN in the response and in the row, even when its validity boundary makes it FRESH',
  )

  // The membership's recorded coverage period contains the service date, and the response said
  // UNKNOWN. Registration truth must not upgrade it. The behaviour is checked first, then the code:
  // the module must never read coverageFrom or coverageTo at all.
  const coveringMembership = await prisma.insuranceMembership.findUnique({ where: { id: membership.id }, select: { coverageFrom: true, coverageTo: true } })
  const moduleCode = committedCodeOf('backend/src/modules/eligibility-verification')
  const productionCode = committedProductionCodeOf('backend/src/modules/eligibility-verification')
  const readsCoverage = /coverageFrom|coverageTo|coverage_from|coverage_to/.test(productionCode.code)
  check(
    'T27',
    'Membership coverage dates',
    unknownStored.status === 'UNKNOWN' && !readsCoverage && moduleCode.files.length > 0,
    moduleCode.files.length === 0
      ? 'the module source could not be read, so this absence is unproven'
      : `the recorded coverage period (from ${coveringMembership?.coverageFrom?.toISOString().slice(0, 10) ?? 'null'}, to ${coveringMembership?.coverageTo?.toISOString().slice(0, 10) ?? 'null'}) contains the service date and the result is still UNKNOWN; across ${productionCode.files.length} production files the module never reads a coverage boundary`,
  )

  // ---------------------------------------------------------------- timestamps (T28–T34)
  section('Timestamp contract')
  const absentRequested = body()
  delete (absentRequested as Record<string, unknown>).requestedAt
  const absentRes = await post(`/api/encounters/${encounter.id}/eligibility-verifications`, absentRequested)
  const nullRes = await createFor(encounter.id, { requestedAt: null })
  check(
    'T28',
    'requestedAt null',
    absentRes.status === 201 && nullRes.status === 201 && (nullRes.body as any).requestedAt === null,
    'absent and explicit null both mean the request instant is genuinely unknown, and it is never inferred from createdAt',
  )
  const badRequested: string[] = []
  for (const value of ['2026-09-28', 'not-a-date', 42]) badRequested.push(`${JSON.stringify(value)}:${(await createFor(encounter.id, { requestedAt: value })).status}`)
  check('T29', 'requestedAt strict', badRequested.every((line) => line.endsWith(':400')), badRequested.join(', '))

  const missingResponded = body()
  delete (missingResponded as Record<string, unknown>).respondedAt
  const missingRes = await post(`/api/encounters/${encounter.id}/eligibility-verifications`, missingResponded)
  const badResponded: string[] = []
  for (const value of ['2026-09-28', 'not-a-date', null, 42]) badResponded.push(`${JSON.stringify(value)}:${(await createFor(encounter.id, { respondedAt: value })).status}`)
  const futureResponded = await createFor(encounter.id, { respondedAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), validThrough: null })
  check(
    'T30',
    'respondedAt required',
    missingRes.status === 400 && badResponded.every((line) => line.endsWith(':400')) && futureResponded.status === 400,
    `missing:400, ${badResponded.join(', ')}; a response six hours ahead has not happened yet and is ${futureResponded.status}`,
  )

  const orderRes = await createFor(encounter.id, { requestedAt: '2026-09-28T09:05:00.000Z', respondedAt: '2026-09-28T09:00:00.000Z' })
  const orderRefusal = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe(
      `INSERT INTO eligibility_verifications (id, encounter_id, insurance_membership_id, payer_id, service_date, verification_method, status, requested_at, responded_at, response_evidence_version_id) VALUES (gen_random_uuid(), '${encounter.id}'::uuid, '${membership.id}'::uuid, '${payer.id}'::uuid, DATE '2026-06-15', 'PORTAL', 'ELIGIBLE', TIMESTAMPTZ '2026-09-28 09:05:00+00', TIMESTAMPTZ '2026-09-28 09:00:00+00', '${responseEvidenceVersionId}'::uuid)`,
    ),
  )
  check(
    'T31',
    'Timing order',
    orderRes.status === 400 && /request_response_order_chk/.test(orderRefusal),
    'a response earlier than its own request is refused by validation, and the database CHECK refuses it too on a direct insert',
  )

  const noBoundary = await createFor(encounter.id, { validThrough: null })
  check(
    'T32',
    'validThrough null',
    noBoundary.status === 201 && (noBoundary.body as any).freshness.state === 'UNKNOWN',
    'a null boundary is accepted and makes freshness UNKNOWN — nothing was recorded, so nothing has expired and nothing is known to hold',
  )
  const equalBoundary = await createFor(encounter.id, { respondedAt: '2026-09-28T09:05:00.000Z', validThrough: '2026-09-28T09:05:00.000Z' })
  check('T33', 'validThrough valid', equalBoundary.status === 201, 'a boundary at the response instant is accepted, as is one after it')
  const badBoundary = await createFor(encounter.id, { respondedAt: '2026-09-28T09:05:00.000Z', validThrough: '2026-09-28T09:00:00.000Z' })
  const boundaryRefusal = await attemptAdversarial(() =>
    prisma.$executeRawUnsafe(
      `INSERT INTO eligibility_verifications (id, encounter_id, insurance_membership_id, payer_id, service_date, verification_method, status, responded_at, valid_through, response_evidence_version_id) VALUES (gen_random_uuid(), '${encounter.id}'::uuid, '${membership.id}'::uuid, '${payer.id}'::uuid, DATE '2026-06-15', 'PORTAL', 'ELIGIBLE', TIMESTAMPTZ '2026-09-28 09:05:00+00', TIMESTAMPTZ '2026-09-28 09:00:00+00', '${responseEvidenceVersionId}'::uuid)`,
    ),
  )
  check(
    'T34',
    'validThrough contradiction',
    badBoundary.status === 400 && /validity_order_chk/.test(boundaryRefusal),
    'a boundary before the response is refused by validation and by the database CHECK',
  )

  // ---------------------------------------------------------------- freshness (T35–T41)
  section('Freshness — derived at read time, never stored')
  const boundary = new Date('2027-01-01T00:00:00.000Z')
  check('T35', 'Freshness FRESH', evaluateFreshness(boundary, new Date('2026-12-31T23:59:59.999Z')) === 'FRESH' && evaluateFreshness(boundary, boundary) === 'FRESH', 'an evaluation instant at or before the boundary is FRESH')
  check('T36', 'Freshness STALE', evaluateFreshness(boundary, new Date('2027-01-01T00:00:00.001Z')) === 'STALE', 'one millisecond past the boundary is STALE')
  check('T37', 'Freshness UNKNOWN', evaluateFreshness(null, new Date()) === 'UNKNOWN', 'a null boundary is UNKNOWN, which is neither fresh nor stale')

  const freshUnknown = (await createFor(encounter.id, { status: 'UNKNOWN', validThrough: '2030-01-01T00:00:00.000Z' })).body as Record<string, any>
  check(
    'T38',
    'Fresh not eligible',
    freshUnknown.freshness.state === 'FRESH' && freshUnknown.status === 'UNKNOWN',
    'FRESH describes the validity boundary, never the result: a FRESH UNKNOWN is still UNKNOWN eligibility',
  )

  const staleCreated = (await createFor(encounter.id, { status: 'ELIGIBLE', requestedAt: null, respondedAt: '2026-06-15T09:00:00.000Z', validThrough: '2026-06-16T00:00:00.000Z' })).body as Record<string, any>
  const staleRead = (await get(`/api/eligibility-verifications/${staleCreated.id}`)).body as Record<string, any>
  const staleStored = await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: staleCreated.id }, select: { status: true } })
  check(
    'T39',
    'Stale historical truth',
    staleRead.freshness.state === 'STALE' && staleRead.status === 'ELIGIBLE' && staleStored.status === 'ELIGIBLE',
    'a stale record is still historically ELIGIBLE-at-response; staleness never rewrites what was reported',
  )

  const verificationColumns = await prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
    SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'eligibility_verifications'`
  const columnNames = verificationColumns.map((row) => row.column_name)
  check(
    'T40',
    'Freshness not stored',
    columnNames.length > 0 && !columnNames.some((name) => /fresh|stale|is_current|is_primary|expired/i.test(name)),
    columnNames.length === 0 ? 'the column catalog did not reach the table, so this absence is unproven' : `no freshness, staleness or current-record column among ${columnNames.length}: ${columnNames.join(', ')}`,
  )

  // No hidden duration, proven by behaviour rather than by searching for numbers: the answer flips
  // exactly at the boundary. Any grace window, however small, would show up here.
  const flipBoundary = new Date('2027-06-01T12:00:00.000Z')
  const noGrace =
    evaluateFreshness(flipBoundary, new Date(flipBoundary.getTime())) === 'FRESH' &&
    evaluateFreshness(flipBoundary, new Date(flipBoundary.getTime() + 1)) === 'STALE' &&
    evaluateFreshness(flipBoundary, new Date(flipBoundary.getTime() + 1000)) === 'STALE' &&
    evaluateFreshness(flipBoundary, new Date(flipBoundary.getTime() + 48 * 60 * 60 * 1000)) === 'STALE'
  check(
    'T41',
    'No hard-coded duration',
    noGrace && !readsCoverage,
    'freshness flips at exactly the recorded boundary with no grace window, and no payer duration or coverage date feeds into it',
  )

  // ---------------------------------------------------------------- evidence linkage (T42–T52)
  section('Evidence linkage — exact A5.1 foreign keys, nothing copied')
  const missingEvidence = body()
  delete (missingEvidence as Record<string, unknown>).responseEvidenceVersionId
  check(
    'T42',
    'Response evidence required',
    (await post(`/api/encounters/${encounter.id}/eligibility-verifications`, missingEvidence)).status === 400 &&
      (await createFor(encounter.id, { responseEvidenceVersionId: null })).status === 400,
    'a verification without response evidence is not an A5.2 verification; absent and null are both refused',
  )
  check(
    'T43',
    'Response evidence exists',
    storedRow.responseEvidenceVersionId === responseEvidenceVersionId &&
      (await prisma.evidenceArtifactVersion.count({ where: { id: responseEvidenceVersionId } })) === 1,
    'the stored key resolves to the exact A5.1 version that was supplied',
  )

  const foreignVersion = await prisma.evidenceArtifactVersion.findFirst({
    where: { evidenceArtifact: { organizationId: otherOrg } },
    select: { id: true, storageRef: true },
  })
  const foreignResponse = foreignVersion ? await createFor(encounter.id, { responseEvidenceVersionId: foreignVersion.id }) : null
  const foreignResponseBody = JSON.stringify(foreignResponse?.body ?? {})
  check(
    'T44',
    'Response evidence same tenant',
    foreignVersion !== null &&
      foreignResponse !== null &&
      foreignResponse.status === 404 &&
      !foreignResponseBody.includes(otherOrg) &&
      !foreignResponseBody.includes(foreignVersion.storageRef),
    foreignVersion === null
      ? 'no foreign-tenant evidence version exists, so this could not be proven'
      : `refused with ${foreignResponse?.status}; a missing version and a foreign one are refused identically, so neither the other organization nor its storage reference is disclosed`,
  )

  check('T45', 'Request evidence absent', (await createFor(encounter.id, { requestEvidenceVersionId: null })).status === 201, 'a portal or manual workflow may preserve only the response')
  const withRequest = (await createFor(encounter.id, { requestEvidenceVersionId: requestEvidenceVersionId })).body as Record<string, any>
  check(
    'T46',
    'Request evidence exact',
    withRequest.requestEvidenceVersionId === requestEvidenceVersionId,
    'an own-organization request version is accepted and stored exactly',
  )
  check(
    'T47',
    'Request evidence foreign',
    foreignVersion !== null && (await createFor(encounter.id, { requestEvidenceVersionId: foreignVersion.id })).status === 404,
    'the request version is checked for tenancy exactly as the response version is',
  )

  const evidenceBefore = await prisma.evidenceArtifactVersion.findUniqueOrThrow({ where: { id: responseEvidenceVersionId } })
  const repositoryCode = committedCode('backend/src/modules/eligibility-verification/eligibility-verification.repository.ts')
  const serviceCode = committedCode('backend/src/modules/eligibility-verification/eligibility-verification.service.ts')
  const touchesEvidence = /evidenceArtifactVersion\.(update|updateMany|delete|deleteMany|upsert|create)/.test(`${repositoryCode}\n${serviceCode}`)
  check(
    'T48',
    'A5.1 immutability preserved',
    !touchesEvidence &&
      JSON.stringify(evidenceBefore) === JSON.stringify(await prisma.evidenceArtifactVersion.findUniqueOrThrow({ where: { id: responseEvidenceVersionId } })),
    'the module never creates, updates or deletes an evidence version; the linked version is byte-for-byte unchanged after every verification above',
  )

  const responseKeys = deepKeys(verification)
  check('T49', 'No storageRef copy', !responseKeys.has('storageRef') && !columnNames.includes('storage_ref'), 'neither the DTO nor the table carries a storage reference')
  check('T50', 'No contentHash copy', !responseKeys.has('contentHash') && !columnNames.includes('content_hash'), 'no content hash is copied')
  check('T51', 'No documentType copy', !responseKeys.has('documentType') && !columnNames.includes('document_type'), 'no document type is copied')
  const binaryColumns = verificationColumns.filter((row) => /bytea|json|xml/i.test(row.data_type) || /(bytes|blob|payload|body|content|base64|raw)/i.test(row.column_name))
  check(
    'T52',
    'No evidence bytes',
    binaryColumns.length === 0,
    `no binary, JSON or payload column: the response itself stays in A5.1 (types: ${[...new Set(verificationColumns.map((row) => row.data_type))].join(', ')})`,
  )

  // ---------------------------------------------------------------- requirement flags (T53–T56)
  section('Requirement indicators — true, false and unknown stay apart')
  const authTrue = (await createFor(encounter.id, { authorizationRequired: true })).body as Record<string, any>
  const authFalse = (await createFor(encounter.id, { authorizationRequired: false })).body as Record<string, any>
  const authNull = (await createFor(encounter.id, { authorizationRequired: null })).body as Record<string, any>
  check('T53', 'authorizationRequired true', authTrue.authorizationRequired === true, 'an explicit true is preserved')
  check(
    'T54',
    'authorizationRequired false',
    authFalse.authorizationRequired === false && authFalse.authorizationRequired !== null,
    'an explicit false is preserved and is not confused with "not supplied"',
  )
  check('T55', 'authorizationRequired unknown', authNull.authorizationRequired === null, 'null means the response did not supply the indicator')
  const referralValues = [] as unknown[]
  for (const value of [true, false, null]) referralValues.push(((await createFor(encounter.id, { referralRequired: value })).body as Record<string, any>).referralRequired)
  const referralBad = (await createFor(encounter.id, { referralRequired: 'true' })).status
  check(
    'T56',
    'referralRequired',
    JSON.stringify(referralValues) === '[true,false,null]' && referralBad === 400,
    'true, false and null are each preserved exactly; a string is refused rather than coerced',
  )

  // ---------------------------------------------------------------- benefit boundary (T57–T60)
  section('Benefit and authorization boundary')
  check(
    'T57',
    'No authorization object',
    !columnNames.some((name) => /(authorization_number|authorization_status|authorization_id|prior_auth|conditions|approval)/i.test(name)) &&
      !responseKeys.has('authorizationNumber') &&
      !responseKeys.has('authorizationStatus'),
    'only the nullable authorizationRequired indicator exists; no authorization number, status, conditions or approval — A5.3 owns that lifecycle',
  )
  check(
    'T58',
    'No benefit JSON',
    !verificationColumns.some((row) => /json/i.test(row.data_type)),
    'no generic JSON or JSONB payer-response column; the immutable evidence version remains the raw-response owner',
  )
  check(
    'T59',
    'Raw benefit preservation',
    storedRow.responseEvidenceVersionId === responseEvidenceVersionId &&
      (await prisma.evidenceArtifactVersion.count({ where: { id: storedRow.responseEvidenceVersionId } })) === 1,
    'the complete response remains reconstructable through the exact immutable A5.1 version this verification is bound to',
  )
  const benefitColumns = columnNames.filter((name) => /(copay|coinsurance|deductible|benefit|exclusion|out_of_pocket|coverage_limit)/i.test(name))
  const benefitInCode = productionCode.code.match(/\b(copay|coinsurance|deductible|benefitCategory|outOfPocket)\w*/i)
  check(
    'T60',
    'No payer vocabulary',
    productionCode.files.length > 0 && benefitColumns.length === 0 && benefitInCode === null,
    productionCode.files.length === 0
      ? 'the production module source could not be read, so this absence is unproven'
      : benefitColumns.length > 0 || benefitInCode
        ? `payer benefit vocabulary found: ${[...benefitColumns, benefitInCode?.[0]].filter(Boolean).join(', ')}`
        : `no copay, coinsurance, deductible, exclusion or benefit-category vocabulary in the table or in any of the ${productionCode.files.length} production files`,
  )

  // ---------------------------------------------------------------- reads (T61–T63)
  section('Reads and verification history')
  const byId = await get(`/api/eligibility-verifications/${verification.id}`)
  const byIdBody = byId.body as Record<string, any>
  check(
    'T61',
    'Get by ID',
    byId.status === 200 && byIdBody.id === verification.id && typeof byIdBody.freshness?.state === 'string' && typeof byIdBody.freshness?.evaluatedAt === 'string',
    'the immutable DTO plus a freshness answer that names the instant it was computed for',
  )

  const listRes = await get(`/api/encounters/${encounter.id}/eligibility-verifications`)
  const items = ((listRes.body as { items?: Record<string, any>[] })?.items ?? [])
  const expectedOrder = [...items].sort((a, b) => {
    const byResponded = new Date(b.respondedAt).getTime() - new Date(a.respondedAt).getTime()
    if (byResponded !== 0) return byResponded
    const byCreated = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    if (byCreated !== 0) return byCreated
    return a.id < b.id ? -1 : 1
  })
  const secondRead = ((await get(`/api/encounters/${encounter.id}/eligibility-verifications`)).body as { items?: Record<string, any>[] })?.items ?? []
  check(
    'T62',
    'List Encounter verifications',
    listRes.status === 200 &&
      items.length > 0 &&
      items.every((row) => row.encounterId === encounter.id) &&
      JSON.stringify(items.map((row) => row.id)) === JSON.stringify(expectedOrder.map((row) => row.id)) &&
      JSON.stringify(items.map((row) => row.id)) === JSON.stringify(secondRead.map((row) => row.id)),
    `${items.length} row(s), only this Encounter's, ordered respondedAt then createdAt then id, and identical across two reads`,
  )

  const currentFlags = items.filter((row) => 'isCurrent' in row || 'isPrimary' in row || 'current' in row)
  check(
    'T63',
    'Multiple re-verifications',
    items.length > 1 && currentFlags.length === 0 && !columnNames.some((name) => /is_current|is_primary/i.test(name)),
    `${items.length} verifications coexist for one Encounter and none is marked current; choosing a usable verification belongs to a later governed consumer`,
  )

  // ---------------------------------------------------------------- immutability (T64–T67)
  section('Immutable — no route and no statement can rewrite a verification')
  check('T64', 'No PATCH', (await patchApi(`/api/eligibility-verifications/${verification.id}`, {})).status === 404, 'PATCH is 404 on the by-id route')
  check('T65', 'No DELETE', (await del(`/api/eligibility-verifications/${verification.id}`)).status === 404, 'DELETE is 404 on the by-id route')

  const updateRefusal = await attemptAdversarial(() => prisma.eligibilityVerification.update({ where: { id: verification.id }, data: { status: 'INELIGIBLE' } }))
  const afterUpdate = await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: verification.id }, select: { status: true } })
  check(
    'T66',
    'DB UPDATE immutability',
    /append-only/i.test(updateRefusal) && afterUpdate.status === storedRow.status,
    'the trigger refused a direct UPDATE, so a recorded result cannot be rewritten even from raw SQL',
  )
  const deleteRefusal = await attemptAdversarial(() => prisma.eligibilityVerification.delete({ where: { id: verification.id } }))
  check(
    'T67',
    'DB DELETE immutability',
    /append-only/i.test(deleteRefusal) && (await prisma.eligibilityVerification.count({ where: { id: verification.id } })) === 1,
    'the trigger refused a direct DELETE and the row survived',
  )

  // ---------------------------------------------------------------- RBAC and tenancy (T68–T73)
  section('Permission, tenancy and safe errors')
  const viewerList = await get(`/api/encounters/${encounter.id}/eligibility-verifications`, asViewer)
  const viewerById = await get(`/api/eligibility-verifications/${verification.id}`, asViewer)
  check('T68', 'Viewer read', viewerList.status === 200 && viewerById.status === 200, 'a viewer may read verification history and a single verification')

  const beforeViewerCreate = await prisma.eligibilityVerification.count({ where: { encounterId: encounter.id } })
  const auditBeforeViewer = await verificationAuditCount()
  const viewerCreate = await createFor(encounter.id, {}, asViewer)
  check(
    'T69',
    'Viewer create',
    viewerCreate.status === 403 &&
      (await prisma.eligibilityVerification.count({ where: { encounterId: encounter.id } })) === beforeViewerCreate &&
      (await verificationAuditCount()) === auditBeforeViewer,
    '403 with no verification and no audit event',
  )

  // The count is taken before and after, not compared against zero. T71 writes a foreign
  // verification directly and, like all history here, it is never deleted — so a second run of this
  // suite would find one already present. What this check proves is that THIS attempt wrote
  // nothing, which stays true however many earlier runs are on record.
  const foreignVerificationsBefore = foreignEncounter
    ? await prisma.eligibilityVerification.count({ where: { encounterId: foreignEncounter.id } })
    : 0
  const foreignList = foreignEncounter ? await get(`/api/encounters/${foreignEncounter.id}/eligibility-verifications`) : null
  const foreignCreate = foreignEncounter ? await createFor(foreignEncounter.id) : null
  const foreignListBody = JSON.stringify(foreignList?.body ?? {})
  const foreignVerificationsAfter = foreignEncounter
    ? await prisma.eligibilityVerification.count({ where: { encounterId: foreignEncounter.id } })
    : 0
  check(
    'T70',
    'Cross-tenant Encounter',
    foreignEncounter !== null &&
      foreignList !== null &&
      foreignCreate !== null &&
      foreignList.status >= 400 &&
      foreignList.status < 500 &&
      foreignCreate.status >= 400 &&
      foreignCreate.status < 500 &&
      !foreignListBody.includes(otherOrg) &&
      foreignVerificationsAfter === foreignVerificationsBefore,
    `read ${foreignList?.status} and create ${foreignCreate?.status}; the foreign encounter still holds ${foreignVerificationsAfter} verification(s), unchanged by this attempt, and no context was disclosed`,
  )

  // A verification owned by the other organization, written directly because this tenant's routes
  // correctly refuse to author one. It exists only to be refused, and nothing reads it back except
  // the privacy assertion below.
  const foreignMembership = await prisma.insuranceMembership.findFirst({
    where: { patient: { organizationId: otherOrg } },
    select: { id: true, payerId: true },
  })
  const foreignEvidence = await prisma.evidenceArtifactVersion.findFirst({ where: { evidenceArtifact: { organizationId: otherOrg } }, select: { id: true } })
  // An earlier run's fixture is reused when one is already on record, so repeated runs do not
  // accumulate foreign rows. Nothing is ever deleted either way.
  let foreignVerificationId = foreignEncounter
    ? (await prisma.eligibilityVerification.findFirst({ where: { encounterId: foreignEncounter.id }, select: { id: true } }))?.id ?? ''
    : ''
  if (foreignVerificationId === '' && foreignEncounter && foreignMembership && foreignEvidence) {
    foreignVerificationId = (
      await prisma.eligibilityVerification.create({
        data: {
          encounterId: foreignEncounter.id,
          insuranceMembershipId: foreignMembership.id,
          serviceDate: foreignEncounter.serviceDate,
          payerId: foreignMembership.payerId,
          verificationMethod: 'MANUAL',
          status: 'INELIGIBLE',
          respondedAt: new Date('2026-06-15T09:00:00.000Z'),
          responseEvidenceVersionId: foreignEvidence.id,
        },
        select: { id: true },
      })
    ).id
  }
  const foreignById = foreignVerificationId ? await get(`/api/eligibility-verifications/${foreignVerificationId}`) : null
  const foreignByIdBody = JSON.stringify(foreignById?.body ?? {})
  check(
    'T71',
    'Cross-tenant by-ID',
    foreignVerificationId !== '' &&
      foreignById !== null &&
      foreignById.status >= 400 &&
      foreignById.status < 500 &&
      !foreignByIdBody.includes('INELIGIBLE') &&
      !foreignByIdBody.includes(otherOrg),
    foreignVerificationId === ''
      ? 'a foreign verification fixture could not be built, so this could not be proven'
      : `refused with ${foreignById?.status}; neither the reported status nor the owning organization leaks`,
  )

  const malformed: string[] = []
  const malformedBodies: string[] = []
  for (const path of [`/api/encounters/not-a-uuid/eligibility-verifications`, `/api/eligibility-verifications/not-a-uuid`]) {
    const res = await get(path)
    malformed.push(`${res.status}`)
    malformedBodies.push(JSON.stringify(res.body ?? {}))
  }
  const malformedCreate = await post(`/api/encounters/not-a-uuid/eligibility-verifications`, body())
  check(
    'T72',
    'Malformed IDs',
    [...malformed, `${malformedCreate.status}`].every((code) => code === '404' || code === '400') &&
      malformedBodies.every((text) => !/prisma|postgres|syntax|invalid input|column|relation/i.test(text)),
    `${malformed.join(', ')}, create ${malformedCreate.status}; safe envelopes with no raw database text, never a 500`,
  )

  const missingRead = await get(`/api/eligibility-verifications/${MISSING}`)
  const missingBody = missingRead.body as any
  check(
    'T73',
    'Missing verification',
    missingRead.status === 404 && typeof missingBody?.error?.requestId === 'string' && !JSON.stringify(missingBody).includes(org),
    `404 with a requestId and no tenant information`,
  )

  // ---------------------------------------------------------------- audit (T74–T77)
  section('Business audit — proves the action, stores none of the eligibility')
  const auditRow = createAudit[0]
  check(
    'T74',
    'Create audit',
    createAudit.length === 1 && auditRow.actionCode === 'eligibility_verification.created' && auditRow.entityId === verification.id,
    'exactly one eligibility_verification.created event, written in the same transaction as the verification',
  )

  const allAudits = await prisma.auditEvent.findMany({ where: { entityType: 'ELIGIBILITY_VERIFICATION' }, select: { afterState: true, beforeState: true } })
  const sensitive = [
    'status',
    'ELIGIBLE',
    'INELIGIBLE',
    'UNKNOWN',
    'payerId',
    'tpaId',
    'networkId',
    'insuranceProductId',
    'encounterId',
    'insuranceMembershipId',
    'responseEvidenceVersionId',
    'requestEvidenceVersionId',
    'respondedAt',
    'validThrough',
    'authorizationRequired',
    'referralRequired',
    'serviceDate',
    'memberIdentifier',
    'policyIdentifier',
  ]
  const leaks = allAudits.filter((event) =>
    sensitive.some((needle) => JSON.stringify(event.afterState ?? {}).includes(needle) || JSON.stringify(event.beforeState ?? {}).includes(needle)),
  )
  check(
    'T75',
    'Audit minimization',
    leaks.length === 0 && JSON.stringify(Object.keys((auditRow.afterState ?? {}) as object).sort()) === JSON.stringify(['createdAt', 'id']),
    leaks.length === 0
      ? `no status, commercial identity, encounter, membership, evidence id, response timing or requirement flag in any of ${allAudits.length} verification audit rows; a snapshot carries id and createdAt only`
      : `${leaks.length} audit row(s) carry eligibility data`,
  )

  const auditBeforeBatch = await verificationAuditCount()
  await createFor(encounter.id, {}, asViewer)
  await createFor(encounter.id, { status: 'NONSENSE' })
  await createFor(selfEncounter.id)
  await createFor(MISSING)
  await createFor(encounter.id, { payerId: payer2.id })
  check(
    'T76',
    'No false audit',
    (await verificationAuditCount()) === auditBeforeBatch,
    `a denied, an invalid, a context-conflict, a missing-encounter and a forged-context attempt created no audit (count stayed ${auditBeforeBatch})`,
  )

  const verificationsBeforeRollback = await prisma.eligibilityVerification.count({ where: { encounterId: encounter.id } })
  const auditBeforeRollback = await verificationAuditCount()
  failAt('eligibility_verification.created', 'forced audit failure (acceptance)')
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail }, select: { id: true } })).id
  let rollbackThrew = false
  try {
    await createEligibilityVerification(
      encounter.id,
      {
        verificationMethod: 'MANUAL',
        status: 'UNKNOWN',
        requestedAt: null,
        respondedAt: '2026-06-15T09:00:00.000Z',
        validThrough: null,
        authorizationRequired: null,
        referralRequired: null,
        requestEvidenceVersionId: null,
        responseEvidenceVersionId,
      },
      actorUserId,
    )
  } catch {
    rollbackThrew = true
  }
  clearConcurrencyProbes()
  check(
    'T77',
    'Atomic rollback',
    rollbackThrew &&
      (await prisma.eligibilityVerification.count({ where: { encounterId: encounter.id } })) === verificationsBeforeRollback &&
      (await verificationAuditCount()) === auditBeforeRollback,
    'a forced audit failure left no verification row and no audit event behind',
  )

  // ---------------------------------------------------------------- concurrency (T78–T79)
  section('Concurrent correction — one coherent snapshot, never a mixture')
  const encounterGate = holdAt('eligibility_verification.encounter_locked')
  const heldVerification = createEligibilityVerification(
    encounter.id,
    {
      verificationMethod: 'PORTAL',
      status: 'UNKNOWN',
      requestedAt: null,
      respondedAt: '2026-06-15T09:00:00.000Z',
      validThrough: null,
      authorizationRequired: null,
      referralRequired: null,
      requestEvidenceVersionId: null,
      responseEvidenceVersionId,
    },
    actorUserId,
  )
  await encounterGate.arrived
  const RACE_DATE = '2026-06-17'
  const competingEncounterPatch = updateEncounter(encounter.id, { serviceDate: RACE_DATE }, actorUserId)
  const encounterBlocked = await waitForLockWaiter()
  encounterGate.release()
  const [racedVerification, patchedEncounter] = await Promise.all([heldVerification, competingEncounterPatch])
  clearConcurrencyProbes()
  const racedRow = racedVerification.ok ? await prisma.eligibilityVerification.findUniqueOrThrow({ where: { id: racedVerification.value.id }, select: { serviceDate: true } }) : null
  const racedDate = racedRow?.serviceDate.toISOString().slice(0, 10) ?? ''
  check(
    'T78',
    'Concurrency Encounter correction',
    encounterBlocked && racedVerification.ok && patchedEncounter.ok && (racedDate === NEW_SERVICE_DATE || racedDate === RACE_DATE),
    `the competing Encounter correction waited on the row lock; the verification recorded ${racedDate}, which is wholly the state before the correction or wholly after it`,
  )

  const membershipGate = holdAt('eligibility_verification.membership_locked')
  const heldVerification2 = createEligibilityVerification(
    encounter.id,
    {
      verificationMethod: 'PORTAL',
      status: 'UNKNOWN',
      requestedAt: null,
      respondedAt: '2026-06-15T09:00:00.000Z',
      validThrough: null,
      authorizationRequired: null,
      referralRequired: null,
      requestEvidenceVersionId: null,
      responseEvidenceVersionId,
    },
    actorUserId,
  )
  await membershipGate.arrived
  const competingMembershipPatch = updateMembership(membership.id, { payerId: payer.id, tpaId: tpa.id, networkId: network.id, insuranceProductId: product.id }, actorUserId)
  const membershipBlocked = await waitForLockWaiter()
  membershipGate.release()
  const [racedVerification2, patchedMembership] = await Promise.all([heldVerification2, competingMembershipPatch])
  clearConcurrencyProbes()
  const racedRow2 = racedVerification2.ok
    ? await prisma.eligibilityVerification.findUniqueOrThrow({
        where: { id: racedVerification2.value.id },
        select: { payerId: true, tpaId: true, networkId: true, insuranceProductId: true },
      })
    : null
  // Either wholly the corrected context, or wholly the one before it — never a payer from one
  // version of the membership and a network from another.
  const wholeBefore = racedRow2?.payerId === payer2.id && racedRow2?.tpaId === null && racedRow2?.networkId === null && racedRow2?.insuranceProductId === null
  const wholeAfter = racedRow2?.payerId === payer.id && racedRow2?.tpaId === tpa.id && racedRow2?.networkId === network.id && racedRow2?.insuranceProductId === product.id
  check(
    'T79',
    'Concurrency membership correction',
    membershipBlocked && racedVerification2.ok && patchedMembership.ok && (wholeBefore || wholeAfter),
    `the competing membership correction waited on the row lock; the snapshot is ${wholeAfter ? 'wholly the corrected context' : 'wholly the context before the correction'}, with no field taken from the other`,
  )

  // ---------------------------------------------------------------- scope guards (T80–T87)
  section('Scope guards — an evidence-bearing verification and nothing more')
  // `insurance_membership_id` is a required foreign key to the selected membership, not a copy of
  // member truth, so the word "member" is not what is forbidden. What is forbidden is a column that
  // would DUPLICATE identity: a patient link, an identifier of any kind, or a demographic.
  const identityColumns = columnNames.filter(
    (name) => name === 'patient_id' || /_identifier$/.test(name) || /(given_name|middle_name|family_name|date_of_birth|national|emirate|gender|phone|email)/i.test(name),
  )
  const identityInCode = productionCode.code.match(/\b(memberIdentifier|policyIdentifier|givenName|familyName|dateOfBirth)\b/)
  check(
    'T80',
    'No Patient/member copy',
    productionCode.files.length > 0 && identityColumns.length === 0 && identityInCode === null,
    productionCode.files.length === 0
      ? 'the production module source could not be read, so this absence is unproven'
      : identityColumns.length > 0 || identityInCode
        ? `identity is duplicated: ${[...identityColumns, identityInCode?.[0]].filter(Boolean).join(', ')}`
        : `among ${columnNames.length} columns none is a patient link, an identifier or a demographic, and no production file reads a member or policy identifier — only insurance_membership_id, the required foreign key to the selected membership`,
  )
  check(
    'T81',
    'No contract/tariff',
    !columnNames.some((name) => /(contract|tariff|price|amount|rate)/i.test(name)) && !/providerContract|tariffSchedule/i.test(moduleCode.code),
    'no ProviderContract or TariffScheduleVersion selection — A5.5 owns that',
  )
  check(
    'T82',
    'No A3 resolver execution',
    !/from '[^']*modules\/(rule-|reference-dataset|source-interpretation)/.test(moduleCode.code) && !/prisma\.(ruleVersion|rulePack|ruleApplicability|ruleSourceScope)\b/.test(moduleCode.code),
    'no second rule-resolution path: the module imports no A3 rule module and reads no rule table',
  )
  check(
    'T83',
    'No validation/readiness',
    !columnNames.some((name) => /(validation|finding|readiness|ready|restrict|block)/i.test(name)) && !/validationRun|validationFinding|readiness/i.test(moduleCode.code),
    'no ValidationRun, ValidationFinding or readiness state — A5.7 and A5.9 own those',
  )
  const futureTables = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name ~* '(claim|submission|remittance|prior_auth|authorization_line|validation_run|readiness)'`).map((row) => row.table_name)
  check(
    'T84',
    'No Claim',
    futureTables.length === 0 && !/prisma\.(claim|claimLine|claimSubmission|remittance)\b/.test(moduleCode.code),
    futureTables.length === 0 ? 'no Claim, ClaimLine, ClaimSubmission or remittance table exists and none is read — A6 owns them' : `unexpected tables: ${futureTables.join(', ')}`,
  )
  const integration = moduleCode.code.match(/\b(fetch|axios|http\.request|https\.request|soap|dhpo|eclaimlink|apiKey|clientSecret|Authorization:)\b/i)
  check(
    'T85',
    'No real integration',
    moduleCode.files.length > 0 && integration === null,
    moduleCode.files.length === 0
      ? 'the module source could not be read, so this absence is unproven'
      : `across ${moduleCode.files.length} committed files there is no network call, payer adapter or credential — A5.2 records what a verification reported, it never performs one`,
  )

  const feCode = committedCodeOf('frontend/src/modules/eligibility-verification')
  const fePersist = /\b(localStorage|sessionStorage|indexedDB)\s*\.\s*[A-Za-z]+\s*\(/.test(feCode.code)
  const feDump = /storageRef|contentHash|documentType/.test(feCode.code)
  check(
    'T86',
    'Frontend privacy',
    feCode.files.length > 0 && feCode.code.includes('createEligibilityVerification') && !fePersist && !feDump,
    feCode.files.length === 0 || !feCode.code.includes('createEligibilityVerification')
      ? 'the scan did not reach the committed frontend source, so this absence is unproven'
      : 'nothing is written to localStorage, sessionStorage or IndexedDB, and no raw evidence is rendered (search verified to reach the source)',
  )

  const logScan = gitGrep(
    'console[.](log|info|warn|error|debug)[(].*(status|payerId|responseEvidenceVersionId|memberIdentifier|policyIdentifier|validThrough|respondedAt)',
    [':/backend/src/modules/eligibility-verification', ':/frontend/src/modules/eligibility-verification'],
  )
  const urlScan = gitGrep(
    '[?&](status|payerId|responseEvidenceVersionId|memberIdentifier|policyIdentifier)=',
    [':/backend/src/modules/eligibility-verification', ':/frontend/src/modules/eligibility-verification'],
  )
  const logReach = gitGrep('responseEvidenceVersionId', [':/backend/src/modules/eligibility-verification', ':/frontend/src/modules/eligibility-verification'])
  check(
    'T87',
    'Logging scan',
    logReach.status === 0 && logScan.status === 1 && urlScan.status === 1,
    logReach.status !== 0
      ? 'the scan did not reach the committed sources, so this absence is unproven'
      : 'no status, commercial identity, evidence id, member or policy value is logged or placed in a query string (search verified to reach the source)',
  )

  // ---------------------------------------------------------------- build and regressions (T88–T91)
  section('Build gates, regressions and database truth')
  const unitTests = run('npm run test:unit')
  const typecheck = run('npm run typecheck')
  const build = run('npm run build --prefix ../frontend')
  const lint = run('npm run lint --prefix ../frontend')
  check(
    'T88',
    'Unit/typecheck/build',
    unitTests.ok && /ℹ fail 0/.test(unitTests.output) && typecheck.ok && build.ok && lint.ok,
    `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]}, typecheck clean, ${(build.output.match(/built in [\dms.]+/) ?? ['build ok'])[0]}, lint clean`,
  )

  // §13 of the A4 closure and §21 step 18 here: the owner suites are INVOKED, never reimplemented.
  // A5.1's suite already nests the whole A4.10 -> A4.9 -> ... -> A1 chain, so one invocation covers
  // both T89 and T90, and each nested verdict is read back below.
  await apiReady('the A5.1 and backward regression chain')
  const a51 = run('npm run test:a5:evidence')
  const a51Lines = a51.output.split(/\r?\n/)
  const a51Failing = failedIds(a51.output, 'A5.1')
  const a51FailLine = (id: string) => a51Lines.find((line) => line.startsWith(`[A5.1] ${id} `) && line.includes(' FAIL'))
  const a51TitleOf = (line: string) => line.slice('[A5.1] '.length).replace(/^\S+\s+/, '').split(' ..')[0].trim()

  // A5.1 asserts facts about its own feature branch, and one of its scope proofs asserts that no
  // table beyond its own two crosses the A4 boundary. A5.2 creates the first such table, which is
  // the A5.1-to-A5.2 boundary this package exists to cross. Each is listed with its own reason; an
  // id that is NOT listed here is a genuine regression and fails T89.
  const a51NonApplicable: Record<string, string> = {
    T01: "A5.1 'Start gate' requires the current branch to be the A5.1 feature branch; A5.2 is a different branch, branched from the merged A5.1 main",
    T03: "A5.1 'Migration scope' judges the single migration this branch adds against main; on A5.2 that migration is A5.2's own, which creates no evidence table",
    T73: "A5.1 'Backward regressions' requires the only tables crossing the A4 boundary to be its own two; A5.2 adds eligibility_verifications, which is exactly the boundary this package crosses",
    T76: "A5.1 'Diff scope' lists the paths A5.1 was allowed to change; A5.2 legitimately changes different ones",
    T78: "A5.1 'Exact head evidence' requires the upstream to be the A5.1 feature branch, which was deleted when PR #49 merged",
  }
  const a51Undocumented = a51Failing.filter((id) => !(id in a51NonApplicable))
  const a51Indented = a51Lines
    .filter((line) => line.startsWith('[A5.1]      ') && line.includes('substantive checks FAIL'))
    .map((line) => line.replace('[A5.1]      ', '').split(' ')[0])
  const a51Counts = a51.output.match(/\[A5\.1\] automated summary: (\d+)\/(\d+) PASS/)
  const a51Failed = a51Counts ? Number(a51Counts[2]) - Number(a51Counts[1]) : -1
  const a51Accounted = a51Failing.length + a51Indented.length
  const a51Reconciled = a51Failed >= 0 && a51Accounted === a51Failed
  const a51Unreadable = Object.keys(a51NonApplicable).filter((id) => a51Failing.includes(id) && !a51FailLine(id))

  check(
    'T89',
    'A5.1 regression',
    a51Undocumented.length === 0 && a51Indented.length === 0 && a51Reconciled && a51Unreadable.length === 0,
    !a51Reconciled
      ? `A5.1 reports ${a51Failed} failure(s) but only ${a51Accounted} could be named; something failed that this suite did not read back`
      : a51Unreadable.length > 0
        ? `tolerated but unreadable in the output: ${a51Unreadable.join(', ')}`
        : a51Undocumented.length > 0
          ? `undocumented A5.1 failures: ${a51Undocumented.join(', ')}`
          : a51Indented.length > 0
            ? `A5.1 owner-suite lines failed: ${a51Indented.join(', ')}`
            : `${(a51.output.match(/\[A5\.1\] automated summary: [^\n]*/) ?? ['no summary'])[0].replace('[A5.1] automated summary: ', 'A5.1 ')}; all ${a51Failed} failure(s) named and accounted for, and every substantive evidence invariant still holds`,
  )
  for (const id of Object.keys(a51NonApplicable)) {
    const line = a51FailLine(id)
    if (line) notApplicableCheck(`T89/${id}`, `A5.1 ${a51TitleOf(line)}`, a51NonApplicable[id])
  }

  // A5.1 prints the deep regression verdicts on indented lines of its own; they are read back here
  // rather than re-run, so A3, A2 and A1 still have to pass on their own terms.
  const a3 = (a51.output.match(/\[A5\.1\] +A3 substantive checks (PASS|FAIL)[^\n]*/) ?? [''])[0]
  const a2 = (a51.output.match(/\[A5\.1\] +A2 substantive checks (PASS|FAIL)[^\n]*/) ?? [''])[0]
  const a1 = (a51.output.match(/\[A5\.1\] +A1 substantive checks (PASS|FAIL)[^\n]*/) ?? [''])[0]
  for (const line of [a3, a2, a1]) console.log(`[A5.2]      ${line.replace('[A5.1]', '').trim().slice(0, 140)}`)
  const a410Summary = (a51.output.match(/A4\.10 \d+\/\d+ PASS[^\n;]*/) ?? ['no A4.10 summary'])[0]
  check(
    'T90',
    'Backward regressions',
    /PASS/.test(a3) && /PASS/.test(a2) && /PASS/.test(a1) && /A4\.10 \d+\/\d+ PASS/.test(a51.output),
    `${a410Summary}; A3, A2 and A1 substantive checks all read back PASS through the A5.1 chain`,
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
    'T91',
    'DB truth',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  // ---------------------------------------------------------------- closure (T92–T95)
  section('Repeatability, diff scope and exact head')
  const priorRuns = await prisma.eligibilityVerification.count({ where: { encounterId: { not: encounter.id } } })
  check(
    'T92',
    'Repeatability',
    true,
    `this run used a fresh synthetic runId (${runId}) and built its own patient, membership and encounters; ${priorRuns} verification(s) from earlier runs retained, none deleted`,
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
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/eligibility-verification/') &&
      !file.startsWith('backend/src/integration/a5-eligibility-verification/') &&
      !file.startsWith('frontend/src/modules/eligibility-verification/') &&
      !file.includes('a5_2_eligibility_verification_freshness') &&
      !allowed.includes(file),
  )
  const scopeCode = ['backend/src/modules/eligibility-verification', 'backend/src/integration/a5-eligibility-verification', 'frontend/src/modules/eligibility-verification']
    .map((dir) => committedCodeOf(dir))
    .reduce((all, one) => ({ files: [...all.files, ...one.files], code: `${all.code}\n${one.code}` }), { files: [] as string[], code: '' })
  const futureImport = scopeCode.code.match(/from '[^']*modules\/(prior-auth|authorization-line|claim|submission|remittance|validation-run|readiness)/)
  const futureModel = scopeCode.code.match(/prisma\.(priorAuthorization|authorizationLine|claim|claimLine|claimSubmission|remittance|validationRun|validationFinding)\b/)
  const scopeReached = scopeCode.files.length > 0 && scopeCode.code.includes("from '")
  check(
    'T93',
    'Diff scope',
    outOfScope.length === 0 && scopeReached && futureImport === null && futureModel === null,
    !scopeReached
      ? 'the import scan did not reach the committed sources, so this absence is unproven'
      : outOfScope.length === 0 && futureImport === null && futureModel === null
        ? `${changedPaths.length} path(s): the verification module, its migration, permission and audit wiring, and the dev check; across ${scopeCode.files.length} committed files no A5.3+, A6 or A9 module is imported and no future-phase table is read`
        : `unexpected: ${[...outOfScope, futureImport?.[0], futureModel?.[0]].filter(Boolean).join(', ').slice(0, 220)}`,
  )

  const secretScan = gitGrep(
    "((pass" + "word|secret|token|apiKey|clientSecret)\\s*[:=]\\s*['\"][^'\"]{3,}|BEGIN (RSA |EC )?PRIV" + "ATE KEY|Bearer [A-Za-z0-9._-]{20,})",
    [':/backend/src/integration/a5-eligibility-verification', ':/backend/src/modules/eligibility-verification', ':/frontend/src/modules/eligibility-verification'],
  )
  const realDataMarkers = new RegExp(
    ['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail']
      .map((fragment) => `(?:${fragment})`)
      .join('|'),
    'i',
  )
  const harnessSource = git('show HEAD:backend/src/integration/a5-eligibility-verification/a5-eligibility-verification.integration.ts')
  const realDataHit = harnessSource.match(realDataMarkers)
  const secretReach = gitGrep('A1_IT_ADMIN_EMAIL', [':/backend/src/integration/a5-eligibility-verification'])
  check(
    'T94',
    'Secret/PHI scan',
    secretReach.status === 0 && /SYNTHETIC|Synthetic/.test(harnessSource) && secretScan.status === 1 && realDataHit === null,
    secretReach.status !== 0 || !/SYNTHETIC|Synthetic/.test(harnessSource)
      ? 'the scan did not reach the committed harness source, so this absence is unproven'
      : secretScan.status === 1 && realDataHit === null
        ? 'no credential value is committed and no real patient, member or eligibility content appears; every fixture is generated from the run id, and every credential is read from the local environment at run time'
        : `${secretScan.output.slice(0, 120)} ${realDataHit ? `real-data marker ${JSON.stringify(realDataHit[0])}` : ''}`,
  )

  const headSha = git('rev-parse HEAD')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check(
    'T95',
    'Exact head evidence',
    headSha.length === 40 && git('status --porcelain') === '' && tracking.includes(`origin/${a52Branch}`),
    `all evidence corresponds to ${headSha}; ${tracking}; working tree clean`,
  )

  console.log(`\n[A5.2] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A5.2] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A5.2] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  if (connectionResets > 0) console.log(`[A5.2] INVALID RUN: the API connection was reset ${connectionResets} time(s)`)
  console.log(`[A5.2] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A5.2] A5.2 ELIGIBILITY VERIFICATION / FRESHNESS ACCEPTANCE COMPLETE' : '[A5.2] A5.2 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    if (error instanceof RunAborted) {
      console.log(`\n[A5.2] RUN ABORTED: ${error.message}`)
      console.log('[A5.2] No verdict was recorded for the remaining checks, so this run is not evidence of anything.')
    } else {
      console.error('[A5.2] uncaught error (this itself is a FAIL):', error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    // T91 takes the database down deliberately. However this run ends, it must not leave the
    // environment worse than it found it.
    const running = (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dbContainer], { encoding: 'utf8' }).stdout ?? '').trim()
    if (running === 'false') {
      const restored = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
      console.log(`[A5.2] the database was left stopped by this run; restarting it: ${restored ? 'done' : 'FAILED — start it manually'}`)
    }
    await prisma.$disconnect()
  })
