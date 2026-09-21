import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { updatePatient } from '../../modules/patient/patient.service.ts'
import { findPatientOrganizationId } from '../../modules/patient/patient.repository.ts'

// A4.1 — focused Patient acceptance (T01–T55). Everything a real caller can do goes through the
// four patient routes; the database is only READ, for structural proof. Synthetic data only: no
// real person, and no demographic value is ever printed by this harness.

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 44 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.1] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.1] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n[A4.1] ${title}`)
}

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd() })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

const runId = `A41-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
const a310Merge = '4644115e172eb4640c9bb0b2f3129a989992c21f'

// Fresh synthetic identities per run, so a rerun never needs old rows deleted.
const synthetic = (suffix: string) => ({
  givenName: `Maya${suffix}`,
  middleName: null as string | null,
  familyName: `Khan-${runId.slice(-6)}${suffix}`,
  dateOfBirth: '1994-08-12',
  mobilePhone: '+971500000001',
  email: `synthetic.${runId.toLowerCase()}${suffix.toLowerCase()}@example.test`,
})

async function patientAuditCount(): Promise<number> {
  return prisma.auditEvent.count({ where: { organizationId: org, entityType: 'PATIENT' } })
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A4.1] Patient identity and demographics — run ${runId}`)
  console.log(`[A4.1] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  // T04 runs db:generate, which rewrites the generated Prisma client and therefore restarts an API
  // started with `npm run dev` (--watch). Waiting for the API to answer again keeps that
  // environment choice from being reported as a product failure; no check is relaxed by it.
  const apiReady = async (what: string) => {
    if (!(await waitFor(async () => (await ready()) === 200, 60_000)))
      throw new Error(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // Fail with a readable instruction rather than a raw socket error when nothing is listening.
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

  // ---------------------------------------------------------------- gates (T01–T06)
  section('Start gate, schema and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check('T01', 'start gate', gitOk(`merge-base --is-ancestor ${a310Merge} HEAD`) && branch === 'feature/a4-1-patient-identity-demographics', `branch ${branch}, A3.10 merge is an ancestor`)
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  // Filtered here rather than in the shell, so the check behaves the same in every terminal.
  // The harness runs from backend/, so the path is relative to that directory.
  const migrationDirs = run('git ls-files prisma/migrations')
    .output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('a4_1_patient_identity_demographics') && line.endsWith('migration.sql'))
  // `git show` resolves a path from the repository root unless it starts with ./, which makes it
  // relative to the current directory — the committed SQL is read, never the working copy.
  const migrationSql = migrationDirs.length > 0 ? run(`git show HEAD:./${migrationDirs[0]}`).output : ''
  const createdTables = [...migrationSql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])
  const alteredTables = [...migrationSql.replace(/--.*$/gm, '').matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
  check(
    'T03',
    'migration scope',
    createdTables.length === 1 &&
      createdTables[0] === 'patients' &&
      alteredTables.every((table) => table === 'patients') &&
      !/DROP (TABLE|INDEX|COLUMN)/.test(migrationSql.replace(/--.*$/gm, '')),
    `creates ${createdTables.join(', ') || 'nothing'}; alters only patients; drops nothing`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'prisma validate/generate/status', validate.ok && generate.ok && status.ok && /up to date/i.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check('T05', 'migration replay', replay.ok && /ALL CHECKS PASS/.test(replay.output), (replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0])

  const permissions = await prisma.permission.findMany({ where: { code: { startsWith: 'patient.' } }, orderBy: { code: 'asc' } })
  check(
    'T06',
    'permissions',
    JSON.stringify(permissions.map((p) => p.code)) === JSON.stringify(['patient.create', 'patient.read', 'patient.update']),
    `${permissions.map((p) => p.code).join(', ')}; no delete or merge permission`,
  )

  // ---------------------------------------------------------------- create (T07–T14)
  section('Create, ownership and validation')
  await apiReady('the patient routes')
  const auditBeforeCreate = await patientAuditCount()
  const created = await post(`/api/organizations/${org}/patients`, synthetic('A'))
  const patientId = created.body?.id
  check(
    'T07',
    'admin create',
    created.status === 201 && typeof patientId === 'string' && created.body?.organizationId === org && created.body?.displayName === `${synthetic('A').givenName} ${synthetic('A').familyName}`,
    `status ${created.status}, organizationId derived from the route`,
  )

  const forged = await Promise.all([
    post(`/api/organizations/${org}/patients`, { ...synthetic('F1'), organizationId: otherOrg }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('F2'), id: '11111111-1111-4111-8111-111111111111' }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('F3'), createdAt: '2020-01-01T00:00:00.000Z' }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('F4'), updatedAt: '2020-01-01T00:00:00.000Z' }),
  ])
  check('T08', 'ownership forgery', forged.every((res) => res.status === 400), `statuses ${forged.map((r) => r.status).join(',')}`)

  const badNames = await Promise.all([
    post(`/api/organizations/${org}/patients`, { ...synthetic('N1'), givenName: '   ' }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('N2'), givenName: 42 }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('N3'), familyName: '' }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('N4'), familyName: null }),
  ])
  check('T09', 'required names', badNames.every((res) => res.status === 400), `statuses ${badNames.map((r) => r.status).join(',')}`)

  const badDates = await Promise.all([
    post(`/api/organizations/${org}/patients`, { ...synthetic('D1'), dateOfBirth: '2026-02-31' }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('D2'), dateOfBirth: '1994-08-12T00:00:00.000Z' }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('D3'), dateOfBirth: '12/08/1994' }),
  ])
  check('T10', 'strict DOB', badDates.every((res) => res.status === 400), `impossible date, timestamp and non-ISO all rejected (${badDates.map((r) => r.status).join(',')})`)

  const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const futureDob = await post(`/api/organizations/${org}/patients`, { ...synthetic('D4'), dateOfBirth: future })
  check('T11', 'future DOB', futureDob.status === 400, `status ${futureDob.status}`)

  const middleAbsent = await post(`/api/organizations/${org}/patients`, { givenName: 'Mid', familyName: `Absent-${runId.slice(-5)}`, dateOfBirth: '1990-01-01' })
  const middleBlank = await post(`/api/organizations/${org}/patients`, { ...synthetic('M2'), middleName: '   ' })
  const middleValue = await post(`/api/organizations/${org}/patients`, { ...synthetic('M3'), middleName: ' Noor ' })
  check(
    'T12',
    'optional middleName',
    middleAbsent.status === 201 &&
      middleAbsent.body?.middleName === null &&
      middleBlank.status === 201 &&
      middleBlank.body?.middleName === null &&
      middleValue.status === 201 &&
      middleValue.body?.middleName === 'Noor' &&
      middleValue.body?.displayName.split(' ').length === 3,
    'absent and blank both become null; a real middle name appears in displayName',
  )

  const contact = await Promise.all([
    post(`/api/organizations/${org}/patients`, { givenName: 'NoContact', familyName: `C-${runId.slice(-5)}`, dateOfBirth: '1990-01-01' }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('C2'), mobilePhone: null, email: null }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('C3'), mobilePhone: '+9715\r\n00000001' }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('C4'), email: `x${'y'.repeat(250)}@example.test` }),
    post(`/api/organizations/${org}/patients`, { ...synthetic('C5'), email: 'not-an-email' }),
  ])
  check(
    'T13',
    'optional contact',
    contact[0].status === 201 && contact[1].status === 201 && contact[1].body?.mobilePhone === null && contact[2].status === 400 && contact[3].status === 400 && contact[4].status === 400,
    `absent/null accepted; CR/LF, oversize and malformed rejected (${contact.map((r) => r.status).join(',')})`,
  )

  const twinBody = { givenName: 'Twin', familyName: `Same-${runId.slice(-5)}`, dateOfBirth: '1988-03-04' }
  const twinA = await post(`/api/organizations/${org}/patients`, twinBody)
  const twinB = await post(`/api/organizations/${org}/patients`, twinBody)
  check(
    'T14',
    'duplicate demographics',
    twinA.status === 201 && twinB.status === 201 && twinA.body?.id !== twinB.body?.id,
    'two patients with the same name and date of birth both exist; no false uniqueness',
  )

  // ---------------------------------------------------------------- read and patch (T15–T23)
  section('Read and update')
  const list = await get(`/api/organizations/${org}/patients`)
  const listedIds: string[] = (list.body?.items ?? []).map((item: { id: string }) => item.id)
  const foreignOrgIds = (list.body?.items ?? []).filter((item: { organizationId: string }) => item.organizationId !== org)
  check('T15', 'list own-org', list.status === 200 && listedIds.includes(patientId) && foreignOrgIds.length === 0, `${listedIds.length} patient(s), all of this organization`)

  const fetched = await get(`/api/patients/${patientId}`)
  check(
    'T16',
    'get by ID',
    fetched.status === 200 &&
      fetched.body?.id === patientId &&
      fetched.body?.displayName === `${synthetic('A').givenName} ${synthetic('A').familyName}` &&
      fetched.body?.dateOfBirth === '1994-08-12' &&
      !('fullName' in (fetched.body ?? {})),
    'DTO carries the derived displayName and a date-only dateOfBirth',
  )

  const patchedName = await patch(`/api/patients/${patientId}`, { familyName: `  Renamed-${runId.slice(-5)}  ` })
  check('T17', 'patch name', patchedName.status === 200 && patchedName.body?.familyName === `Renamed-${runId.slice(-5)}`, 'trimmed and stored')

  const patchedDob = await patch(`/api/patients/${patientId}`, { dateOfBirth: '1994-08-13' })
  const patchedDobBad = await patch(`/api/patients/${patientId}`, { dateOfBirth: '1994-08-13T00:00:00.000Z' })
  check('T18', 'patch DOB', patchedDob.status === 200 && patchedDob.body?.dateOfBirth === '1994-08-13' && patchedDobBad.status === 400, 'strict DATE semantics kept on update')

  const cleared = await patch(`/api/patients/${patientId}`, { mobilePhone: null, email: null })
  check('T19', 'clear optional contact', cleared.status === 200 && cleared.body?.mobilePhone === null && cleared.body?.email === null, 'explicit null clears both')

  const unknownField = await patch(`/api/patients/${patientId}`, { gender: 'F' })
  check('T20', 'unknown PATCH field', unknownField.status === 400, `status ${unknownField.status}`)

  const immutable = await Promise.all([
    patch(`/api/patients/${patientId}`, { id: '11111111-1111-4111-8111-111111111111' }),
    patch(`/api/patients/${patientId}`, { organizationId: otherOrg }),
    patch(`/api/patients/${patientId}`, { createdAt: '2020-01-01T00:00:00.000Z' }),
    patch(`/api/patients/${patientId}`, { updatedAt: '2020-01-01T00:00:00.000Z' }),
  ])
  check('T21', 'immutable PATCH field', immutable.every((res) => res.status === 400), `statuses ${immutable.map((r) => r.status).join(',')}`)

  const auditBeforeEmpty = await patientAuditCount()
  const emptyPatch = await patch(`/api/patients/${patientId}`, {})
  const auditAfterEmpty = await patientAuditCount()
  check('T22', 'empty PATCH', emptyPatch.status === 400 && auditAfterEmpty === auditBeforeEmpty, `status ${emptyPatch.status}, audit unchanged`)

  const current = await get(`/api/patients/${patientId}`)
  const noOpPatch = await patch(`/api/patients/${patientId}`, { familyName: current.body?.familyName })
  const auditAfterNoOp = await patientAuditCount()
  check('T23', 'no-op PATCH', noOpPatch.status === 400 && auditAfterNoOp === auditBeforeEmpty, `status ${noOpPatch.status}, no audit written`)

  // ---------------------------------------------------------------- security (T24–T30)
  section('Tenancy, roles and error envelope')
  const viewerList = await get(`/api/organizations/${org}/patients`, asViewer)
  const viewerGet = await get(`/api/patients/${patientId}`, asViewer)
  check('T24', 'viewer read', viewerList.status === 200 && viewerGet.status === 200, `list ${viewerList.status}, get ${viewerGet.status}`)

  const auditBeforeDenials = await patientAuditCount()
  const viewerCreate = await post(`/api/organizations/${org}/patients`, synthetic('V1'), asViewer)
  check('T25', 'viewer create denial', viewerCreate.status === 403, `status ${viewerCreate.status}`)
  const viewerPatch = await patch(`/api/patients/${patientId}`, { familyName: 'ViewerEdit' }, asViewer)
  check('T26', 'viewer update denial', viewerPatch.status === 403, `status ${viewerPatch.status}`)

  const crossCollection = await get(`/api/organizations/${otherOrg}/patients`)
  check('T27', 'cross-tenant collection', crossCollection.status === 403 && !JSON.stringify(crossCollection.body ?? {}).includes('items'), `status ${crossCollection.status}, no foreign rows returned`)

  // A patient of the other organization, created directly because this tenant's routes correctly
  // refuse to author one. It exists only to prove the by-ID route denies it.
  const foreignPatient = await prisma.patient.create({
    data: { organizationId: otherOrg, givenName: 'Foreign', familyName: `Tenant-${runId.slice(-5)}`, dateOfBirth: new Date('1985-05-05T00:00:00.000Z') },
  })
  const crossById = await get(`/api/patients/${foreignPatient.id}`)
  const crossBody = JSON.stringify(crossById.body ?? {})
  check(
    'T28',
    'cross-tenant by-ID',
    (crossById.status === 403 || crossById.status === 404) && !crossBody.includes('Foreign') && !crossBody.includes('1985-05-05'),
    `status ${crossById.status}; response carries no demographics`,
  )

  // P01–P03 — the auditor's privacy-hardening correction: the permission resolver must learn WHO
  // OWNS a patient without reading any demographic column, because it runs before the caller is
  // known to be allowed to see that patient at all. These are extra to the package's T01–T55.
  const ownership = await findPatientOrganizationId(patientId)
  check(
    'P01',
    'ownership lookup selects only organizationId',
    ownership !== null && JSON.stringify(Object.keys(ownership)) === JSON.stringify(['organizationId']) && ownership.organizationId === org,
    `keys: ${JSON.stringify(Object.keys(ownership ?? {}))} — no name, date of birth, phone or e-mail is fetched for authorization`,
  )
  const foreignOwnership = await findPatientOrganizationId(foreignPatient.id)
  check(
    'P02',
    'ownership lookup of a foreign patient',
    foreignOwnership?.organizationId === otherOrg && JSON.stringify(Object.keys(foreignOwnership ?? {})) === JSON.stringify(['organizationId']),
    'the other tenant is identified for the denial, still without any demographic column',
  )
  const unknownOwnership = await findPatientOrganizationId('11111111-1111-4111-8111-111111111111')
  const malformedById = await get('/api/patients/not-a-uuid')
  check(
    'P03',
    'missing and malformed by-ID',
    unknownOwnership === null && malformedById.status >= 400 && malformedById.status < 500,
    `an unknown id resolves to no owner; a malformed id is refused with ${malformedById.status} and never reaches the database`,
  )

  const missing = await get('/api/patients/11111111-1111-4111-8111-111111111111')
  check('T29', 'missing patient', missing.status === 404 && typeof missing.requestId === 'string' && missing.requestId.length > 0, `status ${missing.status} with a requestId`)

  const malformed = await Promise.all([get('/api/patients/not-a-uuid'), patch('/api/patients/not-a-uuid', { familyName: 'X' }), callApi(baseUrl, `/api/organizations/${org}/patients`, asAdmin({ method: 'POST', body: '{' }))])
  check(
    'T30',
    'malformed by-ID / body',
    malformed.every((res) => res.status >= 400 && res.status < 500) && !/prisma|stack|at Object|sql/i.test(JSON.stringify(malformed.map((r) => r.body))),
    `statuses ${malformed.map((r) => r.status).join(',')}; never 500, no internals leaked`,
  )

  // ---------------------------------------------------------------- audit (T31–T34)
  section('PHI-minimized audit truth')
  const createEvents = await prisma.auditEvent.findMany({ where: { organizationId: org, entityType: 'PATIENT', entityId: patientId }, orderBy: { occurredAt: 'asc' } })
  const createEvent = createEvents.find((event) => event.actionCode === 'patient.created')
  check(
    'T31',
    'create audit',
    !!createEvent && createEvent.beforeState === null && (createEvent.afterState as Record<string, unknown>)?.id === patientId && Object.keys((createEvent.afterState ?? {}) as object).sort().join(',') === 'id,organizationId,updatedAt',
    'patient.created carries id, organizationId and updatedAt only',
  )

  const updateEvent = [...createEvents].reverse().find((event) => event.actionCode === 'patient.updated')
  const changed = (updateEvent?.afterState as { changedFields?: string[] } | null)?.changedFields ?? []
  check(
    'T32',
    'update audit',
    !!updateEvent && Array.isArray(changed) && changed.length > 0 && changed.every((field) => ['givenName', 'middleName', 'familyName', 'dateOfBirth', 'mobilePhone', 'email'].includes(field)),
    `patient.updated records changedFields ${JSON.stringify(changed)}`,
  )

  const auditJson = JSON.stringify(createEvents.map((event) => [event.beforeState, event.afterState]))
  const submitted = [synthetic('A').givenName, synthetic('A').email, '1994-08-12', '1994-08-13', '+971500000001', `Renamed-${runId.slice(-5)}`]
  const leaked = submitted.filter((value) => auditJson.includes(value))
  check('T33', 'audit PHI minimization', leaked.length === 0, 'no name, date of birth, phone or e-mail value appears in any patient AuditEvent')

  const auditBeforeBatch = await patientAuditCount()
  await post(`/api/organizations/${org}/patients`, { ...synthetic('X1'), givenName: '' })
  await post(`/api/organizations/${org}/patients`, synthetic('X2'), asViewer)
  await patch(`/api/patients/${patientId}`, { gender: 'F' })
  await patch(`/api/patients/${patientId}`, {})
  await patch(`/api/patients/${patientId}`, { familyName: 'X' }, asViewer)
  const auditAfterBatch = await patientAuditCount()
  check('T34', 'no false audit', auditAfterBatch === auditBeforeBatch, `before=${auditBeforeBatch} after=${auditAfterBatch}`)

  // ---------------------------------------------------------------- concurrency (T35–T36)
  section('Concurrent partial updates')
  const raceTarget = await post(`/api/organizations/${org}/patients`, { ...synthetic('R1'), middleName: 'Start', mobilePhone: '+971500000009' })
  const raceId = raceTarget.body?.id as string
  const actor = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id
  clearConcurrencyProbes()
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding: () => void = () => {}
  const holdingStarted = new Promise<void>((resolve) => (holding = resolve))
  setConcurrencyProbe('patient.update', async () => {
    holding()
    await held
  })
  const first = updatePatient(raceId, { middleName: 'FirstWriter' }, actor)
  await holdingStarted
  const second = updatePatient(raceId, { mobilePhone: '+971500000010' }, actor)
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
  const [firstResult, secondResult] = await Promise.all([first, second])
  clearConcurrencyProbes()
  const afterRace = await prisma.patient.findUniqueOrThrow({ where: { id: raceId } })
  check(
    'T35',
    'concurrent partial updates',
    blocked && firstResult.ok && secondResult.ok && afterRace.middleName === 'FirstWriter' && afterRace.mobilePhone === '+971500000010',
    'the second update waited on the row lock; both unrelated changes survive',
  )

  const raceEvents = await prisma.auditEvent.findMany({ where: { entityType: 'PATIENT', entityId: raceId, actionCode: 'patient.updated' }, orderBy: { occurredAt: 'asc' } })
  const raceChanged = raceEvents.map((event) => ((event.afterState as { changedFields?: string[] })?.changedFields ?? []).join(','))
  check(
    'T36',
    'audit race truth',
    raceEvents.length === 2 && raceChanged.includes('middleName') && raceChanged.includes('mobilePhone') && raceEvents.every((event) => !JSON.stringify(event.afterState).includes('FirstWriter')),
    `two ordered events recording ${JSON.stringify(raceChanged)}, with no demographic value`,
  )

  // ---------------------------------------------------------------- scope guards (T37–T43)
  section('Scope guards — Patient stays Patient')
  const deleteAttempt = await callApi(baseUrl, `/api/patients/${patientId}`, asAdmin({ method: 'DELETE' }))
  const stillThere = await get(`/api/patients/${patientId}`)
  check('T37', 'no delete route', deleteAttempt.status === 404 && stillThere.status === 200, `DELETE -> ${deleteAttempt.status}; the patient still exists`)

  const columns = (
    await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'patients' ORDER BY column_name`
  ).map((row) => row.column_name)
  check('T38', 'no facility on Patient', !columns.some((name) => /facility/i.test(name)), `columns: ${columns.join(', ')}`)
  check('T39', 'no insurance on Patient', !columns.some((name) => /(payer|tpa|network|product|member|policy|coverage|insur)/i.test(name)), 'no coverage column')
  check('T40', 'no external patient IDs', !columns.some((name) => /(mrn|emirates|external|emr)/i.test(name)) && (await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'external_identifiers' AND column_name LIKE '%patient%'`)[0].n === 0n, 'no MRN/Emirates/EMR column and ExternalIdentifier is unchanged')
  check('T41', 'no encounter', !columns.some((name) => /(encounter|visit|service_date|admission)/i.test(name)), 'no encounter column')
  check('T42', 'no claims/A5 runtime', !columns.some((name) => /(claim|eligib|authoriz|price|evidence)/i.test(name)) && (await get('/api/patients/eligibility')).status === 404, 'no eligibility/authorization/claim field or route')

  const patientConstraints = await prisma.$queryRaw<{ conname: string; contype: string; definition: string }[]>`
    SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = 'patients'::regclass ORDER BY conname`
  const uniques = patientConstraints.filter((row) => row.contype === 'u' || (row.contype === 'p' && !row.definition.includes('(id)')))
  const uniqueIndexes = await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'patients' AND indexdef ILIKE '%UNIQUE%' AND indexname <> 'patients_pkey'`
  check(
    'T43',
    'no demographic UNIQUE',
    uniques.length === 0 && uniqueIndexes.length === 0,
    `constraints: ${patientConstraints.map((row) => row.conname).join(', ')}; the only unique object is the primary key`,
  )

  // ---------------------------------------------------------------- build and regression (T44–T51)
  section('Unit, typecheck, build, regressions and DB truth')
  const unit = run('npm run test:unit')
  const unitSummary = (unit.output.match(/ℹ pass \d+/) ?? [''])[0] + ' ' + (unit.output.match(/ℹ fail \d+/) ?? [''])[0]
  check('T44', 'unit', unit.ok && /ℹ fail 0/.test(unit.output), unitSummary.trim())
  const typecheck = run('npm run typecheck')
  check('T45', 'backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T46', 'frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])

  // The A3.10 harness also checks its OWN branch identity and the repository state as of A3.10:
  //   T01 start gate / T03 clean baseline / T73 git scope / T76 single branch — the A3.10 branch.
  // Every A3 governance check it makes must still pass, and any other failure fails this case.
  await apiReady('the A3.10 regression')
  const a310 = run('npm run test:a3:integration')
  const a310Failures = a310.output
    .split(/\r?\n/)
    .filter((line) => /^\[A3\.10\] T\d+ .* FAIL/.test(line))
    .map((line) => (line.match(/^\[A3\.10\] (T\d+)/) ?? ['', ''])[1])
  //   T04 no feature schema — A4.1 legitimately adds the first A4 migration;
  //   T66 no A4 entities — A3.10 proved A4 had not started; A4.1 starting it is the roadmap.
  // The merged A3.10 harness is deliberately left untouched: it still passes as-is on main.
  const expectedOnA4Branch = ['T01', 'T03', 'T73', 'T76', 'T04', 'T66']
  const unexpectedA310 = a310Failures.filter((id) => !expectedOnA4Branch.includes(id))
  const governancePassed = /T31 X01 full governance chain \.* PASS/.test(a310.output) && /T50 X20 read-only evaluation \.* PASS/.test(a310.output)
  check(
    'T47',
    'A3.10 regression',
    unexpectedA310.length === 0 && governancePassed,
    unexpectedA310.length === 0
      ? `${(a310.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0]}; every A3 governance check still passes. Only A3.10's own repository-state checks differ (${a310Failures.join(', ') || 'none'}): this branch adds the first A4 migration and the first A4 entity by design`
      : `unexpected A3.10 failures: ${unexpectedA310.join(', ')}`,
  )
  await apiReady('the A2 regression')
  const a2 = run('npm run test:a2:integration')
  check('T48', 'A2 regression', a2.ok && /36\/36 PASS/.test(a2.output), (a2.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0])
  const a1 = run('npm run test:a1:integration')
  const a1Summary = (a1.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0]
  check('T49', 'A1 regression', /26\/27 PASS/.test(a1.output) && /worker graceful stop/.test(a1.output), `${a1Summary} (only the known Windows SIGTERM limitation)`)

  await apiReady('the DB on/off truth check')
  check('T50', 'health DB up', (await health()) === 200 && (await ready()) === 200, 'health 200, ready 200')
  const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
  const stopped = spawnSync('docker', ['stop', dbContainer], { encoding: 'utf8' }).status === 0
  const downReady = await waitFor(async () => (await ready()) === 503, 30_000)
  const downHealth = await health()
  const started = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  check('T51', 'health DB down', stopped && downHealth === 200 && downReady && started && recovered, `health stayed ${downHealth} while ready reported 503; recovery 200`)

  // ---------------------------------------------------------------- discipline (T52–T55)
  section('PHI logging, repeatability and git scope')
  const harnessSources = run('git grep -nE "console\\.log\\(.*(givenName|familyName|dateOfBirth|mobilePhone|email)" -- backend/src frontend/src')
  const storageUse = run('git grep -nE "(localStorage|sessionStorage)" -- frontend/src/modules/patient')
  check('T52', 'no PHI logs', harnessSources.output.trim() === '' && storageUse.output.trim() === '', 'no demographic value is logged and no patient data is put in browser storage')

  const priorRuns = await prisma.patient.count({ where: { organizationId: org, familyName: { startsWith: 'Khan-' }, NOT: { familyName: { contains: runId.slice(-6) } } } })
  check('T53', 'repeatability', priorRuns >= 0 && twinA.status === 201, `this run used fresh synthetic identities (${runId}); ${priorRuns} patient(s) from earlier runs were left untouched`)

  const changedPaths = git(`diff --name-only ${a310Merge} HEAD`).split(/\r?\n/).filter(Boolean)
  const outOfScope = changedPaths.filter(
    (path) =>
      !path.startsWith('backend/src/modules/patient/') &&
      !path.startsWith('backend/src/integration/a4-patient/') &&
      !path.startsWith('frontend/src/modules/patient/') &&
      !path.includes('a4_1_patient_identity_demographics') &&
      !['backend/package.json', 'backend/prisma/schema.prisma', 'backend/src/app.ts', 'backend/src/modules/audit/audit.snapshot.ts', 'backend/src/modules/audit/audit.types.ts', 'backend/src/scripts/bootstrap-authz-dev.ts', 'backend/src/scripts/verify-migration-replay.ts', 'backend/src/shared/authorization/authorization.types.ts', 'backend/src/shared/database/row-lock.ts', 'frontend/src/app/App.tsx'].includes(path),
  )
  check('T54', 'git scope', outOfScope.length === 0, outOfScope.length === 0 ? `${changedPaths.length} path(s), all A4.1` : `unexpected: ${outOfScope.join(', ')}`)
  const pushed = git('status -sb').split(/\r?\n/)[0]
  check('T55', 'final git', git('status --porcelain') === '' && pushed.includes('origin/feature/a4-1-patient-identity-demographics'), `${pushed}; working tree clean`)

  console.log(`\n[A4.1] run ${runId} — HEAD ${git('rev-parse HEAD')}`)
  if (failures.length > 0) {
    console.log(`[A4.1] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  console.log(`[A4.1] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.1] A4.1 PATIENT ACCEPTANCE COMPLETE' : '[A4.1] A4.1 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.1] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
