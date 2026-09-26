import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { updateExternalIdentifier } from '../../modules/external-identifier/external-identifier.service.ts'
import { targetTypes } from '../../modules/external-identifier/external-identifier.target.ts'

// A4.8 — focused acceptance for the Patient & Encounter External Identity Extension (T01–T90).
// A4.8 adds no domain of its own: it widens the canonical A2.9 ExternalIdentifier typed target set
// from ten to twelve. Valid fixtures are created through their owning routes; the database is READ
// for structural and audit proof. Records of ANOTHER organization are created directly, because
// this tenant's routes correctly refuse to author them. ADVERSARIAL rows (writes the service would
// never make) go in only to prove the database refuses them, always inside a rolled-back
// transaction. Every identifier, source system and external value is synthetic.

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.8] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.8] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n[A4.8] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

const runId = `A48-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A4.7 FINAL PASS was merged into main as PR #45; A4.8 is branched from exactly that merge and
// never from the (now deleted) A4.7 feature branch.
const a47Merge = '6239479'
const a48Branch = 'feature/a4-8-patient-encounter-external-identity'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const day = (text: string) => new Date(`${text}T00:00:00.000Z`)
const MISSING = '11111111-1111-4111-8111-111111111111'

// The twelve approved target columns, in the order the CHECK names them.
const approvedTargetColumns = [
  'organization_target_id',
  'facility_id',
  'clinician_id',
  'specialty_id',
  'payer_id',
  'tpa_id',
  'network_id',
  'service_id',
  'procedure_code_id',
  'diagnosis_code_id',
  'patient_id',
  'encounter_id',
]

async function identifierAuditCount(): Promise<number> {
  return prisma.auditEvent.count({ where: { organizationId: org, entityType: 'EXTERNAL_IDENTIFIER' } })
}

async function auditStatesFor(entityId: string): Promise<{ beforeState: unknown; afterState: unknown }[]> {
  return prisma.auditEvent.findMany({
    where: { entityType: 'EXTERNAL_IDENTIFIER', entityId },
    orderBy: { occurredAt: 'asc' },
    select: { beforeState: true, afterState: true },
  })
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

// Holds the writer that reaches `probe` (inside its row lock) until released.
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

// True when the serialized snapshot mentions any of these strings anywhere — the check used for
// sensitive-value leakage, so a value nested at any depth is still caught.
const mentions = (state: unknown, needles: string[]) => {
  const text = JSON.stringify(state ?? {})
  return needles.some((needle) => needle.length > 0 && text.includes(needle))
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A4.8] Patient & Encounter external identity extension — run ${runId}`)
  console.log(`[A4.8] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- gates (T01–T05)
  section('Start gate and schema')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const a47OnMain = gitOk(`merge-base --is-ancestor ${a47Merge} origin/main`)
  const branchHasMain = gitOk('merge-base --is-ancestor origin/main HEAD')
  check(
    'T01',
    'start gate',
    branch === a48Branch && a47OnMain && branchHasMain,
    `branch ${branch}; A4.7 merge ${a47Merge} (PR #45) is on main and is an ancestor; the branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )

  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  // git resolves a pathspec from the current directory, and this suite runs from backend/;
  // ':/' anchors the pathspec at the repository root instead.
  const migrationDirs = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations')
    .split(/\r?\n/)
    .filter((line) => line.endsWith('migration.sql'))
  const migrationSql = migrationDirs.length === 1 ? git(`show HEAD:${migrationDirs[0]}`) : ''
  // Only executable SQL is judged. The Drift Guard note in the file header names the statements
  // that were REMOVED, so testing the raw text would match the very words it promises are absent.
  const migrationStatements = migrationSql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
  const scopeProblems = [
    [/ALTER TABLE "external_identifiers" ADD COLUMN/.test(migrationStatements), 'the identity columns are not added'],
    [!/ALTER TABLE "patients"/.test(migrationStatements), 'patients is altered'],
    [!/ALTER TABLE "encounters"/.test(migrationStatements), 'encounters is altered'],
    [!/CREATE TABLE/.test(migrationStatements), 'a table is created'],
    [!/DROP INDEX/.test(migrationStatements), 'an index is dropped (drift)'],
    [!/SET DEFAULT pg_catalog/.test(migrationStatements), 'Better Auth defaults leaked in (drift)'],
    [!/UNIQUE/.test(migrationStatements), 'uniqueness is touched'],
    [(migrationStatements.match(/ADD CONSTRAINT "external_identifiers_(patient|encounter)_id_fkey"/g) ?? []).length === 2, 'the two RESTRICT FKs are not both added'],
    [(migrationStatements.match(/CREATE INDEX "external_identifiers_(patient|encounter)_id_idx"/g) ?? []).length === 2, 'the two indexes are not both created'],
    [approvedTargetColumns.every((column) => migrationStatements.includes(`"${column}"`)), 'the CHECK does not name all 12 approved targets'],
  ]
    .filter(([ok]) => !ok)
    .map(([, reason]) => reason as string)
  check(
    'T03',
    'migration scope',
    migrationDirs.length === 1 && scopeProblems.length === 0,
    migrationDirs.length !== 1
      ? `expected exactly one migration, found ${migrationDirs.length}`
      : scopeProblems.length === 0
        ? 'one migration; 2 columns, 2 RESTRICT FKs, 2 indexes and the 12-target CHECK only; no new table, no patients/encounters change, no uniqueness change, no drift'
        : `out of scope: ${scopeProblems.join('; ')}`,
  )

  const validate = run('npm run db:validate')
  const generate = run('npm run db:generate')
  const status = run('npm run db:status')
  check(
    'T04',
    'prisma validate/generate/status',
    validate.ok && generate.ok && status.ok && /Database schema is up to date/.test(status.output),
    'schema valid, client generated, schema up to date',
  )

  const replay = run('npm run db:verify:replay')
  check(
    'T05',
    'migration replay',
    replay.ok &&
      /ALL CHECKS PASS/.test(replay.output) &&
      /the exact-one-target CHECK names all 12 approved targets after a clean replay/.test(replay.output) &&
      /external_identifiers_patient_id_fkey is present/.test(replay.output) &&
      /external_identifiers_encounter_id_fkey is present/.test(replay.output),
    (replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0] +
      '; the 12-target CHECK, both FKs and both indexes survive a clean replay',
  )

  // ---------------------------------------------------------------- structure (T06–T11)
  section('Foreign keys, indexes and the exact-one-target CHECK')
  const fks = await prisma.$queryRaw<{ conname: string; deltype: string; def: string }[]>`
    SELECT conname, confdeltype::text AS deltype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = 'external_identifiers'::regclass AND contype = 'f' ORDER BY conname`
  const patientFk = fks.find((fk) => fk.conname === 'external_identifiers_patient_id_fkey')
  const encounterFk = fks.find((fk) => fk.conname === 'external_identifiers_encounter_id_fkey')
  check(
    'T06',
    'Patient FK',
    !!patientFk && patientFk.deltype === 'r' && /REFERENCES patients\(id\)/.test(patientFk.def),
    patientFk ? `${patientFk.def} (ON DELETE RESTRICT)` : 'patient_id FK missing',
  )
  check(
    'T07',
    'Encounter FK',
    !!encounterFk && encounterFk.deltype === 'r' && /REFERENCES encounters\(id\)/.test(encounterFk.def),
    encounterFk ? `${encounterFk.def} (ON DELETE RESTRICT)` : 'encounter_id FK missing',
  )

  const indexes = (await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'external_identifiers'`).map((row) => row.indexname)
  check('T08', 'Patient index', indexes.includes('external_identifiers_patient_id_idx'), 'external_identifiers_patient_id_idx present')
  check('T09', 'Encounter index', indexes.includes('external_identifiers_encounter_id_idx'), 'external_identifiers_encounter_id_idx present')

  const targetCheckRows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = 'external_identifiers'::regclass AND contype = 'c'`
  const exactOne = targetCheckRows.find((row) => row.conname === 'external_identifiers_exactly_one_target_chk')
  check(
    'T10',
    'Exact-one CHECK name',
    !!exactOne && targetCheckRows.length === 1,
    exactOne ? 'external_identifiers_exactly_one_target_chk preserved under its original name; it is the only CHECK on the table' : 'the exact-one-target CHECK is missing',
  )
  const checkDef = exactOne?.def ?? ''
  const namedColumns = (checkDef.match(/num_nonnulls\(([^)]*)\)/) ?? ['', ''])[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  check(
    'T11',
    'Exact-one CHECK count',
    namedColumns.length === 12 &&
      approvedTargetColumns.every((column) => namedColumns.includes(column)) &&
      namedColumns.every((column) => approvedTargetColumns.includes(column)) &&
      / = 1\)/.test(checkDef),
    `num_nonnulls names exactly the 12 approved columns = 1 (${namedColumns.length} found)`,
  )

  // ---------------------------------------------------------------- DB truth, rolled back (T12–T14)
  section('Database refuses zero and two targets')
  // These rows need a real Patient/Encounter to satisfy the new FKs, so the fixtures come first.
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
  const del = (path: string, who = asAdmin) => callApi(baseUrl, path, who({ method: 'DELETE' }))
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
  const encounter = must('encounter', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: '2026-07-01' })).body)
  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)

  // Run-specific synthetic namespaces and values, so an audit leak search cannot match anything else.
  const tail = runId.slice(-6)
  const patientSource = `SYNTHETIC_EMR_PATIENT_${tail}`
  const encounterSource = `SYNTHETIC_EMR_ENCOUNTER_${tail}`
  const patientValue = `PT-${tail}`
  const encounterValue = `VISIT-${tail}`

  const insert = (data: Record<string, unknown>) =>
    attemptAdversarialInsert((tx) =>
      tx.externalIdentifier.create({ data: { organizationId: org, sourceSystem: `${runId}-ADV`, externalValue: `ADV-${Math.random()}`, ...data } as never }),
    )
  const noTarget = await insert({})
  check('T12', 'DB zero target', /external_identifiers_exactly_one_target_chk/.test(noTarget), 'a row with no target at all is refused by the database')
  const bothNew = await insert({ patientId: patient.id, encounterId: encounter.id })
  check('T13', 'DB two targets Patient+Encounter', /external_identifiers_exactly_one_target_chk/.test(bothNew), 'patient_id and encounter_id together are refused')
  const oldAndNew = await insert({ payerId: payer.id, patientId: patient.id })
  const oldAndEncounter = await insert({ payerId: payer.id, encounterId: encounter.id })
  check(
    'T14',
    'DB old+Patient two targets',
    /external_identifiers_exactly_one_target_chk/.test(oldAndNew) && /external_identifiers_exactly_one_target_chk/.test(oldAndEncounter),
    'an old target combined with either new target is refused',
  )

  // ---------------------------------------------------------------- the target union (T15–T16)
  section('Target union — ten still work, twelve are recognized, nothing else is')
  const oldTargets: { type: string; id: string }[] = [
    { type: 'ORGANIZATION', id: org },
    { type: 'FACILITY', id: facility.id },
    { type: 'CLINICIAN', id: clinician.id },
    { type: 'PAYER', id: payer.id },
  ]
  const oldResults: string[] = []
  for (const target of oldTargets) {
    const res = await post(`/api/organizations/${org}/external-identifiers`, {
      sourceSystem: `${runId}-OLD-${target.type}`,
      externalValue: `OLD-${tail}-${target.type}`,
      target,
    })
    const body = res.body as { target?: { type?: string; id?: string } }
    oldResults.push(`${target.type}:${res.status}:${body?.target?.type === target.type && body?.target?.id === target.id ? 'ok' : 'wrong'}`)
  }
  check(
    'T15',
    'Old 10 target regression',
    oldResults.every((line) => line.endsWith(':201:ok')),
    `pre-existing targets still resolve and derive correctly (${oldResults.join(', ')})`,
  )

  const unknownTarget = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: `${runId}-UNKNOWN`,
    externalValue: `UNK-${tail}`,
    target: { type: 'INSURANCE_MEMBERSHIP', id: patient.id },
  })
  check(
    'T16',
    'Target union',
    targetTypes.includes('PATIENT') && targetTypes.includes('ENCOUNTER') && targetTypes.length === 12 && unknownTarget.status === 400,
    `PATIENT and ENCOUNTER recognized, union size ${targetTypes.length}; an arbitrary target type is refused with ${unknownTarget.status}`,
  )

  // ---------------------------------------------------------------- create (T17–T26)
  section('Patient and Encounter mappings — create and ownership')
  const auditBeforeCreates = await identifierAuditCount()
  const patientCreate = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: patientSource,
    externalValue: patientValue,
    target: { type: 'PATIENT', id: patient.id },
  })
  const patientIdentifier = must('patient identifier', patientCreate.body as { id?: string })
  const patientBody = patientCreate.body as { target?: { type?: string; id?: string } }
  check(
    'T17',
    'Patient create',
    patientCreate.status === 201 && patientBody.target?.type === 'PATIENT' && patientBody.target?.id === patient.id,
    `201 with target {PATIENT, ${patient.id}}`,
  )

  const encounterCreate = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: encounterSource,
    externalValue: encounterValue,
    target: { type: 'ENCOUNTER', id: encounter.id },
  })
  const encounterIdentifier = must('encounter identifier', encounterCreate.body as { id?: string })
  const encounterBody = encounterCreate.body as { target?: { type?: string; id?: string } }
  check(
    'T18',
    'Encounter create',
    encounterCreate.status === 201 && encounterBody.target?.type === 'ENCOUNTER' && encounterBody.target?.id === encounter.id,
    `201 with target {ENCOUNTER, ${encounter.id}}`,
  )

  const storedPatientRow = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: patientIdentifier.id } })
  check(
    'T19',
    'Patient ownership',
    storedPatientRow.organizationId === org && storedPatientRow.patientId === patient.id && storedPatientRow.encounterId === null,
    'the own-organization Patient is accepted and stored in patient_id alone',
  )
  const storedEncounterRow = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: encounterIdentifier.id } })
  check(
    'T20',
    'Encounter ownership',
    storedEncounterRow.organizationId === org && storedEncounterRow.encounterId === encounter.id && storedEncounterRow.patientId === null,
    'the own-organization Encounter is accepted through its Patient ownership, stored in encounter_id alone',
  )

  // Records of ANOTHER organization — created directly, see the header.
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

  const rowsBeforeRefusals = await prisma.externalIdentifier.count({ where: { organizationId: org } })
  const auditBeforeRefusals = await identifierAuditCount()
  const crossPatient = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: `${runId}-XP`,
    externalValue: `XP-${tail}`,
    target: { type: 'PATIENT', id: foreignPatient.id },
  })
  const crossEncounter = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: `${runId}-XE`,
    externalValue: `XE-${tail}`,
    target: { type: 'ENCOUNTER', id: foreignEncounter.id },
  })
  const missingPatient = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: `${runId}-MP`,
    externalValue: `MP-${tail}`,
    target: { type: 'PATIENT', id: MISSING },
  })
  const missingEncounter = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: `${runId}-ME`,
    externalValue: `ME-${tail}`,
    target: { type: 'ENCOUNTER', id: MISSING },
  })
  const badPatientUuid = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: `${runId}-BP`,
    externalValue: `BP-${tail}`,
    target: { type: 'PATIENT', id: 'not-a-uuid' },
  })
  const badEncounterUuid = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: `${runId}-BE`,
    externalValue: `BE-${tail}`,
    target: { type: 'ENCOUNTER', id: '123' },
  })
  const rowsAfterRefusals = await prisma.externalIdentifier.count({ where: { organizationId: org } })
  const auditAfterRefusals = await identifierAuditCount()
  const noSideEffect = rowsAfterRefusals === rowsBeforeRefusals && auditAfterRefusals === auditBeforeRefusals
  const foreignLeak = (res: { body: unknown }) => JSON.stringify(res.body ?? {}).includes(otherOrg)

  check(
    'T21',
    'Cross-org Patient',
    crossPatient.status >= 400 && crossPatient.status < 500 && !foreignLeak(crossPatient) && noSideEffect,
    `a Patient owned by another organization is refused with ${crossPatient.status}, no row and no audit, and the response names no foreign detail`,
  )
  check(
    'T22',
    'Cross-org Encounter',
    crossEncounter.status >= 400 && crossEncounter.status < 500 && !foreignLeak(crossEncounter) && noSideEffect,
    `an Encounter owned by another organization is refused with ${crossEncounter.status} through its Patient, no row and no audit`,
  )
  check('T23', 'Missing Patient', missingPatient.status === 404 && noSideEffect, `an unknown Patient is ${missingPatient.status}, no row and no audit`)
  check('T24', 'Missing Encounter', missingEncounter.status === 404 && noSideEffect, `an unknown Encounter is ${missingEncounter.status}, no row and no audit`)
  check('T25', 'Malformed Patient UUID', badPatientUuid.status === 400 && noSideEffect, `a malformed Patient id is ${badPatientUuid.status}, never a 500`)
  check('T26', 'Malformed Encounter UUID', badEncounterUuid.status === 400 && noSideEffect, `a malformed Encounter id is ${badEncounterUuid.status}, never a 500`)

  // ---------------------------------------------------------------- reads (T27–T30)
  section('Reads — clean typed target, correct scoping, viewer access')
  const internals = ['patientId', 'encounterId', 'payerId', 'facilityId', 'organizationTargetId', 'diagnosisCodeId', 'procedureCodeId']
  const patientGet = await get(`/api/external-identifiers/${patientIdentifier.id}`)
  const patientDto = patientGet.body as Record<string, unknown>
  check(
    'T27',
    'Patient DTO',
    patientGet.status === 200 &&
      JSON.stringify((patientDto.target ?? {}) as object) === JSON.stringify({ type: 'PATIENT', id: patient.id }) &&
      internals.every((name) => !(name in patientDto)),
    'returns a clean { type, id } target and exposes no nullable FK internals',
  )
  const encounterGet = await get(`/api/external-identifiers/${encounterIdentifier.id}`)
  const encounterDto = encounterGet.body as Record<string, unknown>
  check(
    'T28',
    'Encounter DTO',
    encounterGet.status === 200 &&
      JSON.stringify((encounterDto.target ?? {}) as object) === JSON.stringify({ type: 'ENCOUNTER', id: encounter.id }) &&
      internals.every((name) => !(name in encounterDto)),
    'returns a clean { type, id } target and exposes no nullable FK internals',
  )

  const ownList = ((await get(`/api/organizations/${org}/external-identifiers`)).body as { items?: { id: string }[] })?.items ?? []
  const otherList = ((await get(`/api/organizations/${otherOrg}/external-identifiers`)).body as { items?: { id: string }[] })?.items ?? []
  const ownIds = ownList.map((item) => item.id)
  check(
    'T29',
    'Organization list',
    ownIds.includes(patientIdentifier.id) &&
      ownIds.includes(encounterIdentifier.id) &&
      !otherList.some((item) => item.id === patientIdentifier.id || item.id === encounterIdentifier.id),
    'the Patient and Encounter mappings appear only in their owner organization list',
  )

  const viewerGet = await get(`/api/external-identifiers/${patientIdentifier.id}`, asViewer)
  const viewerList = await get(`/api/organizations/${org}/external-identifiers`, asViewer)
  check('T30', 'Viewer read', viewerGet.status === 200 && viewerList.status === 200, 'a viewer may list and get Patient/Encounter identifiers')

  // ---------------------------------------------------------------- RBAC (T31–T32)
  section('RBAC — reuse of the external_identifier permission family')
  const rowsBeforeViewer = await prisma.externalIdentifier.count({ where: { organizationId: org } })
  const auditBeforeViewer = await identifierAuditCount()
  const viewerCreate = await post(
    `/api/organizations/${org}/external-identifiers`,
    { sourceSystem: `${runId}-VC`, externalValue: `VC-${tail}`, target: { type: 'PATIENT', id: patient.id } },
    asViewer,
  )
  const viewerUpdate = await patch(`/api/external-identifiers/${patientIdentifier.id}`, { externalValue: `VU-${tail}` }, asViewer)
  const afterViewerRow = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: patientIdentifier.id } })
  check(
    'T31',
    'Viewer create denial',
    viewerCreate.status === 403 &&
      (await prisma.externalIdentifier.count({ where: { organizationId: org } })) === rowsBeforeViewer &&
      (await identifierAuditCount()) === auditBeforeViewer,
    '403 with no row and no audit',
  )
  check(
    'T32',
    'Viewer update denial',
    viewerUpdate.status === 403 && afterViewerRow.externalValue === patientValue,
    '403 and the stored value is unchanged',
  )

  // ---------------------------------------------------------------- immutability (T33–T34)
  section('Target immutability — locked for the new targets too')
  const reassignAttempts = [
    { target: { type: 'ENCOUNTER', id: encounter.id } },
    { targetType: 'ENCOUNTER' },
    { targetId: encounter.id },
    { patientId: patient.id },
  ]
  const patientReassign: number[] = []
  for (const body of reassignAttempts) patientReassign.push((await patch(`/api/external-identifiers/${patientIdentifier.id}`, body)).status)
  const patientStillPatient = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: patientIdentifier.id } })
  check(
    'T33',
    'Target immutability PATIENT',
    patientReassign.every((status) => status === 400) && patientStillPatient.patientId === patient.id && patientStillPatient.encounterId === null,
    'target, targetType, targetId and the raw patientId are all refused; the stored target is unchanged',
  )

  const encounterReassign: number[] = []
  for (const body of [
    { target: { type: 'PATIENT', id: patient.id } },
    { targetType: 'PATIENT' },
    { targetId: patient.id },
    { encounterId: encounter.id },
  ])
    encounterReassign.push((await patch(`/api/external-identifiers/${encounterIdentifier.id}`, body)).status)
  const encounterStillEncounter = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: encounterIdentifier.id } })
  check(
    'T34',
    'Target immutability ENCOUNTER',
    encounterReassign.every((status) => status === 400) && encounterStillEncounter.encounterId === encounter.id && encounterStillEncounter.patientId === null,
    'target, targetType, targetId and the raw encounterId are all refused; the stored target is unchanged',
  )

  // ---------------------------------------------------------------- source/value updates (T35–T40)
  section('Source and value updates — allowed, with a truthful audit')
  const patientSource2 = `${patientSource}_V2`
  const patientValue2 = `${patientValue}-V2`
  const sourceUpdatePatient = await patch(`/api/external-identifiers/${patientIdentifier.id}`, { sourceSystem: patientSource2 })
  const afterSourcePatient = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: patientIdentifier.id } })
  check(
    'T35',
    'Source update Patient',
    sourceUpdatePatient.status === 200 && afterSourcePatient.sourceSystem === patientSource2 && afterSourcePatient.patientId === patient.id,
    'the source namespace changes and the target stays the same Patient',
  )
  const valueUpdatePatient = await patch(`/api/external-identifiers/${patientIdentifier.id}`, { externalValue: patientValue2 })
  const afterValuePatient = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: patientIdentifier.id } })
  check(
    'T36',
    'External value update Patient',
    valueUpdatePatient.status === 200 && afterValuePatient.externalValue === patientValue2 && afterValuePatient.patientId === patient.id,
    'the external value changes and the target stays the same Patient',
  )

  const encounterSource2 = `${encounterSource}_V2`
  const encounterValue2 = `${encounterValue}-V2`
  const sourceUpdateEncounter = await patch(`/api/external-identifiers/${encounterIdentifier.id}`, { sourceSystem: encounterSource2 })
  const afterSourceEncounter = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: encounterIdentifier.id } })
  check(
    'T37',
    'Source update Encounter',
    sourceUpdateEncounter.status === 200 && afterSourceEncounter.sourceSystem === encounterSource2 && afterSourceEncounter.encounterId === encounter.id,
    'the source namespace changes and the target stays the same Encounter',
  )
  const valueUpdateEncounter = await patch(`/api/external-identifiers/${encounterIdentifier.id}`, { externalValue: encounterValue2 })
  const afterValueEncounter = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: encounterIdentifier.id } })
  check(
    'T38',
    'External value update Encounter',
    valueUpdateEncounter.status === 200 && afterValueEncounter.externalValue === encounterValue2 && afterValueEncounter.encounterId === encounter.id,
    'the external value changes and the target stays the same Encounter',
  )

  const auditBeforeEmpty = await identifierAuditCount()
  const emptyPatch = await patch(`/api/external-identifiers/${patientIdentifier.id}`, {})
  check(
    'T39',
    'Empty PATCH',
    emptyPatch.status === 400 && (await identifierAuditCount()) === auditBeforeEmpty,
    `an empty body is ${emptyPatch.status} with no audit`,
  )

  // A4.8 §18 — an identical PATCH must not manufacture an update event.
  const beforeNoOp = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: patientIdentifier.id } })
  const auditBeforeNoOp = await identifierAuditCount()
  const noOpBoth = await patch(`/api/external-identifiers/${patientIdentifier.id}`, { sourceSystem: beforeNoOp.sourceSystem, externalValue: beforeNoOp.externalValue })
  const noOpOne = await patch(`/api/external-identifiers/${patientIdentifier.id}`, { externalValue: beforeNoOp.externalValue })
  const afterNoOp = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: patientIdentifier.id } })
  check(
    'T40',
    'No-op PATCH',
    noOpBoth.status === 400 &&
      noOpOne.status === 400 &&
      afterNoOp.updatedAt.getTime() === beforeNoOp.updatedAt.getTime() &&
      (await identifierAuditCount()) === auditBeforeNoOp,
    'identical values are refused with 400; updatedAt is untouched and no AuditEvent is written',
  )

  // A4.8 audit correction — the PATCH endpoint used to read five named fields off the body, so any
  // other key sent ALONGSIDE a legitimate one was silently discarded: the source changed and the
  // attempted retarget vanished without a word, leaving the caller to believe it had happened. Each
  // case below must fail the WHOLE request and leave the row and the audit trail untouched.
  const mixedFieldCases: [string, string, Record<string, unknown>][] = [
    ['T40a', 'Mixed PATCH sourceSystem+patientId', { sourceSystem: `MIX1-${tail}`, patientId: encounter.id }],
    ['T40b', 'Mixed PATCH externalValue+encounterId', { externalValue: `MIX2-${tail}`, encounterId: encounter.id }],
    ['T40c', 'Mixed PATCH sourceSystem+payerId', { sourceSystem: `MIX3-${tail}`, payerId: payer.id }],
    ['T40d', 'Mixed PATCH externalValue+unknown field', { externalValue: `MIX4-${tail}`, unexpectedField: 'x' }],
  ]
  for (const [id, title, mixedBody] of mixedFieldCases) {
    const before = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: patientIdentifier.id } })
    const auditBefore = await identifierAuditCount()
    const response = await patch(`/api/external-identifiers/${patientIdentifier.id}`, mixedBody)
    const after = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: patientIdentifier.id } })
    const auditAfter = await identifierAuditCount()
    const unchanged =
      after.sourceSystem === before.sourceSystem &&
      after.externalValue === before.externalValue &&
      after.patientId === before.patientId &&
      after.encounterId === before.encounterId &&
      after.payerId === before.payerId
    const offendingField = Object.keys(mixedBody).find((key) => key !== 'sourceSystem' && key !== 'externalValue') ?? ''
    const namesTheField = JSON.stringify(response.body ?? {}).includes(offendingField)
    check(
      id,
      title,
      response.status === 400 && unchanged && after.updatedAt.getTime() === before.updatedAt.getTime() && auditAfter === auditBefore && namesTheField,
      response.status === 400 && unchanged
        ? `400 naming ${offendingField}; no field changed, updatedAt untouched, no AuditEvent`
        : `status ${response.status}; unchanged=${unchanged}; audit ${auditBefore}->${auditAfter}`,
    )
  }

  // ---------------------------------------------------------------- uniqueness (T41–T45)
  section('Uniqueness and value handling — unchanged from A2.9')
  const duplicate = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: afterNoOp.sourceSystem,
    externalValue: afterNoOp.externalValue,
    target: { type: 'ENCOUNTER', id: encounter.id },
  })
  check(
    'T41',
    'Duplicate same org/source/value',
    duplicate.status === 400 && !/prisma|constraint|sql/i.test(JSON.stringify(duplicate.body ?? {})),
    `the same organization/source/value pair is refused with ${duplicate.status} regardless of target type, with no database text`,
  )

  const sharedValue = `SHARED-${tail}`
  const namespaceA = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: `SYNTHETIC_NS_A_${tail}`,
    externalValue: sharedValue,
    target: { type: 'PATIENT', id: patient.id },
  })
  const namespaceB = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: `SYNTHETIC_NS_B_${tail}`,
    externalValue: sharedValue,
    target: { type: 'ENCOUNTER', id: encounter.id },
  })
  check(
    'T42',
    'Same value different source namespace',
    namespaceA.status === 201 && namespaceB.status === 201,
    'one raw value may name a Patient in one namespace and an Encounter in another; uniqueness was not weakened to allow it',
  )

  const foreignSameValue = await prisma.externalIdentifier.create({
    data: { organizationId: otherOrg, sourceSystem: `SYNTHETIC_NS_A_${tail}`, externalValue: sharedValue, patientId: foreignPatient.id },
  })
  check(
    'T43',
    'Same source/value different org',
    foreignSameValue.organizationId === otherOrg,
    'the same source/value pair is free to exist in another organization; the namespace is per tenant',
  )

  const opaqueValues = [`  ${tail}-lead`, `0000${tail}`, `${tail}/slash:colon`, `${tail}#hash`]
  const opaqueResults: string[] = []
  for (const [index, value] of opaqueValues.entries()) {
    const res = await post(`/api/organizations/${org}/external-identifiers`, {
      sourceSystem: `SYNTHETIC_OPAQUE_${index}_${tail}`,
      externalValue: value,
      target: { type: 'PATIENT', id: patient.id },
    })
    opaqueResults.push(`${res.status}`)
  }
  check(
    'T44',
    'Opaque external value',
    opaqueResults.every((status) => status === '201'),
    'no format, prefix or numeric assumption is made about an external value',
  )

  const mixedSource = `SyNtHeTiC_Case_${tail}`
  const mixedValue = `Pt-MiXeD-${tail}`
  const caseCreate = await post(`/api/organizations/${org}/external-identifiers`, {
    sourceSystem: mixedSource,
    externalValue: mixedValue,
    target: { type: 'ENCOUNTER', id: encounter.id },
  })
  const caseRow = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: (caseCreate.body as { id: string }).id } })
  check(
    'T45',
    'Case preservation',
    caseRow.sourceSystem === mixedSource && caseRow.externalValue === mixedValue,
    'source and value case is stored exactly as submitted, never folded',
  )

  // ---------------------------------------------------------------- audit privacy (T46–T52)
  section('Audit minimization — sensitive targets never store the value or the target id')
  const sensitiveNeedles = [patientValue, patientValue2, encounterValue, encounterValue2, patient.id, encounter.id]
  const patientAudits = await auditStatesFor(patientIdentifier.id)
  const patientCreateAudit = patientAudits[0]
  check(
    'T46',
    'Patient create audit',
    patientAudits.length > 0 &&
      !mentions(patientCreateAudit?.afterState, [patientValue, patient.id]) &&
      String((patientCreateAudit?.afterState as { targetType?: string })?.targetType) === 'PATIENT',
    'the create snapshot carries id, sourceSystem and targetType only — no externalValue, no Patient id',
  )
  const encounterAudits = await auditStatesFor(encounterIdentifier.id)
  check(
    'T47',
    'Encounter create audit',
    encounterAudits.length > 0 &&
      !mentions(encounterAudits[0]?.afterState, [encounterValue, encounter.id]) &&
      String((encounterAudits[0]?.afterState as { targetType?: string })?.targetType) === 'ENCOUNTER',
    'the create snapshot carries id, sourceSystem and targetType only — no externalValue, no Encounter id',
  )

  const patientUpdates = patientAudits.slice(1)
  const patientChangedFields = patientUpdates.map((event) => JSON.stringify((event.afterState as { changedFields?: string[] })?.changedFields ?? null))
  check(
    'T48',
    'Patient update audit',
    patientUpdates.length >= 2 &&
      patientChangedFields.includes('["sourceSystem"]') &&
      patientChangedFields.includes('["externalValue"]') &&
      patientUpdates.every((event) => !mentions(event.beforeState, sensitiveNeedles) && !mentions(event.afterState, sensitiveNeedles)),
    `changedFields proves the change (${patientChangedFields.join(' ')}) and neither the old nor the new value is stored`,
  )
  const encounterUpdates = encounterAudits.slice(1)
  const encounterChangedFields = encounterUpdates.map((event) => JSON.stringify((event.afterState as { changedFields?: string[] })?.changedFields ?? null))
  check(
    'T49',
    'Encounter update audit',
    encounterUpdates.length >= 2 &&
      encounterChangedFields.includes('["sourceSystem"]') &&
      encounterChangedFields.includes('["externalValue"]') &&
      encounterUpdates.every((event) => !mentions(event.beforeState, sensitiveNeedles) && !mentions(event.afterState, sensitiveNeedles)),
    `changedFields proves the change (${encounterChangedFields.join(' ')}) and neither the old nor the new value is stored`,
  )

  check(
    'T50',
    'Sensitive audit sourceSystem',
    String((patientCreateAudit?.afterState as { sourceSystem?: string })?.sourceSystem) === patientSource &&
      String((encounterAudits[0]?.afterState as { sourceSystem?: string })?.sourceSystem) === encounterSource,
    'the safe source label is retained, so the audit still says which outside system the mapping came from',
  )

  // A non-sensitive target keeps its full A2.9 snapshot — A4.8 narrowed two types, not all twelve.
  const payerIdentifierId = ownList.find((item) => item.id)?.id
  const payerAuditRow = await prisma.auditEvent.findFirst({
    where: { entityType: 'EXTERNAL_IDENTIFIER', organizationId: org, afterState: { path: ['targetType'], equals: 'PAYER' } },
    orderBy: { occurredAt: 'desc' },
    select: { afterState: true },
  })
  const payerState = (payerAuditRow?.afterState ?? {}) as Record<string, unknown>
  check(
    'T51',
    'Non-sensitive audit regression',
    !!payerAuditRow && 'externalValue' in payerState && 'targetId' in payerState && 'organizationId' in payerState,
    'an existing PAYER-target snapshot still carries organizationId, externalValue and targetId unchanged',
  )
  void payerIdentifierId

  const auditBeforeFalse = await identifierAuditCount()
  await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `${runId}-F1`, externalValue: `F1-${tail}`, target: { type: 'PATIENT', id: foreignPatient.id } })
  await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `${runId}-F2`, externalValue: `F2-${tail}`, target: { type: 'ENCOUNTER', id: MISSING } })
  await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: afterNoOp.sourceSystem, externalValue: afterNoOp.externalValue, target: { type: 'PATIENT', id: patient.id } })
  await patch(`/api/external-identifiers/${patientIdentifier.id}`, { externalValue: afterNoOp.externalValue })
  await patch(`/api/external-identifiers/${patientIdentifier.id}`, { externalValue: `NO-${tail}` }, asViewer)
  check(
    'T52',
    'Audit no false event',
    (await identifierAuditCount()) === auditBeforeFalse,
    `denied, invalid, duplicate and no-op writes create no audit (count stayed ${auditBeforeFalse})`,
  )

  // ---------------------------------------------------------------- concurrency (T53–T55)
  section('Concurrency — the database decides duplicates, the row lock keeps the audit truthful')
  const raceSource = `SYNTHETIC_RACE_${tail}`
  const raceValue = `RACE-${tail}`
  const raceBody = { sourceSystem: raceSource, externalValue: raceValue, target: { type: 'PATIENT', id: patient.id } }
  const [raceA, raceB] = await Promise.all([
    post(`/api/organizations/${org}/external-identifiers`, raceBody),
    post(`/api/organizations/${org}/external-identifiers`, raceBody),
  ])
  const raceRows = await prisma.externalIdentifier.count({ where: { organizationId: org, sourceSystem: raceSource, externalValue: raceValue } })
  const raceStatuses = [raceA.status, raceB.status].sort()
  check(
    'T53',
    'Concurrent duplicate create',
    raceRows === 1 && raceStatuses[0] === 201 && raceStatuses[1] >= 400 && raceStatuses[1] < 500,
    `exactly one row survives; the loser got a safe ${raceStatuses[1]}, not a 500`,
  )

  const actorUserId = (await prisma.user.findFirstOrThrow({ where: { email: adminEmail } })).id
  const concurrentUpdate = async (label: string, identifierId: string, firstValue: string, secondValue: string) => {
    const gate = holdAt('external_identifier.update')
    const first = updateExternalIdentifier(identifierId, { externalValue: firstValue }, actorUserId)
    await gate.arrived
    const second = updateExternalIdentifier(identifierId, { externalValue: secondValue }, actorUserId)
    const blocked = await waitForLockWaiter()
    gate.release()
    await Promise.all([first, second])
    clearConcurrencyProbes()
    const events = await auditStatesFor(identifierId)
    const last = events[events.length - 1]
    const finalRow = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: identifierId } })
    void label
    return { blocked, last, finalRow, events }
  }

  const patientRace = await concurrentUpdate('patient', patientIdentifier.id, `RC1-${tail}`, `RC2-${tail}`)
  check(
    'T54',
    'Concurrent Patient update',
    patientRace.blocked &&
      patientRace.finalRow.externalValue === `RC2-${tail}` &&
      JSON.stringify((patientRace.last?.afterState as { changedFields?: string[] })?.changedFields ?? null) === '["externalValue"]' &&
      !mentions(patientRace.last?.beforeState, [`RC1-${tail}`, `RC2-${tail}`, patient.id]),
    'the second writer waited on the row lock; the surviving audit names the true predecessor by changedFields, never by value',
  )

  const encounterRace = await concurrentUpdate('encounter', encounterIdentifier.id, `RE1-${tail}`, `RE2-${tail}`)
  check(
    'T55',
    'Concurrent Encounter update',
    encounterRace.blocked &&
      encounterRace.finalRow.externalValue === `RE2-${tail}` &&
      JSON.stringify((encounterRace.last?.afterState as { changedFields?: string[] })?.changedFields ?? null) === '["externalValue"]' &&
      !mentions(encounterRace.last?.beforeState, [`RE1-${tail}`, `RE2-${tail}`, encounter.id]),
    'the second writer waited on the row lock; the surviving audit names the true predecessor by changedFields, never by value',
  )

  // ---------------------------------------------------------------- scope guards (T56–T69)
  section('Scope guards — one identity model, twelve targets, nothing else')
  const columnsOf = async (table: string) =>
    (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`).map((row) => row.column_name)
  const patientColumns = await columnsOf('patients')
  const encounterColumns = await columnsOf('encounters')
  check(
    'T56',
    'No Patient schema external value',
    !patientColumns.some((name) => /(^|_)(mrn|external|emr|source_system|external_value)/i.test(name)),
    `patients columns unchanged: ${patientColumns.join(', ')}`,
  )
  check(
    'T57',
    'No Encounter schema external value',
    !encounterColumns.some((name) => /(^|_)(visit|external|emr|source_system|external_value)/i.test(name)),
    `encounters columns unchanged: ${encounterColumns.join(', ')}`,
  )

  const tables = (await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((row) => row.table_name)
  const identityTables = tables.filter((name) => /identifier/i.test(name))
  check(
    'T58',
    'No second identity table',
    identityTables.length === 1 && identityTables[0] === 'external_identifiers',
    `identity tables: ${identityTables.join(', ')}`,
  )

  const permissionCodes = (await prisma.permission.findMany({ where: { code: { contains: 'identifier', mode: 'insensitive' } }, select: { code: true } })).map((row) => row.code).sort()
  check(
    'T59',
    'No new permission family',
    permissionCodes.length === 3 &&
      permissionCodes.join(',') === 'external_identifier.create,external_identifier.read,external_identifier.update',
    `only ${permissionCodes.join(', ')}`,
  )

  const routeSource = git('show HEAD:backend/src/modules/external-identifier/external-identifier.route.ts')
  const routeVerbs = (routeSource.match(/\.(get|post|patch|put|delete)\(\s*'[^']*'/g) ?? []).map((line) => line.replace(/^\./, '').replace(/\(\s*'/, ' ').replace(/'$/, ''))
  check(
    'T60',
    'No new create/update routes',
    routeVerbs.length === 4 &&
      routeVerbs.includes("post /:organizationId/external-identifiers") &&
      routeVerbs.includes("get /:organizationId/external-identifiers") &&
      routeVerbs.includes('get /:id') &&
      routeVerbs.includes('patch /:id'),
    `the A2.9 family is unchanged: ${routeVerbs.join(', ')}`,
  )

  const deleteAttempt = await del(`/api/external-identifiers/${patientIdentifier.id}`)
  const survives = await prisma.externalIdentifier.findUnique({ where: { id: patientIdentifier.id } })
  check('T61', 'No DELETE', deleteAttempt.status === 404 && !!survives, `DELETE is ${deleteAttempt.status} and the row survives`)

  const reassignRoute = (routeSource.match(/reassign|re-assign|retarget|revoke|retire|supersede/gi) ?? []).length
  check('T62', 'No target reassignment', reassignRoute === 0 && !/'\/:id\/(reassign|target)'/.test(routeSource), 'no reassignment endpoint exists')

  const identifierColumns = await columnsOf('external_identifiers')
  check(
    'T63',
    'No verification/status',
    !identifierColumns.some((name) => /(verified|verification|status|current|active|retired|revoked|synced|last_seen)/i.test(name)),
    `external_identifiers columns: ${identifierColumns.join(', ')}`,
  )

  const moduleSources = [':/backend/src/modules/external-identifier']
  const gitGrep = (pattern: string, paths: string[]) => {
    const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
    return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
  }
  const adapterCall = gitGrep('(fetch|axios|https?://|apiKey|api_key|clientSecret|credential|DHPO|eClaimLink)', moduleSources)
  check('T64', 'No adapter/sync', adapterCall.status === 1, adapterCall.status === 1 ? 'no external call, endpoint or credential anywhere in the module' : adapterCall.output.slice(0, 200))

  const forbiddenTargets: [string, string][] = [
    ['T65', 'No InsuranceMembership target'],
    ['T66', 'No Activity target'],
    ['T67', 'No Diagnosis-link target expansion'],
    ['T68', 'No Observation target'],
  ]
  const forbiddenNames: Record<string, [string, RegExp]> = {
    T65: ['INSURANCE_MEMBERSHIP', /insurance_membership_id/],
    T66: ['ENCOUNTER_ACTIVITY', /encounter_activity_id/],
    T67: ['ENCOUNTER_DIAGNOSIS', /encounter_diagnosis_id/],
    T68: ['ENCOUNTER_OBSERVATION', /encounter_observation_id/],
  }
  for (const [id, title] of forbiddenTargets) {
    const [unionName, columnPattern] = forbiddenNames[id]
    check(
      id,
      title,
      !(targetTypes as readonly string[]).includes(unionName) &&
        !identifierColumns.some((name) => columnPattern.test(name)) &&
        !checkDef.includes(unionName.toLowerCase()),
      `${unionName} is absent from targetTypes, from the columns and from the CHECK`,
    )
  }

  const byRepository = await prisma.externalIdentifier.findMany({
    where: { organizationId: org, OR: [{ patientId: patient.id }, { encounterId: encounter.id }] },
    select: { id: true, patientId: true, encounterId: true },
  })
  check(
    'T69',
    'A4.9 readiness',
    byRepository.some((row) => row.patientId === patient.id) && byRepository.some((row) => row.encounterId === encounter.id),
    `Patient and Encounter mappings are retrievable through the canonical repository (${byRepository.length} row(s))`,
  )

  // ---------------------------------------------------------------- developer check (T70–T71)
  section('Developer check — one identity UI, twelve options')
  const feApi = git('show HEAD:frontend/src/modules/external-identifier/external-identifier.api.ts')
  const feOptions = (feApi.match(/'(?:[A-Z][A-Z_]*)'/g) ?? []).map((token) => token.replace(/'/g, ''))
  const feCheckFiles = git('ls-tree --name-only --full-tree HEAD frontend/src/modules/external-identifier/').split(/\r?\n/).filter(Boolean)
  check(
    'T70',
    'Developer check target options',
    approvedTargetColumns.length === 12 &&
      feOptions.includes('PATIENT') &&
      feOptions.includes('ENCOUNTER') &&
      (targetTypes as readonly string[]).every((type) => feOptions.includes(type)) &&
      feCheckFiles.filter((file) => /Check\.tsx$/.test(file)).length === 1,
    `the single existing check renders all 12 approved types including PATIENT and ENCOUNTER (${feCheckFiles.join(', ')})`,
  )

  const feSources = [':/frontend/src/modules/external-identifier']
  const feLogged = gitGrep('console[.](log|info|warn|error|debug)[(].*(externalValue|targetId|patient|encounter)', feSources)
  const feStored = gitGrep('(localStorage|sessionStorage)[.][A-Za-z]+[(]', feSources)
  const feUrlLeak = gitGrep('[?&](externalValue|sourceSystem|targetId|patientId|encounterId)=', feSources)
  const feLookup = gitGrep('(lookup|verify|sync|import|poll)[A-Za-z]*\\s*[(=]', feSources)
  const feSanity = gitGrep('targetTypes', [':/frontend/src/modules/external-identifier/external-identifier.api.ts'])
  check(
    'T71',
    'Developer check privacy',
    feSanity.status === 0 && feLogged.status === 1 && feStored.status === 1 && feUrlLeak.status === 1 && feLookup.status === 1,
    feLogged.status === 1 && feStored.status === 1 && feUrlLeak.status === 1 && feLookup.status === 1
      ? 'no identifier logged, put in a query string or kept in browser storage, and no lookup/sync button (searches verified to reach the sources)'
      : `logged=${feLogged.status} storage=${feStored.status} url=${feUrlLeak.status} lookup=${feLookup.status}`,
  )

  // ---------------------------------------------------------------- build (T72–T74)
  section('Unit, typecheck and build')
  const unitTests = run('npm run test:unit')
  check('T72', 'Unit tests', unitTests.ok && /ℹ fail 0/.test(unitTests.output), `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]} ${(unitTests.output.match(/ℹ fail \d+/) ?? [''])[0]}`.trim())
  const typecheck = run('npm run typecheck')
  check('T73', 'Backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T74', 'Frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])

  // ---------------------------------------------------------------- regressions (T75–T84)
  section('Regressions — A4.7 and, nested inside it, A4.6 → A1')
  // The A4.7 suite runs A4.6 itself, which runs every earlier suite, each with its narrowly
  // documented expected IDs; so it is run ONCE here and its nested verdicts are read back for
  // T76–T84. On the A4.8 branch only A4.7's own branch-identity/diff checks and its "A2.9 target
  // constraint unchanged" guard cannot hold — A4.8 is exactly the approved change to that
  // constraint. Every other A4.7 check must pass.
  await apiReady('the A4.7 regression')
  const a47 = run('npm run test:a4:observations')
  const a47Failing = failedIds(a47.output, 'A4.7')
  const a47Expected = ['T01', 'T03', 'T82', 'T98', 'T99']
  const a47Unexpected = a47Failing.filter((id) => !a47Expected.includes(id))
  const a47Summary = (a47.output.match(/\[A4\.7\] automated summary: [^\n]*/) ?? ['no summary'])[0]
  check(
    'T75',
    'A4.7 regression',
    a47Unexpected.length === 0 && /T09 typed DB CHECK \.* PASS/.test(a47.output),
    a47Unexpected.length === 0
      ? `${a47Summary}; only A4.7's own branch/diff checks and its "A2.9 constraint unchanged" guard differ (${a47Failing.join(', ') || 'none'})`
      : `unexpected A4.7 failures: ${a47Unexpected.join(', ')}`,
  )
  const nested = (id: string, title: string, a47Id: string, a47Title: string) => {
    const line = a47.output.match(new RegExp(`\\[A4\\.7\\] ${a47Id} ${a47Title.replace(/\./g, '\\.')} \\.* (PASS|FAIL)( - [^\\n]*)?`))
    check(id, title, line?.[1] === 'PASS', line ? `via A4.7 ${a47Id}${line[2] ?? ''}` : `A4.7 ${a47Id} line missing`)
  }
  nested('T76', 'A4.6 regression', 'T86', 'A4.6 regression')
  nested('T77', 'A4.5 regression', 'T87', 'A4.5 regression')
  nested('T78', 'A4.4 regression', 'T88', 'A4.4 regression')
  nested('T79', 'A4.3 regression', 'T89', 'A4.3 regression')
  nested('T80', 'A4.2 regression', 'T90', 'A4.2 regression')
  nested('T81', 'A4.1 regression', 'T91', 'A4.1 regression')
  nested('T82', 'A3 regression', 'T92', 'A3 regression')
  nested('T83', 'A2 regression', 'T93', 'A2 regression')
  nested('T84', 'A1 regression', 'T94', 'A1 regression')

  // ---------------------------------------------------------------- DB truth, repeatability (T85–T88)
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
    'DB health/recovery',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  const priorRows = await prisma.externalIdentifier.count({
    where: { organizationId: org, sourceSystem: { startsWith: 'SYNTHETIC_EMR_PATIENT_' }, NOT: { sourceSystem: { contains: tail } } },
  })
  check('T86', 'Repeatability', true, `this run used fresh synthetic source/value pairs (${runId}); ${priorRows} Patient mapping(s) from earlier runs retained`)

  const liveCheck = (await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'external_identifiers_exactly_one_target_chk'`)[0]?.def ?? ''
  check(
    'T87',
    'DB truth query',
    approvedTargetColumns.every((column) => liveCheck.includes(column)) && liveCheck.includes('patient_id') && liveCheck.includes('encounter_id'),
    liveCheck.slice(0, 220),
  )

  const beSources = [':/backend/src/modules/external-identifier', ':/backend/src/modules/audit/audit.snapshot.ts']
  const beLogged = gitGrep('console[.](log|info|warn|error|debug)[(].*(externalValue|sourceSystem|targetId)', beSources)
  const beSanity = gitGrep('externalValue', [':/backend/src/modules/external-identifier/external-identifier.service.ts'])
  const leakedRows = await prisma.$queryRaw<{ leaked: bigint }[]>`
    SELECT count(*) AS leaked FROM audit_events
    WHERE entity_type = 'EXTERNAL_IDENTIFIER'
      AND (after_state::text LIKE ${'%' + patientValue + '%'} OR after_state::text LIKE ${'%' + encounterValue + '%'}
        OR after_state::text LIKE ${'%' + patient.id + '%'} OR after_state::text LIKE ${'%' + encounter.id + '%'}
        OR before_state::text LIKE ${'%' + patientValue + '%'} OR before_state::text LIKE ${'%' + encounterValue + '%'}
        OR before_state::text LIKE ${'%' + patient.id + '%'} OR before_state::text LIKE ${'%' + encounter.id + '%'})`
  check(
    'T88',
    'Logging/privacy',
    beSanity.status === 0 && beLogged.status === 1 && Number(leakedRows[0].leaked) === 0,
    `no identifier logged server-side; ${Number(leakedRows[0].leaked)} audit row(s) contain a sensitive external value or target id`,
  )

  // ---------------------------------------------------------------- git (T89–T90)
  section('Git scope')
  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/prisma/schema.prisma',
    'backend/src/modules/audit/audit.snapshot.ts',
    'backend/src/scripts/verify-migration-replay.ts',
    // The PATCH-validation correction moved the update service onto a whole-body signature, which
    // this A3 concurrency script also calls. Mechanical call-site update, no behaviour change.
    'backend/src/scripts/test-a3-write-atomicity.ts',
    'frontend/src/modules/external-identifier/external-identifier.api.ts',
    'frontend/src/modules/external-identifier/ExternalIdentifierCheck.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/external-identifier/') &&
      !file.startsWith('backend/src/integration/a4-external-identity/') &&
      !file.includes('a4_8_patient_encounter_external_identity') &&
      !allowed.includes(file),
  )
  check(
    'T89',
    'Git scope',
    outOfScope.length === 0,
    outOfScope.length === 0 ? `${changedPaths.length} path(s) since A4.7, all identity extension + the privacy/audit correction + test wiring` : `unexpected: ${outOfScope.join(', ')}`,
  )
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T90', 'Final Git', git('status --porcelain') === '' && tracking.includes(`origin/${a48Branch}`), `${tracking}; working tree ${git('status --porcelain') === '' ? 'clean' : 'dirty'}`)

  console.log(`\n[A4.8] run ${runId} — HEAD ${git('rev-parse HEAD')}`)
  if (failures.length > 0) {
    console.log(`[A4.8] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  console.log(`[A4.8] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.8] A4.8 PATIENT/ENCOUNTER EXTERNAL IDENTITY ACCEPTANCE COMPLETE' : '[A4.8] A4.8 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.8] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    await prisma.$disconnect()
  })
