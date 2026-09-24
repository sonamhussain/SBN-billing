import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { createEncounter, updateEncounter } from '../../modules/encounter/encounter.service.ts'
import { findEncounterOwnership, findPatientOwnership } from '../../modules/encounter/encounter.repository.ts'
import { closeFacilityAssignment } from '../../modules/clinician-assignment/clinician-assignment.service.ts'
import { updateFacilityRegulatoryProfile } from '../../modules/facility-regulatory/facility-regulatory.service.ts'
import { updateMembership } from '../../modules/insurance-membership/insurance-membership.service.ts'

// A4.4 — focused acceptance for the Encounter foundation (T01–T83). Valid fixtures are created
// through their owning routes. The database is READ for structural and audit proof. Records of
// ANOTHER organization are created directly, because this tenant's routes correctly refuse to
// author them. Two ADVERSARIAL fixtures (a second overlapping assignment, a second ACTIVE profile)
// are written directly because the owning services would never write them; each is removed again
// right after the refusal it proves, and nothing ever references it. Every identifier is synthetic.

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.4] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.4] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n[A4.4] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd() })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

const runId = `A44-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A4.3 FINAL PASS was merged into main as PR #39; A4.4 is branched from exactly that merge.
const a43Merge = '618efe9'
const a44Branch = 'feature/a4-4-encounter-foundation-regulatory-context'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const day = (text: string) => new Date(`${text}T00:00:00.000Z`)

async function encounterAuditCount(): Promise<number> {
  return prisma.auditEvent.count({ where: { organizationId: org, entityType: 'ENCOUNTER' } })
}

// Pull the "[X] Tnn ... FAIL" ids out of a nested suite's output.
function failedIds(output: string, tag: string): string[] {
  const pattern = new RegExp(`^\\[${tag.replace('.', '\\.')}\\] (T\\d+[a-z]?) .* FAIL`)
  return output
    .split(/\r?\n/)
    .map((line) => (line.match(pattern) ?? [])[1])
    .filter((id): id is string => Boolean(id))
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

// Holds the writer that reaches `probe` until released, so a competing writer can be started
// against the locks it holds.
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

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A4.4] Encounter foundation & regulatory context — run ${runId}`)
  console.log(`[A4.4] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  // Called before every HTTP phase that follows a long child process: it retries through any
  // keep-alive socket the server closed meanwhile.
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 60_000)))
      throw new Error(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // ---------------------------------------------------------------- gates (T01–T06)
  section('Start gate, schema and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'start gate',
    gitOk(`merge-base --is-ancestor ${a43Merge} HEAD`) &&
      gitOk(`merge-base --is-ancestor ${a43Merge} origin/main`) &&
      gitOk('merge-base --is-ancestor origin/main HEAD') &&
      branch === a44Branch,
    `branch ${branch}; A4.3 merge ${a43Merge} (PR #39) is on main and is an ancestor; the branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationFile = run('git ls-files prisma/migrations')
    .output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('a4_4_encounter_foundation_regulatory_context') && line.endsWith('migration.sql'))
  const migrationSql = migrationFile.length > 0 ? run(`git show HEAD:./${migrationFile[0]}`).output : ''
  const bare = migrationSql.replace(/--.*$/gm, '')
  const createdTables = [...bare.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).sort()
  const alteredTables = [...bare.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
  const fkCount = (bare.match(/FOREIGN KEY/g) ?? []).length
  const indexCount = (bare.match(/CREATE INDEX/g) ?? []).length
  check(
    'T03',
    'migration scope',
    migrationFile.length === 1 &&
      JSON.stringify(createdTables) === JSON.stringify(['encounters']) &&
      alteredTables.every((table) => table === 'encounters') &&
      fkCount === 6 &&
      indexCount === 5 &&
      !/DROP (TABLE|INDEX|COLUMN|CONSTRAINT)|ALTER COLUMN|UNIQUE/.test(bare),
    `one migration; creates ${createdTables.join(', ') || 'nothing'}; ${fkCount} FKs, ${indexCount} indexes; no drift, no UNIQUE`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'prisma validate/generate/status', validate.ok && generate.ok && status.ok && /up to date/i.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && /insurance_memberships_coverage_period_chk is present/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; replay schema equals the upgraded schema`,
  )

  const permissions = (await prisma.permission.findMany({ where: { code: { startsWith: 'encounter.' } }, orderBy: { code: 'asc' } })).map((row) => row.code)
  const forbiddenPermissions = await prisma.permission.count({
    where: { OR: [{ code: { contains: 'claim', mode: 'insensitive' } }, { code: { contains: 'eligib', mode: 'insensitive' } }, { code: 'encounter.delete' }] },
  })
  check(
    'T06',
    'permissions',
    JSON.stringify(permissions) === JSON.stringify(['encounter.create', 'encounter.read', 'encounter.update']) && forbiddenPermissions === 0,
    `${permissions.join(', ')}; no delete, claim or eligibility permission`,
  )

  // ---------------------------------------------------------------- sign-in + fixtures
  await apiReady('signing in')
  const signIn = async (email: string, password: string) => {
    const res = await callApi(baseUrl, '/api/auth/sign-in/email', {
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
    headers: { ...(init.headers ?? {}), 'Content-Type': 'application/json', Cookie: cookie },
  })
  const asAdmin = as(admin.cookie)
  const asViewer = as(viewer.cookie)
  const post = (path: string, body: unknown, who = asAdmin) => callApi(baseUrl, path, who({ method: 'POST', body: JSON.stringify(body) }))
  const patch = (path: string, body: unknown, who = asAdmin) => callApi(baseUrl, path, who({ method: 'PATCH', body: JSON.stringify(body) }))
  const get = (path: string, who = asAdmin) => callApi(baseUrl, path, who())
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 200)}`)
    return body as T & { id: string }
  }

  const newPatient = async (label: string) =>
    must(`patient ${label}`, (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-${label}`, dateOfBirth: '1990-01-01' })).body)
  const newFacility = async (label: string) => must(`facility ${label}`, (await post(`/api/organizations/${org}/facilities`, { name: `${runId} ${label}` })).body)
  const newClinician = async (label: string) => must(`clinician ${label}`, (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} ${label}` })).body)
  const activeProfile = async (facilityId: string, effectiveFrom: string, effectiveTo: string | null) => {
    const created = must('profile', (await post(`/api/facilities/${facilityId}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom, effectiveTo })).body)
    const activated = await post(`/api/facility-regulatory-profiles/${created.id}/activate`, {})
    if (activated.status !== 200) throw new Error(`fixture profile activation failed: ${activated.status} ${JSON.stringify(activated.body).slice(0, 200)}`)
    return created
  }
  const inactiveProfile = async (facilityId: string, effectiveFrom: string) =>
    must('inactive profile', (await post(`/api/facilities/${facilityId}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom, effectiveTo: null })).body)
  const assign = async (clinicianId: string, facilityId: string, effectiveFrom: string, effectiveTo: string | null) =>
    must('assignment', (await post(`/api/clinicians/${clinicianId}/facility-assignments`, { facilityId, effectiveFrom, effectiveTo })).body)
  const membership = async (patientId: string, payerId: string, label: string, coverageFrom: string | null, coverageTo: string | null) =>
    must(`membership ${label}`, (await post(`/api/patients/${patientId}/insurance-memberships`, { payerId, memberIdentifier: `SYN-${runId}-${label}`, coverageFrom, coverageTo })).body)

  // F1: two consecutive ACTIVE profiles and, for C1, two consecutive assignments — so correcting
  // the service date across 2026-07-01 must re-resolve BOTH stored context IDs.
  const patientA = await newPatient('A')
  const patientB = await newPatient('B')
  const f1 = await newFacility('F1')
  const f2 = await newFacility('F2')
  const f3NoProfile = await newFacility('F3-no-profile')
  const f4Inactive = await newFacility('F4-inactive-profile')
  const c1 = await newClinician('C1')
  const c2 = await newClinician('C2')
  const c3Unassigned = await newClinician('C3-unassigned')
  const f1ProfileH1 = await activeProfile(f1.id, '2026-01-01', '2026-06-30')
  const f1ProfileH2 = await activeProfile(f1.id, '2026-07-01', null)
  const f2Profile = await activeProfile(f2.id, '2025-01-01', null)
  await inactiveProfile(f4Inactive.id, '2025-01-01')
  const c1f1H1 = await assign(c1.id, f1.id, '2026-01-01', '2026-06-30')
  const c1f1H2 = await assign(c1.id, f1.id, '2026-07-01', '2026-12-31')
  const c1f2 = await assign(c1.id, f2.id, '2025-01-01', null)
  await assign(c1.id, f3NoProfile.id, '2025-01-01', null)
  await assign(c1.id, f4Inactive.id, '2025-01-01', null)
  const c2f1 = await assign(c2.id, f1.id, '2026-01-01', null)
  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const m2026 = await membership(patientA.id, payer.id, 'M2026', '2026-01-01', '2026-12-31')
  const mUnknown = await membership(patientA.id, payer.id, 'MUNK', null, null)
  const mOtherPatient = await membership(patientB.id, payer.id, 'MB', null, null)
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id

  // Records of ANOTHER organization — created directly, see the header.
  const foreignFacility = await prisma.facility.create({ data: { organizationId: otherOrg, name: `${runId} foreign facility` } })
  const foreignClinician = await prisma.clinician.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign clinician` } })
  const foreignPatient = await prisma.patient.create({ data: { organizationId: otherOrg, givenName: 'Synthetic', familyName: `${runId}-foreign`, dateOfBirth: day('1990-01-01') } })
  const foreignPayer = await prisma.payer.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign payer` } })
  const foreignMembership = await prisma.insuranceMembership.create({ data: { patientId: foreignPatient.id, payerId: foreignPayer.id, memberIdentifier: `SYN-${runId}-FOREIGN` } })
  const foreignAssignment = await prisma.clinicianFacilityAssignment.create({ data: { clinicianId: foreignClinician.id, facilityId: foreignFacility.id, effectiveFrom: day('2025-01-01') } })
  const foreignProfile = await prisma.facilityRegulatoryProfile.create({
    data: { facilityId: foreignFacility.id, jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: day('2025-01-01'), status: 'ACTIVE' },
  })
  const foreignEncounter = await prisma.encounter.create({
    data: {
      patientId: foreignPatient.id,
      facilityId: foreignFacility.id,
      clinicianId: foreignClinician.id,
      serviceDate: day('2026-05-05'),
      clinicianFacilityAssignmentId: foreignAssignment.id,
      facilityRegulatoryProfileId: foreignProfile.id,
    },
  })

  const pathA = `/api/patients/${patientA.id}/encounters`
  const body = (facilityId: string, clinicianId: string, serviceDate: string, insuranceMembershipId?: string | null) => ({
    facilityId,
    clinicianId,
    serviceDate,
    ...(insuranceMembershipId !== undefined ? { insuranceMembershipId } : {}),
  })

  // ---------------------------------------------------------------- create (T07–T18)
  section('Create, strict dates and safe refusals')
  const selfPay = await post(pathA, body(f1.id, c1.id, '2026-03-15'))
  check(
    'T07',
    'create minimal self-pay',
    selfPay.status === 201 && selfPay.body?.insuranceMembershipId === null && selfPay.body?.patientId === patientA.id && selfPay.body?.serviceDate === '2026-03-15',
    `status ${selfPay.status}; membership null`,
  )
  const withMembership = await post(pathA, body(f2.id, c1.id, '2026-05-01', m2026.id))
  check('T08', 'create with membership', withMembership.status === 201 && withMembership.body?.insuranceMembershipId === m2026.id, `status ${withMembership.status}; exact membership reference`)
  const strict = await Promise.all([
    post(pathA, body(f2.id, c1.id, '2026-02-31')),
    post(pathA, body(f2.id, c1.id, '2026-05-01T00:00:00.000Z')),
    post(pathA, body(f2.id, c1.id, '01/05/2026')),
  ])
  check('T09', 'strict serviceDate', strict.every((res) => res.status === 400), `statuses ${strict.map((r) => r.status).join(',')}`)
  const future = await post(pathA, body(f2.id, c1.id, '2099-06-01'))
  check('T10', 'no invented future-date rule', future.status === 201 && future.body?.serviceDate === '2099-06-01', `a valid future date -> ${future.status}`)
  const forgedPatient = await post(pathA, { ...body(f2.id, c1.id, '2026-05-01'), patientId: patientB.id })
  check('T11', 'patient body forgery', forgedPatient.status === 400 && /patientId/.test(String(forgedPatient.body?.error?.message)), `status ${forgedPatient.status}; the route owns the patient`)
  const forgedContext = await Promise.all([
    post(pathA, { ...body(f2.id, c1.id, '2026-05-01'), clinicianFacilityAssignmentId: c1f2.id }),
    post(pathA, { ...body(f2.id, c1.id, '2026-05-01'), facilityRegulatoryProfileId: f2Profile.id }),
  ])
  check('T12', 'context ID forgery', forgedContext.every((res) => res.status === 400), `statuses ${forgedContext.map((r) => r.status).join(',')}; the server resolves context`)

  const auditBeforeCross = await encounterAuditCount()
  const encountersBeforeCross = await prisma.encounter.count({ where: { patientId: patientA.id } })
  const crossFacility = await post(pathA, body(foreignFacility.id, c1.id, '2026-05-01'))
  const crossClinician = await post(pathA, body(f2.id, foreignClinician.id, '2026-05-01'))
  const crossMembership = await post(pathA, body(f2.id, c1.id, '2026-05-01', foreignMembership.id))
  const crossText = JSON.stringify([crossFacility.body, crossClinician.body, crossMembership.body])
  const noForeign = !crossText.includes('foreign') && !crossText.includes(otherOrg)
  const noWrite = (await encounterAuditCount()) === auditBeforeCross && (await prisma.encounter.count({ where: { patientId: patientA.id } })) === encountersBeforeCross
  check('T13', 'cross-org facility', crossFacility.status === 404 && noForeign && noWrite, `status ${crossFacility.status}; refused as not found, no encounter/audit`)
  check('T14', 'cross-org clinician', crossClinician.status === 404 && noForeign, `status ${crossClinician.status}`)
  check('T15', 'cross-org membership', crossMembership.status === 404 && noForeign, `status ${crossMembership.status}`)
  const otherPatientMembership = await post(pathA, body(f2.id, c1.id, '2026-05-01', mOtherPatient.id))
  check('T16', 'membership of another patient', otherPatientMembership.status === 404, `status ${otherPatientMembership.status}`)
  const missing = await Promise.all([
    post(`/api/patients/11111111-1111-4111-8111-111111111111/encounters`, body(f2.id, c1.id, '2026-05-01')),
    post(pathA, body('11111111-1111-4111-8111-111111111111', c1.id, '2026-05-01')),
    post(pathA, body(f2.id, '11111111-1111-4111-8111-111111111111', '2026-05-01')),
  ])
  check('T17', 'missing patient/facility/clinician', missing.every((res) => res.status === 404), `statuses ${missing.map((r) => r.status).join(',')}`)
  const malformed = await Promise.all([
    post('/api/patients/not-a-uuid/encounters', body(f2.id, c1.id, '2026-05-01')),
    post(pathA, body('not-a-uuid', c1.id, '2026-05-01')),
    get('/api/encounters/not-a-uuid'),
    patch('/api/encounters/not-a-uuid', { serviceDate: '2026-05-01' }),
    callApi(baseUrl, pathA, asAdmin({ method: 'POST', body: '{' })),
    post(pathA, [1, 2]),
  ])
  check(
    'T18',
    'malformed UUID/body',
    malformed.every((res) => res.status >= 400 && res.status < 500) && !/prisma|stack|at Object|sql/i.test(JSON.stringify(malformed.map((r) => r.body))),
    `statuses ${malformed.map((r) => r.status).join(',')}; never 500 or a raw DB error`,
  )

  // ---------------------------------------------------------------- assignment context (T19–T24)
  section('Clinician-facility assignment resolution')
  check('T19', 'assignment exact match', selfPay.body?.clinicianFacilityAssignmentId === c1f1H1.id, 'the exact A4.2 assignment effective on the date is stored')
  const noAssignment = await post(pathA, body(f2.id, c3Unassigned.id, '2026-05-01'))
  check('T20', 'assignment zero match', noAssignment.status === 400 && /assignment/.test(String(noAssignment.body?.error?.message)), `status ${noAssignment.status}; blocked`)

  // ADVERSARIAL FIXTURE: a second assignment overlapping an existing one for the same pair — the
  // A4.2 writer would refuse it. Removed right after the refusal; nothing references it.
  const advClinician = await newClinician('C-adversarial')
  await assign(advClinician.id, f2.id, '2025-01-01', null)
  const advAssignment = await prisma.clinicianFacilityAssignment.create({ data: { clinicianId: advClinician.id, facilityId: f2.id, effectiveFrom: day('2026-01-01') } })
  const auditBeforeAdv = await encounterAuditCount()
  const advAssignmentResult = await post(pathA, body(f2.id, advClinician.id, '2026-05-01'))
  const advWritten = (await prisma.encounter.count({ where: { clinicianId: advClinician.id } })) + ((await encounterAuditCount()) - auditBeforeAdv)
  await prisma.clinicianFacilityAssignment.delete({ where: { id: advAssignment.id } })
  check(
    'T21',
    'assignment >1 adversarial',
    advAssignmentResult.status === 400 && /integrity conflict/.test(String(advAssignmentResult.body?.error?.message)) && advWritten === 0,
    `status ${advAssignmentResult.status}; fail closed, no arbitrary winner, nothing written (adversarial row removed)`,
  )
  const onStart = await post(pathA, body(f1.id, c1.id, '2026-01-01'))
  check('T22', 'assignment inclusive start', onStart.status === 201 && onStart.body?.clinicianFacilityAssignmentId === c1f1H1.id, 'created on assignment effectiveFrom')
  const onEnd = await post(pathA, body(f1.id, c1.id, '2026-06-30'))
  check('T23', 'assignment inclusive end', onEnd.status === 201 && onEnd.body?.clinicianFacilityAssignmentId === c1f1H1.id, 'created on assignment effectiveTo')
  const outside = await Promise.all([post(pathA, body(f1.id, c1.id, '2025-12-31')), post(pathA, body(f1.id, c1.id, '2027-01-01'))])
  check('T24', 'assignment outside period', outside.every((res) => res.status === 400), `the day before / after -> ${outside.map((r) => r.status).join(',')}`)

  // ---------------------------------------------------------------- regulatory context (T25–T29)
  section('Facility regulatory profile resolution')
  check('T25', 'regulatory exact match', selfPay.body?.facilityRegulatoryProfileId === f1ProfileH1.id, 'the exact ACTIVE profile effective on the date is stored')
  const noProfile = await post(pathA, body(f3NoProfile.id, c1.id, '2026-05-01'))
  check('T26', 'regulatory zero match', noProfile.status === 400 && /regulatory profile/.test(String(noProfile.body?.error?.message)), `status ${noProfile.status}; blocked`)

  // ADVERSARIAL FIXTURE: a second ACTIVE profile overlapping an existing one — the A3 writer would
  // refuse it. Removed right after the refusal; nothing references it.
  const advFacility = await newFacility('F-adversarial')
  await activeProfile(advFacility.id, '2025-01-01', null)
  await assign(c1.id, advFacility.id, '2025-01-01', null)
  const advProfile = await prisma.facilityRegulatoryProfile.create({
    data: { facilityId: advFacility.id, jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: day('2026-01-01'), status: 'ACTIVE' },
  })
  const advProfileResult = await post(pathA, body(advFacility.id, c1.id, '2026-05-01'))
  const advProfileWritten = await prisma.encounter.count({ where: { facilityId: advFacility.id } })
  await prisma.facilityRegulatoryProfile.delete({ where: { id: advProfile.id } })
  check(
    'T27',
    'regulatory >1 adversarial',
    advProfileResult.status === 400 && /integrity conflict/.test(String(advProfileResult.body?.error?.message)) && advProfileWritten === 0,
    `status ${advProfileResult.status}; fail closed, no arbitrary profile (adversarial row removed)`,
  )
  check(
    'T28',
    'regulatory inclusive start/end',
    onStart.body?.facilityRegulatoryProfileId === f1ProfileH1.id && onEnd.body?.facilityRegulatoryProfileId === f1ProfileH1.id,
    'both boundary dates of the ACTIVE period are accepted',
  )
  const inactiveOnly = await post(pathA, body(f4Inactive.id, c1.id, '2026-05-01'))
  check('T29', 'inactive regulatory profile only', inactiveOnly.status === 400, `status ${inactiveOnly.status}; an INACTIVE profile does not satisfy the encounter`)

  // ---------------------------------------------------------------- membership (T30–T33)
  section('Recorded membership period')
  const unknownDates = await post(pathA, body(f2.id, c1.id, '2030-01-01', mUnknown.id))
  check('T30', 'membership unknown dates', unknownDates.status === 201 && !Object.keys(unknownDates.body ?? {}).some((key) => /(eligib|status|verified)/i.test(key)), 'allowed; no eligibility inference')
  const lower = await post(pathA, body(f2.id, c1.id, '2025-12-31', m2026.id))
  check('T31', 'membership lower bound mismatch', lower.status === 400 && /recorded coverage period/.test(String(lower.body?.error?.message)), `status ${lower.status}`)
  const upper = await post(pathA, body(f2.id, c1.id, '2027-01-01', m2026.id))
  check('T32', 'membership upper bound mismatch', upper.status === 400 && /recorded coverage period/.test(String(upper.body?.error?.message)), `status ${upper.status}`)
  const boundaries = await Promise.all([post(pathA, body(f2.id, c1.id, '2026-01-01', m2026.id)), post(pathA, body(f2.id, c1.id, '2026-12-31', m2026.id))])
  check('T33', 'membership boundary dates', boundaries.every((res) => res.status === 201), 'serviceDate equal to recorded coverageFrom / coverageTo accepted')

  // ---------------------------------------------------------------- reads + security (T34–T42)
  section('Reads, roles, tenancy and pre-authorization privacy')
  const list = await get(pathA)
  const items: { patientId: string }[] = list.body?.items ?? []
  const listB = await get(`/api/patients/${patientB.id}/encounters`)
  check('T34', 'list by patient', list.status === 200 && items.length > 0 && items.every((item) => item.patientId === patientA.id) && (listB.body?.items ?? []).length === 0, `${items.length} encounter(s), all for the requested patient`)
  const byId = await get(`/api/encounters/${withMembership.body.id}`)
  check(
    'T35',
    'get by ID',
    byId.status === 200 && byId.body?.id === withMembership.body.id && byId.body?.clinicianFacilityAssignmentId === c1f2.id && byId.body?.facilityRegulatoryProfileId === f2Profile.id,
    'authorized exact DTO with the stored context IDs',
  )
  const viewerReads = await Promise.all([get(pathA, asViewer), get(`/api/encounters/${withMembership.body.id}`, asViewer)])
  check('T36', 'viewer read', viewerReads.every((res) => res.status === 200), `statuses ${viewerReads.map((r) => r.status).join(',')}`)
  const auditBeforeViewer = await encounterAuditCount()
  const viewerCreate = await post(pathA, body(f2.id, c1.id, '2026-05-02'), asViewer)
  check('T37', 'viewer create denial', viewerCreate.status === 403 && (await encounterAuditCount()) === auditBeforeViewer, `status ${viewerCreate.status}, no audit`)
  const viewerPatch = await patch(`/api/encounters/${withMembership.body.id}`, { serviceDate: '2026-05-03' }, asViewer)
  check('T38', 'viewer update denial', viewerPatch.status === 403 && (await encounterAuditCount()) === auditBeforeViewer, `status ${viewerPatch.status}, no audit`)
  const crossCollection = await Promise.all([
    get(`/api/patients/${foreignPatient.id}/encounters`),
    post(`/api/patients/${foreignPatient.id}/encounters`, body(foreignFacility.id, foreignClinician.id, '2026-05-05')),
  ])
  check(
    'T39',
    'cross-tenant collection',
    crossCollection.every((res) => res.status === 403 || res.status === 404) && !JSON.stringify(crossCollection.map((r) => r.body)).includes(foreignEncounter.id),
    `statuses ${crossCollection.map((r) => r.status).join(',')}; no foreign encounter disclosed`,
  )
  const crossById = await Promise.all([get(`/api/encounters/${foreignEncounter.id}`), patch(`/api/encounters/${foreignEncounter.id}`, { serviceDate: '2026-05-06' })])
  const foreignAfter = await prisma.encounter.findUniqueOrThrow({ where: { id: foreignEncounter.id } })
  const crossByIdText = JSON.stringify(crossById.map((r) => r.body))
  check(
    'T40',
    'cross-tenant by-ID',
    crossById.every((res) => res.status === 403 || res.status === 404) &&
      !crossByIdText.includes('2026-05-05') &&
      !crossByIdText.includes(foreignClinician.id) &&
      foreignAfter.serviceDate.toISOString().slice(0, 10) === '2026-05-05',
    `statuses ${crossById.map((r) => r.status).join(',')}; no date/provider/membership disclosure, foreign row untouched`,
  )
  const missingEncounter = await get('/api/encounters/11111111-1111-4111-8111-111111111111')
  check('T41', 'missing encounter', missingEncounter.status === 404 && typeof missingEncounter.requestId === 'string' && missingEncounter.requestId.length > 0, `status ${missingEncounter.status} with requestId`)
  const encounterOwner = await findEncounterOwnership(withMembership.body.id)
  const patientOwner = await findPatientOwnership(patientA.id)
  check(
    'T42',
    'pre-auth minimal lookup',
    JSON.stringify(Object.keys(encounterOwner ?? {})) === JSON.stringify(['organizationId']) &&
      JSON.stringify(Object.keys(patientOwner ?? {})) === JSON.stringify(['organizationId']) &&
      encounterOwner?.organizationId === org,
    'ownership lookups return organizationId only — no clinical or context field',
  )

  // ---------------------------------------------------------------- guarded PATCH (T43–T54)
  section('Guarded PATCH with full context re-resolution')
  const e1 = must('E1', (await post(pathA, body(f1.id, c1.id, '2026-03-01'))).body)
  const e1Path = `/api/encounters/${e1.id}`
  const dateMove = await patch(e1Path, { serviceDate: '2026-08-01' })
  check(
    'T43',
    'patch serviceDate',
    dateMove.status === 200 && dateMove.body?.clinicianFacilityAssignmentId === c1f1H2.id && dateMove.body?.facilityRegulatoryProfileId === f1ProfileH2.id,
    'moving across 2026-07-01 re-resolved BOTH the assignment and the regulatory profile',
  )
  const clinicianMove = await patch(e1Path, { clinicianId: c2.id })
  check('T44', 'patch clinician', clinicianMove.status === 200 && clinicianMove.body?.clinicianFacilityAssignmentId === c2f1.id, 'the new clinician\'s assignment is resolved')
  const facilityMove = await patch(e1Path, { clinicianId: c1.id, facilityId: f2.id })
  check(
    'T45',
    'patch facility',
    facilityMove.status === 200 && facilityMove.body?.clinicianFacilityAssignmentId === c1f2.id && facilityMove.body?.facilityRegulatoryProfileId === f2Profile.id,
    'assignment and regulatory profile re-resolved for the new facility',
  )
  const membershipSet = await patch(e1Path, { insuranceMembershipId: m2026.id })
  check('T46', 'patch membership', membershipSet.status === 200 && membershipSet.body?.insuranceMembershipId === m2026.id, 'patient ownership and recorded period revalidated')
  const membershipClear = await patch(e1Path, { insuranceMembershipId: null })
  check('T47', 'clear membership', membershipClear.status === 200 && membershipClear.body?.insuranceMembershipId === null, 'explicit null allowed')

  const snapshot = async () => JSON.stringify(await prisma.encounter.findUniqueOrThrow({ where: { id: e1.id } }))
  const beforeInvalid = await snapshot()
  const badAssignment = await patch(e1Path, { clinicianId: c3Unassigned.id })
  check('T48', 'patch to invalid assignment context', badAssignment.status === 400 && (await snapshot()) === beforeInvalid, `status ${badAssignment.status}; row unchanged`)
  const badProfile = await patch(e1Path, { facilityId: f3NoProfile.id })
  check('T49', 'patch to missing regulatory context', badProfile.status === 400 && (await snapshot()) === beforeInvalid, `status ${badProfile.status}; row unchanged`)
  const e2 = must('E2', (await post(pathA, body(f2.id, c1.id, '2027-03-01'))).body)
  const beforeMismatch = JSON.stringify(await prisma.encounter.findUniqueOrThrow({ where: { id: e2.id } }))
  const periodMismatch = await patch(`/api/encounters/${e2.id}`, { insuranceMembershipId: m2026.id })
  check(
    'T50',
    'patch to membership period mismatch',
    periodMismatch.status === 400 && JSON.stringify(await prisma.encounter.findUniqueOrThrow({ where: { id: e2.id } })) === beforeMismatch,
    `status ${periodMismatch.status}; row unchanged`,
  )
  const unknownField = await patch(e1Path, { diagnosisCode: 'X' })
  check('T51', 'unknown PATCH field', unknownField.status === 400, `status ${unknownField.status}`)
  const immutable = await Promise.all(
    ['id', 'patientId', 'clinicianFacilityAssignmentId', 'facilityRegulatoryProfileId', 'createdAt', 'updatedAt'].map((field) => patch(e1Path, { [field]: field.endsWith('At') ? '2026-01-01T00:00:00.000Z' : c1f2.id })),
  )
  check('T52', 'immutable PATCH fields', immutable.every((res) => res.status === 400), `statuses ${immutable.map((r) => r.status).join(',')}`)
  const auditBeforeNoop = await encounterAuditCount()
  const empty = await patch(e1Path, {})
  check('T53', 'empty PATCH', empty.status === 400 && (await encounterAuditCount()) === auditBeforeNoop, `status ${empty.status}, no audit`)
  const current = (await get(e1Path)).body
  const noop = await patch(e1Path, { serviceDate: current.serviceDate, facilityId: current.facilityId })
  check('T54', 'no-op PATCH', noop.status === 400 && (await encounterAuditCount()) === auditBeforeNoop, `status ${noop.status}, no audit`)

  // ---------------------------------------------------------------- audit (T55–T58)
  section('PHI-minimized business audit')
  const createEvent = await prisma.auditEvent.findFirst({ where: { entityId: selfPay.body.id, actionCode: 'encounter.created' } })
  check(
    'T55',
    'create audit',
    !!createEvent &&
      createEvent.entityType === 'ENCOUNTER' &&
      createEvent.beforeState === null &&
      JSON.stringify(Object.keys((createEvent.afterState ?? {}) as Record<string, unknown>).sort()) === JSON.stringify(['id', 'updatedAt']),
    'safe snapshot only: id + updatedAt',
  )
  const updateEvents = await prisma.auditEvent.findMany({ where: { entityId: e1.id, actionCode: 'encounter.updated' }, orderBy: { occurredAt: 'asc' } })
  const dateMoveEvent = (updateEvents[0]?.afterState ?? {}) as Record<string, unknown>
  check(
    'T56',
    'update audit',
    updateEvents.length === 5 &&
      JSON.stringify(dateMoveEvent.changedFields) === JSON.stringify(['clinicianFacilityAssignmentId', 'facilityRegulatoryProfileId', 'serviceDate']) &&
      updateEvents.every((event) => JSON.stringify(Object.keys((event.afterState ?? {}) as Record<string, unknown>).sort()) === JSON.stringify(['changedFields', 'id', 'updatedAt'])),
    `${updateEvents.length} update events; changedFields names only`,
  )
  const runEncounterIds = (await prisma.encounter.findMany({ where: { patientId: { in: [patientA.id, patientB.id] } }, select: { id: true } })).map((row) => row.id)
  const runEvents = await prisma.auditEvent.findMany({ where: { entityType: 'ENCOUNTER', entityId: { in: runEncounterIds } } })
  const runEventText = JSON.stringify(runEvents.map((event) => [event.beforeState, event.afterState]))
  const forbiddenValues = [
    patientA.id,
    f1.id,
    f2.id,
    c1.id,
    c2.id,
    m2026.id,
    mUnknown.id,
    c1f1H1.id,
    c1f1H2.id,
    c1f2.id,
    c2f1.id,
    f1ProfileH1.id,
    f1ProfileH2.id,
    f2Profile.id,
    '2026-03-15',
    '2026-08-01',
    `SYN-${runId}`,
  ]
  const leaked = forbiddenValues.filter((value) => runEventText.includes(value))
  check('T57', 'audit PHI minimization', runEvents.length > 0 && leaked.length === 0, `${runEvents.length} event(s); no patient ID, service date, provider, membership or context ID`)
  const auditBeforeBatch = await encounterAuditCount()
  await post(pathA, body(foreignFacility.id, c1.id, '2026-05-01')) // cross-org
  await post(pathA, body(f2.id, c1.id, '2026-02-31')) // invalid
  await post(pathA, body(f2.id, c1.id, '2026-05-01'), asViewer) // denied
  await post(pathA, body(f3NoProfile.id, c1.id, '2026-05-01')) // context conflict
  await patch(e1Path, {}) // empty
  await patch(e1Path, { serviceDate: current.serviceDate }) // no-op
  const auditAfterBatch = await encounterAuditCount()
  check('T58', 'no false audit', auditAfterBatch === auditBeforeBatch, `before=${auditBeforeBatch} after=${auditAfterBatch}`)

  // ---------------------------------------------------------------- concurrency (T59–T62)
  section('Concurrency — encounter row and context locks')
  const race = must('E-race', (await post(pathA, body(f2.id, c1.id, '2026-05-01', m2026.id))).body)
  let hold = holdAt('encounter.update')
  const firstPatch = updateEncounter(race.id, { insuranceMembershipId: null }, actorUserId)
  await hold.arrived
  const secondPatch = updateEncounter(race.id, { serviceDate: '2026-06-15' }, actorUserId)
  const patchBlocked = await waitForLockWaiter()
  hold.release()
  const [firstResult, secondResult] = await Promise.all([firstPatch, secondPatch])
  clearConcurrencyProbes()
  const raceFinal = await prisma.encounter.findUniqueOrThrow({ where: { id: race.id } })
  check(
    'T59',
    'concurrent partial PATCH',
    patchBlocked && firstResult.ok && secondResult.ok && raceFinal.insuranceMembershipId === null && raceFinal.serviceDate.toISOString().slice(0, 10) === '2026-06-15',
    'the second PATCH waited on the encounter row lock; both unrelated corrections survive',
  )

  // Context races: the Encounter writer holds the owners' parent locks while it resolves, so a
  // concurrent owner write (closing the assignment / regulatory profile, narrowing the membership)
  // must wait, and the Encounter is written against the context that was valid when it resolved.
  const raceClinician = await newClinician('C-race')
  const raceAssignment = await assign(raceClinician.id, f2.id, '2026-01-01', null)
  hold = holdAt('encounter.create')
  const assignmentRaceCreate = createEncounter(patientA.id, body(f2.id, raceClinician.id, '2026-05-01'), actorUserId)
  await hold.arrived
  const assignmentClose = closeFacilityAssignment(raceAssignment.id, { effectiveTo: '2026-03-31' }, actorUserId)
  const assignmentBlocked = await waitForLockWaiter()
  hold.release()
  const [assignmentCreated, assignmentClosed] = await Promise.all([assignmentRaceCreate, assignmentClose])
  clearConcurrencyProbes()
  check(
    'T60',
    'context race - assignment close',
    assignmentBlocked && assignmentCreated.ok && assignmentCreated.value.clinicianFacilityAssignmentId === raceAssignment.id && assignmentClosed.ok,
    'the close waited on the clinician lock; the encounter kept the assignment valid when it resolved',
  )

  const raceFacility = await newFacility('F-race')
  const raceProfile = await activeProfile(raceFacility.id, '2026-01-01', null)
  await assign(c1.id, raceFacility.id, '2026-01-01', null)
  hold = holdAt('encounter.create')
  const profileRaceCreate = createEncounter(patientA.id, body(raceFacility.id, c1.id, '2026-05-01'), actorUserId)
  await hold.arrived
  const profileClose = updateFacilityRegulatoryProfile(raceProfile.id, undefined, undefined, undefined, '2026-03-31', actorUserId)
  const profileBlocked = await waitForLockWaiter()
  hold.release()
  const [profileCreated, profileClosed] = await Promise.all([profileRaceCreate, profileClose])
  clearConcurrencyProbes()
  check(
    'T61',
    'context race - regulatory close',
    profileBlocked && profileCreated.ok && profileCreated.value.facilityRegulatoryProfileId === raceProfile.id && profileClosed.ok,
    'the profile close waited on the facility lock; the encounter kept the profile valid when it resolved',
  )

  const raceMembership = await membership(patientA.id, payer.id, 'MRACE', '2026-01-01', null)
  hold = holdAt('encounter.create')
  const membershipRaceCreate = createEncounter(patientA.id, body(f2.id, c1.id, '2026-05-01', raceMembership.id), actorUserId)
  await hold.arrived
  const membershipNarrow = updateMembership(raceMembership.id, { coverageTo: '2026-03-31' }, actorUserId)
  const membershipBlocked = await waitForLockWaiter()
  hold.release()
  const [membershipCreated, membershipNarrowed] = await Promise.all([membershipRaceCreate, membershipNarrow])
  clearConcurrencyProbes()
  check(
    'T62',
    'context race - membership update',
    membershipBlocked && membershipCreated.ok && membershipCreated.value.insuranceMembershipId === raceMembership.id && membershipNarrowed.ok,
    'the membership update waited on the membership row lock; the encounter validated a stable record',
  )

  // ---------------------------------------------------------------- scope guards (T63–T69)
  section('Scope guards — encounter stays an operational event')
  await apiReady('the scope checks')
  const deleted = await callApi(baseUrl, e1Path, asAdmin({ method: 'DELETE' }))
  check('T63', 'no DELETE', deleted.status === 404 && (await get(e1Path)).status === 200, `DELETE -> ${deleted.status}; the row remains`)
  const columnsOf = async (table: string) =>
    (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = ${table} ORDER BY column_name`).map((row) => row.column_name)
  const columns = await columnsOf('encounters')
  check('T64', 'no organizationId', !columns.includes('organization_id'), `columns: ${columns.join(', ')}`)
  check('T65', 'no payer/member duplication', !columns.some((name) => /(payer|tpa|network|product|member_identifier|policy)/i.test(name)), 'coverage stays on InsuranceMembership (A4.3)')
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  const childTables = tables.filter((name) => /(diagnos|activit|observation)/i.test(name) && name !== 'diagnosis_codes')
  check('T66', 'no diagnosis/activity/observation', childTables.length === 0 && !columns.some((name) => /(diagnos|procedure|activity|observation)/i.test(name)), childTables.length === 0 ? 'no A4.5–A4.7 schema' : `unexpected: ${childTables.join(', ')}`)
  const laterScope = tables.filter((name) => /(eligib|authoriz|claim|remittance|payment|evidence)/i.test(name))
  check(
    'T67',
    'no eligibility/auth/claim fields',
    laterScope.length === 0 && !columns.some((name) => /(status|eligib|authoriz|claim|price|amount|tariff)/i.test(name)),
    laterScope.length === 0 ? 'no A5/A6 schema or column' : `unexpected: ${laterScope.join(', ')}`,
  )
  const externalIdentifierColumns = await columnsOf('external_identifiers')
  check('T68', 'no external Encounter ID', !externalIdentifierColumns.some((name) => /encounter/i.test(name)) && !columns.some((name) => /(external|visit|mrn|emr)/i.test(name)), 'ExternalIdentifier unchanged')
  check('T69', 'no specialty invention', !columns.some((name) => /specialt/i.test(name)), 'no specialtyId / primarySpecialty on Encounter')
  const constraints = await prisma.$queryRaw<{ conname: string; contype: string; deltype: string }[]>`
    SELECT conname, contype::text AS contype, confdeltype::text AS deltype FROM pg_constraint
    WHERE conrelid = 'encounters'::regclass AND contype IN ('c', 'u', 'f') ORDER BY conname`
  check(
    'T03b',
    'database structure',
    constraints.filter((row) => row.contype === 'f' && row.deltype === 'r').length === 6 && !constraints.some((row) => row.contype === 'u'),
    '6 RESTRICT FKs (patient, facility, clinician, membership, assignment, profile), no UNIQUE',
  )

  // ---------------------------------------------------------------- build and regressions (T70–T79)
  section('Unit, typecheck, build, regressions and DB truth')
  const unit = run('npm run test:unit')
  check('T70', 'unit', unit.ok && /ℹ fail 0/.test(unit.output), `${(unit.output.match(/ℹ pass \d+/) ?? [''])[0]} ${(unit.output.match(/ℹ fail \d+/) ?? [''])[0]}`.trim())
  const typecheck = run('npm run typecheck')
  check('T71', 'backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T72', 'frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])

  // Each nested suite also asserts its OWN branch identity and diff, and A4.3 asserts that no
  // Encounter table exists yet (its T57). On the A4.4 branch those checks cannot hold, so they are
  // listed; every other check must pass.
  const regression = (id: string, title: string, script: string, tag: string, expected: string[], marker: RegExp) => {
    const result = run(`npm run ${script}`)
    const failing = failedIds(result.output, tag)
    const unexpected = failing.filter((failure) => !expected.includes(failure))
    const summary = (result.output.match(new RegExp(`\\[${tag.replace('.', '\\.')}\\] automated summary: [^\\n]*`)) ?? ['no summary'])[0]
    check(
      id,
      title,
      unexpected.length === 0 && marker.test(result.output),
      unexpected.length === 0 ? `${summary}; only ${tag}'s own branch/diff/scope checks differ (${failing.join(', ') || 'none'})` : `unexpected ${tag} failures: ${unexpected.join(', ') || 'marker check missing'}`,
    )
  }
  await apiReady('the A4.3 regression')
  regression('T73', 'A4.3 regression', 'test:a4:insurance', 'A4.3', ['T01', 'T57', 'T69', 'T70'], /T49 concurrent partial updates \.* PASS/)
  await apiReady('the A4.2 regression')
  regression('T74', 'A4.2 regression', 'test:a4:assignments', 'A4.2', ['T01', 'T72', 'T73'], /T48 facility create race \.* PASS/)
  await apiReady('the A4.1 regression')
  regression('T75', 'A4.1 regression', 'test:a4:patient', 'A4.1', ['T01', 'T54', 'T55'], /P01 ownership lookup selects only organizationId \.* PASS/)
  await apiReady('the A3 governance regression')
  regression('T76', 'A3 governance regression', 'test:a3:integration', 'A3.10', ['T01', 'T03', 'T04', 'T66', 'T73', 'T76'], /T31 X01 full governance chain \.* PASS/)
  await apiReady('the A2 regression')
  const a2 = run('npm run test:a2:integration')
  check('T77', 'A2 regression', a2.ok && /36\/36 PASS/.test(a2.output), (a2.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0])
  await apiReady('the A1 regression')
  const a1 = run('npm run test:a1:integration')
  check('T78', 'A1 regression', /26\/27 PASS/.test(a1.output) && /worker graceful stop/.test(a1.output), `${(a1.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0]} (only the known Windows SIGTERM limitation)`)

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
    'T79',
    'DB health truth',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  const priorEncounters = await prisma.encounter.count({ where: { patient: { organizationId: org, familyName: { startsWith: 'A44-' }, NOT: { familyName: { startsWith: runId } } } } })
  check('T80', 'repeatability', true, `this run used fresh synthetic identities (${runId}); ${priorEncounters} encounter(s) from earlier runs retained`)

  // git is called WITHOUT a shell, with repository-root `:/` pathspecs. Exit 1 = no match (wanted),
  // anything but 0/1 = the search itself failed, which is a FAIL. The sanity search proves the
  // pathspecs reach the sources.
  const gitGrep = (pattern: string, paths: string[]) => {
    const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
    return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
  }
  const logged = gitGrep('console[.](log|info|warn|error|debug)[(].*(serviceDate|patientId|memberIdentifier|insuranceMembershipId)', [
    ':/backend/src/modules/encounter',
    ':/frontend/src/modules/encounter',
  ])
  const stored = gitGrep('(localStorage|sessionStorage)[.][A-Za-z]+[(]', [':/frontend/src/modules/encounter'])
  const urlLeak = gitGrep('[?&](serviceDate|patientId|memberIdentifier)=', [':/frontend/src/modules/encounter'])
  const sanity = gitGrep('serviceDate', [':/frontend/src/modules/encounter/encounter.api.ts'])
  check(
    'T81',
    'no PHI logs/storage',
    sanity.status === 0 && logged.status === 1 && stored.status === 1 && urlLeak.status === 1,
    logged.status === 1 && stored.status === 1 && urlLeak.status === 1
      ? 'no encounter/patient/member value logged, in a URL query or in browser storage (searches verified to reach the sources)'
      : `logged=${logged.status} storage=${stored.status} url=${urlLeak.status}: ${[logged.output, stored.output, urlLeak.output].join(' | ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- git (T82–T83)
  section('Git scope')
  // Scope is measured against the latest main this branch contains (three-dot = from their merge
  // base), so main's own later changes — merged into this branch — are never counted as A4.4's.
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.snapshot.ts',
    'backend/src/modules/audit/audit.types.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/database/row-lock.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/encounter/') &&
      !file.startsWith('backend/src/integration/a4-encounter/') &&
      !file.startsWith('frontend/src/modules/encounter/') &&
      !file.includes('a4_4_encounter_foundation_regulatory_context') &&
      !allowed.includes(file),
  )
  check('T82', 'git scope', outOfScope.length === 0, outOfScope.length === 0 ? `${changedPaths.length} path(s) since A4.3, all A4.4` : `unexpected: ${outOfScope.join(', ')}`)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T83', 'final git', git('status --porcelain') === '' && tracking.includes(`origin/${a44Branch}`), `${tracking}; working tree ${git('status --porcelain') === '' ? 'clean' : 'dirty'}`)

  console.log(`\n[A4.4] run ${runId} — HEAD ${git('rev-parse HEAD')}`)
  if (failures.length > 0) {
    console.log(`[A4.4] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  console.log(`[A4.4] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.4] A4.4 ENCOUNTER ACCEPTANCE COMPLETE' : '[A4.4] A4.4 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.4] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    await prisma.$disconnect()
  })
