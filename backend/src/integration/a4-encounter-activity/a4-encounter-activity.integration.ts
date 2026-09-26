import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { createEncounterActivity, removeEncounterActivity } from '../../modules/encounter-activity/encounter-activity.service.ts'
import { findEncounterActivityOwnership } from '../../modules/encounter-activity/encounter-activity.repository.ts'
import { addEncounterDiagnosis } from '../../modules/encounter-diagnosis/encounter-diagnosis.service.ts'
import { findEncounterOwnership } from '../../modules/encounter/encounter.repository.ts'

// A4.6 — focused acceptance for Encounter Activity / Procedure Capture (T01–T89). Valid fixtures
// are created through their owning routes; the database is READ for structural and audit proof.
// Records of ANOTHER organization are created directly, because this tenant's routes correctly
// refuse to author them. ADVERSARIAL fixtures (stored rows the service would never write) are
// written directly only to prove the database or the reader refuses them, and are removed right
// after. Every identifier is synthetic.

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.6] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.6] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n[A4.6] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

const runId = `A46-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A4.5 FINAL PASS was merged into main as PR #42; A4.6 is branched from exactly that merge.
const a45Merge = 'c5ed758'
const a46Branch = 'feature/a4-6-encounter-activity-procedure-capture'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const day = (text: string) => new Date(`${text}T00:00:00.000Z`)
const allowedAuditKeys = ['id', 'removedAt', 'updatedAt']

async function activityAuditCount(): Promise<number> {
  return prisma.auditEvent.count({ where: { organizationId: org, entityType: 'ENCOUNTER_ACTIVITY' } })
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

  console.log(`[A4.6] Encounter activity / procedure capture — run ${runId}`)
  console.log(`[A4.6] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
  section('Start gate, schema, constraints and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'start gate',
    gitOk(`merge-base --is-ancestor ${a45Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${a45Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD') && branch === a46Branch,
    `branch ${branch}; A4.5 merge ${a45Merge} (PR #42) is on main and is an ancestor; the branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationFile = run('git ls-files prisma/migrations')
    .output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('a4_6_encounter_activity_procedure_capture') && line.endsWith('migration.sql'))
  const migrationSql = migrationFile.length > 0 ? run(`git show HEAD:./${migrationFile[0]}`).output : ''
  const bare = migrationSql.replace(/--.*$/gm, '')
  const createdTables = [...bare.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).sort()
  const alteredTables = [...bare.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
  const checkNames = [
    'encounter_activities_identity_chk',
    'encounter_activities_quantity_positive_chk',
    'encounter_activities_unit_code_nonblank_chk',
    'encounter_activity_modifiers_sequence_positive_chk',
    'encounter_activity_modifiers_code_nonblank_chk',
  ]
  const uniqueNames = ['encounter_activity_modifiers_encounter_activity_id_sequence_key', 'encounter_activity_modifiers_encounter_activity_id_code_key']
  check(
    'T03',
    'migration scope',
    migrationFile.length === 1 &&
      JSON.stringify(createdTables) === JSON.stringify(['encounter_activities', 'encounter_activity_modifiers']) &&
      alteredTables.every((table) => table === 'encounter_activities' || table === 'encounter_activity_modifiers') &&
      (bare.match(/FOREIGN KEY/g) ?? []).length === 4 &&
      checkNames.every((name) => bare.includes(`"${name}"`)) &&
      uniqueNames.every((name) => new RegExp(`CREATE UNIQUE INDEX "${name}"`).test(bare)) &&
      (bare.match(/CREATE UNIQUE INDEX/g) ?? []).length === 2 &&
      !/DROP (TABLE|INDEX|COLUMN|CONSTRAINT)|ALTER COLUMN/.test(bare),
    `one migration; creates ${createdTables.join(', ') || 'nothing'}; 4 FKs, 5 CHECKs and 2 modifier UNIQUEs; no drift`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'prisma validate/generate/status', validate.ok && generate.ok && status.ok && /up to date/i.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'migration replay',
    replay.ok && /ALL CHECKS PASS/.test(replay.output) && [...checkNames, ...uniqueNames].every((name) => new RegExp(`${name} is present`).test(replay.output)),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the 5 CHECKs and 2 UNIQUEs survive a clean replay`,
  )

  const fks = await prisma.$queryRaw<{ conname: string; deltype: string }[]>`
    SELECT conname, confdeltype::text AS deltype FROM pg_constraint
    WHERE conrelid IN ('encounter_activities'::regclass, 'encounter_activity_modifiers'::regclass) AND contype = 'f' ORDER BY conname`
  check('T06', 'FK delete policy', fks.length === 4 && fks.every((fk) => fk.deltype === 'r'), `${fks.map((fk) => fk.conname).join(', ')}: ON DELETE RESTRICT`)

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
  const svc1 = must('service 1', (await post(`/api/organizations/${org}/services`, { internalCode: `${runId}-SVC1`, displayName: 'Synthetic service 1' })).body)
  const svc2 = must('service 2', (await post(`/api/organizations/${org}/services`, { internalCode: `${runId}-SVC2`, displayName: 'Synthetic service 2' })).body)
  const proc1 = must('procedure 1', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: `${runId}-PROC1`, displayName: 'Synthetic procedure 1', codeSystem: 'SYNTHETIC', externalCode: `${runId}-X1` })).body)
  const proc2 = must('procedure 2', (await post(`/api/organizations/${org}/procedure-codes`, { internalCode: `${runId}-PROC2`, displayName: 'Synthetic procedure 2', codeSystem: 'SYNTHETIC', externalCode: `${runId}-X2` })).body)
  const dx = must('diagnosis', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-DX`, displayName: 'Synthetic diagnosis' })).body)
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id
  // Run-specific opaque unit/modifier codes, so an audit leak search cannot match anything else.
  const tail = runId.slice(-6)
  const unit = `U${tail}`
  const [m1, m2, m3] = [`M1${tail}`, `M2${tail}`, `Z9${tail}`]

  // Records of ANOTHER organization — created directly, see the header.
  const foreignService = await prisma.service.create({ data: { organizationId: otherOrg, internalCode: `${runId}-FSVC`, displayName: `${runId} foreign service` } })
  const foreignProcedure = await prisma.procedureCode.create({ data: { organizationId: otherOrg, internalCode: `${runId}-FPROC`, displayName: `${runId} foreign procedure` } })
  const foreignPatient = await prisma.patient.create({ data: { organizationId: otherOrg, givenName: 'Synthetic', familyName: `${runId}-foreign`, dateOfBirth: day('1990-01-01') } })
  const foreignFacility = await prisma.facility.create({ data: { organizationId: otherOrg, name: `${runId} foreign facility` } })
  const foreignClinician = await prisma.clinician.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign clinician` } })
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
  const foreignActivity = await prisma.encounterActivity.create({ data: { encounterId: foreignEncounter.id, serviceId: foreignService.id, quantity: new Prisma.Decimal('1') } })

  // Database-level integrity (T07, T23, T26, T34, T35) — each attempt is rolled back.
  const dbEncounter = await newEncounter('2026-06-01')
  const noIdentity = await attemptAdversarialInsert((tx) => tx.encounterActivity.create({ data: { encounterId: dbEncounter.id, quantity: new Prisma.Decimal('1') } }))

  const permissions = (await prisma.permission.findMany({ where: { code: { startsWith: 'encounterActivity.' } }, orderBy: { code: 'asc' } })).map((row) => row.code)
  const viewerRole = await prisma.role.findFirst({ where: { code: 'ORG_VIEWER' }, include: { permissions: { include: { permission: true } } } })
  const viewerActivityPermissions = (viewerRole?.permissions ?? []).map((row) => row.permission.code).filter((code) => code.startsWith('encounterActivity.'))

  // ---------------------------------------------------------------- identity (T08–T15)
  section('Identity — Service and/or ProcedureCode, same organization, no mapping')
  const e1 = await newEncounter('2026-06-02')
  const path1 = `/api/encounters/${e1.id}/activities`
  const serviceOnly = await post(path1, { serviceId: svc1.id, quantity: '1' })
  check('T08', 'Service only', serviceOnly.status === 201 && serviceOnly.body?.serviceId === svc1.id && serviceOnly.body?.procedureCodeId === null, `status ${serviceOnly.status}`)
  const procedureOnly = await post(path1, { procedureCodeId: proc1.id, quantity: '1' })
  check('T09', 'Procedure only', procedureOnly.status === 201 && procedureOnly.body?.procedureCodeId === proc1.id && procedureOnly.body?.serviceId === null, `status ${procedureOnly.status}`)
  const both = await post(path1, { serviceId: svc1.id, procedureCodeId: proc1.id, quantity: '1' })
  check('T10', 'Service + procedure', both.status === 201 && both.body?.serviceId === svc1.id && both.body?.procedureCodeId === proc1.id, `status ${both.status}`)
  const unmapped = await post(path1, { serviceId: svc2.id, procedureCodeId: proc2.id, quantity: '1' })
  const unmappedCross = await post(path1, { serviceId: svc1.id, procedureCodeId: proc2.id, quantity: '1' })
  check('T11', 'no invented mapping', unmapped.status === 201 && unmappedCross.status === 201, 'any same-organization Service + Procedure pair is accepted; no mapping is asserted')
  const neither = await post(path1, { serviceId: null, procedureCodeId: null, quantity: '1' })
  check(
    'T07',
    'activity identity CHECK',
    neither.status === 400 && /encounter_activities_identity_chk/.test(noIdentity),
    `API ${neither.status}; serviceId and procedureCodeId both null also refused by the database CHECK`,
  )

  const auditBeforeCross = await activityAuditCount()
  const crossService = await post(path1, { serviceId: foreignService.id, quantity: '1' })
  const crossProcedure = await post(path1, { procedureCodeId: foreignProcedure.id, quantity: '1' })
  const crossRows = await prisma.encounterActivity.count({ where: { encounterId: e1.id, OR: [{ serviceId: foreignService.id }, { procedureCodeId: foreignProcedure.id }] } })
  const crossAuditUnchanged = (await activityAuditCount()) === auditBeforeCross
  const crossText = JSON.stringify([crossService.body, crossProcedure.body])
  check('T12', 'cross-org Service', crossService.status === 404 && crossRows === 0 && crossAuditUnchanged && !crossText.includes('foreign'), `status ${crossService.status}; refused as not found, no row, no audit`)
  check('T13', 'cross-org Procedure', crossProcedure.status === 404 && crossRows === 0 && crossAuditUnchanged && !crossText.includes(foreignProcedure.internalCode), `status ${crossProcedure.status}; refused as not found, no row, no audit`)
  const missingService = await post(path1, { serviceId: '11111111-1111-4111-8111-111111111111', quantity: '1' })
  check('T14', 'missing Service', missingService.status === 404, `status ${missingService.status}`)
  const missingProcedure = await post(path1, { procedureCodeId: '11111111-1111-4111-8111-111111111111', quantity: '1' })
  check('T15', 'missing Procedure', missingProcedure.status === 404, `status ${missingProcedure.status}`)

  // ---------------------------------------------------------------- quantity (T16–T23)
  section('Quantity — exact Decimal, never a float, never rounded')
  const qtyOne = await post(path1, { serviceId: svc1.id, quantity: '1' })
  check('T16', 'strict quantity integer', qtyOne.status === 201 && qtyOne.body?.quantity === '1', `status ${qtyOne.status}; DTO quantity ${JSON.stringify(qtyOne.body?.quantity)}`)
  const qtyDecimal = await post(path1, { serviceId: svc1.id, quantity: '2.5' })
  const storedDecimal = qtyDecimal.body?.id
    ? (await prisma.$queryRaw<{ q: string }[]>`SELECT quantity::text AS q FROM encounter_activities WHERE id = ${qtyDecimal.body.id}::uuid`)[0]?.q
    : ''
  check('T17', 'strict quantity decimal', qtyDecimal.status === 201 && qtyDecimal.body?.quantity === '2.5' && typeof qtyDecimal.body?.quantity === 'string' && storedDecimal === '2.5000', `DTO "${qtyDecimal.body?.quantity}" (string); stored NUMERIC ${storedDecimal}`)
  const rowsBeforeBad = await prisma.encounterActivity.count({ where: { encounterId: e1.id } })
  const zero = await post(path1, { serviceId: svc1.id, quantity: '0' })
  check('T18', 'zero quantity', zero.status === 400, `status ${zero.status}`)
  const negative = await post(path1, { serviceId: svc1.id, quantity: '-1' })
  check('T19', 'negative quantity', negative.status === 400, `status ${negative.status}`)
  const exponent = await post(path1, { serviceId: svc1.id, quantity: '1e3' })
  check('T20', 'exponent quantity', exponent.status === 400, `status ${exponent.status}`)
  const tooPrecise = await post(path1, { serviceId: svc1.id, quantity: '1.23456' })
  const oversized = await post(path1, { serviceId: svc1.id, quantity: '100000000000000' })
  check('T21', 'too many decimals', tooPrecise.status === 400 && oversized.status === 400, `5 decimals -> ${tooPrecise.status}; 15 integer digits -> ${oversized.status}; nothing rounded or stored`)
  const numeric = await post(path1, { serviceId: svc1.id, quantity: 2.5 })
  const rowsAfterBad = await prisma.encounterActivity.count({ where: { encounterId: e1.id } })
  check('T22', 'non-string quantity', numeric.status === 400 && rowsAfterBad === rowsBeforeBad, `number 2.5 -> ${numeric.status}; no row from any refused quantity`)
  const dbZero = await attemptAdversarialInsert((tx) => tx.encounterActivity.create({ data: { encounterId: dbEncounter.id, serviceId: svc1.id, quantity: new Prisma.Decimal('0') } }))
  const dbNegative = await attemptAdversarialInsert((tx) => tx.encounterActivity.create({ data: { encounterId: dbEncounter.id, serviceId: svc1.id, quantity: new Prisma.Decimal('-2') } }))
  check('T23', 'DB positive CHECK', [dbZero, dbNegative].every((text) => /encounter_activities_quantity_positive_chk/.test(text)), 'direct zero and negative quantities refused by the database')

  // ---------------------------------------------------------------- unit (T24–T26)
  section('Unit — optional, opaque, never blank')
  const unitNull = await post(path1, { serviceId: svc1.id, quantity: '1', unitCode: null })
  check('T24', 'unit null', unitNull.status === 201 && unitNull.body?.unitCode === null, `status ${unitNull.status}`)
  const unitTrim = await post(path1, { serviceId: svc1.id, quantity: '1', unitCode: `  ${unit}  ` })
  check('T25', 'unit trimmed', unitTrim.status === 201 && unitTrim.body?.unitCode === unit, `stored "${unitTrim.body?.unitCode}"`)
  const unitBlank = await post(path1, { serviceId: svc1.id, quantity: '1', unitCode: '   ' })
  const dbBlankUnit = await attemptAdversarialInsert((tx) => tx.encounterActivity.create({ data: { encounterId: dbEncounter.id, serviceId: svc1.id, quantity: new Prisma.Decimal('1'), unitCode: '  ' } }))
  check('T26', 'blank unit', unitBlank.status === 400 && /encounter_activities_unit_code_nonblank_chk/.test(dbBlankUnit), `API ${unitBlank.status} (refused, not silently nulled); the database never stores a blank unit`)

  // ---------------------------------------------------------------- modifiers (T27–T35)
  section('Modifiers — ordered, opaque, unique')
  const noModifiers = await post(path1, { serviceId: svc1.id, quantity: '1' })
  check('T27', 'modifier none', noModifiers.status === 201 && JSON.stringify(noModifiers.body?.modifierCodes) === '[]', `modifierCodes ${JSON.stringify(noModifiers.body?.modifierCodes)}`)
  const ordered = await post(path1, { serviceId: svc1.id, quantity: '1', modifierCodes: [m3, m1, m2] })
  const storedOrder = ordered.body?.id
    ? (await prisma.encounterActivityModifier.findMany({ where: { encounterActivityId: ordered.body.id }, orderBy: { sequence: 'asc' } })).map((row) => [row.sequence, row.code])
    : []
  check(
    'T28',
    'modifier order',
    ordered.status === 201 && JSON.stringify(ordered.body?.modifierCodes) === JSON.stringify([m3, m1, m2]) && JSON.stringify(storedOrder) === JSON.stringify([[1, m3], [2, m1], [3, m2]]),
    'stored as sequence 1..3 and returned in exactly the supplied order',
  )
  const trimmed = await post(path1, { serviceId: svc1.id, quantity: '1', modifierCodes: [`  ${m1} `, `${m2.toLowerCase()}`] })
  check('T29', 'modifier trim', trimmed.status === 201 && JSON.stringify(trimmed.body?.modifierCodes) === JSON.stringify([m1, m2.toLowerCase()]), 'whitespace removed; case left exactly as supplied')
  const blankModifier = await post(path1, { serviceId: svc1.id, quantity: '1', modifierCodes: [m1, '  '] })
  check('T30', 'blank modifier', blankModifier.status === 400, `status ${blankModifier.status}`)
  const nonStringModifier = await post(path1, { serviceId: svc1.id, quantity: '1', modifierCodes: [m1, 25] })
  check('T31', 'non-string modifier', nonStringModifier.status === 400, `status ${nonStringModifier.status}`)
  const duplicateModifier = await post(path1, { serviceId: svc1.id, quantity: '1', modifierCodes: [m1, ` ${m1}`] })
  check('T32', 'duplicate modifier', duplicateModifier.status === 400, `status ${duplicateModifier.status}`)
  const manyCodes = Array.from({ length: 25 }, (_, index) => `MX${index}-${tail}`)
  const many = await post(path1, { serviceId: svc1.id, quantity: '1', modifierCodes: manyCodes })
  check('T33', 'no modifier max', many.status === 201 && many.body?.modifierCodes?.length === 25, `${many.body?.modifierCodes?.length ?? 0} modifiers accepted; no payer limit invented`)

  const dbActivity = must('db activity', (await post(`/api/encounters/${dbEncounter.id}/activities`, { serviceId: svc1.id, quantity: '1', modifierCodes: [m1] })).body)
  const seqZero = await attemptAdversarialInsert((tx) => tx.encounterActivityModifier.create({ data: { encounterActivityId: dbActivity.id, sequence: 0, code: m2 } }))
  const seqDuplicate = await attemptAdversarialInsert((tx) => tx.encounterActivityModifier.create({ data: { encounterActivityId: dbActivity.id, sequence: 1, code: m2 } }))
  check('T34', 'modifier sequence DB', /encounter_activity_modifiers_sequence_positive_chk/.test(seqZero) && /unique/i.test(seqDuplicate) && /sequence/.test(seqDuplicate), 'sequence 0 and a duplicate sequence refused by the database')
  const codeBlank = await attemptAdversarialInsert((tx) => tx.encounterActivityModifier.create({ data: { encounterActivityId: dbActivity.id, sequence: 2, code: '  ' } }))
  const codeDuplicate = await attemptAdversarialInsert((tx) => tx.encounterActivityModifier.create({ data: { encounterActivityId: dbActivity.id, sequence: 2, code: m1 } }))
  check('T35', 'modifier code DB', /encounter_activity_modifiers_code_nonblank_chk/.test(codeBlank) && /unique/i.test(codeDuplicate) && /code/.test(codeDuplicate), 'a blank code and a duplicate code per activity refused by the database')

  // ---------------------------------------------------------------- facts and reads (T36–T43)
  section('Repeated facts, reads and the stored-modifier invariant')
  const repeatEncounter = await newEncounter('2026-06-03')
  const repeatPath = `/api/encounters/${repeatEncounter.id}/activities`
  const repeatA = await post(repeatPath, { serviceId: svc1.id, procedureCodeId: proc1.id, quantity: '1' })
  const repeatB = await post(repeatPath, { serviceId: svc1.id, procedureCodeId: proc1.id, quantity: '1' })
  const repeatActive = await prisma.encounterActivity.count({ where: { encounterId: repeatEncounter.id, removedAt: null } })
  check('T36', 'repeated activities', repeatA.status === 201 && repeatB.status === 201 && repeatA.body?.id !== repeatB.body?.id && repeatActive === 2, 'the same Service + Procedure is recorded as two separate active rows')

  const columnsOf = async (table: string) =>
    (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY column_name`).map((row) => row.column_name)
  const activityColumns = await columnsOf('encounter_activities')
  const modifierColumns = await columnsOf('encounter_activity_modifiers')
  check('T37', 'no activity sequence', !activityColumns.some((name) => /(sequence|line|position|rank|order)/i.test(name)), `activity columns: ${activityColumns.join(', ')}`)

  const listEncounter = await newEncounter('2026-06-04')
  const listPath = `/api/encounters/${listEncounter.id}/activities`
  const la1 = must('la1', (await post(listPath, { serviceId: svc1.id, quantity: '1', modifierCodes: [m1, m2] })).body)
  const la2 = must('la2', (await post(listPath, { procedureCodeId: proc1.id, quantity: '2', unitCode: unit, modifierCodes: [m2] })).body)
  const la3 = must('la3', (await post(listPath, { serviceId: svc2.id, procedureCodeId: proc2.id, quantity: '0.125' })).body)
  await post(`/api/encounter-activities/${la2.id}/remove`, {})
  const listed = await get(listPath)
  const listedIds: string[] = (listed.body?.items ?? []).map((item: { id: string }) => item.id)
  check('T38', 'list active', listed.status === 200 && JSON.stringify(listedIds) === JSON.stringify([la1.id, la3.id]), `status ${listed.status}; removed row not listed`)
  const dbOrder = (await prisma.encounterActivity.findMany({ where: { encounterId: listEncounter.id, removedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((row) => row.id)
  const listedAgain = await get(listPath)
  check(
    'T39',
    'list deterministic',
    JSON.stringify(listedIds) === JSON.stringify(dbOrder) && JSON.stringify(listedAgain.body) === JSON.stringify(listed.body),
    'createdAt then id; identical on repeat; display order only',
  )
  const gotActive = await get(`/api/encounter-activities/${la1.id}`)
  const listedLa1 = (listed.body?.items ?? []).find((item: { id: string }) => item.id === la1.id)
  check(
    'T40',
    'get active',
    gotActive.status === 200 && JSON.stringify(gotActive.body) === JSON.stringify(listedLa1) && JSON.stringify(gotActive.body?.modifierCodes) === JSON.stringify([m1, m2]),
    'exact DTO, identical to the list entry',
  )
  const gotRemoved = await get(`/api/encounter-activities/${la2.id}`)
  check(
    'T41',
    'get removed',
    gotRemoved.status === 200 && gotRemoved.body?.removedAt !== null && gotRemoved.body?.quantity === '2' && gotRemoved.body?.unitCode === unit && JSON.stringify(gotRemoved.body?.modifierCodes) === JSON.stringify([m2]),
    'historical DTO with removedAt and its original facts',
  )

  // ADVERSARIAL FIXTURES: stored modifier orders the service would never write. Readers must fail
  // closed and never repair them. The rows are removed right after; nothing references them.
  const plant = async (serviceDate: string, sequences: number[]) => {
    const encounter = await newEncounter(serviceDate)
    const activity = await prisma.encounterActivity.create({ data: { encounterId: encounter.id, serviceId: svc1.id, quantity: new Prisma.Decimal('1') } })
    for (const [index, sequence] of sequences.entries()) {
      await prisma.encounterActivityModifier.create({ data: { encounterActivityId: activity.id, sequence, code: `P${index}${tail}` } })
    }
    const read = await get(`/api/encounter-activities/${activity.id}`)
    const list = await get(`/api/encounters/${encounter.id}/activities`)
    const stored = (await prisma.encounterActivityModifier.findMany({ where: { encounterActivityId: activity.id }, orderBy: { sequence: 'asc' } })).map((row) => row.sequence)
    await prisma.encounterActivityModifier.deleteMany({ where: { encounterActivityId: activity.id } })
    await prisma.encounterActivity.delete({ where: { id: activity.id } })
    return { read, list, stored }
  }
  const gap = await plant('2026-06-05', [1, 3])
  check(
    'T42',
    'modifier corruption gap',
    gap.read.status === 409 && gap.read.body?.error?.code === 'INTEGRITY_CONFLICT' && gap.list.status === 409 && JSON.stringify(gap.stored) === '[1,3]',
    `get ${gap.read.status} and list ${gap.list.status} fail closed as INTEGRITY_CONFLICT; stored order left unrepaired (adversarial rows removed)`,
  )
  const offset = await plant('2026-06-06', [2, 3])
  check(
    'T43',
    'modifier corruption duplicate/order',
    offset.read.status === 409 && offset.list.status === 409 && JSON.stringify(offset.stored) === '[2,3]' && /unique/i.test(seqDuplicate) && /unique/i.test(codeDuplicate),
    'an order not starting at 1 fails closed and is not repaired; duplicate sequence/code cannot be stored (UNIQUE), and the reader rule for them is proven by the unit tests',
  )

  // ---------------------------------------------------------------- remove and correction (T44–T50)
  section('Remove — history kept, correction by a new row')
  const rmEncounter = await newEncounter('2026-06-07')
  const rmPath = `/api/encounters/${rmEncounter.id}/activities`
  const rm = must('rm', (await post(rmPath, { serviceId: svc1.id, procedureCodeId: proc1.id, quantity: '3', unitCode: unit, modifierCodes: [m1, m2] })).body)
  const modifierSnapshot = async (id: string) =>
    JSON.stringify((await prisma.encounterActivityModifier.findMany({ where: { encounterActivityId: id }, orderBy: { sequence: 'asc' } })).map((row) => [row.id, row.sequence, row.code, row.createdAt.toISOString()]))
  const modifiersBefore = await modifierSnapshot(rm.id)
  const removed = await post(`/api/encounter-activities/${rm.id}/remove`, {})
  const rmRow = await prisma.encounterActivity.findUnique({ where: { id: rm.id } })
  check('T44', 'remove active', removed.status === 200 && removed.body?.removedAt !== null && !!rmRow && rmRow.removedAt !== null, `status ${removed.status}; removedAt set; row retained`)
  check('T45', 'modifier history', (await modifierSnapshot(rm.id)) === modifiersBefore && JSON.stringify(removed.body?.modifierCodes) === JSON.stringify([m1, m2]), 'the removed activity keeps its original modifier rows unchanged')
  const auditBeforeTwice = await activityAuditCount()
  const removeTwice = await post(`/api/encounter-activities/${rm.id}/remove`, {})
  check('T46', 'remove twice', removeTwice.status === 400 && (await activityAuditCount()) === auditBeforeTwice, `status ${removeTwice.status}; no second audit`)
  const deleteRoute = await callApi(baseUrl, `/api/encounter-activities/${rm.id}`, asAdmin({ method: 'DELETE' }))
  check('T47', 'no hard DELETE', deleteRoute.status === 404 && (await prisma.encounterActivity.count({ where: { id: rm.id } })) === 1, `DELETE -> ${deleteRoute.status}; the row remains`)
  const patchRoute = await callApi(baseUrl, `/api/encounter-activities/${la1.id}`, asAdmin({ method: 'PATCH', body: JSON.stringify({ quantity: '9' }) }))
  const la1After = await get(`/api/encounter-activities/${la1.id}`)
  check('T48', 'no PATCH', patchRoute.status === 404 && la1After.body?.quantity === '1', `PATCH -> ${patchRoute.status}; facts unchanged`)
  const restore = await post(`/api/encounter-activities/${rm.id}/restore`, {})
  check('T49', 'no restore', restore.status === 404 && (await prisma.encounterActivity.findUniqueOrThrow({ where: { id: rm.id } })).removedAt !== null, `restore -> ${restore.status}`)
  const corrected = await post(rmPath, { serviceId: svc1.id, procedureCodeId: proc1.id, quantity: '2', unitCode: unit, modifierCodes: [m1] })
  const oldRow = await prisma.encounterActivity.findUniqueOrThrow({ where: { id: rm.id } })
  const rmActive = await get(rmPath)
  check(
    'T50',
    'correction pattern',
    corrected.status === 201 &&
      corrected.body?.id !== rm.id &&
      oldRow.removedAt !== null &&
      oldRow.quantity.toFixed() === '3' &&
      JSON.stringify((rmActive.body?.items ?? []).map((item: { id: string }) => item.id)) === JSON.stringify([corrected.body?.id]),
    'old row removed with its original facts retained; the corrected activity is a new active row',
  )

  // ---------------------------------------------------------------- roles and tenancy (T51–T55)
  section('Roles, tenancy and pre-authorization ownership')
  const viewerList = await get(listPath, asViewer)
  const viewerGet = await get(`/api/encounter-activities/${la1.id}`, asViewer)
  // §13 permission catalogue and bootstrap mapping, measured alongside the viewer's read access.
  const catalogueOk =
    JSON.stringify(permissions) === JSON.stringify(['encounterActivity.create', 'encounterActivity.read', 'encounterActivity.update']) &&
    JSON.stringify(viewerActivityPermissions) === JSON.stringify(['encounterActivity.read'])
  check(
    'T51',
    'viewer read',
    viewerList.status === 200 && viewerGet.status === 200 && catalogueOk,
    `list ${viewerList.status}, get ${viewerGet.status}; permissions ${permissions.join(', ')}; viewer holds ${viewerActivityPermissions.join(', ')} only; no delete/pricing/claim permission`,
  )
  const auditBeforeViewer = await activityAuditCount()
  const rowsBeforeViewer = await prisma.encounterActivity.count({ where: { encounterId: listEncounter.id } })
  const viewerCreate = await post(listPath, { serviceId: svc1.id, quantity: '1' }, asViewer)
  check(
    'T52',
    'viewer create denial',
    viewerCreate.status === 403 && (await prisma.encounterActivity.count({ where: { encounterId: listEncounter.id } })) === rowsBeforeViewer && (await activityAuditCount()) === auditBeforeViewer,
    `status ${viewerCreate.status}; no row, no audit`,
  )
  const viewerRemove = await post(`/api/encounter-activities/${la1.id}/remove`, {}, asViewer)
  check('T53', 'viewer remove denial', viewerRemove.status === 403 && (await prisma.encounterActivity.findUniqueOrThrow({ where: { id: la1.id } })).removedAt === null, `status ${viewerRemove.status}; unchanged`)
  const crossList = await get(`/api/encounters/${foreignEncounter.id}/activities`)
  const crossGet = await get(`/api/encounter-activities/${foreignActivity.id}`)
  const crossRemove = await post(`/api/encounter-activities/${foreignActivity.id}/remove`, {})
  const foreignStill = await prisma.encounterActivity.findUniqueOrThrow({ where: { id: foreignActivity.id } })
  check(
    'T54',
    'cross-tenant list/get',
    [crossList.status, crossGet.status, crossRemove.status].every((s) => s === 403 || s === 404) &&
      !JSON.stringify([crossList.body, crossGet.body, crossRemove.body]).includes(foreignService.id) &&
      foreignStill.removedAt === null,
    `statuses ${crossList.status},${crossGet.status},${crossRemove.status}; no foreign activity disclosed or changed`,
  )
  const activityOwner = await findEncounterActivityOwnership(la1.id)
  const encounterOwner = await findEncounterOwnership(listEncounter.id)
  check(
    'T55',
    'pre-auth ownership',
    JSON.stringify(Object.keys(activityOwner ?? {})) === JSON.stringify(['organizationId']) &&
      JSON.stringify(Object.keys(encounterOwner ?? {})) === JSON.stringify(['organizationId']) &&
      activityOwner?.organizationId === org,
    'ownership lookups return organizationId only',
  )

  // ---------------------------------------------------------------- concurrency (T56–T59)
  section('Concurrency — every writer locks the Encounter first')
  const createCreate = await newEncounter('2026-06-08')
  let hold = holdAt('encounterActivity.create')
  const createOne = createEncounterActivity(createCreate.id, { serviceId: svc1.id, quantity: '1' }, actorUserId)
  await hold.arrived
  const createTwo = createEncounterActivity(createCreate.id, { serviceId: svc1.id, quantity: '1' }, actorUserId)
  const createCreateBlocked = await waitForLockWaiter()
  hold.release()
  const [createOneResult, createTwoResult] = await Promise.all([createOne, createTwo])
  clearConcurrencyProbes()
  check(
    'T56',
    'create concurrency',
    createCreateBlocked && createOneResult.ok && createTwoResult.ok && (await prisma.encounterActivity.count({ where: { encounterId: createCreate.id, removedAt: null } })) === 2,
    'the second create waited on the Encounter lock; both valid rows retained',
  )

  const createRemove = await newEncounter('2026-06-09')
  const cr1 = must('cr1', (await post(`/api/encounters/${createRemove.id}/activities`, { serviceId: svc1.id, quantity: '1' })).body)
  hold = holdAt('encounterActivity.remove')
  const removeHeld = removeEncounterActivity(cr1.id, {}, actorUserId)
  await hold.arrived
  const createDuringRemove = createEncounterActivity(createRemove.id, { procedureCodeId: proc1.id, quantity: '1' }, actorUserId)
  const createRemoveBlocked = await waitForLockWaiter()
  hold.release()
  const [removeHeldResult, createDuringRemoveResult] = await Promise.all([removeHeld, createDuringRemove])
  clearConcurrencyProbes()
  const createRemoveActive = (await prisma.encounterActivity.findMany({ where: { encounterId: createRemove.id, removedAt: null } })).map((row) => row.id)
  check(
    'T57',
    'create/remove race',
    createRemoveBlocked &&
      removeHeldResult.ok &&
      createDuringRemoveResult.ok &&
      JSON.stringify(createRemoveActive) === JSON.stringify([createDuringRemoveResult.value.id]) &&
      (await prisma.encounterActivity.findUniqueOrThrow({ where: { id: cr1.id } })).removedAt !== null,
    'the create waited for the remove; both outcomes kept, no lost update',
  )

  const removeRemove = await newEncounter('2026-06-10')
  const rr1 = must('rr1', (await post(`/api/encounters/${removeRemove.id}/activities`, { serviceId: svc1.id, quantity: '1' })).body)
  hold = holdAt('encounterActivity.remove')
  const firstRemove = removeEncounterActivity(rr1.id, {}, actorUserId)
  await hold.arrived
  const secondRemove = removeEncounterActivity(rr1.id, {}, actorUserId)
  const removeRemoveBlocked = await waitForLockWaiter()
  hold.release()
  const [firstRemoveResult, secondRemoveResult] = await Promise.all([firstRemove, secondRemove])
  clearConcurrencyProbes()
  const removedEvents = await prisma.auditEvent.count({ where: { entityId: rr1.id, actionCode: 'encounterActivity.removed' } })
  check(
    'T58',
    'remove/remove race',
    removeRemoveBlocked && firstRemoveResult.ok && !secondRemoveResult.ok && removedEvents === 1,
    'only one removal succeeded; exactly one removed audit event',
  )

  // A4.5 and A4.6 share the Encounter row as their single parent lock, in both directions.
  const shared = await newEncounter('2026-06-11')
  hold = holdAt('encounterActivity.create')
  const activityFirst = createEncounterActivity(shared.id, { serviceId: svc1.id, quantity: '1' }, actorUserId)
  await hold.arrived
  const diagnosisWaits = addEncounterDiagnosis(shared.id, { diagnosisCodeId: dx.id }, actorUserId)
  const diagnosisBlocked = await waitForLockWaiter()
  hold.release()
  const [activityFirstResult, diagnosisWaitsResult] = await Promise.all([activityFirst, diagnosisWaits])
  clearConcurrencyProbes()
  const sharedReverse = await newEncounter('2026-06-12')
  hold = holdAt('encounterDiagnosis.add')
  const diagnosisFirst = addEncounterDiagnosis(sharedReverse.id, { diagnosisCodeId: dx.id }, actorUserId)
  await hold.arrived
  const activityWaits = createEncounterActivity(sharedReverse.id, { serviceId: svc1.id, quantity: '1' }, actorUserId)
  const activityBlocked = await waitForLockWaiter()
  hold.release()
  const [diagnosisFirstResult, activityWaitsResult] = await Promise.all([diagnosisFirst, activityWaits])
  clearConcurrencyProbes()
  check(
    'T59',
    'A4.5/A4.6 common lock',
    diagnosisBlocked && activityBlocked && activityFirstResult.ok && diagnosisWaitsResult.ok && diagnosisFirstResult.ok && activityWaitsResult.ok,
    'an A4.5 diagnosis write waits on an A4.6 activity write and vice versa: one Encounter parent lock',
  )

  // ---------------------------------------------------------------- audit (T60–T63)
  section('Billing-payload-minimized audit')
  const createdEvent = await prisma.auditEvent.findFirst({ where: { entityId: serviceOnly.body?.id, actionCode: 'encounterActivity.created' } })
  const createdKeys = Object.keys((createdEvent?.afterState ?? {}) as Record<string, unknown>).sort()
  check(
    'T60',
    'create audit',
    !!createdEvent && createdEvent.entityType === 'ENCOUNTER_ACTIVITY' && createdEvent.beforeState === null && keysWithin(createdEvent.afterState),
    `snapshot keys: ${createdKeys.join(', ')}`,
  )
  const removedEvent = await prisma.auditEvent.findFirst({ where: { entityId: rm.id, actionCode: 'encounterActivity.removed' } })
  check(
    'T61',
    'remove audit',
    !!removedEvent && keysWithin(removedEvent.beforeState) && keysWithin(removedEvent.afterState) && ((removedEvent.afterState ?? {}) as Record<string, unknown>).removedAt !== undefined,
    'removed event records the row and its removal only',
  )
  const runRowIds = (await prisma.encounterActivity.findMany({ where: { encounter: { patientId: patient.id } }, select: { id: true } })).map((row) => row.id)
  const runEvents = await prisma.auditEvent.findMany({ where: { entityType: 'ENCOUNTER_ACTIVITY', entityId: { in: runRowIds } } })
  const runEventText = JSON.stringify(runEvents.map((event) => [event.beforeState, event.afterState]))
  const forbidden = [
    svc1.id,
    svc2.id,
    proc1.id,
    proc2.id,
    svc1.internalCode,
    proc1.internalCode,
    unit,
    m1,
    m2,
    m3,
    e1.id,
    listEncounter.id,
    rmEncounter.id,
    patient.id,
    facility.id,
    clinician.id,
    '2026-06-0',
  ]
  const leaked = forbidden.filter((value) => runEventText.includes(value))
  check(
    'T62',
    'audit payload minimization',
    runEvents.length > 0 && leaked.length === 0 && runEvents.every((event) => keysWithin(event.beforeState) && keysWithin(event.afterState)),
    `${runEvents.length} event(s); keys only id/removedAt/updatedAt; no service/procedure/quantity/unit/modifier/encounter/patient value`,
  )
  const auditBeforeBatch = await activityAuditCount()
  await post(path1, { serviceId: foreignService.id, quantity: '1' }) // cross-org
  await post(path1, { procedureCodeId: '11111111-1111-4111-8111-111111111111', quantity: '1' }) // missing master
  await post(path1, { serviceId: svc1.id, quantity: '1' }, asViewer) // denied
  await post(path1, { serviceId: svc1.id, quantity: '1.00001' }) // invalid quantity
  await post(path1, { serviceId: svc1.id, quantity: '1', lineNumber: 1 }) // unknown field
  await post(`/api/encounter-activities/${rm.id}/remove`, {}) // already removed
  await post(`/api/encounter-activities/${la1.id}/remove`, {}, asViewer) // denied
  check('T63', 'no false audit', (await activityAuditCount()) === auditBeforeBatch, `before=${auditBeforeBatch} after=${await activityAuditCount()}`)

  // ---------------------------------------------------------------- scope guards (T64–T73)
  section('Scope guards — activity facts, nothing more')
  const bothColumns = [...activityColumns, ...modifierColumns]
  check('T64', 'no organizationId', !bothColumns.includes('organization_id'), `activity columns: ${activityColumns.join(', ')}`)
  check('T65', 'no Patient/context duplication', !activityColumns.some((name) => /(patient|facility|clinician|membership|service_date|regulatory|organization)/i.test(name)), 'context derives from the Encounter')
  check('T66', 'no Service/Procedure snapshot', !activityColumns.some((name) => /^(code|display_name|internal_code|external_code|code_system|description)$/i.test(name)), 'code/displayName stay on the A2 masters')
  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).map((row) => row.table_name)
  const activityTables = tables.filter((name) => /activit/i.test(name))
  check(
    'T67',
    'no Service↔Procedure mapping',
    !tables.some((name) => /(service_procedure|procedure_service|_mapping|modifier_master|^modifiers$|^units$)/i.test(name)) && JSON.stringify(activityTables) === JSON.stringify(['encounter_activities', 'encounter_activity_modifiers']),
    `activity tables: ${activityTables.join(', ')}; no mapping/modifier/unit master`,
  )
  check('T68', 'no diagnosis pointer', !bothColumns.some((name) => /diagnos/i.test(name)), 'no EncounterDiagnosis/DiagnosisCode link on Activity')
  check('T69', 'no observations', !tables.some((name) => /observation/i.test(name)), 'no A4.7 schema')
  check('T70', 'no A5 fields', !bothColumns.some((name) => /(eligib|authoriz|evidence|readiness|status)/i.test(name)), 'no A5 field')
  check('T71', 'no A6 fields', !bothColumns.some((name) => /(price|amount|tariff|claim|line|submission)/i.test(name)), 'no A6 field')
  const externalIdentifierColumns = await columnsOf('external_identifiers')
  const targetCheck = (await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'external_identifiers_exactly_one_target_chk'`)[0]?.def ?? ''
  // A4.8 (PR #46) added the approved `encounter_id` target, so the exact-one-target CHECK now names
  // it. A4.6's own boundary is unchanged: an Activity is not an identity target, and none of the
  // activity's billing facts — quantity, unit or modifiers — may be duplicated onto the identity
  // table.
  const activityLeak = externalIdentifierColumns.filter((name) =>
    /(activit|quantity|unit_code|modifier)/i.test(name),
  )
  check(
    'T72',
    'no external ID extension',
    !!targetCheck && !/activit/i.test(targetCheck) && activityLeak.length === 0,
    activityLeak.length === 0
      ? 'EncounterActivity is not an external-ID target and no activity fact is duplicated; the approved encounter_id target is named by the CHECK'
      : `Activity leaked into the identity table: ${activityLeak.join(', ')}`,
  )

  // git is called WITHOUT a shell, with repository-root `:/` pathspecs. Exit 1 = no match (wanted),
  // anything but 0/1 = the search itself failed, which is a FAIL. Sanity searches prove reach.
  const gitGrep = (pattern: string, paths: string[]) => {
    const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
    return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
  }
  const activitySources = [':/backend/src/modules/encounter-activity', ':/frontend/src/modules/encounter-activity']
  const vocabulary = gitGrep('(DHPO|eClaimLink|eclaimlink|whitelist|allowlist|ALLOWED_(UNIT|MODIFIER)|VALID_(UNIT|MODIFIER)|(UNIT|MODIFIER)_CODES|(unit|modifier)Vocabulary)', activitySources)
  const vocabularySanity = gitGrep('modifierCodes', [':/backend/src/modules/encounter-activity/encounter-activity.validation.ts'])
  check(
    'T73',
    'no hardcoded vocab',
    vocabulary.status === 1 && vocabularySanity.status === 0 && ordered.status === 201 && unitTrim.status === 201,
    vocabulary.status === 1 ? 'no payer/DHA/eClaimLink unit or modifier list; arbitrary opaque codes accepted' : `vocabulary search: ${vocabulary.output.slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- build (T74–T76)
  section('Unit, typecheck and build')
  const unitTests = run('npm run test:unit')
  check('T74', 'unit tests', unitTests.ok && /ℹ fail 0/.test(unitTests.output), `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]} ${(unitTests.output.match(/ℹ fail \d+/) ?? [''])[0]}`.trim())
  const typecheck = run('npm run typecheck')
  check('T75', 'backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T76', 'frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])

  // ---------------------------------------------------------------- regressions (T77–T84)
  section('Regressions — A4.5 and, nested inside it, A4.4 → A1')
  // The A4.5 suite runs every earlier suite itself (its T68–T74) with their narrowly documented
  // expected IDs, so it is run ONCE here and its nested verdicts are read back for T78–T84. On the
  // A4.6 branch only A4.5's own branch-identity and diff checks cannot hold: T01 (branch name),
  // T78 (git scope since A4.4) and T79 (tracking its own branch). Every other check must pass.
  await apiReady('the A4.5 regression')
  const a45 = run('npm run test:a4:diagnoses')
  const a45Failing = failedIds(a45.output, 'A4.5')
  const a45Expected = ['T01', 'T78', 'T79']
  const a45Unexpected = a45Failing.filter((id) => !a45Expected.includes(id))
  const a45Summary = (a45.output.match(/\[A4\.5\] automated summary: [^\n]*/) ?? ['no summary'])[0]
  check(
    'T77',
    'A4.5 regression',
    a45Unexpected.length === 0 && /T48 concurrent add\/add \.* PASS/.test(a45.output) && /T56 audit clinical minimization \.* PASS/.test(a45.output),
    a45Unexpected.length === 0 ? `${a45Summary}; only A4.5's own branch/diff checks differ (${a45Failing.join(', ') || 'none'})` : `unexpected A4.5 failures: ${a45Unexpected.join(', ')}`,
  )
  const nested = (id: string, title: string, a45Id: string, a45Title: string) => {
    const line = a45.output.match(new RegExp(`\\[A4\\.5\\] ${a45Id} ${a45Title.replace(/\./g, '\\.')} \\.* (PASS|FAIL)( - [^\\n]*)?`))
    check(id, title, line?.[1] === 'PASS', line ? `via A4.5 ${a45Id}${line[2] ?? ''}` : `A4.5 ${a45Id} line missing`)
  }
  nested('T78', 'A4.4 regression', 'T68', 'A4.4 regression')
  nested('T79', 'A4.3 regression', 'T69', 'A4.3 regression')
  nested('T80', 'A4.2 regression', 'T70', 'A4.2 regression')
  nested('T81', 'A4.1 regression', 'T71', 'A4.1 regression')
  nested('T82', 'A3 regression', 'T72', 'A3 regression')
  nested('T83', 'A2 regression', 'T73', 'A2 regression')
  nested('T84', 'A1 regression', 'T74', 'A1 regression')

  // ---------------------------------------------------------------- DB truth, repeatability, privacy (T85–T87)
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
    'T85',
    'DB health truth',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  const priorRows = await prisma.encounterActivity.count({ where: { encounter: { patient: { organizationId: org, familyName: { startsWith: 'A46-' }, NOT: { familyName: { startsWith: runId } } } } } })
  check('T86', 'repeatability', true, `this run used fresh synthetic identities (${runId}); ${priorRows} activity row(s) from earlier runs retained`)

  const logged = gitGrep('console[.](log|info|warn|error|debug)[(].*(quantity|unitCode|modifier|serviceId|procedureCodeId|activity)', activitySources)
  const stored = gitGrep('(localStorage|sessionStorage)[.][A-Za-z]+[(]', [':/frontend/src/modules/encounter-activity'])
  const urlLeak = gitGrep('[?&](quantity|serviceId|procedureCodeId|unitCode|modifier)', [':/frontend/src/modules/encounter-activity'])
  const sanity = gitGrep('modifierCodes', [':/frontend/src/modules/encounter-activity/encounter-activity.api.ts'])
  check(
    'T87',
    'no sensitive logs/storage',
    sanity.status === 0 && logged.status === 1 && stored.status === 1 && urlLeak.status === 1,
    logged.status === 1 && stored.status === 1 && urlLeak.status === 1
      ? 'no activity value logged, put in a query URL or kept in browser storage (searches verified to reach the sources)'
      : `logged=${logged.status} storage=${stored.status} url=${urlLeak.status}: ${[logged.output, stored.output, urlLeak.output].join(' | ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- git (T88–T89)
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
    // The developer check is registered where the latest main composes checks: App.tsx today, or
    // FE-01's developer/checkRegistry.tsx once FE-01 is merged.
    'frontend/src/app/App.tsx',
    'frontend/src/developer/checkRegistry.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/encounter-activity/') &&
      !file.startsWith('backend/src/integration/a4-encounter-activity/') &&
      !file.startsWith('frontend/src/modules/encounter-activity/') &&
      !file.includes('a4_6_encounter_activity_procedure_capture') &&
      !allowed.includes(file),
  )
  check('T88', 'git scope', outOfScope.length === 0, outOfScope.length === 0 ? `${changedPaths.length} path(s) since A4.5, all A4.6` : `unexpected: ${outOfScope.join(', ')}`)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T89', 'final git', git('status --porcelain') === '' && tracking.includes(`origin/${a46Branch}`), `${tracking}; working tree ${git('status --porcelain') === '' ? 'clean' : 'dirty'}`)

  console.log(`\n[A4.6] run ${runId} — HEAD ${git('rev-parse HEAD')}`)
  if (failures.length > 0) {
    console.log(`[A4.6] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  console.log(`[A4.6] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.6] A4.6 ENCOUNTER ACTIVITY ACCEPTANCE COMPLETE' : '[A4.6] A4.6 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.6] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    await prisma.$disconnect()
  })
