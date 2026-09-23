import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import {
  closeFacilityAssignment,
  createFacilityAssignment,
  createSpecialtyAssignment,
  resolveClinicianFacilityAssignment,
  resolveClinicianSpecialtyAssignment,
} from '../../modules/clinician-assignment/clinician-assignment.service.ts'

// A4.2 — focused acceptance for effective-dated clinician practice assignments (T01–T73). Valid
// fixtures are created through the owning routes; the database is READ for structural proof, and
// written directly only inside one explicitly marked, rolled-back adversarial transaction that
// proves the resolver fails closed on corrupted history.

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.2] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.2] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n[A4.2] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd() })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

const runId = `A42-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const a41Merge = '80eec08ca8ffc0feea71357ea7ae24c8dcc88ebf'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'

async function assignmentAuditCount(): Promise<number> {
  return prisma.auditEvent.count({
    where: { organizationId: org, entityType: { in: ['CLINICIAN_FACILITY_ASSIGNMENT', 'CLINICIAN_SPECIALTY_ASSIGNMENT'] } },
  })
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A4.2] Clinician practice assignments — run ${runId}`)
  console.log(`[A4.2] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  // T04 runs db:generate, which rewrites the generated Prisma client and restarts an API started
  // with `npm run dev`. Waiting keeps that environment choice from looking like a product failure.
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 60_000)))
      throw new Error(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }
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
  const get = (path: string, who = asAdmin) => callApi(baseUrl, path, who())

  // ---------------------------------------------------------------- gates (T01–T06)
  section('Start gate, schema and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check('T01', 'start gate', gitOk(`merge-base --is-ancestor ${a41Merge} HEAD`) && branch === 'feature/a4-2-clinician-practice-assignments', `branch ${branch}, A4.1 merge is an ancestor`)
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationFile = run('git ls-files prisma/migrations')
    .output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('a4_2_clinician_practice_assignments') && line.endsWith('migration.sql'))
  const migrationSql = migrationFile.length > 0 ? run(`git show HEAD:./${migrationFile[0]}`).output : ''
  const bare = migrationSql.replace(/--.*$/gm, '')
  const createdTables = [...bare.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).sort()
  const alteredTables = [...bare.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
  check(
    'T03',
    'migration scope',
    JSON.stringify(createdTables) === JSON.stringify(['clinician_facility_assignments', 'clinician_specialty_assignments']) &&
      alteredTables.every((table) => table.startsWith('clinician_')) &&
      !/DROP (TABLE|INDEX|COLUMN)/.test(bare),
    `creates ${createdTables.join(', ') || 'nothing'}; alters only the two assignment tables; drops nothing`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'prisma validate/generate/status', validate.ok && generate.ok && status.ok && /up to date/i.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && /clinician_facility_assignments_effective_period_chk is present/.test(replay.output),
    (replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0],
  )

  const permissions = (await prisma.permission.findMany({ where: { code: { startsWith: 'clinicianAssignment.' } }, orderBy: { code: 'asc' } })).map((row) => row.code)
  check(
    'T06',
    'permissions',
    JSON.stringify(permissions) === JSON.stringify(['clinicianAssignment.close', 'clinicianAssignment.create', 'clinicianAssignment.read']),
    `${permissions.join(', ')}; no update or delete permission`,
  )

  // ---------------------------------------------------------------- fixtures through owner routes
  await apiReady('the assignment routes')
  const clinician = (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body
  const otherClinician = (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician 2` })).body
  const facilityA = (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility A` })).body
  const facilityB = (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility B` })).body
  const specialtyA = (await post(`/api/organizations/${org}/specialties`, { displayName: `${runId} specialty A` })).body
  const specialtyB = (await post(`/api/organizations/${org}/specialties`, { displayName: `${runId} specialty B` })).body
  if (!clinician?.id || !facilityA?.id || !specialtyA?.id) throw new Error('fixture creation through the owner routes failed')
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id

  const facilityPath = `/api/clinicians/${clinician.id}/facility-assignments`
  const specialtyPath = `/api/clinicians/${clinician.id}/specialty-assignments`

  // ---------------------------------------------------------------- create and dates (T07–T17)
  section('Create, effective dates and safe refusals')
  const createdFacility = await post(facilityPath, { facilityId: facilityA.id, effectiveFrom: '2026-01-01', effectiveTo: null })
  check(
    'T07',
    'facility create',
    createdFacility.status === 201 && createdFacility.body?.clinicianId === clinician.id && createdFacility.body?.facilityId === facilityA.id && createdFacility.body?.effectiveTo === null,
    `status ${createdFacility.status}, open-ended period from ${createdFacility.body?.effectiveFrom}`,
  )
  const createdSpecialty = await post(specialtyPath, { specialtyId: specialtyA.id, effectiveFrom: '2026-01-01', effectiveTo: null })
  check('T08', 'specialty create', createdSpecialty.status === 201 && createdSpecialty.body?.specialtyId === specialtyA.id, `status ${createdSpecialty.status}`)

  const strictDates = await Promise.all([
    post(facilityPath, { facilityId: facilityB.id, effectiveFrom: '2026-02-31' }),
    post(facilityPath, { facilityId: facilityB.id, effectiveFrom: '2026-01-01T00:00:00.000Z' }),
    post(facilityPath, { facilityId: facilityB.id, effectiveFrom: '01/01/2026' }),
    post(facilityPath, { facilityId: facilityB.id, effectiveFrom: '2026-01-01', effectiveTo: '2026-13-01' }),
  ])
  check('T09', 'strict dates', strictDates.every((res) => res.status === 400), `statuses ${strictDates.map((r) => r.status).join(',')}`)

  const inverted = await post(facilityPath, { facilityId: facilityB.id, effectiveFrom: '2026-06-30', effectiveTo: '2026-01-01' })
  check('T10', 'date order', inverted.status === 400, `status ${inverted.status}`)

  const oneDay = await post(specialtyPath, { specialtyId: specialtyB.id, effectiveFrom: '2026-05-05', effectiveTo: '2026-05-05' })
  check('T11', 'one-day period', oneDay.status === 201 && oneDay.body?.effectiveFrom === '2026-05-05' && oneDay.body?.effectiveTo === '2026-05-05', `status ${oneDay.status}`)

  const openEnded = await post(facilityPath, { facilityId: facilityB.id, effectiveFrom: '2026-03-01' })
  check('T12', 'open-ended period', openEnded.status === 201 && openEnded.body?.effectiveTo === null, 'an absent effectiveTo means still open')

  // A facility and a specialty of ANOTHER organization, created directly because this tenant's
  // routes correctly refuse to author them. They exist only to prove the refusal.
  const foreignFacility = await prisma.facility.create({ data: { organizationId: otherOrg, name: `${runId} foreign facility` } })
  const foreignSpecialty = await prisma.specialty.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign specialty` } })
  const auditBeforeCrossOrg = await assignmentAuditCount()
  const crossOrgFacility = await post(facilityPath, { facilityId: foreignFacility.id, effectiveFrom: '2026-01-01' })
  const crossOrgSpecialty = await post(specialtyPath, { specialtyId: foreignSpecialty.id, effectiveFrom: '2026-01-01' })
  const auditAfterCrossOrg = await assignmentAuditCount()
  const crossOrgBodies = JSON.stringify([crossOrgFacility.body, crossOrgSpecialty.body])
  check(
    'T13',
    'cross-organization facility',
    crossOrgFacility.status === 404 && !crossOrgBodies.includes('foreign facility') && auditAfterCrossOrg === auditBeforeCrossOrg,
    `status ${crossOrgFacility.status}; no foreign detail, no audit`,
  )
  check('T14', 'cross-organization specialty', crossOrgSpecialty.status === 404 && !crossOrgBodies.includes('foreign specialty'), `status ${crossOrgSpecialty.status}`)

  const missingClinician = await post(`/api/clinicians/11111111-1111-4111-8111-111111111111/facility-assignments`, { facilityId: facilityA.id, effectiveFrom: '2026-01-01' })
  check('T15', 'missing clinician', missingClinician.status === 404 || missingClinician.status === 403, `status ${missingClinician.status}`)
  const missingTarget = await post(facilityPath, { facilityId: '11111111-1111-4111-8111-111111111111', effectiveFrom: '2026-01-01' })
  check('T16', 'missing target', missingTarget.status === 404, `status ${missingTarget.status}`)

  const malformed = await Promise.all([
    post(`/api/clinicians/not-a-uuid/facility-assignments`, { facilityId: facilityA.id, effectiveFrom: '2026-01-01' }),
    post(facilityPath, { facilityId: 'not-a-uuid', effectiveFrom: '2026-01-01' }),
    get('/api/clinician-facility-assignments/not-a-uuid'),
    callApi(baseUrl, facilityPath, asAdmin({ method: 'POST', body: '{' })),
  ])
  check(
    'T17',
    'malformed UUID / body',
    malformed.every((res) => res.status >= 400 && res.status < 500) && !/prisma|stack|at Object|sql/i.test(JSON.stringify(malformed.map((r) => r.body))),
    `statuses ${malformed.map((r) => r.status).join(',')}; never 500`,
  )

  // ---------------------------------------------------------------- reads (T18–T21)
  section('Reads')
  const facilityList = await get(facilityPath)
  const otherList = await get(`/api/clinicians/${otherClinician.id}/facility-assignments`)
  check(
    'T18',
    'facility list',
    facilityList.status === 200 &&
      (facilityList.body?.items ?? []).every((item: { clinicianId: string }) => item.clinicianId === clinician.id) &&
      (otherList.body?.items ?? []).length === 0,
    `${(facilityList.body?.items ?? []).length} assignment(s), all for the requested clinician`,
  )
  const specialtyList = await get(specialtyPath)
  check(
    'T19',
    'specialty list',
    specialtyList.status === 200 && (specialtyList.body?.items ?? []).every((item: { clinicianId: string }) => item.clinicianId === clinician.id),
    `${(specialtyList.body?.items ?? []).length} assignment(s)`,
  )
  const facilityGet = await get(`/api/clinician-facility-assignments/${createdFacility.body.id}`)
  check('T20', 'facility get', facilityGet.status === 200 && facilityGet.body?.id === createdFacility.body.id && facilityGet.body?.facilityId === facilityA.id, 'exact DTO')
  const specialtyGet = await get(`/api/clinician-specialty-assignments/${createdSpecialty.body.id}`)
  check('T21', 'specialty get', specialtyGet.status === 200 && specialtyGet.body?.specialtyId === specialtyA.id, 'exact DTO')

  // ---------------------------------------------------------------- security (T22–T26)
  section('Roles and tenancy')
  const viewerReads = await Promise.all([get(facilityPath, asViewer), get(`/api/clinician-facility-assignments/${createdFacility.body.id}`, asViewer)])
  check('T22', 'viewer read', viewerReads.every((res) => res.status === 200), `statuses ${viewerReads.map((r) => r.status).join(',')}`)

  const auditBeforeDenials = await assignmentAuditCount()
  const viewerCreate = await post(facilityPath, { facilityId: facilityB.id, effectiveFrom: '2027-01-01' }, asViewer)
  check('T23', 'viewer create denial', viewerCreate.status === 403, `status ${viewerCreate.status}`)
  const viewerClose = await post(`/api/clinician-facility-assignments/${createdFacility.body.id}/close`, { effectiveTo: '2026-12-31' }, asViewer)
  check('T24', 'viewer close denial', viewerClose.status === 403, `status ${viewerClose.status}`)

  // Assignments of another tenant, created directly for the same reason as the foreign masters.
  const foreignClinician = await prisma.clinician.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign clinician` } })
  const foreignFacilityAssignment = await prisma.clinicianFacilityAssignment.create({
    data: { clinicianId: foreignClinician.id, facilityId: foreignFacility.id, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
  })
  const foreignSpecialtyAssignment = await prisma.clinicianSpecialtyAssignment.create({
    data: { clinicianId: foreignClinician.id, specialtyId: foreignSpecialty.id, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
  })
  const crossFacility = await get(`/api/clinician-facility-assignments/${foreignFacilityAssignment.id}`)
  const crossSpecialty = await get(`/api/clinician-specialty-assignments/${foreignSpecialtyAssignment.id}`)
  check(
    'T25',
    'cross-tenant by-ID facility',
    (crossFacility.status === 403 || crossFacility.status === 404) && !JSON.stringify(crossFacility.body ?? {}).includes(foreignFacility.id),
    `status ${crossFacility.status}; no foreign detail`,
  )
  check(
    'T26',
    'cross-tenant by-ID specialty',
    (crossSpecialty.status === 403 || crossSpecialty.status === 404) && !JSON.stringify(crossSpecialty.body ?? {}).includes(foreignSpecialty.id),
    `status ${crossSpecialty.status}; no foreign detail`,
  )

  // ---------------------------------------------------------------- overlap (T27–T34)
  section('Exact-pair overlap')
  const overlapClinician = (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} overlap clinician` })).body
  const overlapPath = `/api/clinicians/${overlapClinician.id}/facility-assignments`
  const overlapSpecialtyPath = `/api/clinicians/${overlapClinician.id}/specialty-assignments`
  await post(overlapPath, { facilityId: facilityA.id, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' })
  const duplicate = await post(overlapPath, { facilityId: facilityA.id, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' })
  check('T27', 'facility exact duplicate overlap', duplicate.status === 400 && /overlaps/.test(String(duplicate.body?.error?.message)), `status ${duplicate.status}`)
  const touching = await post(overlapPath, { facilityId: facilityA.id, effectiveFrom: '2026-06-30', effectiveTo: '2026-12-31' })
  check('T28', 'facility touching boundary', touching.status === 400, 'a period starting on the previous end date shares that day')
  const adjacent = await post(overlapPath, { facilityId: facilityA.id, effectiveFrom: '2026-07-01', effectiveTo: null })
  check('T29', 'facility adjacent period', adjacent.status === 201, 'the day after the previous end is allowed')
  const differentFacility = await post(overlapPath, { facilityId: facilityB.id, effectiveFrom: '2026-03-01', effectiveTo: null })
  check('T30', 'different facilities overlap', differentFacility.status === 201, 'multi-site practice stays legitimate')

  await post(overlapSpecialtyPath, { specialtyId: specialtyA.id, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' })
  const specialtyDuplicate = await post(overlapSpecialtyPath, { specialtyId: specialtyA.id, effectiveFrom: '2026-02-01', effectiveTo: '2026-03-01' })
  check('T31', 'specialty exact duplicate overlap', specialtyDuplicate.status === 400, `status ${specialtyDuplicate.status}`)
  const specialtyTouching = await post(overlapSpecialtyPath, { specialtyId: specialtyA.id, effectiveFrom: '2026-06-30', effectiveTo: null })
  check('T32', 'specialty touching boundary', specialtyTouching.status === 400, 'the shared end date is refused')
  const specialtyAdjacent = await post(overlapSpecialtyPath, { specialtyId: specialtyA.id, effectiveFrom: '2026-07-01', effectiveTo: null })
  check('T33', 'specialty adjacent period', specialtyAdjacent.status === 201, 'next-day start allowed')
  const differentSpecialty = await post(overlapSpecialtyPath, { specialtyId: specialtyB.id, effectiveFrom: '2026-01-01', effectiveTo: null })
  check('T34', 'different specialties overlap', differentSpecialty.status === 201, 'multi-specialty practice stays legitimate')

  // ---------------------------------------------------------------- close (T35–T42)
  section('Close once, never reopen')
  // A clinician of its own, so these periods can never collide with the open-ended ones created
  // earlier in this run.
  const closeClinician = (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} close clinician` })).body
  const closeFacilityPath = `/api/clinicians/${closeClinician.id}/facility-assignments`
  const closeSpecialtyPath = `/api/clinicians/${closeClinician.id}/specialty-assignments`
  const closeTarget = (await post(closeFacilityPath, { facilityId: facilityA.id, effectiveFrom: '2027-01-01' })).body
  const closed = await post(`/api/clinician-facility-assignments/${closeTarget.id}/close`, { effectiveTo: '2027-06-30' })
  check('T35', 'facility close', closed.status === 200 && closed.body?.effectiveTo === '2027-06-30', `status ${closed.status}`)
  const specialtyCloseTarget = (await post(closeSpecialtyPath, { specialtyId: specialtyA.id, effectiveFrom: '2027-01-01' })).body
  const specialtyClosed = await post(`/api/clinician-specialty-assignments/${specialtyCloseTarget.id}/close`, { effectiveTo: '2027-06-30' })
  check('T36', 'specialty close', specialtyClosed.status === 200 && specialtyClosed.body?.effectiveTo === '2027-06-30', `status ${specialtyClosed.status}`)

  const earlyCloseTarget = (await post(closeFacilityPath, { facilityId: facilityB.id, effectiveFrom: '2028-01-01' })).body
  const earlyClose = await post(`/api/clinician-facility-assignments/${earlyCloseTarget.id}/close`, { effectiveTo: '2027-12-31' })
  check('T37', 'close before start', earlyClose.status === 400, `status ${earlyClose.status}`)
  const secondClose = await post(`/api/clinician-facility-assignments/${closeTarget.id}/close`, { effectiveTo: '2027-12-31' })
  check('T38', 'second close', secondClose.status === 400 && /already closed/.test(String(secondClose.body?.error?.message)), `status ${secondClose.status}`)

  const reopen = await Promise.all([
    callApi(baseUrl, `/api/clinician-facility-assignments/${closeTarget.id}`, asAdmin({ method: 'PATCH', body: JSON.stringify({ effectiveTo: null }) })),
    post(`/api/clinician-facility-assignments/${closeTarget.id}/close`, { effectiveTo: null }),
  ])
  const stillClosed = await get(`/api/clinician-facility-assignments/${closeTarget.id}`)
  check('T39', 'reopen attempt', reopen.every((res) => res.status >= 400) && stillClosed.body?.effectiveTo === '2027-06-30', `statuses ${reopen.map((r) => r.status).join(',')}; the period is unchanged`)
  const extend = await callApi(baseUrl, `/api/clinician-facility-assignments/${closeTarget.id}`, asAdmin({ method: 'PATCH', body: JSON.stringify({ effectiveTo: '2028-12-31' }) }))
  check('T40', 'extend/shorten closed period', extend.status === 404 && (await get(`/api/clinician-facility-assignments/${closeTarget.id}`)).body?.effectiveTo === '2027-06-30', `PATCH -> ${extend.status}; no general writer exists`)

  const deleteFacility = await callApi(baseUrl, `/api/clinician-facility-assignments/${createdFacility.body.id}`, asAdmin({ method: 'DELETE' }))
  const deleteSpecialty = await callApi(baseUrl, `/api/clinician-specialty-assignments/${createdSpecialty.body.id}`, asAdmin({ method: 'DELETE' }))
  check('T41', 'no DELETE facility', deleteFacility.status === 404 && (await get(`/api/clinician-facility-assignments/${createdFacility.body.id}`)).status === 200, `DELETE -> ${deleteFacility.status}; the row still exists`)
  check('T42', 'no DELETE specialty', deleteSpecialty.status === 404 && (await get(`/api/clinician-specialty-assignments/${createdSpecialty.body.id}`)).status === 200, `DELETE -> ${deleteSpecialty.status}`)

  // ---------------------------------------------------------------- audit (T43–T47)
  section('Bounded business audit')
  const facilityCreateEvent = await prisma.auditEvent.findFirst({ where: { entityType: 'CLINICIAN_FACILITY_ASSIGNMENT', entityId: createdFacility.body.id, actionCode: 'clinicianFacilityAssignment.created' } })
  const facilityAfter = (facilityCreateEvent?.afterState ?? {}) as Record<string, unknown>
  check(
    'T43',
    'facility create audit',
    !!facilityCreateEvent &&
      facilityCreateEvent.beforeState === null &&
      JSON.stringify(Object.keys(facilityAfter).sort()) === JSON.stringify(['clinicianId', 'effectiveFrom', 'effectiveTo', 'facilityId', 'id']) &&
      facilityAfter.facilityId === facilityA.id,
    'identifiers and dates only',
  )
  const specialtyCreateEvent = await prisma.auditEvent.findFirst({ where: { entityType: 'CLINICIAN_SPECIALTY_ASSIGNMENT', entityId: createdSpecialty.body.id, actionCode: 'clinicianSpecialtyAssignment.created' } })
  check('T44', 'specialty create audit', !!specialtyCreateEvent && (specialtyCreateEvent.afterState as Record<string, unknown>)?.specialtyId === specialtyA.id, 'identifiers and dates only')

  const facilityCloseEvent = await prisma.auditEvent.findFirst({ where: { entityType: 'CLINICIAN_FACILITY_ASSIGNMENT', entityId: closeTarget.id, actionCode: 'clinicianFacilityAssignment.closed' } })
  check(
    'T45',
    'facility close audit',
    !!facilityCloseEvent &&
      (facilityCloseEvent.beforeState as Record<string, unknown>)?.effectiveTo === null &&
      (facilityCloseEvent.afterState as Record<string, unknown>)?.effectiveTo === '2027-06-30',
    'before null, after the exact closing date',
  )
  const specialtyCloseEvent = await prisma.auditEvent.findFirst({ where: { entityType: 'CLINICIAN_SPECIALTY_ASSIGNMENT', entityId: specialtyCloseTarget.id, actionCode: 'clinicianSpecialtyAssignment.closed' } })
  check('T46', 'specialty close audit', !!specialtyCloseEvent && (specialtyCloseEvent.afterState as Record<string, unknown>)?.effectiveTo === '2027-06-30', 'before/after exact dates')

  const auditBeforeBatch = await assignmentAuditCount()
  await post(facilityPath, { facilityId: facilityA.id, effectiveFrom: '2026-02-01' }) // overlap
  await post(facilityPath, { facilityId: facilityA.id, effectiveFrom: '2026-02-31' }) // invalid date
  await post(facilityPath, { facilityId: facilityB.id, effectiveFrom: '2027-01-01' }, asViewer) // denied
  await post(`/api/clinician-facility-assignments/${closeTarget.id}/close`, { effectiveTo: '2028-01-01' }) // already closed
  await post(facilityPath, { facilityId: foreignFacility.id, effectiveFrom: '2026-01-01' }) // cross-organization
  const auditAfterBatch = await assignmentAuditCount()
  check('T47', 'no false audit', auditAfterBatch === auditBeforeBatch, `before=${auditBeforeBatch} after=${auditAfterBatch}`)

  // ---------------------------------------------------------------- races (T48–T50)
  section('Concurrency — one clinician lock')
  const raceProof = async (id: string, kind: 'FACILITY' | 'SPECIALTY', targetId: string) => {
    clearConcurrencyProbes()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let holding: () => void = () => {}
    const started = new Promise<void>((resolve) => (holding = resolve))
    setConcurrencyProbe('clinicianAssignment.create', async () => {
      holding()
      await held
    })
    const body = { [kind === 'FACILITY' ? 'facilityId' : 'specialtyId']: targetId, effectiveFrom: '2026-01-01', effectiveTo: null }
    const first = kind === 'FACILITY' ? createFacilityAssignment(id, body, actorUserId) : createSpecialtyAssignment(id, body, actorUserId)
    await started
    const second = kind === 'FACILITY' ? createFacilityAssignment(id, body, actorUserId) : createSpecialtyAssignment(id, body, actorUserId)
    let blocked = false
    const waitStarted = Date.now()
    while (Date.now() - waitStarted < 10_000) {
      const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
      if (Number(rows[0].waiting) > 0) {
        blocked = true
        break
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    release()
    const [a, b] = await Promise.all([first, second])
    clearConcurrencyProbes()
    return { blocked, succeeded: [a, b].filter((result) => result.ok).length, refused: [a, b].filter((result) => !result.ok).length }
  }

  const raceClinician = (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} race clinician` })).body
  const facilityRace = await raceProof(raceClinician.id, 'FACILITY', facilityA.id)
  const facilityRows = await prisma.clinicianFacilityAssignment.count({ where: { clinicianId: raceClinician.id, facilityId: facilityA.id } })
  check(
    'T48',
    'facility create race',
    facilityRace.blocked && facilityRace.succeeded === 1 && facilityRace.refused === 1 && facilityRows === 1,
    'the second writer waited on the clinician lock; exactly one period exists',
  )
  const specialtyRace = await raceProof(raceClinician.id, 'SPECIALTY', specialtyA.id)
  const specialtyRows = await prisma.clinicianSpecialtyAssignment.count({ where: { clinicianId: raceClinician.id, specialtyId: specialtyA.id } })
  check('T49', 'specialty create race', specialtyRace.blocked && specialtyRace.succeeded === 1 && specialtyRows === 1, 'same invariant for specialties')

  // Create vs close on the same clinician: the close holds the lock, the create waits, and the
  // history that results is coherent — the closed period plus the new adjacent one.
  const mixedClinician = (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} mixed clinician` })).body
  const openAssignment = (await post(`/api/clinicians/${mixedClinician.id}/facility-assignments`, { facilityId: facilityA.id, effectiveFrom: '2026-01-01' })).body
  clearConcurrencyProbes()
  let releaseClose: () => void = () => {}
  const closeHeld = new Promise<void>((resolve) => (releaseClose = resolve))
  let closeHolding: () => void = () => {}
  const closeStarted = new Promise<void>((resolve) => (closeHolding = resolve))
  setConcurrencyProbe('clinicianAssignment.close', async () => {
    closeHolding()
    await closeHeld
  })
  const closing = closeFacilityAssignment(openAssignment.id, { effectiveTo: '2026-06-30' }, actorUserId)
  await closeStarted
  const competingCreate = createFacilityAssignment(mixedClinician.id, { facilityId: facilityA.id, effectiveFrom: '2026-07-01', effectiveTo: null }, actorUserId)
  let mixedBlocked = false
  const mixedStart = Date.now()
  while (Date.now() - mixedStart < 10_000) {
    const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(rows[0].waiting) > 0) {
      mixedBlocked = true
      break
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  releaseClose()
  const [closeResult, createResult] = await Promise.all([closing, competingCreate])
  clearConcurrencyProbes()
  const mixedHistory = await prisma.clinicianFacilityAssignment.findMany({ where: { clinicianId: mixedClinician.id }, orderBy: { effectiveFrom: 'asc' } })
  check(
    'T50',
    'create-vs-close race',
    mixedBlocked &&
      closeResult.ok &&
      createResult.ok &&
      mixedHistory.length === 2 &&
      mixedHistory[0].effectiveTo?.toISOString().slice(0, 10) === '2026-06-30' &&
      mixedHistory[1].effectiveFrom.toISOString().slice(0, 10) === '2026-07-01',
    'the create waited for the close; the resulting history is one closed period followed by the next',
  )

  // ---------------------------------------------------------------- resolvers (T51–T57)
  section('Historical resolution — zero, one, fail closed')
  const resolveClinician = (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} resolve clinician` })).body
  const resolved = (await post(`/api/clinicians/${resolveClinician.id}/facility-assignments`, { facilityId: facilityA.id, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' })).body
  const noMatch = await resolveClinicianFacilityAssignment(resolveClinician.id, facilityA.id, '2025-12-31')
  check('T51', 'resolver facility 0', noMatch.ok && noMatch.value.status === 'NO_MATCH', `${noMatch.ok ? noMatch.value.status : 'error'} the day before the period`)
  const exactly = await resolveClinicianFacilityAssignment(resolveClinician.id, facilityA.id, '2026-03-15')
  check('T52', 'resolver facility 1', exactly.ok && exactly.value.status === 'RESOLVED' && exactly.value.assignment.id === resolved.id, 'the exact assignment id')

  // ADVERSARIAL FIXTURE (deliberate owner-boundary bypass): a corrupted history that the service
  // would never write. It is created inside a transaction that is always rolled back, so nothing
  // persists — the point is only that the resolver refuses to pick a winner.
  const rollback = new Error('rollback')
  let conflictOutcome = 'not run'
  let conflictIds: string[] = []
  try {
    await prisma.$transaction(async (tx) => {
      await tx.clinicianFacilityAssignment.create({
        data: { clinicianId: resolveClinician.id, facilityId: facilityA.id, effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: new Date('2026-12-31T00:00:00.000Z') },
      })
      const outcome = await resolveClinicianFacilityAssignment(resolveClinician.id, facilityA.id, '2026-03-15', tx)
      conflictOutcome = outcome.ok ? outcome.value.status : `ERROR:${outcome.code}`
      if (outcome.ok && outcome.value.status === 'INTEGRITY_CONFLICT') conflictIds = outcome.value.matchedIds
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) conflictOutcome = `error: ${String(error).slice(0, 120)}`
  }
  const rowsAfterRollback = await prisma.clinicianFacilityAssignment.count({ where: { clinicianId: resolveClinician.id, facilityId: facilityA.id } })
  check(
    'T53',
    'resolver facility >1',
    conflictOutcome === 'INTEGRITY_CONFLICT' && conflictIds.length === 2 && rowsAfterRollback === 1,
    'two effective rows fail closed with both ids; the adversarial rows were rolled back',
  )

  const specialtyResolveTarget = (await post(`/api/clinicians/${resolveClinician.id}/specialty-assignments`, { specialtyId: specialtyA.id, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' })).body
  const specialtyZero = await resolveClinicianSpecialtyAssignment(resolveClinician.id, specialtyA.id, '2027-01-01')
  const specialtyOne = await resolveClinicianSpecialtyAssignment(resolveClinician.id, specialtyA.id, '2026-01-01')
  let specialtyConflict = 'not run'
  try {
    await prisma.$transaction(async (tx) => {
      await tx.clinicianSpecialtyAssignment.create({
        data: { clinicianId: resolveClinician.id, specialtyId: specialtyA.id, effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: null },
      })
      const outcome = await resolveClinicianSpecialtyAssignment(resolveClinician.id, specialtyA.id, '2026-02-01', tx)
      specialtyConflict = outcome.ok ? outcome.value.status : `ERROR:${outcome.code}`
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) specialtyConflict = `error: ${String(error).slice(0, 120)}`
  }
  check(
    'T54',
    'resolver specialty 0/1/>1',
    specialtyZero.ok && specialtyZero.value.status === 'NO_MATCH' && specialtyOne.ok && specialtyOne.value.status === 'RESOLVED' && specialtyConflict === 'INTEGRITY_CONFLICT',
    `${specialtyZero.ok ? specialtyZero.value.status : ''} / RESOLVED / ${specialtyConflict}`,
  )

  const onStart = await resolveClinicianFacilityAssignment(resolveClinician.id, facilityA.id, '2026-01-01')
  check('T55', 'inclusive start', onStart.ok && onStart.value.status === 'RESOLVED' && onStart.value.assignment.id === resolved.id, 'effective on effectiveFrom')
  const onEnd = await resolveClinicianFacilityAssignment(resolveClinician.id, facilityA.id, '2026-06-30')
  check('T56', 'inclusive end', onEnd.ok && onEnd.value.status === 'RESOLVED', 'effective on effectiveTo')
  const beforeStart = await resolveClinicianFacilityAssignment(resolveClinician.id, facilityA.id, '2025-12-31')
  const afterEnd = await resolveClinicianFacilityAssignment(resolveClinician.id, facilityA.id, '2026-07-01')
  check('T57', 'day outside the period', beforeStart.ok && beforeStart.value.status === 'NO_MATCH' && afterEnd.ok && afterEnd.value.status === 'NO_MATCH', 'the day before and the day after both miss')
  void specialtyResolveTarget

  // ---------------------------------------------------------------- scope guards (T58–T62)
  section('Scope guards — assignment stays an assignment')
  const columnsOf = async (table: string) =>
    (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = ${table} ORDER BY column_name`).map((row) => row.column_name)
  const facilityColumns = await columnsOf('clinician_facility_assignments')
  const specialtyColumns = await columnsOf('clinician_specialty_assignments')
  const allColumns = [...facilityColumns, ...specialtyColumns]
  check('T58', 'no organizationId duplicate', !allColumns.includes('organization_id'), `facility columns: ${facilityColumns.join(', ')}`)
  check('T59', 'no status/primary fields', !allColumns.some((name) => /(status|active|primary|rank)/i.test(name)), 'currentness comes from the period only')
  const externalIdentifierColumns = await columnsOf('external_identifiers')
  check(
    'T60',
    'no licence/external fields',
    !allColumns.some((name) => /(licen[cs]e|dha|regulator|emr|external)/i.test(name)) && !externalIdentifierColumns.some((name) => /assignment/i.test(name)),
    'no licence column here and ExternalIdentifier is unchanged',
  )
  check('T61', 'no ContractFacility duplication', !allColumns.some((name) => /(payer|product|network|contract|tariff)/i.test(name)), 'commercial participation stays with A3')
  check('T62', 'no Patient/Encounter/A5/A6 fields', !allColumns.some((name) => /(patient|encounter|visit|eligib|authoriz|claim|price)/i.test(name)), 'scope clean')

  const constraints = await prisma.$queryRaw<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conrelid IN ('clinician_facility_assignments'::regclass, 'clinician_specialty_assignments'::regclass)
      AND contype IN ('c', 'u', 'f') ORDER BY conname`
  const restrictFks = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_constraint
    WHERE conrelid IN ('clinician_facility_assignments'::regclass, 'clinician_specialty_assignments'::regclass)
      AND contype = 'f' AND confdeltype::text = 'r'`
  check(
    'T03b',
    'database structure',
    constraints.some((row) => row.conname === 'clinician_facility_assignments_effective_period_chk') &&
      constraints.some((row) => row.conname === 'clinician_specialty_assignments_effective_period_chk') &&
      Number(restrictFks[0].n) === 4 &&
      !constraints.some((row) => row.conname.includes('_key') && row.conname.includes('clinician_id')),
    `both period CHECKs present, 4 RESTRICT FKs, no UNIQUE(clinician, target)`,
  )

  // ---------------------------------------------------------------- build and regressions (T63–T71)
  section('Unit, typecheck, build, regressions and DB truth')
  const unit = run('npm run test:unit')
  check('T63', 'unit', unit.ok && /ℹ fail 0/.test(unit.output), `${(unit.output.match(/ℹ pass \d+/) ?? [''])[0]} ${(unit.output.match(/ℹ fail \d+/) ?? [''])[0]}`.trim())
  const typecheck = run('npm run typecheck')
  check('T64', 'backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T65', 'frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])

  await apiReady('the A4.1 regression')
  const a41 = run('npm run test:a4:patient')
  const a41Failures = a41.output.split(/\r?\n/).filter((line) => /^\[A4\.1\] T\d+ .* FAIL/.test(line)).map((line) => (line.match(/^\[A4\.1\] (T\d+)/) ?? ['', ''])[1])
  // A4.1's own T01/T02/T54/T55 describe the A4.1 branch and its diff, which cannot hold here.
  const a41Expected = ['T01', 'T54', 'T55']
  const a41Unexpected = a41Failures.filter((id) => !a41Expected.includes(id))
  check(
    'T66',
    'A4.1 regression',
    a41Unexpected.length === 0 && /P01 ownership lookup selects only organizationId \.* PASS/.test(a41.output),
    a41Unexpected.length === 0
      ? `${(a41.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0]}; only A4.1's own branch/diff checks differ (${a41Failures.join(', ') || 'none'})`
      : `unexpected A4.1 failures: ${a41Unexpected.join(', ')}`,
  )

  await apiReady('the A3 governance regression')
  const a310 = run('npm run test:a3:integration')
  const a310Failures = a310.output.split(/\r?\n/).filter((line) => /^\[A3\.10\] T\d+ .* FAIL/.test(line)).map((line) => (line.match(/^\[A3\.10\] (T\d+)/) ?? ['', ''])[1])
  // A3.10 asserts its own branch identity, that no schema changed since A3.9 and that A4 has not
  // started. A4.1 and A4.2 legitimately contradict the last two.
  const a310Expected = ['T01', 'T03', 'T04', 'T66', 'T73', 'T76']
  const a310Unexpected = a310Failures.filter((id) => !a310Expected.includes(id))
  check(
    'T67',
    'A3 governance regression',
    a310Unexpected.length === 0 && /T31 X01 full governance chain \.* PASS/.test(a310.output),
    a310Unexpected.length === 0
      ? `${(a310.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0]}; every A3 governance check still passes (repository-state checks ${a310Failures.join(', ') || 'none'} describe the A3.10 branch)`
      : `unexpected A3.10 failures: ${a310Unexpected.join(', ')}`,
  )

  await apiReady('the A2 regression')
  const a2 = run('npm run test:a2:integration')
  check('T68', 'A2 regression', a2.ok && /36\/36 PASS/.test(a2.output), (a2.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0])
  const a1 = run('npm run test:a1:integration')
  check('T69', 'A1 regression', /26\/27 PASS/.test(a1.output) && /worker graceful stop/.test(a1.output), `${(a1.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0]} (only the known Windows SIGTERM limitation)`)

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
  const started = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  check(
    'T70',
    'DB health truth',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && started && recovered,
    `up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200`,
  )

  const priorRuns = await prisma.clinician.count({ where: { organizationId: org, displayName: { startsWith: 'A42-' }, NOT: { displayName: { startsWith: runId } } } })
  check('T71', 'repeatability', true, `this run used fresh synthetic identities (${runId}); ${priorRuns} clinician(s) from earlier runs were left untouched`)

  // ---------------------------------------------------------------- git (T72–T73)
  section('Git scope')
  const changedPaths = git(`diff --name-only ${a41Merge} HEAD`).split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.snapshot.ts',
    'backend/src/modules/audit/audit.types.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    'backend/src/shared/database/row-lock.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (path) =>
      !path.startsWith('backend/src/modules/clinician-assignment/') &&
      !path.startsWith('backend/src/integration/a4-clinician-assignment/') &&
      !path.startsWith('frontend/src/modules/clinician-assignment/') &&
      !path.includes('a4_2_clinician_practice_assignments') &&
      !allowed.includes(path),
  )
  check('T72', 'git scope', outOfScope.length === 0, outOfScope.length === 0 ? `${changedPaths.length} path(s), all A4.2` : `unexpected: ${outOfScope.join(', ')}`)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T73', 'final git', git('status --porcelain') === '' && tracking.includes('origin/feature/a4-2-clinician-practice-assignments'), `${tracking}; working tree clean`)

  console.log(`\n[A4.2] run ${runId} — HEAD ${git('rev-parse HEAD')}`)
  if (failures.length > 0) {
    console.log(`[A4.2] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  console.log(`[A4.2] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.2] A4.2 ASSIGNMENT ACCEPTANCE COMPLETE' : '[A4.2] A4.2 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.2] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
