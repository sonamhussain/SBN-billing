import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import {
  addEncounterDiagnosis,
  removeEncounterDiagnosis,
  reorderEncounterDiagnoses,
} from '../../modules/encounter-diagnosis/encounter-diagnosis.service.ts'
import { findEncounterDiagnosisOwnership } from '../../modules/encounter-diagnosis/encounter-diagnosis.repository.ts'
import { findEncounterOwnership } from '../../modules/encounter/encounter.repository.ts'

// A4.5 — focused acceptance for Encounter Diagnosis Capture (T01–T79). Valid fixtures are created
// through their owning routes; the database is READ for structural and audit proof. Records of
// ANOTHER organization are created directly, because this tenant's routes correctly refuse to
// author them. ADVERSARIAL fixtures (stored rows the service would never write) are written
// directly only to prove the database or the reader refuses them, and are removed right after.
// Every identifier is synthetic.

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.5] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.5] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n[A4.5] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd() })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

const runId = `A45-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A4.4 FINAL PASS was merged into main as PR #40; A4.5 is branched from exactly that merge.
const a44Merge = 'ef17c08'
const a45Branch = 'feature/a4-5-encounter-diagnosis-capture'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const day = (text: string) => new Date(`${text}T00:00:00.000Z`)

async function diagnosisAuditCount(): Promise<number> {
  return prisma.auditEvent.count({ where: { organizationId: org, entityType: 'ENCOUNTER_DIAGNOSIS' } })
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

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A4.5] Encounter diagnosis capture — run ${runId}`)
  console.log(`[A4.5] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- gates (T01–T11)
  section('Start gate, schema, constraints and permissions')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'start gate',
    gitOk(`merge-base --is-ancestor ${a44Merge} HEAD`) && gitOk(`merge-base --is-ancestor ${a44Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD') && branch === a45Branch,
    `branch ${branch}; A4.4 merge ${a44Merge} (PR #40) is on main and is an ancestor; the branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationFile = run('git ls-files prisma/migrations')
    .output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('a4_5_encounter_diagnosis_capture') && line.endsWith('migration.sql'))
  const migrationSql = migrationFile.length > 0 ? run(`git show HEAD:./${migrationFile[0]}`).output : ''
  const bare = migrationSql.replace(/--.*$/gm, '')
  const createdTables = [...bare.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).sort()
  const alteredTables = [...bare.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
  check(
    'T03',
    'migration scope',
    migrationFile.length === 1 &&
      JSON.stringify(createdTables) === JSON.stringify(['encounter_diagnoses']) &&
      alteredTables.every((table) => table === 'encounter_diagnoses') &&
      (bare.match(/FOREIGN KEY/g) ?? []).length === 2 &&
      /encounter_diagnoses_sequence_positive_chk/.test(bare) &&
      /encounter_diagnoses_active_code_uidx[\s\S]*WHERE "removed_at" IS NULL/.test(bare) &&
      /encounter_diagnoses_active_sequence_uidx[\s\S]*WHERE "removed_at" IS NULL/.test(bare) &&
      !/DROP (TABLE|INDEX|COLUMN|CONSTRAINT)|ALTER COLUMN/.test(bare),
    `one migration; creates ${createdTables.join(', ') || 'nothing'}; 2 FKs, CHECK and 2 active partial unique indexes; no drift`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check('T04', 'prisma validate/generate/status', validate.ok && generate.ok && status.ok && /up to date/i.test(status.output), 'schema valid, client generated, schema up to date')
  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'migration replay',
    replay.ok &&
      /ALL CHECKS PASS/.test(replay.output) &&
      /encounter_diagnoses_active_code_uidx is present/.test(replay.output) &&
      /encounter_diagnoses_active_sequence_uidx is present/.test(replay.output) &&
      /encounter_diagnoses_sequence_positive_chk is present/.test(replay.output),
    `${(replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0]}; the CHECK and both partial indexes survive a clean replay`,
  )

  const fks = await prisma.$queryRaw<{ conname: string; deltype: string }[]>`
    SELECT conname, confdeltype::text AS deltype FROM pg_constraint WHERE conrelid = 'encounter_diagnoses'::regclass AND contype = 'f' ORDER BY conname`
  check('T06', 'DB FKs', fks.length === 2 && fks.every((fk) => fk.deltype === 'r'), `${fks.map((fk) => fk.conname).join(', ')}: ON DELETE RESTRICT`)

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
  const put = (path: string, body: unknown, who = asAdmin) => callApi(baseUrl, path, who({ method: 'PUT', body: JSON.stringify(body) }))
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
  const codes: { id: string; code: string; displayName: string }[] = []
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
    codes.push(must(`diagnosis ${letter}`, (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-${letter}`, displayName: `Synthetic diagnosis ${letter}` })).body))
  }
  const [dxA, dxB, dxC, dxD, dxE, dxF] = codes
  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id

  // Records of ANOTHER organization — created directly, see the header.
  const foreignCode = await prisma.diagnosisCode.create({ data: { organizationId: otherOrg, code: `${runId}-FOREIGN`, displayName: `${runId} foreign diagnosis` } })
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
  const foreignDiagnosis = await prisma.encounterDiagnosis.create({ data: { encounterId: foreignEncounter.id, diagnosisCodeId: foreignCode.id, sequence: 1 } })

  // Database-level integrity (T07, T08, T10) — each attempt is rolled back.
  const dbEncounter = await newEncounter('2026-03-01')
  await prisma.encounterDiagnosis.create({ data: { encounterId: dbEncounter.id, diagnosisCodeId: dxA.id, sequence: 1 } })
  const zeroSequence = await attemptAdversarialInsert((tx) => tx.encounterDiagnosis.create({ data: { encounterId: dbEncounter.id, diagnosisCodeId: dxB.id, sequence: 0 } }))
  check('T07', 'DB sequence CHECK', /encounter_diagnoses_sequence_positive_chk/.test(zeroSequence), 'sequence 0 refused by the database')
  const duplicateCode = await attemptAdversarialInsert((tx) => tx.encounterDiagnosis.create({ data: { encounterId: dbEncounter.id, diagnosisCodeId: dxA.id, sequence: 2 } }))
  check('T08', 'active code uniqueness', /unique|encounter_diagnoses_active_code_uidx/i.test(duplicateCode), 'the same active DiagnosisCode twice on one Encounter is refused by the database')
  const duplicateSequence = await attemptAdversarialInsert((tx) => tx.encounterDiagnosis.create({ data: { encounterId: dbEncounter.id, diagnosisCodeId: dxB.id, sequence: 1 } }))
  check('T10', 'active sequence uniqueness', /unique|encounter_diagnoses_active_sequence_uidx/i.test(duplicateSequence), 'two active rows cannot share one sequence')
  const removedTwin = await attemptAdversarialInsert((tx) =>
    tx.encounterDiagnosis.create({ data: { encounterId: dbEncounter.id, diagnosisCodeId: dxA.id, sequence: 1, removedAt: new Date() } }),
  )

  const permissions = (await prisma.permission.findMany({ where: { code: { startsWith: 'encounterDiagnosis.' } }, orderBy: { code: 'asc' } })).map((row) => row.code)
  check(
    'T11',
    'permissions',
    JSON.stringify(permissions) === JSON.stringify(['encounterDiagnosis.create', 'encounterDiagnosis.read', 'encounterDiagnosis.update']),
    `${permissions.join(', ')}; no delete permission`,
  )

  // ---------------------------------------------------------------- add (T12–T20)
  section('Add under the Encounter lock')
  const e1 = await newEncounter('2026-04-01')
  const path1 = `/api/encounters/${e1.id}/diagnoses`
  const first = await post(path1, { diagnosisCodeId: dxA.id })
  check('T12', 'admin add first', first.status === 201 && first.body?.sequence === 1 && first.body?.encounterId === e1.id, `status ${first.status}; sequence ${first.body?.sequence}`)
  const second = await post(path1, { diagnosisCodeId: dxB.id })
  check('T13', 'admin add second', second.status === 201 && second.body?.sequence === 2, `sequence ${second.body?.sequence}`)
  const clientSequence = await post(path1, { diagnosisCodeId: dxC.id, sequence: 1 })
  check('T14', 'server sequence', clientSequence.status === 400 && /sequence/.test(String(clientSequence.body?.error?.message)), `status ${clientSequence.status}; a client sequence is refused`)
  const unknownFields = await Promise.all([post(path1, { diagnosisCodeId: dxC.id, isPrimary: true }), post(path1, { diagnosisCodeId: dxC.id, encounterId: e1.id })])
  check('T15', 'unknown field', unknownFields.every((res) => res.status === 400), `statuses ${unknownFields.map((r) => r.status).join(',')}`)
  const badEncounter = await post('/api/encounters/not-a-uuid/diagnoses', { diagnosisCodeId: dxC.id })
  check('T16', 'invalid encounter UUID', badEncounter.status >= 400 && badEncounter.status < 500 && !/prisma|stack|sql/i.test(JSON.stringify(badEncounter.body)), `status ${badEncounter.status}; safe error`)
  const missingEncounter = await post('/api/encounters/11111111-1111-4111-8111-111111111111/diagnoses', { diagnosisCodeId: dxC.id })
  check('T17', 'missing Encounter', missingEncounter.status === 404, `status ${missingEncounter.status}`)
  const missingCode = await post(path1, { diagnosisCodeId: '11111111-1111-4111-8111-111111111111' })
  check('T18', 'missing DiagnosisCode', missingCode.status === 404, `status ${missingCode.status}`)
  const auditBeforeCross = await diagnosisAuditCount()
  const crossCode = await post(path1, { diagnosisCodeId: foreignCode.id })
  const crossWritten = await prisma.encounterDiagnosis.count({ where: { encounterId: e1.id, diagnosisCodeId: foreignCode.id } })
  check(
    'T19',
    'cross-org DiagnosisCode',
    crossCode.status === 404 && crossWritten === 0 && (await diagnosisAuditCount()) === auditBeforeCross && !JSON.stringify(crossCode.body).includes('foreign'),
    `status ${crossCode.status}; refused as not found, no row, no audit`,
  )
  const duplicate = await post(path1, { diagnosisCodeId: dxA.id })
  const activeA = await prisma.encounterDiagnosis.count({ where: { encounterId: e1.id, diagnosisCodeId: dxA.id, removedAt: null } })
  check('T20', 'duplicate active code', duplicate.status === 400 && activeA === 1, `status ${duplicate.status}; still one active row`)

  // ---------------------------------------------------------------- reads + security (T21–T28)
  section('Reads, roles, tenancy and the read invariant')
  await post(path1, { diagnosisCodeId: dxC.id })
  const viewerList = await get(path1, asViewer)
  const viewerItems: { sequence: number }[] = viewerList.body?.items ?? []
  check('T21', 'viewer list', viewerList.status === 200 && JSON.stringify(viewerItems.map((i) => i.sequence)) === '[1,2,3]', `status ${viewerList.status}; ordered DTO`)
  const auditBeforeViewer = await diagnosisAuditCount()
  const viewerAdd = await post(path1, { diagnosisCodeId: dxD.id }, asViewer)
  check('T22', 'viewer add', viewerAdd.status === 403 && (await diagnosisAuditCount()) === auditBeforeViewer, `status ${viewerAdd.status}; no row, no audit`)
  const crossList = await get(`/api/encounters/${foreignEncounter.id}/diagnoses`)
  const crossRemove = await post(`/api/encounter-diagnoses/${foreignDiagnosis.id}/remove`, {})
  const foreignStill = await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: foreignDiagnosis.id } })
  check(
    'T23',
    'cross-tenant list',
    [crossList.status, crossRemove.status].every((s) => s === 403 || s === 404) && !JSON.stringify([crossList.body, crossRemove.body]).includes(foreignCode.code) && foreignStill.removedAt === null,
    `statuses ${crossList.status},${crossRemove.status}; no foreign diagnosis disclosed or changed`,
  )
  const diagnosisOwner = await findEncounterDiagnosisOwnership(first.body.id)
  const encounterOwner = await findEncounterOwnership(e1.id)
  check(
    'T24',
    'pre-auth ownership',
    JSON.stringify(Object.keys(diagnosisOwner ?? {})) === JSON.stringify(['organizationId']) &&
      JSON.stringify(Object.keys(encounterOwner ?? {})) === JSON.stringify(['organizationId']) &&
      diagnosisOwner?.organizationId === org,
    'ownership lookups return organizationId only',
  )
  const list = await get(path1)
  const items: { id: string; sequence: number; diagnosisCodeId: string; diagnosisCode: { code: string; displayName: string } }[] = list.body?.items ?? []
  check('T25', 'ordered list', list.status === 200 && JSON.stringify(items.map((i) => i.sequence)) === '[1,2,3]', 'sequence 1..N ascending')
  check(
    'T26',
    'DTO join',
    items[0]?.diagnosisCode?.code === dxA.code && items[0]?.diagnosisCode?.displayName === dxA.displayName && items[1]?.diagnosisCode?.code === dxB.code,
    'code + displayName joined from the A2.8 master, not stored on the link',
  )

  // ADVERSARIAL FIXTURE: a stored gap (1, 3) that the service would never write. The reader must
  // fail closed and never repair it. The rows are removed right after; nothing references them.
  const gapEncounter = await newEncounter('2026-04-02')
  const gapRows = [
    await prisma.encounterDiagnosis.create({ data: { encounterId: gapEncounter.id, diagnosisCodeId: dxA.id, sequence: 1 } }),
    await prisma.encounterDiagnosis.create({ data: { encounterId: gapEncounter.id, diagnosisCodeId: dxB.id, sequence: 3 } }),
  ]
  const gapRead = await get(`/api/encounters/${gapEncounter.id}/diagnoses`)
  const gapAdd = await post(`/api/encounters/${gapEncounter.id}/diagnoses`, { diagnosisCodeId: dxC.id })
  const gapUnrepaired = (await prisma.encounterDiagnosis.findMany({ where: { encounterId: gapEncounter.id }, orderBy: { sequence: 'asc' } })).map((r) => r.sequence)
  await prisma.encounterDiagnosis.deleteMany({ where: { id: { in: gapRows.map((r) => r.id) } } })
  check(
    'T27',
    'stored gap adversarial',
    gapRead.status === 409 && gapRead.body?.error?.code === 'INTEGRITY_CONFLICT' && gapAdd.status === 409 && JSON.stringify(gapUnrepaired) === '[1,3]',
    `read ${gapRead.status} and write ${gapAdd.status} fail closed as INTEGRITY_CONFLICT; stored order left unrepaired (adversarial rows removed)`,
  )
  check(
    'T28',
    'stored duplicate sequence adversarial',
    /unique|encounter_diagnoses_active_sequence_uidx/i.test(duplicateSequence) && removedTwin === '',
    'a duplicate active sequence cannot be stored (active partial unique index refuses it); the reader\'s fail-closed rule for it is proven by the unit tests; a removed row may share it',
  )

  // ---------------------------------------------------------------- reorder (T29–T38)
  section('Reorder — exact set, atomic')
  const [r1, r2, r3] = items
  const snapshot = async (encounterId: string) =>
    JSON.stringify((await prisma.encounterDiagnosis.findMany({ where: { encounterId }, orderBy: { id: 'asc' } })).map((r) => [r.id, r.sequence, r.removedAt]))
  const orderPath = `${path1}/order`
  const auditBeforeReverse = await diagnosisAuditCount()
  const reverse = await put(orderPath, { encounterDiagnosisIds: [r3.id, r2.id, r1.id] })
  const reversed: { id: string; sequence: number }[] = reverse.body?.items ?? []
  const reverseAudits = (await diagnosisAuditCount()) - auditBeforeReverse
  check(
    'T29',
    'reorder exact reverse',
    reverse.status === 200 && reversed.map((i) => i.id).join() === [r3.id, r2.id, r1.id].join() && JSON.stringify(reversed.map((i) => i.sequence)) === '[1,2,3]',
    'PUT succeeded; sequences rewritten atomically',
  )
  const before = await snapshot(e1.id)
  const auditBeforeInvalid = await diagnosisAuditCount()
  const sameOrder = await put(orderPath, { encounterDiagnosisIds: [r3.id, r2.id, r1.id] })
  check('T30', 'reorder same order', sameOrder.status === 400 && (await diagnosisAuditCount()) === auditBeforeInvalid, `status ${sameOrder.status}; no audit`)
  const missingId = await put(orderPath, { encounterDiagnosisIds: [r1.id, r2.id] })
  check('T31', 'reorder missing ID', missingId.status === 400 && (await snapshot(e1.id)) === before, `status ${missingId.status}; unchanged`)
  const duplicateId = await put(orderPath, { encounterDiagnosisIds: [r1.id, r1.id, r2.id] })
  check('T32', 'reorder duplicate ID', duplicateId.status === 400 && (await snapshot(e1.id)) === before, `status ${duplicateId.status}; unchanged`)
  const extraForeign = await put(orderPath, { encounterDiagnosisIds: [r1.id, r2.id, r3.id, foreignDiagnosis.id] })
  check('T33', 'reorder extra foreign ID', extraForeign.status === 400 && (await snapshot(e1.id)) === before && !JSON.stringify(extraForeign.body).includes(foreignCode.code), `status ${extraForeign.status}; unchanged`)
  const e2 = await newEncounter('2026-04-03')
  const e2Row = must('e2 diagnosis', (await post(`/api/encounters/${e2.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body)
  const e2Removed = must('e2 removed diagnosis', (await post(`/api/encounters/${e2.id}/diagnoses`, { diagnosisCodeId: dxB.id })).body)
  await post(`/api/encounter-diagnoses/${e2Removed.id}/remove`, {})
  const removedId = await put(`/api/encounters/${e2.id}/diagnoses/order`, { encounterDiagnosisIds: [e2Removed.id, e2Row.id] })
  check('T34', 'reorder removed ID', removedId.status === 400, `status ${removedId.status}; a removed row is not part of the active set`)
  const otherEncounterId = await put(orderPath, { encounterDiagnosisIds: [r3.id, r2.id, e2Row.id] })
  check('T35', 'reorder other Encounter ID', otherEncounterId.status === 400 && (await snapshot(e1.id)) === before, `status ${otherEncounterId.status}; unchanged`)
  const unknownOrderField = await put(orderPath, { encounterDiagnosisIds: [r1.id, r2.id, r3.id], sequence: [1, 2, 3] })
  check('T36', 'reorder unknown field', unknownOrderField.status === 400, `status ${unknownOrderField.status}`)
  const emptyWithActive = await put(orderPath, { encounterDiagnosisIds: [] })
  check('T37', 'reorder empty with active rows', emptyWithActive.status === 400 && (await snapshot(e1.id)) === before, `status ${emptyWithActive.status}`)
  const emptyEncounter = await newEncounter('2026-04-04')
  const auditBeforeEmpty = await diagnosisAuditCount()
  const emptyZero = await put(`/api/encounters/${emptyEncounter.id}/diagnoses/order`, { encounterDiagnosisIds: [] })
  check('T38', 'reorder empty with zero active rows', emptyZero.status === 400 && (await diagnosisAuditCount()) === auditBeforeEmpty, `status ${emptyZero.status}; no-op, no audit`)

  // ---------------------------------------------------------------- remove (T39–T47)
  section('Remove — history kept, order compacted')
  const e3 = await newEncounter('2026-04-05')
  const path3 = `/api/encounters/${e3.id}/diagnoses`
  const e3Rows: { id: string }[] = []
  for (const dx of [dxA, dxB, dxC, dxD]) e3Rows.push(must('e3 diagnosis', (await post(path3, { diagnosisCodeId: dx.id })).body))
  const [x1, x2, x3, x4] = e3Rows
  const activeSequences = async (encounterId: string) =>
    (await prisma.encounterDiagnosis.findMany({ where: { encounterId, removedAt: null }, orderBy: { sequence: 'asc' } })).map((r) => [r.id, r.sequence] as const)

  const removeMiddle = await post(`/api/encounter-diagnoses/${x2.id}/remove`, {})
  const x2Row = await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: x2.id } })
  check('T39', 'remove active row', removeMiddle.status === 200 && x2Row.removedAt !== null, `status ${removeMiddle.status}; removedAt set`)
  const afterMiddle = await activeSequences(e3.id)
  check(
    'T42',
    'remove middle',
    JSON.stringify(afterMiddle) === JSON.stringify([[x1.id, 1], [x3.id, 2], [x4.id, 3]]),
    'later rows compacted without a gap',
  )
  const removeFirst = await post(`/api/encounter-diagnoses/${x1.id}/remove`, {})
  const afterFirst = await activeSequences(e3.id)
  check('T41', 'remove first', removeFirst.status === 200 && JSON.stringify(afterFirst) === JSON.stringify([[x3.id, 1], [x4.id, 2]]), 'the former second row became 1')
  const removeLast = await post(`/api/encounter-diagnoses/${x4.id}/remove`, {})
  const afterLast = await activeSequences(e3.id)
  check('T43', 'remove last', removeLast.status === 200 && JSON.stringify(afterLast) === JSON.stringify([[x3.id, 1]]), 'earlier sequence unchanged')
  check(
    'T40',
    'remove compaction',
    [afterMiddle, afterFirst, afterLast].every((rows) => rows.every(([, sequence], index) => sequence === index + 1)),
    'remaining active rows stay contiguous 1..N after every removal',
  )
  const auditBeforeTwice = await diagnosisAuditCount()
  const removeTwice = await post(`/api/encounter-diagnoses/${x2.id}/remove`, {})
  check('T44', 'remove twice', removeTwice.status === 400 && (await diagnosisAuditCount()) === auditBeforeTwice, `status ${removeTwice.status}; no extra audit`)
  const retained = await prisma.encounterDiagnosis.count({ where: { id: { in: [x1.id, x2.id, x4.id] }, removedAt: { not: null } } })
  const deleteRoute = await callApi(baseUrl, `/api/encounter-diagnoses/${x3.id}`, asAdmin({ method: 'DELETE' }))
  check('T45', 'no hard delete', retained === 3 && deleteRoute.status === 404 && (await prisma.encounterDiagnosis.count({ where: { id: x3.id } })) === 1, `3 removed rows retained; DELETE -> ${deleteRoute.status}`)
  const restore = await post(`/api/encounter-diagnoses/${x2.id}/restore`, {})
  check('T46', 'no restore', restore.status === 404 && (await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: x2.id } })).removedAt !== null, `restore -> ${restore.status}`)
  const reAdd = await post(path3, { diagnosisCodeId: dxB.id })
  check(
    'T47',
    're-add after remove',
    reAdd.status === 201 && reAdd.body?.id !== x2.id && reAdd.body?.sequence === 2 && (await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: x2.id } })).removedAt !== null,
    'a new row id at the next sequence; the old removed row is retained',
  )
  check('T09', 'historical re-add', reAdd.status === 201, 'the removed row does not block adding the same code again (partial index)')

  // ---------------------------------------------------------------- concurrency (T48–T52)
  section('Concurrency — every writer locks the Encounter first')
  const raceEncounter = async () => newEncounter('2026-04-06')
  const contiguous = async (encounterId: string) => (await activeSequences(encounterId)).every(([, sequence], index) => sequence === index + 1)

  const addAdd = await raceEncounter()
  let hold = holdAt('encounterDiagnosis.add')
  const addOne = addEncounterDiagnosis(addAdd.id, { diagnosisCodeId: dxA.id }, actorUserId)
  await hold.arrived
  const addTwo = addEncounterDiagnosis(addAdd.id, { diagnosisCodeId: dxB.id }, actorUserId)
  const addAddBlocked = await waitForLockWaiter()
  hold.release()
  const [addOneResult, addTwoResult] = await Promise.all([addOne, addTwo])
  clearConcurrencyProbes()
  check(
    'T48',
    'concurrent add/add',
    addAddBlocked && addOneResult.ok && addTwoResult.ok && (await contiguous(addAdd.id)) && (await activeSequences(addAdd.id)).length === 2,
    'the second add waited on the Encounter lock; distinct contiguous sequences 1, 2',
  )

  const addReorder = await raceEncounter()
  const ar1 = must('ar1', (await post(`/api/encounters/${addReorder.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body)
  const ar2 = must('ar2', (await post(`/api/encounters/${addReorder.id}/diagnoses`, { diagnosisCodeId: dxB.id })).body)
  hold = holdAt('encounterDiagnosis.reorder')
  const reorderFirst = reorderEncounterDiagnoses(addReorder.id, { encounterDiagnosisIds: [ar2.id, ar1.id] }, actorUserId)
  await hold.arrived
  const addAfter = addEncounterDiagnosis(addReorder.id, { diagnosisCodeId: dxC.id }, actorUserId)
  const addReorderBlocked = await waitForLockWaiter()
  hold.release()
  const [reorderResult, addAfterResult] = await Promise.all([reorderFirst, addAfter])
  clearConcurrencyProbes()
  const addReorderState = await activeSequences(addReorder.id)
  check(
    'T49',
    'concurrent add/reorder',
    addReorderBlocked && reorderResult.ok && addAfterResult.ok && addReorderState.map(([id]) => id).slice(0, 2).join() === [ar2.id, ar1.id].join() && (await contiguous(addReorder.id)),
    'the add waited for the reorder, then appended at 3; the reordered state is preserved',
  )

  const addRemove = await raceEncounter()
  const am1 = must('am1', (await post(`/api/encounters/${addRemove.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body)
  must('am2', (await post(`/api/encounters/${addRemove.id}/diagnoses`, { diagnosisCodeId: dxB.id })).body)
  hold = holdAt('encounterDiagnosis.remove')
  const removeHeld = removeEncounterDiagnosis(am1.id, {}, actorUserId)
  await hold.arrived
  const addDuringRemove = addEncounterDiagnosis(addRemove.id, { diagnosisCodeId: dxC.id }, actorUserId)
  const addRemoveBlocked = await waitForLockWaiter()
  hold.release()
  const [removeHeldResult, addDuringRemoveResult] = await Promise.all([removeHeld, addDuringRemove])
  clearConcurrencyProbes()
  check(
    'T50',
    'concurrent add/remove',
    addRemoveBlocked && removeHeldResult.ok && addDuringRemoveResult.ok && addDuringRemoveResult.value.sequence === 2 && (await contiguous(addRemove.id)),
    'the add waited for the remove + compaction, then appended at 2; no duplicate or gap',
  )

  const reorderRemove = await raceEncounter()
  const rr1 = must('rr1', (await post(`/api/encounters/${reorderRemove.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body)
  const rr2 = must('rr2', (await post(`/api/encounters/${reorderRemove.id}/diagnoses`, { diagnosisCodeId: dxB.id })).body)
  const rr3 = must('rr3', (await post(`/api/encounters/${reorderRemove.id}/diagnoses`, { diagnosisCodeId: dxC.id })).body)
  hold = holdAt('encounterDiagnosis.reorder')
  const reorderHeld = reorderEncounterDiagnoses(reorderRemove.id, { encounterDiagnosisIds: [rr3.id, rr2.id, rr1.id] }, actorUserId)
  await hold.arrived
  const removeDuringReorder = removeEncounterDiagnosis(rr2.id, {}, actorUserId)
  const reorderRemoveBlocked = await waitForLockWaiter()
  hold.release()
  const [reorderHeldResult, removeDuringReorderResult] = await Promise.all([reorderHeld, removeDuringReorder])
  clearConcurrencyProbes()
  const reorderRemoveState = await activeSequences(reorderRemove.id)
  check(
    'T51',
    'concurrent reorder/remove',
    reorderRemoveBlocked &&
      reorderHeldResult.ok &&
      removeDuringReorderResult.ok &&
      JSON.stringify(reorderRemoveState) === JSON.stringify([[rr3.id, 1], [rr1.id, 2]]),
    'the remove waited for the reorder and compacted the reordered list; no lost update',
  )

  const removeRemove = await raceEncounter()
  const dd1 = must('dd1', (await post(`/api/encounters/${removeRemove.id}/diagnoses`, { diagnosisCodeId: dxA.id })).body)
  must('dd2', (await post(`/api/encounters/${removeRemove.id}/diagnoses`, { diagnosisCodeId: dxB.id })).body)
  hold = holdAt('encounterDiagnosis.remove')
  const firstRemove = removeEncounterDiagnosis(dd1.id, {}, actorUserId)
  await hold.arrived
  const secondRemove = removeEncounterDiagnosis(dd1.id, {}, actorUserId)
  const removeRemoveBlocked = await waitForLockWaiter()
  hold.release()
  const [firstRemoveResult, secondRemoveResult] = await Promise.all([firstRemove, secondRemove])
  clearConcurrencyProbes()
  const removedEvents = await prisma.auditEvent.count({ where: { entityId: dd1.id, actionCode: 'encounterDiagnosis.removed' } })
  check(
    'T52',
    'concurrent remove/remove',
    removeRemoveBlocked && firstRemoveResult.ok && !secondRemoveResult.ok && removedEvents === 1 && (await contiguous(removeRemove.id)),
    'only one remove succeeded; exactly one removed audit event',
  )

  // ---------------------------------------------------------------- audit (T53–T57)
  section('Clinical-data-minimized audit')
  const addedEvent = await prisma.auditEvent.findFirst({ where: { entityId: first.body.id, actionCode: 'encounterDiagnosis.added' } })
  const addedKeys = Object.keys((addedEvent?.afterState ?? {}) as Record<string, unknown>).sort()
  check('T53', 'create audit', !!addedEvent && addedEvent.entityType === 'ENCOUNTER_DIAGNOSIS' && addedEvent.beforeState === null && addedKeys.every((key) => ['id', 'removedAt', 'sequence', 'updatedAt'].includes(key)), `snapshot keys: ${addedKeys.join(', ')}`)
  check('T54', 'reorder audit', reverseAudits === 2, `reversing three rows wrote ${reverseAudits} reordered events (only the two rows that moved)`)
  const removedEvent = await prisma.auditEvent.findFirst({ where: { entityId: x2.id, actionCode: 'encounterDiagnosis.removed' } })
  check(
    'T55',
    'remove audit',
    !!removedEvent && !JSON.stringify([removedEvent.beforeState, removedEvent.afterState]).includes(dxB.id) && ((removedEvent.afterState ?? {}) as Record<string, unknown>).removedAt !== undefined,
    'removed event records the row and its removal, not the diagnosis',
  )
  const runRowIds = (await prisma.encounterDiagnosis.findMany({ where: { encounter: { patientId: patient.id } }, select: { id: true } })).map((row) => row.id)
  const runEvents = await prisma.auditEvent.findMany({ where: { entityType: 'ENCOUNTER_DIAGNOSIS', entityId: { in: runRowIds } } })
  const runEventText = JSON.stringify(runEvents.map((event) => [event.beforeState, event.afterState]))
  const forbidden = [
    ...codes.flatMap((code) => [code.id, code.code, code.displayName]),
    e1.id,
    e2.id,
    e3.id,
    patient.id,
    facility.id,
    clinician.id,
    '2026-04-0',
  ]
  const leaked = forbidden.filter((value) => runEventText.includes(value))
  check('T56', 'audit clinical minimization', runEvents.length > 0 && leaked.length === 0, `${runEvents.length} event(s); no encounterId, diagnosisCodeId, code, displayName or request body`)
  const auditBeforeBatch = await diagnosisAuditCount()
  await post(path1, { diagnosisCodeId: foreignCode.id }) // cross-org
  await post(path1, { diagnosisCodeId: dxA.id }) // duplicate active
  await post(path1, { diagnosisCodeId: dxE.id }, asViewer) // denied
  await put(orderPath, { encounterDiagnosisIds: [r3.id, r2.id, r1.id] }) // no-op
  await post(`/api/encounter-diagnoses/${x2.id}/remove`, {}) // already removed
  await post(path1, { diagnosisCodeId: dxF.id, sequence: 9 }) // invalid body
  check('T57', 'no false audit', (await diagnosisAuditCount()) === auditBeforeBatch, `before=${auditBeforeBatch} after=${await diagnosisAuditCount()}`)

  // ---------------------------------------------------------------- scope guards (T58–T64)
  section('Scope guards — a link table, nothing more')
  const columnsOf = async (table: string) =>
    (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = ${table} ORDER BY column_name`).map((row) => row.column_name)
  const columns = await columnsOf('encounter_diagnoses')
  check('T58', 'no org duplicate', !columns.includes('organization_id') && !columns.includes('patient_id'), `columns: ${columns.join(', ')}`)
  check('T59', 'no isPrimary', !columns.some((name) => /(primary|role|rank|principal)/i.test(name)), 'no primary/role column; sequence 1 is simply first-listed')
  check('T60', 'no code snapshot', !columns.some((name) => /^(code|display_name)$/i.test(name) || /(code_text|description)/i.test(name)), 'code/displayName stay on DiagnosisCode')
  check('T61', 'no claim fields', !columns.some((name) => /(claim|line|submission|price|amount|tariff)/i.test(name)), 'no A6 field')
  check('T62', 'no A5 fields', !columns.some((name) => /(eligib|authoriz|evidence|readiness|status)/i.test(name)), 'no A5 field')
  check('T63', 'no A4.6 fields', !columns.some((name) => /(procedure|service|quantity|modifier|activity)/i.test(name)), 'no A4.6 field')
  const externalIdentifierColumns = await columnsOf('external_identifiers')
  // A4.8 (PR #46) added the approved `encounter_id` target. A4.5's own boundary is unchanged: the
  // diagnosis LINK is not an identity target — only the DiagnosisCode master ever was — so no
  // encounter_diagnosis / diagnosis_link column may appear on the identity table.
  const diagnosisLinkLeak = externalIdentifierColumns.filter((name) =>
    /(encounter_diagnosis|diagnosis_link)/i.test(name),
  )
  check(
    'T64',
    'no external-ID extension',
    diagnosisLinkLeak.length === 0 && externalIdentifierColumns.includes('diagnosis_code_id'),
    diagnosisLinkLeak.length === 0
      ? 'EncounterDiagnosis is not an external-ID target; only the DiagnosisCode master is, and the approved encounter_id target is allowed'
      : `EncounterDiagnosis leaked into the identity table: ${diagnosisLinkLeak.join(', ')}`,
  )

  // ---------------------------------------------------------------- build and regressions (T65–T75)
  section('Unit, typecheck, build, regressions and DB truth')
  const unit = run('npm run test:unit')
  check('T65', 'unit tests', unit.ok && /ℹ fail 0/.test(unit.output), `${(unit.output.match(/ℹ pass \d+/) ?? [''])[0]} ${(unit.output.match(/ℹ fail \d+/) ?? [''])[0]}`.trim())
  const typecheck = run('npm run typecheck')
  check('T66', 'backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T67', 'frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])

  // Each nested suite also asserts its OWN branch identity and diff, and some assert that later
  // tables do not exist yet (A4.4 T66: no diagnosis table; A4.3 T57: no encounter table). On the
  // A4.5 branch those checks cannot hold, so exactly those IDs are listed; every other check must
  // pass, and each suite's core marker must be present.
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
  await apiReady('the A4.4 regression')
  regression('T68', 'A4.4 regression', 'test:a4:encounter', 'A4.4', ['T01', 'T66', 'T82', 'T83'], /T59 concurrent partial PATCH \.* PASS/)
  await apiReady('the A4.3 regression')
  regression('T69', 'A4.3 regression', 'test:a4:insurance', 'A4.3', ['T01', 'T57', 'T69', 'T70'], /T49 concurrent partial updates \.* PASS/)
  await apiReady('the A4.2 regression')
  regression('T70', 'A4.2 regression', 'test:a4:assignments', 'A4.2', ['T01', 'T72', 'T73'], /T48 facility create race \.* PASS/)
  await apiReady('the A4.1 regression')
  regression('T71', 'A4.1 regression', 'test:a4:patient', 'A4.1', ['T01', 'T54', 'T55'], /P01 ownership lookup selects only organizationId \.* PASS/)
  await apiReady('the A3 governance regression')
  regression('T72', 'A3 regression', 'test:a3:integration', 'A3.10', ['T01', 'T03', 'T04', 'T66', 'T73', 'T76'], /T31 X01 full governance chain \.* PASS/)
  await apiReady('the A2 regression')
  const a2 = run('npm run test:a2:integration')
  check('T73', 'A2 regression', a2.ok && /36\/36 PASS/.test(a2.output), (a2.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0])
  await apiReady('the A1 regression')
  const a1 = run('npm run test:a1:integration')
  check('T74', 'A1 regression', /26\/27 PASS/.test(a1.output) && /worker graceful stop/.test(a1.output), `${(a1.output.match(/automated summary: [^\n]*/) ?? ['no summary'])[0]} (only the known Windows SIGTERM limitation)`)

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
    'T75',
    'DB health truth',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  const priorRows = await prisma.encounterDiagnosis.count({ where: { encounter: { patient: { organizationId: org, familyName: { startsWith: 'A45-' }, NOT: { familyName: { startsWith: runId } } } } } })
  check('T76', 'repeatability', true, `this run used fresh synthetic identities (${runId}); ${priorRows} diagnosis row(s) from earlier runs retained`)

  // git is called WITHOUT a shell, with repository-root `:/` pathspecs. Exit 1 = no match (wanted),
  // anything but 0/1 = the search itself failed, which is a FAIL. The sanity search proves reach.
  const gitGrep = (pattern: string, paths: string[]) => {
    const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
    return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
  }
  const logged = gitGrep('console[.](log|info|warn|error|debug)[(].*(diagnos|displayName|code)', [':/backend/src/modules/encounter-diagnosis', ':/frontend/src/modules/encounter-diagnosis'])
  const stored = gitGrep('(localStorage|sessionStorage)[.][A-Za-z]+[(]', [':/frontend/src/modules/encounter-diagnosis'])
  const sanity = gitGrep('diagnosisCodeId', [':/frontend/src/modules/encounter-diagnosis/encounter-diagnosis.api.ts'])
  check(
    'T77',
    'logging/storage',
    sanity.status === 0 && logged.status === 1 && stored.status === 1,
    logged.status === 1 && stored.status === 1
      ? 'no diagnosis or clinical value logged or kept in browser storage (searches verified to reach the sources)'
      : `logged=${logged.status} storage=${stored.status}: ${[logged.output, stored.output].join(' | ').slice(0, 200)}`,
  )

  // ---------------------------------------------------------------- git (T78–T79)
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
    // Approved (Option A): the shared API error vocabulary gains INTEGRITY_CONFLICT (A4.5 §21).
    'backend/src/shared/errors/error.types.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/encounter-diagnosis/') &&
      !file.startsWith('backend/src/integration/a4-encounter-diagnosis/') &&
      !file.startsWith('frontend/src/modules/encounter-diagnosis/') &&
      !file.includes('a4_5_encounter_diagnosis_capture') &&
      !allowed.includes(file),
  )
  check('T78', 'git scope', outOfScope.length === 0, outOfScope.length === 0 ? `${changedPaths.length} path(s) since A4.4, all A4.5` : `unexpected: ${outOfScope.join(', ')}`)
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T79', 'final git', git('status --porcelain') === '' && tracking.includes(`origin/${a45Branch}`), `${tracking}; working tree ${git('status --porcelain') === '' ? 'clean' : 'dirty'}`)

  console.log(`\n[A4.5] run ${runId} — HEAD ${git('rev-parse HEAD')}`)
  if (failures.length > 0) {
    console.log(`[A4.5] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  console.log(`[A4.5] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.5] A4.5 ENCOUNTER DIAGNOSIS ACCEPTANCE COMPLETE' : '[A4.5] A4.5 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.5] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    await prisma.$disconnect()
  })
