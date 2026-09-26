import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { createEncounterObservation, removeEncounterObservation } from '../../modules/encounter-observation/encounter-observation.service.ts'
import { findEncounterObservationOwnership } from '../../modules/encounter-observation/encounter-observation.repository.ts'
import { removeEncounterActivity } from '../../modules/encounter-activity/encounter-activity.service.ts'
import { findEncounterOwnership } from '../../modules/encounter/encounter.repository.ts'

// A4.7 — focused acceptance for Encounter Observation / Structured Billing Facts (T01–T99). Valid
// fixtures are created through their owning routes; the database is READ for structural and audit
// proof. Records of ANOTHER organization are created directly, because this tenant's routes
// correctly refuse to author them. ADVERSARIAL fixtures (stored rows the service would never write)
// are written directly only to prove the database or the reader refuses them, and are removed right
// after. Every identifier and fact key is synthetic.

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.7] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.7] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n[A4.7] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

const runId = `A47-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A4.6 FINAL PASS was merged into main as PR #44; A4.7 is branched from exactly that merge.
const a46Merge = '95856b0'
const a47Branch = 'feature/a4-7-encounter-observation-structured-facts'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const day = (text: string) => new Date(`${text}T00:00:00.000Z`)
const allowedAuditKeys = ['id', 'removedAt', 'updatedAt']
const MISSING = '11111111-1111-4111-8111-111111111111'

async function observationAuditCount(): Promise<number> {
  return prisma.auditEvent.count({ where: { organizationId: org, entityType: 'ENCOUNTER_OBSERVATION' } })
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

// Holds the writer that reaches `probe` (inside its Encounter lock) until released.
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

// A direct write the service would never make; resolves to the database error text, or '' if the
// database accepted it (the transaction is always rolled back).
async function attemptAdversarialInsert(write: (tx: typeof prisma) => Promise<unknown>): Promise<string> {
  const rollback = new Error('rollback')
  try {
    await prisma.$transaction(async (tx) => {
      await write(tx as unknown as typeof prisma)
      throw rollback
    })
  } catch (error) {
    if (error === rollback) return ''
    return String((error as Error).message ?? error)
  }
  return ''
}

const keysWithin = (state: unknown) => Object.keys((state ?? {}) as Record<string, unknown>).every((key) => allowedAuditKeys.includes(key))

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A4.7] Encounter observation / structured billing facts — run ${runId}`)
  console.log(`[A4.7] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  section('Start gate, schema and the narrow A4.6 guard')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'start gate',
    gitOk(`merge-base --is-ancestor ${a46Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${a46Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD') && branch === a47Branch,
    `branch ${branch}; A4.6 merge ${a46Merge} (PR #44) is on main and is an ancestor; the branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationFile = run('git ls-files prisma/migrations')
    .output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('a4_7_encounter_observation_structured_facts') && line.endsWith('migration.sql'))
  const migrationSql = migrationFile.length > 0 ? run(`git show HEAD:./${migrationFile[0]}`).output : ''
  const bare = migrationSql.replace(/--.*$/gm, '')
  const createdTables = [...bare.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).sort()
  const alteredTables = [...bare.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
  const checkNames = [
    'encounter_observations_fact_key_nonblank_chk',
    'encounter_observations_value_type_chk',
    'encounter_observations_text_nonblank_chk',
    'encounter_observations_unit_nonblank_chk',
    'encounter_observations_typed_value_chk',
  ]
  const fkNames = ['encounter_observations_encounter_id_fkey', 'encounter_observations_encounter_activity_id_fkey']
  // The only existing-owner code change allowed: the A4.6 removal dependency guard (§17, §25).
  const guardDiff = spawnSync('git', ['diff', '--numstat', 'origin/main...HEAD', '--', ':/backend/src/modules/encounter-activity'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/).filter(Boolean)
  const guardOk =
    guardDiff.length === 1 &&
    /\tbackend\/src\/modules\/encounter-activity\/encounter-activity\.service\.ts$/.test(guardDiff[0]) &&
    Number(guardDiff[0].split('\t')[0]) <= 6 &&
    Number(guardDiff[0].split('\t')[1]) === 0 &&
    /findActiveObservationCountForActivity/.test(
      spawnSync('git', ['diff', 'origin/main...HEAD', '--', ':/backend/src/modules/encounter-activity/encounter-activity.service.ts'], { encoding: 'utf8' }).stdout,
    )
  check(
    'T03',
    'migration scope',
    migrationFile.length === 1 &&
      JSON.stringify(createdTables) === JSON.stringify(['encounter_observations']) &&
      alteredTables.every((table) => table === 'encounter_observations') &&
      (bare.match(/FOREIGN KEY/g) ?? []).length === 2 &&
      checkNames.every((name) => bare.includes(`"${name}"`)) &&
      !/CREATE UNIQUE INDEX/.test(bare) &&
      !/JSONB?\b/i.test(bare) &&
      !/DROP (TABLE|INDEX|COLUMN|CONSTRAINT)|ALTER COLUMN/.test(bare) &&
      guardOk,
    `one migration; creates ${createdTables.join(', ') || 'nothing'}; 2 FKs and 5 CHECKs, no UNIQUE/JSON, no drift; A4.6 code change = the removal guard only (${guardDiff.map((line) => line.split('\t').slice(0, 2).join('+/-')).join(', ') || 'none'} lines)`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'prisma validate/generate/status', validate.ok && generate.ok && status.ok && /up to date/i.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && [...checkNames, ...fkNames].every((name) => new RegExp(`${name} is present`).test(replay.output)),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the 5 CHECKs and 2 FKs survive a clean replay`,
  )

  const fks = await prisma.$queryRaw<{ conname: string; deltype: string }[]>`
    SELECT conname, confdeltype::text AS deltype FROM pg_constraint WHERE conrelid = 'encounter_observations'::regclass AND contype = 'f' ORDER BY conname`
  check('T06', 'FK delete policy', fks.length === 2 && fks.every((fk) => fk.deltype === 'r'), `${fks.map((fk) => fk.conname).join(', ')}: ON DELETE RESTRICT`)

  // ---------------------------------------------------------------- fixtures through owner routes
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
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 200)}`)
    return body as T & { id: string }
  }

  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const newEncounter = async (serviceDate: string) =>
    must('encounter', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate })).body)
  const service = must('service', (await post(`/api/organizations/${org}/services`, { internalCode: `${runId}-SVC`, displayName: 'Synthetic service' })).body)
  const newActivity = async (encounterId: string) => must('activity', (await post(`/api/encounters/${encounterId}/activities`, { serviceId: service.id, quantity: '1' })).body)
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id
  // Run-specific synthetic keys, text and unit, so an audit leak search cannot match anything else.
  const tail = runId.slice(-6)
  const key = (name: string) => `SYNTHETIC_${name}_${tail}`
  const noteText = `Synthetic note ${tail}`
  const unit = `u${tail}`

  // Records of ANOTHER organization — created directly, see the header.
  const foreignPatient = await prisma.patient.create({ data: { organizationId: otherOrg, givenName: 'Synthetic', familyName: `${runId}-foreign`, dateOfBirth: day('1990-01-01') } })
  const foreignFacility = await prisma.facility.create({ data: { organizationId: otherOrg, name: `${runId} foreign facility` } })
  const foreignClinician = await prisma.clinician.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign clinician` } })
  const foreignAssignment = await prisma.clinicianFacilityAssignment.create({ data: { clinicianId: foreignClinician.id, facilityId: foreignFacility.id, effectiveFrom: day('2025-01-01') } })
  const foreignProfile = await prisma.facilityRegulatoryProfile.create({
    data: { facilityId: foreignFacility.id, jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: day('2025-01-01'), status: 'ACTIVE' },
  })
  const foreignService = await prisma.service.create({ data: { organizationId: otherOrg, internalCode: `${runId}-FSVC`, displayName: `${runId} foreign service` } })
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
  const foreignActivity = await prisma.encounterActivity.create({ data: { encounterId: foreignEncounter.id, serviceId: foreignService.id, quantity: new Prisma.Decimal('1') } })
  const foreignKey = key('FOREIGN')
  const foreignObservation = await prisma.encounterObservation.create({ data: { encounterId: foreignEncounter.id, factKey: foreignKey, valueType: 'TEXT', valueText: 'foreign synthetic' } })

  // ---------------------------------------------------------------- DB CHECKs (T07–T11), rolled back
  section('Database CHECKs — one typed value, never blank')
  const dbEncounter = await newEncounter('2026-07-01')
  const insert = (data: Record<string, unknown>) =>
    attemptAdversarialInsert((tx) => tx.encounterObservation.create({ data: { encounterId: dbEncounter.id, factKey: 'K', valueType: 'TEXT', valueText: 'x', ...data } as never }))
  const blankKey = await insert({ factKey: '   ' })
  check('T07', 'factKey DB CHECK', /encounter_observations_fact_key_nonblank_chk/.test(blankKey), 'a blank factKey is refused by the database')
  // An unknown type breaks both value_type_chk and typed_value_chk; PostgreSQL may report either,
  // so the refusal is asserted together with the exact catalog definition of value_type_chk.
  const codeType = await insert({ valueType: 'CODE' })
  const lowerType = await insert({ valueType: 'text' })
  const valueTypeDef = (await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'encounter_observations_value_type_chk'`)[0]?.def ?? ''
  const typeRefused = (text: string) => /encounter_observations_(value_type|typed_value)_chk/.test(text)
  check(
    'T08',
    'valueType DB CHECK',
    [codeType, lowerType].every(typeRefused) && ['TEXT', 'DECIMAL', 'BOOLEAN', 'DATE'].every((type) => valueTypeDef.includes(`'${type}'`)) && (valueTypeDef.match(/'[A-Za-z]+'::text/g) ?? []).length === 4,
    `'CODE' and 'text' refused; ${valueTypeDef}`,
  )
  const twoColumns = await insert({ valueDecimal: new Prisma.Decimal('1') })
  const wrongColumn = await insert({ valueType: 'DECIMAL' })
  const noColumn = await insert({ valueType: 'BOOLEAN', valueText: null })
  check('T09', 'typed DB CHECK', [twoColumns, wrongColumn, noColumn].every((text) => /encounter_observations_typed_value_chk/.test(text)), 'two typed columns, the wrong column and no column are all refused')
  const blankText = await insert({ valueText: '   ' })
  check('T10', 'text DB CHECK', /encounter_observations_text_nonblank_chk/.test(blankText), 'a blank text value is refused')
  const blankUnit = await insert({ valueType: 'DECIMAL', valueText: null, valueDecimal: new Prisma.Decimal('1'), unitCode: '  ' })
  const unitOnText = await insert({ unitCode: 'cm' })
  const unitOnBoolean = await insert({ valueType: 'BOOLEAN', valueText: null, valueBoolean: true, unitCode: 'cm' })
  check(
    'T11',
    'unit DB CHECK',
    /encounter_observations_unit_nonblank_chk/.test(blankUnit) && [unitOnText, unitOnBoolean].every((text) => /encounter_observations_typed_value_chk/.test(text)),
    'a blank unit is refused; a unit is allowed only with DECIMAL',
  )

  const permissions = (await prisma.permission.findMany({ where: { code: { startsWith: 'encounterObservation.' } }, orderBy: { code: 'asc' } })).map((row) => row.code)
  const viewerRole = await prisma.role.findFirst({ where: { code: 'ORG_VIEWER' }, include: { permissions: { include: { permission: true } } } })
  const viewerObservationPermissions = (viewerRole?.permissions ?? []).map((row) => row.permission.code).filter((code) => code.startsWith('encounterObservation.'))
  check(
    'T12',
    'permissions',
    JSON.stringify(permissions) === JSON.stringify(['encounterObservation.create', 'encounterObservation.read', 'encounterObservation.update']) &&
      JSON.stringify(viewerObservationPermissions) === JSON.stringify(['encounterObservation.read']),
    `${permissions.join(', ')}; viewer holds ${viewerObservationPermissions.join(', ')} only; no delete/evaluate permission`,
  )

  // ---------------------------------------------------------------- typed create (T13–T22)
  section('Typed create at Encounter and Activity scope')
  const e1 = await newEncounter('2026-07-02')
  const path1 = `/api/encounters/${e1.id}/observations`
  const rowsOnE1 = () => prisma.encounterObservation.count({ where: { encounterId: e1.id } })
  const textCreate = await post(path1, { factKey: key('NOTE'), value: { type: 'TEXT', text: `  ${noteText}  ` } })
  check(
    'T13',
    'Encounter TEXT create',
    textCreate.status === 201 && textCreate.body?.value?.type === 'TEXT' && textCreate.body?.value?.text === noteText && textCreate.body?.encounterActivityId === null,
    `status ${textCreate.status}; trimmed text, Encounter scope`,
  )
  const decimalCreate = await post(path1, { factKey: key('HEIGHT'), value: { type: 'DECIMAL', decimal: '175.5', unitCode: unit } })
  const storedDecimal = decimalCreate.body?.id
    ? (await prisma.$queryRaw<{ v: string }[]>`SELECT value_decimal::text AS v FROM encounter_observations WHERE id = ${decimalCreate.body.id}::uuid`)[0]?.v
    : ''
  check(
    'T14',
    'Encounter DECIMAL create',
    decimalCreate.status === 201 && decimalCreate.body?.value?.decimal === '175.5' && typeof decimalCreate.body?.value?.decimal === 'string' && storedDecimal === '175.50000000',
    `DTO "${decimalCreate.body?.value?.decimal}" (string); stored NUMERIC ${storedDecimal}`,
  )
  const boolTrue = await post(path1, { factKey: key('FLAG'), value: { type: 'BOOLEAN', boolean: true } })
  const boolFalse = await post(path1, { factKey: key('FLAG'), value: { type: 'BOOLEAN', boolean: false } })
  check('T15', 'Encounter BOOLEAN create', boolTrue.status === 201 && boolTrue.body?.value?.boolean === true && boolFalse.status === 201 && boolFalse.body?.value?.boolean === false, 'true and false preserved exactly')
  const dateCreate = await post(path1, { factKey: key('ONSET'), value: { type: 'DATE', date: '2024-02-29' } })
  const storedDate = dateCreate.body?.id
    ? (await prisma.$queryRaw<{ v: string }[]>`SELECT value_date::text AS v FROM encounter_observations WHERE id = ${dateCreate.body.id}::uuid`)[0]?.v
    : ''
  check('T16', 'Encounter DATE create', dateCreate.status === 201 && dateCreate.body?.value?.date === '2024-02-29' && storedDate === '2024-02-29', `DTO ${dateCreate.body?.value?.date}; stored DATE ${storedDate}`)

  const a1 = await newActivity(e1.id)
  const activityText = await post(path1, { encounterActivityId: a1.id, factKey: key('SITE'), value: { type: 'TEXT', text: `Synthetic site ${tail}` } })
  check('T17', 'Activity TEXT create', activityText.status === 201 && activityText.body?.encounterActivityId === a1.id, `status ${activityText.status}; anchored to an active activity of the same Encounter`)

  const e2 = await newEncounter('2026-07-03')
  const otherActivity = await newActivity(e2.id)
  const auditBeforeAnchors = await observationAuditCount()
  const rowsBeforeAnchors = await rowsOnE1()
  const crossEncounter = await post(path1, { encounterActivityId: otherActivity.id, factKey: key('X'), value: { type: 'TEXT', text: 'x' } })
  const crossTenant = await post(path1, { encounterActivityId: foreignActivity.id, factKey: key('X'), value: { type: 'TEXT', text: 'x' } })
  check(
    'T18',
    'Activity other Encounter',
    crossEncounter.status === 404 && crossTenant.status === 404 && (await rowsOnE1()) === rowsBeforeAnchors && (await observationAuditCount()) === auditBeforeAnchors,
    `another Encounter's activity ${crossEncounter.status}, another tenant's ${crossTenant.status}; refused as not found, no row, no audit`,
  )
  const removedActivity = await newActivity(e1.id)
  await post(`/api/encounter-activities/${removedActivity.id}/remove`, {})
  const removedAnchor = await post(path1, { encounterActivityId: removedActivity.id, factKey: key('X'), value: { type: 'TEXT', text: 'x' } })
  check('T19', 'Removed activity anchor', removedAnchor.status === 400 && (await rowsOnE1()) === rowsBeforeAnchors && (await observationAuditCount()) === auditBeforeAnchors, `status ${removedAnchor.status}; no row, no audit`)
  const missingActivity = await post(path1, { encounterActivityId: MISSING, factKey: key('X'), value: { type: 'TEXT', text: 'x' } })
  check('T20', 'Missing activity', missingActivity.status === 404, `status ${missingActivity.status}`)
  const missingEncounter = await post(`/api/encounters/${MISSING}/observations`, { factKey: key('X'), value: { type: 'TEXT', text: 'x' } })
  check('T21', 'Missing Encounter', missingEncounter.status === 404, `status ${missingEncounter.status}`)
  const badPath = await post('/api/encounters/not-a-uuid/observations', { factKey: key('X'), value: { type: 'TEXT', text: 'x' } })
  const badBody = await post(path1, { encounterActivityId: 'not-a-uuid', factKey: key('X'), value: { type: 'TEXT', text: 'x' } })
  const badGet = await get('/api/encounter-observations/not-a-uuid')
  const safe = !/prisma|stack|sql|uuid.*syntax/i.test(JSON.stringify([badPath.body, badBody.body, badGet.body]))
  check('T22', 'Invalid UUIDs', badBody.status === 400 && [badPath.status, badGet.status].every((s) => s >= 400 && s < 500) && safe, `body ${badBody.status}, path ${badPath.status}, get ${badGet.status}; safe errors, no database text`)

  // ---------------------------------------------------------------- validation (T23–T46)
  section('Validation — typed values, nothing coerced')
  const rowsBeforeInvalid = await rowsOnE1()
  const trimmedKey = await post(path1, { factKey: `  Synthetic_Mixed_${tail}  `, value: { type: 'BOOLEAN', boolean: true } })
  check('T23', 'factKey trim', trimmedKey.status === 201 && trimmedKey.body?.factKey === `Synthetic_Mixed_${tail}`, `stored "${trimmedKey.body?.factKey}" (case preserved)`)
  const statusOf = async (body: unknown) => (await post(path1, body)).status
  check('T24', 'blank factKey', (await statusOf({ factKey: '   ', value: { type: 'TEXT', text: 'x' } })) === 400, '400')
  check('T25', 'unknown top-level field', (await statusOf({ factKey: key('X'), value: { type: 'TEXT', text: 'x' }, operator: '>' })) === 400, '400')
  check('T26', 'unknown value field', (await statusOf({ factKey: key('X'), value: { type: 'TEXT', text: 'x', expression: 'a' } })) === 400, '400')
  check('T27', 'TEXT blank', (await statusOf({ factKey: key('X'), value: { type: 'TEXT', text: '   ' } })) === 400, '400')
  check('T28', 'TEXT with unit', (await statusOf({ factKey: key('X'), value: { type: 'TEXT', text: 'x', unitCode: 'cm' } })) === 400, '400')
  const decimal = async (value: string) => (await post(path1, { factKey: key('NUM'), value: { type: 'DECIMAL', decimal: value } })).body?.value?.decimal
  check('T29', 'DECIMAL integer', (await decimal('42')) === '42', 'exact string "42"')
  check('T30', 'DECIMAL fraction', (await decimal('0.12345678')) === '0.12345678', 'eight decimals kept exactly')
  check('T31', 'DECIMAL negative', (await decimal('-3.25')) === '-3.25', 'accepted; no invented domain rule')
  check('T32', 'DECIMAL zero', (await decimal('0')) === '0', 'accepted; no invented domain rule')
  const rowsMid = await rowsOnE1()
  check('T33', 'DECIMAL exponent', (await statusOf({ factKey: key('X'), value: { type: 'DECIMAL', decimal: '1e3' } })) === 400, '400')
  check('T34', 'DECIMAL >8 fractional digits', (await statusOf({ factKey: key('X'), value: { type: 'DECIMAL', decimal: '1.123456789' } })) === 400, '400; never rounded')
  check('T35', 'DECIMAL oversized integer', (await statusOf({ factKey: key('X'), value: { type: 'DECIMAL', decimal: '12345678901234567' } })) === 400, '17 integer digits -> 400, never a database overflow')
  check('T36', 'DECIMAL JSON number', (await statusOf({ factKey: key('X'), value: { type: 'DECIMAL', decimal: 175.5 } })) === 400 && (await rowsOnE1()) === rowsMid, '400; a string is required; no row from any refused decimal')
  const unitNull = await post(path1, { factKey: key('NUM'), value: { type: 'DECIMAL', decimal: '1', unitCode: null } })
  check('T37', 'DECIMAL unit null', unitNull.status === 201 && unitNull.body?.value?.unitCode === null, `status ${unitNull.status}`)
  const unitTrim = await post(path1, { factKey: key('NUM'), value: { type: 'DECIMAL', decimal: '1', unitCode: `  ${unit}X  ` } })
  check('T38', 'DECIMAL unit trim', unitTrim.status === 201 && unitTrim.body?.value?.unitCode === `${unit}X`, `stored "${unitTrim.body?.value?.unitCode}" (case preserved)`)
  check('T39', 'DECIMAL unit blank', (await statusOf({ factKey: key('X'), value: { type: 'DECIMAL', decimal: '1', unitCode: '  ' } })) === 400, '400; never turned into null')
  check('T40', 'BOOLEAN string true', (await statusOf({ factKey: key('X'), value: { type: 'BOOLEAN', boolean: 'true' } })) === 400, "400; 'true' is not coerced")
  const gotTrue = await get(`/api/encounter-observations/${boolTrue.body?.id}`)
  const gotFalse = await get(`/api/encounter-observations/${boolFalse.body?.id}`)
  check('T41', 'BOOLEAN actual true/false', gotTrue.body?.value?.boolean === true && gotFalse.body?.value?.boolean === false, 'read back as JSON true and false')
  const leap = await post(path1, { factKey: key('DATE'), value: { type: 'DATE', date: '2028-02-29' } })
  check('T42', 'DATE valid leap date', leap.status === 201 && leap.body?.value?.date === '2028-02-29', `status ${leap.status}`)
  check('T43', 'DATE impossible date', (await statusOf({ factKey: key('X'), value: { type: 'DATE', date: '2025-02-29' } })) === 400, '400')
  check('T44', 'DATE timestamp', (await statusOf({ factKey: key('X'), value: { type: 'DATE', date: '2026-07-02T00:00:00.000Z' } })) === 400, '400; no timestamp-to-date coercion')
  const future = await post(path1, { factKey: key('DATE'), value: { type: 'DATE', date: '2099-12-31' } })
  check('T45', 'DATE future date', future.status === 201 && future.body?.value?.date === '2099-12-31', 'accepted; no invented future rule')
  const invalidRows = (await rowsOnE1()) - rowsBeforeInvalid
  const repeatKey = key('REPEAT')
  const repeatA = await post(path1, { factKey: repeatKey, value: { type: 'TEXT', text: 'first' } })
  const repeatB = await post(path1, { factKey: repeatKey, value: { type: 'TEXT', text: 'first' } })
  const repeatActive = await prisma.encounterObservation.count({ where: { encounterId: e1.id, factKey: repeatKey, removedAt: null } })
  check(
    'T46',
    'Repeated factKey',
    repeatA.status === 201 && repeatB.status === 201 && repeatA.body?.id !== repeatB.body?.id && repeatActive === 2 && invalidRows === 9,
    'two same-key rows coexist; only the 9 valid creates above were stored',
  )

  // ---------------------------------------------------------------- reads (T47–T56)
  section('Reads, roles and tenancy')
  const listEncounter = await newEncounter('2026-07-04')
  const listPath = `/api/encounters/${listEncounter.id}/observations`
  const lo1 = must('lo1', (await post(listPath, { factKey: key('L1'), value: { type: 'DECIMAL', decimal: '-1.5', unitCode: unit } })).body)
  const lo2 = must('lo2', (await post(listPath, { factKey: key('L2'), value: { type: 'DATE', date: '2026-01-15' } })).body)
  const lo3 = must('lo3', (await post(listPath, { factKey: key('L3'), value: { type: 'BOOLEAN', boolean: false } })).body)
  await post(`/api/encounter-observations/${lo2.id}/remove`, {})
  const listed = await get(listPath)
  const listedIds: string[] = (listed.body?.items ?? []).map((item: { id: string }) => item.id)
  check('T47', 'List active', listed.status === 200 && JSON.stringify(listedIds) === JSON.stringify([lo1.id, lo3.id]), `status ${listed.status}; removed row not listed`)
  const dbOrder = (await prisma.encounterObservation.findMany({ where: { encounterId: listEncounter.id, removedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((row) => row.id)
  const listedAgain = await get(listPath)
  check('T48', 'Display order', JSON.stringify(listedIds) === JSON.stringify(dbOrder) && JSON.stringify(listedAgain.body) === JSON.stringify(listed.body), 'createdAt then id; identical on repeat; no semantic precedence')
  const gotActive = await get(`/api/encounter-observations/${lo1.id}`)
  const listedLo1 = (listed.body?.items ?? []).find((item: { id: string }) => item.id === lo1.id)
  check(
    'T49',
    'Exact get active',
    gotActive.status === 200 && JSON.stringify(gotActive.body) === JSON.stringify(listedLo1) && JSON.stringify(gotActive.body?.value) === JSON.stringify({ type: 'DECIMAL', decimal: '-1.5', unitCode: unit }),
    'exact DTO, identical to the list entry',
  )
  const gotRemoved = await get(`/api/encounter-observations/${lo2.id}`)
  check('T50', 'Exact get removed', gotRemoved.status === 200 && gotRemoved.body?.removedAt !== null && gotRemoved.body?.value?.date === '2026-01-15', 'historical DTO with removedAt and its original value')
  const viewerList = await get(listPath, asViewer)
  const viewerGet = await get(`/api/encounter-observations/${lo1.id}`, asViewer)
  check('T51', 'Viewer list/get', viewerList.status === 200 && viewerGet.status === 200, `list ${viewerList.status}, get ${viewerGet.status}`)
  const auditBeforeViewer = await observationAuditCount()
  const rowsBeforeViewer = await prisma.encounterObservation.count({ where: { encounterId: listEncounter.id } })
  const viewerCreate = await post(listPath, { factKey: key('X'), value: { type: 'TEXT', text: 'x' } }, asViewer)
  check(
    'T52',
    'Viewer create',
    viewerCreate.status === 403 && (await prisma.encounterObservation.count({ where: { encounterId: listEncounter.id } })) === rowsBeforeViewer && (await observationAuditCount()) === auditBeforeViewer,
    `status ${viewerCreate.status}; no row, no audit`,
  )
  const viewerRemove = await post(`/api/encounter-observations/${lo1.id}/remove`, {}, asViewer)
  check(
    'T53',
    'Viewer remove',
    viewerRemove.status === 403 && (await prisma.encounterObservation.findUniqueOrThrow({ where: { id: lo1.id } })).removedAt === null && (await observationAuditCount()) === auditBeforeViewer,
    `status ${viewerRemove.status}; no change, no audit`,
  )
  const crossList = await get(`/api/encounters/${foreignEncounter.id}/observations`)
  check('T54', 'Cross-tenant Encounter list', (crossList.status === 403 || crossList.status === 404) && !JSON.stringify(crossList.body).includes(foreignKey), `status ${crossList.status}; no foreign disclosure`)
  const crossGet = await get(`/api/encounter-observations/${foreignObservation.id}`)
  const crossRemove = await post(`/api/encounter-observations/${foreignObservation.id}/remove`, {})
  check(
    'T55',
    'Cross-tenant observation ID',
    [crossGet.status, crossRemove.status].every((s) => s === 403 || s === 404) &&
      !JSON.stringify([crossGet.body, crossRemove.body]).includes(foreignKey) &&
      (await prisma.encounterObservation.findUniqueOrThrow({ where: { id: foreignObservation.id } })).removedAt === null,
    `statuses ${crossGet.status},${crossRemove.status}; no foreign fact disclosed or changed`,
  )
  const observationOwner = await findEncounterObservationOwnership(lo1.id)
  const encounterOwner = await findEncounterOwnership(listEncounter.id)
  check(
    'T56',
    'Pre-auth ownership',
    JSON.stringify(Object.keys(observationOwner ?? {})) === JSON.stringify(['organizationId']) &&
      JSON.stringify(Object.keys(encounterOwner ?? {})) === JSON.stringify(['organizationId']) &&
      observationOwner?.organizationId === org,
    'organizationId only; no fact or value loaded',
  )

  // ---------------------------------------------------------------- remove and correction (T57–T61)
  section('Remove — history kept, correction by a new row')
  const rmEncounter = await newEncounter('2026-07-05')
  const rmPath = `/api/encounters/${rmEncounter.id}/observations`
  const rm = must('rm', (await post(rmPath, { factKey: key('RM'), value: { type: 'DECIMAL', decimal: '3.5', unitCode: unit } })).body)
  const removed = await post(`/api/encounter-observations/${rm.id}/remove`, {})
  const rmRow = await prisma.encounterObservation.findUnique({ where: { id: rm.id } })
  check('T57', 'Remove active', removed.status === 200 && removed.body?.removedAt !== null && !!rmRow && rmRow.removedAt !== null && rmRow.valueDecimal?.toFixed() === '3.5', `status ${removed.status}; removedAt set; row and value retained`)
  const auditBeforeTwice = await observationAuditCount()
  const removeTwice = await post(`/api/encounter-observations/${rm.id}/remove`, {})
  check('T58', 'Remove twice', removeTwice.status === 400 && (await observationAuditCount()) === auditBeforeTwice, `status ${removeTwice.status}; no second audit`)
  const deleteRoute = await callApi(baseUrl, `/api/encounter-observations/${rm.id}`, asAdmin({ method: 'DELETE' }))
  const patchRoute = await callApi(baseUrl, `/api/encounter-observations/${lo1.id}`, asAdmin({ method: 'PATCH', body: JSON.stringify({ value: { type: 'DECIMAL', decimal: '9' } }) }))
  const lo1After = await get(`/api/encounter-observations/${lo1.id}`)
  check(
    'T59',
    'No hard DELETE',
    deleteRoute.status === 404 && (await prisma.encounterObservation.count({ where: { id: rm.id } })) === 1 && patchRoute.status === 404 && lo1After.body?.value?.decimal === '-1.5',
    `DELETE -> ${deleteRoute.status} (row remains); PATCH -> ${patchRoute.status} (value unchanged)`,
  )
  const restore = await post(`/api/encounter-observations/${rm.id}/restore`, {})
  check('T60', 'No restore', restore.status === 404 && (await prisma.encounterObservation.findUniqueOrThrow({ where: { id: rm.id } })).removedAt !== null, `restore -> ${restore.status}`)
  const corrected = await post(rmPath, { factKey: key('RM'), value: { type: 'DECIMAL', decimal: '2.5', unitCode: unit } })
  const oldRow = await prisma.encounterObservation.findUniqueOrThrow({ where: { id: rm.id } })
  const rmActive = await get(rmPath)
  check(
    'T61',
    'Correction pattern',
    corrected.status === 201 &&
      corrected.body?.id !== rm.id &&
      oldRow.removedAt !== null &&
      oldRow.valueDecimal?.toFixed() === '3.5' &&
      JSON.stringify((rmActive.body?.items ?? []).map((item: { id: string }) => item.id)) === JSON.stringify([corrected.body?.id]),
    'old row removed with its original value retained; the correction is a new active row',
  )

  // ---------------------------------------------------------------- concurrency and the A4.6 guard (T62–T67)
  section('Concurrency and the A4.6 activity-removal guard')
  const createCreate = await newEncounter('2026-07-06')
  let hold = holdAt('encounterObservation.create')
  const createOne = createEncounterObservation(createCreate.id, { factKey: key('CC'), value: { type: 'TEXT', text: 'one' } }, actorUserId)
  await hold.arrived
  const createTwo = createEncounterObservation(createCreate.id, { factKey: key('CC'), value: { type: 'TEXT', text: 'two' } }, actorUserId)
  const createCreateBlocked = await waitForLockWaiter()
  hold.release()
  const [createOneResult, createTwoResult] = await Promise.all([createOne, createTwo])
  clearConcurrencyProbes()
  check(
    'T62',
    'Create/create concurrency',
    createCreateBlocked && createOneResult.ok && createTwoResult.ok && (await prisma.encounterObservation.count({ where: { encounterId: createCreate.id, removedAt: null } })) === 2,
    'the second create waited on the Encounter lock; both facts preserved',
  )

  const createRemove = await newEncounter('2026-07-07')
  const cr1 = must('cr1', (await post(`/api/encounters/${createRemove.id}/observations`, { factKey: key('CR'), value: { type: 'TEXT', text: 'old' } })).body)
  hold = holdAt('encounterObservation.remove')
  const removeHeld = removeEncounterObservation(cr1.id, {}, actorUserId)
  await hold.arrived
  const createDuringRemove = createEncounterObservation(createRemove.id, { factKey: key('CR'), value: { type: 'TEXT', text: 'new' } }, actorUserId)
  const createRemoveBlocked = await waitForLockWaiter()
  hold.release()
  const [removeHeldResult, createDuringRemoveResult] = await Promise.all([removeHeld, createDuringRemove])
  clearConcurrencyProbes()
  const createRemoveActive = (await prisma.encounterObservation.findMany({ where: { encounterId: createRemove.id, removedAt: null } })).map((row) => row.id)
  check(
    'T63',
    'Create/remove concurrency',
    createRemoveBlocked &&
      removeHeldResult.ok &&
      createDuringRemoveResult.ok &&
      JSON.stringify(createRemoveActive) === JSON.stringify([createDuringRemoveResult.value.id]),
    'serialized on the Encounter; both writes kept, no lost write',
  )

  // Observation create vs activity removal, in both lock orders: never an active fact on a removed activity.
  const orphanFree = async (encounterId: string) =>
    (await prisma.encounterObservation.count({ where: { encounterId, removedAt: null, encounterActivity: { removedAt: { not: null } } } })) === 0
  const raceA = await newEncounter('2026-07-08')
  const raceActivityA = await newActivity(raceA.id)
  hold = holdAt('encounterActivity.remove')
  const activityRemoveFirst = removeEncounterActivity(raceActivityA.id, {}, actorUserId)
  await hold.arrived
  const observationWaits = createEncounterObservation(raceA.id, { encounterActivityId: raceActivityA.id, factKey: key('RACE'), value: { type: 'TEXT', text: 'x' } }, actorUserId)
  const observationBlocked = await waitForLockWaiter()
  hold.release()
  const [activityRemoveFirstResult, observationWaitsResult] = await Promise.all([activityRemoveFirst, observationWaits])
  clearConcurrencyProbes()
  const raceB = await newEncounter('2026-07-09')
  const raceActivityB = await newActivity(raceB.id)
  hold = holdAt('encounterObservation.create')
  const observationFirst = createEncounterObservation(raceB.id, { encounterActivityId: raceActivityB.id, factKey: key('RACE'), value: { type: 'TEXT', text: 'x' } }, actorUserId)
  await hold.arrived
  const activityRemoveWaits = removeEncounterActivity(raceActivityB.id, {}, actorUserId)
  const activityRemoveBlocked = await waitForLockWaiter()
  hold.release()
  const [observationFirstResult, activityRemoveWaitsResult] = await Promise.all([observationFirst, activityRemoveWaits])
  clearConcurrencyProbes()
  check(
    'T64',
    'Observation create vs activity remove',
    observationBlocked &&
      activityRemoveBlocked &&
      activityRemoveFirstResult.ok &&
      !observationWaitsResult.ok &&
      observationFirstResult.ok &&
      !activityRemoveWaitsResult.ok &&
      (await orphanFree(raceA.id)) &&
      (await orphanFree(raceB.id)),
    'removal first -> the waiting create is refused (removed anchor); create first -> the waiting removal is refused (guard); no orphan either way',
  )

  const guardEncounter = await newEncounter('2026-07-10')
  const guardActivity = await newActivity(guardEncounter.id)
  const guardObservation = must('guard obs', (await post(`/api/encounters/${guardEncounter.id}/observations`, { encounterActivityId: guardActivity.id, factKey: key('GUARD'), value: { type: 'TEXT', text: 'x' } })).body)
  const activityAuditBefore = await prisma.auditEvent.count({ where: { entityId: guardActivity.id, actionCode: 'encounterActivity.removed' } })
  const guarded = await post(`/api/encounter-activities/${guardActivity.id}/remove`, {})
  const activityStill = await prisma.encounterActivity.findUniqueOrThrow({ where: { id: guardActivity.id } })
  check(
    'T65',
    'A4.6 guard',
    guarded.status === 400 &&
      /remove active activity observations first/.test(String(guarded.body?.error?.message)) &&
      activityStill.removedAt === null &&
      (await prisma.auditEvent.count({ where: { entityId: guardActivity.id, actionCode: 'encounterActivity.removed' } })) === activityAuditBefore,
    `status ${guarded.status}; "${guarded.body?.error?.message}"; activity still active, no audit`,
  )
  const observationUntouched = (await prisma.encounterObservation.findUniqueOrThrow({ where: { id: guardObservation.id } })).removedAt === null
  await post(`/api/encounter-observations/${guardObservation.id}/remove`, {})
  const unguarded = await post(`/api/encounter-activities/${guardActivity.id}/remove`, {})
  check('T66', 'A4.6 guard after observation remove', unguarded.status === 200 && unguarded.body?.removedAt !== null, `status ${unguarded.status}; the activity is removable once its observations are removed`)
  check(
    'T67',
    'No cascade logical delete',
    observationUntouched && (await prisma.encounterObservation.count({ where: { encounterActivityId: guardActivity.id } })) === 1,
    'the refused removal left the observation active; nothing was cascade-removed',
  )

  // ---------------------------------------------------------------- stored invariant (T68–T71)
  section('Stored-row invariant — fail closed, never repaired')
  check(
    'T68',
    'Stored invalid valueType adversarial',
    typeRefused(codeType) && typeRefused(lowerType),
    'an unknown value type cannot be stored (value_type/typed CHECKs); the reader\'s fail-closed rule for it is proven by the unit tests',
  )
  check(
    'T69',
    'Stored multiple typed columns adversarial',
    [twoColumns, wrongColumn, noColumn].every((text) => /encounter_observations_typed_value_chk/.test(text)),
    'multiple, mismatched or missing typed columns cannot be stored (typed CHECK); the reader rule is proven by the unit tests',
  )
  check(
    'T70',
    'Stored blank text/unit adversarial',
    /encounter_observations_text_nonblank_chk/.test(blankText) && /encounter_observations_unit_nonblank_chk/.test(blankUnit),
    'blank text and blank unit cannot be stored (nonblank CHECKs); the reader rule is proven by the unit tests',
  )
  // ADVERSARIAL FIXTURE: an observation anchored to an activity of ANOTHER Encounter (the database
  // FK alone cannot see the Encounter mismatch). The reader must fail closed; the row is removed.
  const plantedEncounter = await newEncounter('2026-07-11')
  const planted = await prisma.encounterObservation.create({
    data: { encounterId: plantedEncounter.id, encounterActivityId: otherActivity.id, factKey: key('PLANT'), valueType: 'TEXT', valueText: 'planted' },
  })
  const plantedGet = await get(`/api/encounter-observations/${planted.id}`)
  const plantedList = await get(`/api/encounters/${plantedEncounter.id}/observations`)
  const plantedUnchanged = (await prisma.encounterObservation.findUniqueOrThrow({ where: { id: planted.id } })).encounterActivityId === otherActivity.id
  await prisma.encounterObservation.delete({ where: { id: planted.id } })
  check(
    'T71',
    'Stored cross-Encounter activity adversarial',
    plantedGet.status === 409 && plantedGet.body?.error?.code === 'INTEGRITY_CONFLICT' && plantedList.status === 409 && plantedUnchanged,
    `get ${plantedGet.status} and list ${plantedList.status} fail closed as INTEGRITY_CONFLICT; row left unrepaired (adversarial row removed)`,
  )

  // ---------------------------------------------------------------- audit (T72–T75)
  section('PHI / clinical-minimized audit')
  const createdEvent = await prisma.auditEvent.findFirst({ where: { entityId: textCreate.body?.id, actionCode: 'encounterObservation.created' } })
  const createdKeys = Object.keys((createdEvent?.afterState ?? {}) as Record<string, unknown>).sort()
  check('T72', 'Create audit', !!createdEvent && createdEvent.entityType === 'ENCOUNTER_OBSERVATION' && createdEvent.beforeState === null && keysWithin(createdEvent.afterState), `snapshot keys: ${createdKeys.join(', ')}`)
  const removedEvent = await prisma.auditEvent.findFirst({ where: { entityId: rm.id, actionCode: 'encounterObservation.removed' } })
  check(
    'T73',
    'Remove audit',
    !!removedEvent && keysWithin(removedEvent.beforeState) && keysWithin(removedEvent.afterState) && ((removedEvent.afterState ?? {}) as Record<string, unknown>).removedAt !== undefined,
    'removed event records the row and its removal only',
  )
  const runRowIds = (await prisma.encounterObservation.findMany({ where: { encounter: { patientId: patient.id } }, select: { id: true } })).map((row) => row.id)
  const runEvents = await prisma.auditEvent.findMany({ where: { entityType: 'ENCOUNTER_OBSERVATION', entityId: { in: runRowIds } } })
  const runEventText = JSON.stringify(runEvents.map((event) => [event.beforeState, event.afterState]))
  const forbidden = ['SYNTHETIC_', `Synthetic_Mixed_${tail}`, noteText, unit, '175.5', '2024-02-29', '2099-12-31', e1.id, a1.id, listEncounter.id, rmEncounter.id, patient.id, facility.id, clinician.id]
  const leaked = forbidden.filter((value) => runEventText.includes(value))
  check(
    'T74',
    'Audit PHI minimization',
    runEvents.length > 0 && leaked.length === 0 && runEvents.every((event) => keysWithin(event.beforeState) && keysWithin(event.afterState)),
    `${runEvents.length} event(s); keys only id/removedAt/updatedAt; no factKey, value, unit, anchor, context or request body`,
  )
  const auditBeforeBatch = await observationAuditCount()
  await post(path1, { encounterActivityId: foreignActivity.id, factKey: key('X'), value: { type: 'TEXT', text: 'x' } }) // foreign anchor
  await post(path1, { encounterActivityId: removedActivity.id, factKey: key('X'), value: { type: 'TEXT', text: 'x' } }) // removed anchor
  await post(path1, { factKey: key('X'), value: { type: 'TEXT', text: 'x' } }, asViewer) // denied
  await post(path1, { factKey: key('X'), value: { type: 'BOOLEAN', boolean: 'false' } }) // invalid value
  await post(path1, { factKey: key('X'), value: { type: 'TEXT', text: 'x' }, formula: '1+1' }) // unknown field
  await post(`/api/encounter-observations/${rm.id}/remove`, {}) // already removed
  await post(`/api/encounter-observations/${lo1.id}/remove`, {}, asViewer) // denied
  check('T75', 'No false audit', (await observationAuditCount()) === auditBeforeBatch, `before=${auditBeforeBatch} after=${await observationAuditCount()}`)

  // ---------------------------------------------------------------- scope guards (T76–T82)
  section('Scope guards — typed facts, nothing more')
  const columns = await prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
    SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'encounter_observations' ORDER BY column_name`
  const names = columns.map((row) => row.column_name)
  check('T76', 'No organizationId duplicate', !names.includes('organization_id') && !names.some((name) => /(patient|facility|clinician|payer|member|service_date)/i.test(name)), `columns: ${names.join(', ')}`)
  check('T77', 'No JSON field', !columns.some((row) => /json/i.test(row.data_type)), `types: ${[...new Set(columns.map((row) => row.data_type))].join(', ')}`)
  check('T78', 'No DSL fields', !names.some((name) => /(operator|expression|condition|action|formula|rule|script|comparator|range)/i.test(name)), 'no operator/expression/condition/action/formula column')
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).map((row) => row.table_name)
  const observationTables = tables.filter((name) => /observation/i.test(name))
  check(
    'T79',
    'No EHR sprawl',
    JSON.stringify(observationTables) === JSON.stringify(['encounter_observations']) && !tables.some((name) => /(vital|lab_result|labs|clinical_note|document|chart|observation_definition)/i.test(name)),
    `observation tables: ${observationTables.join(', ')}; no vitals/lab/document/note/definition schema`,
  )
  check('T80', 'No A5 fields', !names.some((name) => /(eligib|authoriz|evidence|readiness|status|verified)/i.test(name)), 'no A5 field')
  check('T81', 'No A6 fields', !names.some((name) => /(claim|line|price|amount|tariff|responsib|submission)/i.test(name)), 'no A6 field')
  const externalIdentifierColumns = (await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'external_identifiers'`).map((row) => row.column_name)
  const targetCheck = (await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'external_identifiers_exactly_one_target_chk'`)[0]?.def ?? ''
  // A4.8 (PR #46) added the approved `encounter_id` target, so the exact-one-target CHECK now names
  // it and the original "no encounter column" assertion is obsolete. A4.7's own boundary is
  // unchanged: an Observation is not an identity target, and none of a fact's content — its key,
  // typed value or unit — may be duplicated onto the identity table.
  const observationLeak = externalIdentifierColumns.filter((name) =>
    /(observation|fact_key|value_text|value_decimal|value_boolean|value_date|unit_code)/i.test(name),
  )
  check(
    'T82',
    'No external-ID extension',
    !!targetCheck && !/observation/i.test(targetCheck) && observationLeak.length === 0,
    observationLeak.length === 0
      ? 'EncounterObservation is not an external-ID target and no typed fact is duplicated; the approved encounter_id target is named by the CHECK'
      : `Observation leaked into the identity table: ${observationLeak.join(', ')}`,
  )

  // ---------------------------------------------------------------- build (T83–T85)
  section('Unit, typecheck and build')
  const unitTests = run('npm run test:unit')
  check('T83', 'Unit tests', unitTests.ok && /ℹ fail 0/.test(unitTests.output), `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]} ${(unitTests.output.match(/ℹ fail \d+/) ?? [''])[0]}`.trim())
  const typecheck = run('npm run typecheck')
  check('T84', 'Backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T85', 'Frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])

  // ---------------------------------------------------------------- regressions (T86–T94)
  section('Regressions — A4.6 and, nested inside it, A4.5 → A1')
  // The A4.6 suite runs A4.5 itself, which runs every earlier suite, each with its narrowly documented
  // expected IDs; so it is run ONCE here and its nested verdicts are read back for T87–T94. On the
  // A4.7 branch only A4.6's own branch-identity/diff checks and its "no A4.7 schema yet" guard cannot
  // hold: T01 (branch), T69 (no observation table — A4.7 now adds it), T88 (git scope since A4.5) and
  // T89 (tracking its own branch). Every other A4.6 check — including every removal path the new
  // dependency guard touches — must pass.
  await apiReady('the A4.6 regression')
  const a46 = run('npm run test:a4:activities')
  const a46Failing = failedIds(a46.output, 'A4.6')
  const a46Expected = ['T01', 'T69', 'T88', 'T89']
  const a46Unexpected = a46Failing.filter((id) => !a46Expected.includes(id))
  const a46Summary = (a46.output.match(/\[A4\.6\] automated summary: [^\n]*/) ?? ['no summary'])[0]
  check(
    'T86',
    'A4.6 regression',
    a46Unexpected.length === 0 &&
      /T44 remove active \.* PASS/.test(a46.output) &&
      /T57 create\/remove race \.* PASS/.test(a46.output) &&
      /T58 remove\/remove race \.* PASS/.test(a46.output) &&
      /T59 A4\.5\/A4\.6 common lock \.* PASS/.test(a46.output),
    a46Unexpected.length === 0 ? `${a46Summary}; only A4.6's own branch/diff/"no A4.7 schema" checks differ (${a46Failing.join(', ') || 'none'})` : `unexpected A4.6 failures: ${a46Unexpected.join(', ')}`,
  )
  const nested = (id: string, title: string, a46Id: string, a46Title: string) => {
    const line = a46.output.match(new RegExp(`\\[A4\\.6\\] ${a46Id} ${a46Title.replace(/\./g, '\\.')} \\.* (PASS|FAIL)( - [^\\n]*)?`))
    check(id, title, line?.[1] === 'PASS', line ? `via A4.6 ${a46Id}${line[2] ?? ''}` : `A4.6 ${a46Id} line missing`)
  }
  nested('T87', 'A4.5 regression', 'T77', 'A4.5 regression')
  nested('T88', 'A4.4 regression', 'T78', 'A4.4 regression')
  nested('T89', 'A4.3 regression', 'T79', 'A4.3 regression')
  nested('T90', 'A4.2 regression', 'T80', 'A4.2 regression')
  nested('T91', 'A4.1 regression', 'T81', 'A4.1 regression')
  nested('T92', 'A3 regression', 'T82', 'A3 regression')
  nested('T93', 'A2 regression', 'T83', 'A2 regression')
  nested('T94', 'A1 regression', 'T84', 'A1 regression')

  // ---------------------------------------------------------------- DB truth, repeatability, privacy (T95–T97)
  section('DB truth, repeatability and privacy')
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
    'T95',
    'DB truth/recovery',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  const priorRows = await prisma.encounterObservation.count({ where: { encounter: { patient: { organizationId: org, familyName: { startsWith: 'A47-' }, NOT: { familyName: { startsWith: runId } } } } } })
  check('T96', 'Repeatability', true, `this run used fresh synthetic values (${runId}); ${priorRows} observation row(s) from earlier runs retained`)

  // git is called WITHOUT a shell, with repository-root `:/` pathspecs. Exit 1 = no match (wanted),
  // anything but 0/1 = the search itself failed, which is a FAIL. The sanity search proves reach.
  const gitGrep = (pattern: string, paths: string[]) => {
    const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
    return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
  }
  const sources = [':/backend/src/modules/encounter-observation', ':/frontend/src/modules/encounter-observation']
  const logged = gitGrep('console[.](log|info|warn|error|debug)[(].*(factKey|value|unit|observation)', sources)
  const stored = gitGrep('(localStorage|sessionStorage)[.][A-Za-z]+[(]', [':/frontend/src/modules/encounter-observation'])
  const urlLeak = gitGrep('[?&](factKey|value|decimal|text|date|unitCode)=', [':/frontend/src/modules/encounter-observation'])
  const sanity = gitGrep('factKey', [':/frontend/src/modules/encounter-observation/encounter-observation.api.ts'])
  check(
    'T97',
    'Logging/storage',
    sanity.status === 0 && logged.status === 1 && stored.status === 1 && urlLeak.status === 1,
    logged.status === 1 && stored.status === 1 && urlLeak.status === 1
      ? 'no observation value logged, put in a query string or kept in browser storage (searches verified to reach the sources)'
      : `logged=${logged.status} storage=${stored.status} url=${urlLeak.status}: ${[logged.output, stored.output, urlLeak.output].join(' | ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- git (T98–T99)
  section('Git scope')
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/app.ts',
    'backend/src/modules/audit/audit.snapshot.ts',
    'backend/src/modules/audit/audit.types.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    // §17/§25: the one allowed existing-owner change — the A4.6 activity-removal dependency guard.
    'backend/src/modules/encounter-activity/encounter-activity.service.ts',
    // The developer check is registered where the latest main composes checks: App.tsx today, or
    // FE-01's developer/checkRegistry.tsx once FE-01 is merged.
    'frontend/src/app/App.tsx',
    'frontend/src/developer/checkRegistry.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/encounter-observation/') &&
      !file.startsWith('backend/src/integration/a4-encounter-observation/') &&
      !file.startsWith('frontend/src/modules/encounter-observation/') &&
      !file.includes('a4_7_encounter_observation_structured_facts') &&
      !allowed.includes(file),
  )
  check('T98', 'Git scope', outOfScope.length === 0, outOfScope.length === 0 ? `${changedPaths.length} path(s) since A4.6, all A4.7 + the narrow A4.6 guard` : `unexpected: ${outOfScope.join(', ')}`)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T99', 'Final Git', git('status --porcelain') === '' && tracking.includes(`origin/${a47Branch}`), `${tracking}; working tree ${git('status --porcelain') === '' ? 'clean' : 'dirty'}`)

  console.log(`\n[A4.7] run ${runId} — HEAD ${git('rev-parse HEAD')}`)
  if (failures.length > 0) {
    console.log(`[A4.7] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  console.log(`[A4.7] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.7] A4.7 ENCOUNTER OBSERVATION ACCEPTANCE COMPLETE' : '[A4.7] A4.7 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.7] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    await prisma.$disconnect()
  })
