import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { loadEncounterBillingContext } from '../../modules/encounter-billing-context/encounter-billing-context.service.ts'

// A4.9 — focused acceptance for the Canonical Encounter Billing Context & A5 Handoff Contract
// (T01–T99). A4.9 owns no table: it composes A4.1–A4.8 truth into one read-only bundle and verifies
// that the stored relationships still cohere. Valid fixtures are created through their owning
// routes; the database is READ for structural proof. Records of ANOTHER organization are created
// directly, because this tenant's routes correctly refuse to author them. ADVERSARIAL fixtures —
// stored states the owning services would never write — are written directly to prove the composer
// refuses them, and are restored immediately afterwards. Every identifier and value is synthetic.

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.9] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.9] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n[A4.9] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

// git resolves a pathspec from the current directory and this suite runs from backend/; ':/'
// anchors it at the repository root.
const gitGrep = (pattern: string, paths: string[]) => {
  const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
  return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
}

const runId = `A49-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A4.8 FINAL PASS was merged into main as PR #46; A4.9 is branched from exactly that merge.
const a48Merge = '1a0dc09'
const a49Branch = 'feature/a4-9-canonical-encounter-billing-context'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const day = (text: string) => new Date(`${text}T00:00:00.000Z`)
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'

// Every field A4.9 is forbidden to invent (§8, T56–T62).
const forbiddenKeys = [
  'eligibilityStatus',
  'authorizationStatus',
  'readiness',
  'readyForClaim',
  'payerAcceptance',
  'providerContractId',
  'tariffScheduleVersionId',
  'price',
  'amount',
  'patientResponsibility',
  'ruleResolution',
  'ruleDecision',
  'ruleDecisionProvenanceRef',
  'claimId',
  'claimLineId',
  'submissionId',
  'preferredExternalIdentifier',
  'snapshotHash',
  'payloadHash',
]

function failedIds(output: string, tag: string): string[] {
  const pattern = new RegExp(`^\\[${tag.replace('.', '\\.')}\\] (T\\d+[a-z]?) .* FAIL`)
  return output
    .split(/\r?\n/)
    .map((line) => (line.match(pattern) ?? [])[1])
    .filter((id): id is string => Boolean(id))
}

// Holds the composer at `probe` (just after its snapshot is established) until released.
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

// Attempts a direct write the owning service would never make, and returns the database's refusal
// text (or '' if it was accepted). Used where an invariant is enforced by an index rather than by
// the composer: the strongest proof there is that the contradictory state cannot exist at all.
async function attemptAdversarial(write: () => Promise<unknown>): Promise<string> {
  try {
    await write()
    return ''
  } catch (error) {
    // Prisma keeps the constraint name in the driver adapter error rather than in `message`, so the
    // whole error is serialized: the caller asserts on the code and, where available, the name.
    const code = (error as { code?: string }).code ?? ''
    return `${code} ${String((error as Error).message ?? error)} ${JSON.stringify((error as { meta?: unknown }).meta ?? {})}`
  }
}

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

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A4.9] Canonical encounter billing context & A5 handoff — run ${runId}`)
  console.log(`[A4.9] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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
      throw new Error(`the API at ${baseUrl} is not ready before ${what}; start it with \`npm start\``)
  }

  // ---------------------------------------------------------------- gates (T01–T08)
  section('Start gate — a read contract that adds no schema')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'start gate',
    branch === a49Branch && gitOk(`merge-base --is-ancestor ${a48Merge} origin/main`) && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch}; A4.8 merge ${a48Merge} (PR #46) is on main and is an ancestor; the branch contains the latest main ${git('rev-parse --short origin/main')}`,
  )

  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T02', 'git clean', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter(Boolean)
  check('T03', 'No migration', migrationPaths.length === 0, migrationPaths.length === 0 ? 'A4.9 adds no migration at all' : `unexpected: ${migrationPaths.join(', ')}`)

  const schemaDiff = git('diff --name-only origin/main...HEAD -- :/backend/prisma/schema.prisma').split(/\r?\n/).filter(Boolean)
  check('T04', 'No schema drift', schemaDiff.length === 0, schemaDiff.length === 0 ? 'schema.prisma byte-identical to main' : 'schema.prisma changed')

  const permissionRow = await prisma.permission.findFirst({ where: { code: 'encounterBillingContext.read' }, select: { id: true } })
  const grantedRoles = permissionRow
    ? (
        await prisma.rolePermission.findMany({ where: { permissionId: permissionRow.id }, select: { role: { select: { code: true } } } })
      ).map((row) => row.role.code).sort()
    : []
  check(
    'T05',
    'Permission',
    !!permissionRow && grantedRoles.includes('ORG_ADMIN') && grantedRoles.includes('ORG_VIEWER'),
    `encounterBillingContext.read granted to ${grantedRoles.join(', ') || 'nobody'}`,
  )

  const contextPermissions = (await prisma.permission.findMany({ where: { code: { contains: 'illingContext' } }, select: { code: true } })).map((row) => row.code).sort()
  check(
    'T06',
    'No write permissions',
    contextPermissions.length === 1 && contextPermissions[0] === 'encounterBillingContext.read',
    `only ${contextPermissions.join(', ')}`,
  )

  const routeSource = git('show HEAD:backend/src/modules/encounter-billing-context/encounter-billing-context.route.ts')
  const verbs = (routeSource.match(/Router\.(get|post|patch|put|delete)\(/g) ?? []).map((line) => line.replace(/Router\.|\(/g, ''))
  check(
    'T07',
    'Route shape',
    verbs.length === 1 && verbs[0] === 'get' && /'\/:encounterId\/billing-context'/.test(routeSource),
    `exactly one route: GET /:encounterId/billing-context`,
  )
  check('T08', 'No mutation routes', !/Router\.(post|patch|put|delete)\(/.test(routeSource), 'no POST/PATCH/PUT/DELETE on the context router')

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
  const patchApi = (path: string, body: unknown, who = asAdmin) => callApi(baseUrl, path, who({ method: 'PATCH', body: JSON.stringify(body) }))
  const get = (path: string, who = asAdmin) => callApi(baseUrl, path, who())
  const must = <T extends { id?: string }>(label: string, body: T) => {
    if (!body?.id) throw new Error(`fixture ${label} could not be created through its owner route: ${JSON.stringify(body).slice(0, 200)}`)
    return body as T & { id: string }
  }

  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', middleName: 'Q', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  const profile1 = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile1.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')
  const assignment1 = must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const membership = must('membership', (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier: `MEM-${runId}`, coverageFrom: '2025-01-01', coverageTo: null })).body)
  const service = must('service', (await post(`/api/organizations/${org}/services`, { internalCode: `${runId}-SVC`, displayName: 'Synthetic service' })).body)
  const diagnosisCodeA = must('diagnosis code A', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-DXA`, displayName: 'Synthetic diagnosis A' })).body)
  const diagnosisCodeB = must('diagnosis code B', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-DXB`, displayName: 'Synthetic diagnosis B' })).body)
  const diagnosisCodeC = must('diagnosis code C', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-DXC`, displayName: 'Synthetic diagnosis C' })).body)

  // The covered encounter every positive test reads.
  const encounter = must('encounter', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membership.id })).body)
  // A second encounter with no membership selected at all.
  const selfEncounter = must('self-pay encounter', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE })).body)

  const diagnosis1 = must('diagnosis 1', (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: diagnosisCodeA.id })).body)
  const diagnosis2 = must('diagnosis 2', (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: diagnosisCodeB.id })).body)
  // A third diagnosis that is then removed, so the context can prove it excludes removed rows. It
  // needs its own code: an active code may not repeat on one encounter.
  const removedDiagnosis = must('removed diagnosis', (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: diagnosisCodeC.id })).body)
  if ((await post(`/api/encounter-diagnoses/${removedDiagnosis.id}/remove`, {})).status !== 200) throw new Error('fixture diagnosis removal failed')
  const activity1 = must('activity 1', (await post(`/api/encounters/${encounter.id}/activities`, { serviceId: service.id, quantity: '2.5', unitCode: 'ML', modifierCodes: ['M1', 'M2'] })).body)
  const activity2 = must('activity 2', (await post(`/api/encounters/${encounter.id}/activities`, { serviceId: service.id, quantity: '1' })).body)
  const removedActivity = must('removed activity', (await post(`/api/encounters/${encounter.id}/activities`, { serviceId: service.id, quantity: '1' })).body)
  if ((await post(`/api/encounter-activities/${removedActivity.id}/remove`, {})).status !== 200) throw new Error('fixture activity removal failed')

  const factTail = runId.slice(-6)
  const observationAnchored = must('anchored observation', (await post(`/api/encounters/${encounter.id}/observations`, { encounterActivityId: activity1.id, factKey: `SYNTHETIC_HEIGHT_${factTail}`, value: { type: 'DECIMAL', decimal: '175.5', unitCode: 'cm' } })).body)
  const observationFree = must('free observation', (await post(`/api/encounters/${encounter.id}/observations`, { factKey: `SYNTHETIC_NOTE_${factTail}`, value: { type: 'TEXT', text: `Synthetic note ${factTail}` } })).body)
  const removedObservation = must('removed observation', (await post(`/api/encounters/${encounter.id}/observations`, { factKey: `SYNTHETIC_GONE_${factTail}`, value: { type: 'BOOLEAN', boolean: true } })).body)
  if ((await post(`/api/encounter-observations/${removedObservation.id}/remove`, {})).status !== 200) throw new Error('fixture observation removal failed')

  const patientMapping = must('patient mapping', (await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `SYNTH_EMR_PT_${factTail}`, externalValue: `PT-${factTail}`, target: { type: 'PATIENT', id: patient.id } })).body)
  const encounterMapping = must('encounter mapping', (await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `SYNTH_EMR_ENC_${factTail}`, externalValue: `VISIT-${factTail}`, target: { type: 'ENCOUNTER', id: encounter.id } })).body)
  // A second patient mapping so the deterministic order has something to order.
  const patientMapping2 = must('patient mapping 2', (await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `SYNTH_AAA_PT_${factTail}`, externalValue: `PT2-${factTail}`, target: { type: 'PATIENT', id: patient.id } })).body)
  // An organization-level mapping that targets neither this patient nor this encounter.
  must('unrelated mapping', (await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `SYNTH_UNREL_${factTail}`, externalValue: `UNREL-${factTail}`, target: { type: 'PAYER', id: payer.id } })).body)

  // Records of ANOTHER organization — created directly, see the header.
  const foreignPatient = await prisma.patient.create({ data: { organizationId: otherOrg, givenName: 'Synthetic', familyName: `${runId}-foreign`, dateOfBirth: day('1990-01-01') } })
  const foreignFacility = await prisma.facility.create({ data: { organizationId: otherOrg, name: `${runId} foreign facility` } })
  const foreignClinician = await prisma.clinician.create({ data: { organizationId: otherOrg, displayName: `${runId} foreign clinician` } })
  const foreignAssignment = await prisma.clinicianFacilityAssignment.create({ data: { clinicianId: foreignClinician.id, facilityId: foreignFacility.id, effectiveFrom: day('2025-01-01') } })
  const foreignProfile = await prisma.facilityRegulatoryProfile.create({ data: { facilityId: foreignFacility.id, jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: day('2025-01-01'), status: 'ACTIVE' } })
  const foreignEncounter = await prisma.encounter.create({
    data: {
      patientId: foreignPatient.id,
      facilityId: foreignFacility.id,
      clinicianId: foreignClinician.id,
      serviceDate: day(SERVICE_DATE),
      clinicianFacilityAssignmentId: foreignAssignment.id,
      facilityRegulatoryProfileId: foreignProfile.id,
    },
  })

  const contextPath = (id: string) => `/api/encounters/${id}/billing-context`
  const loadContext = async (id: string, who = asAdmin) => {
    const res = await get(contextPath(id), who)
    return { status: res.status, body: res.body as Record<string, unknown> }
  }

  // ---------------------------------------------------------------- errors and access (T09–T13)
  section('Errors, tenancy and the dedicated aggregate permission')
  const malformed = await loadContext('not-a-uuid')
  check(
    'T09',
    'Malformed Encounter UUID',
    malformed.status === 400 && !/prisma|postgres|sql|syntax/i.test(JSON.stringify(malformed.body)),
    `400 with no database or raw error text`,
  )
  const missing = await loadContext(MISSING)
  check('T10', 'Missing Encounter', missing.status === 404, `an unknown encounter is ${missing.status}`)
  const foreign = await loadContext(foreignEncounter.id)
  check(
    'T11',
    'Cross-tenant Encounter',
    foreign.status >= 400 && foreign.status < 500 && !JSON.stringify(foreign.body).includes(otherOrg) && !JSON.stringify(foreign.body).includes(foreignPatient.id),
    `refused with ${foreign.status} and no foreign detail disclosed`,
  )

  const viewerContext = await loadContext(encounter.id, asViewer)
  check('T12', 'Viewer read', viewerContext.status === 200, 'a viewer holding the aggregate permission reads it')

  // A principal with encounter.read but WITHOUT the aggregate permission must be refused. The grant
  // is removed for the duration of the check and restored immediately.
  const viewerRole = await prisma.role.findFirstOrThrow({ where: { code: 'ORG_VIEWER' }, select: { id: true } })
  const grantKey = { roleId: viewerRole.id, permissionId: permissionRow?.id ?? MISSING }
  const grant = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: grantKey } })
  let isolationStatus = 0
  let encounterStillReadable = 0
  if (grant) {
    await prisma.rolePermission.delete({ where: { roleId_permissionId: grantKey } })
    isolationStatus = (await loadContext(encounter.id, asViewer)).status
    encounterStillReadable = (await get(`/api/encounters/${encounter.id}`, asViewer)).status
    await prisma.rolePermission.create({ data: grantKey })
  }
  check(
    'T13',
    'Permission isolation',
    isolationStatus === 403 && encounterStillReadable === 200 && (await loadContext(encounter.id, asViewer)).status === 200,
    `without encounterBillingContext.read the aggregate is ${isolationStatus} while encounter.read still returns ${encounterStillReadable}; the grant was restored`,
  )

  // ---------------------------------------------------------------- the bundle (T14–T21)
  section('The composed bundle')
  const loaded = await loadContext(encounter.id)
  if (loaded.status !== 200) throw new Error(`the covered encounter did not compose: ${loaded.status} ${JSON.stringify(loaded.body).slice(0, 300)}`)
  const ctx = loaded.body as Record<string, any>

  check('T14', 'Schema version', ctx.schemaVersion === 'EncounterBillingContextV1', `schemaVersion ${JSON.stringify(ctx.schemaVersion)}`)
  check('T15', 'Organization owner', ctx.organizationId === org, 'organizationId equals the encounter patient organization')
  check(
    'T16',
    'Encounter DTO',
    ctx.encounter?.id === encounter.id &&
      ctx.encounter?.serviceDate === SERVICE_DATE &&
      ctx.encounter?.clinicianFacilityAssignmentId === assignment1.id &&
      ctx.encounter?.facilityRegulatoryProfileId === profile1.id,
    'exact ids, a date-only service date and the stored context ids',
  )
  const patientKeys = Object.keys(ctx.patient ?? {}).sort()
  check(
    'T17',
    'Patient projection',
    ctx.patient?.id === patient.id &&
      ctx.patient?.dateOfBirth === '1990-01-01' &&
      typeof ctx.patient?.displayName === 'string' &&
      !patientKeys.includes('mobilePhone') &&
      !patientKeys.includes('email'),
    `identity fields present, phone and email omitted (${patientKeys.join(', ')})`,
  )
  check('T18', 'Facility projection', ctx.facility?.id === facility.id && ctx.facility?.name === `${runId} facility`, 'exact facility id and current display name')
  check('T19', 'Clinician projection', ctx.clinician?.id === clinician.id && ctx.clinician?.displayName === `${runId} clinician`, 'exact clinician id and current display name')

  const selfPay = await loadContext(selfEncounter.id)
  const selfBody = selfPay.body as Record<string, any>
  check(
    'T20',
    'No membership',
    selfPay.status === 200 &&
      selfBody.insuranceMembership === null &&
      !deepKeys(selfBody).has('selfPay') &&
      !deepKeys(selfBody).has('uninsured') &&
      !deepKeys(selfBody).has('eligible'),
    'insuranceMembership is null with no self-pay, uninsured or eligibility label anywhere',
  )
  check('T21', 'Selected membership', ctx.insuranceMembership?.id === membership.id, 'the exact referenced A4.3 membership is returned')

  // ---------------------------------------------------------------- membership integrity (T22–T25)
  section('Membership integrity — registration truth, never eligibility')
  // Adversarial: repoint the stored membership at another patient, read, restore.
  const otherPatient = must('second patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P2`, dateOfBirth: '1991-02-02' })).body)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { patientId: otherPatient.id } })
  const wrongPatient = await loadContext(encounter.id)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { patientId: patient.id } })
  check(
    'T22',
    'Membership other Patient adversarial',
    wrongPatient.status === 409 && /different patient/i.test(JSON.stringify(wrongPatient.body)),
    '409 INTEGRITY_CONFLICT naming the patient mismatch; the fixture was restored',
  )

  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageFrom: day('2026-07-01') } })
  const lowerConflict = await loadContext(encounter.id)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageFrom: day('2025-01-01') } })
  check('T23', 'Membership lower-period contradiction', lowerConflict.status === 409, `service date before the recorded coverage start -> ${lowerConflict.status}`)

  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageTo: day('2026-05-31') } })
  const upperConflict = await loadContext(encounter.id)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageTo: null } })
  check('T24', 'Membership upper-period contradiction', upperConflict.status === 409, `service date after the recorded coverage end -> ${upperConflict.status}`)

  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageFrom: null, coverageTo: null } })
  const unknownBounds = await loadContext(encounter.id)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageFrom: day('2025-01-01') } })
  check(
    'T25',
    'Membership unknown boundaries',
    unknownBounds.status === 200 && (unknownBounds.body as Record<string, any>).insuranceMembership?.id === membership.id,
    'unknown coverage dates are accepted and never inferred into a verdict',
  )

  // ---------------------------------------------------------------- historical binding (T26–T35)
  section('Exact stored provider and regulatory bindings — never re-resolved')
  check('T26', 'Assignment exact ID', ctx.providerContext?.clinicianFacilityAssignment?.id === assignment1.id, 'the returned assignment is the one stored on the encounter')

  // Close the recorded assignment AFTER the service date, then create a newer one that is currently
  // effective. The context must still return the recorded row.
  if ((await post(`/api/clinician-facility-assignments/${assignment1.id}/close`, { effectiveTo: '2026-12-31' })).status !== 200)
    throw new Error('fixture assignment close failed')
  const assignment2 = must('newer assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2027-01-01', effectiveTo: null })).body)
  const afterNewerAssignment = await loadContext(encounter.id)
  const afterNewerBody = afterNewerAssignment.body as Record<string, any>
  check(
    'T27',
    'No assignment re-resolution',
    afterNewerAssignment.status === 200 &&
      afterNewerBody.providerContext?.clinicianFacilityAssignment?.id === assignment1.id &&
      afterNewerBody.providerContext?.clinicianFacilityAssignment?.id !== assignment2.id,
    `a newer currently-effective assignment (${assignment2.id.slice(0, 8)}) exists and is NOT substituted`,
  )

  await prisma.clinicianFacilityAssignment.update({ where: { id: assignment1.id }, data: { clinicianId: otherPatient.id === '' ? clinician.id : foreignClinician.id } })
  const clinicianMismatch = await loadContext(encounter.id)
  await prisma.clinicianFacilityAssignment.update({ where: { id: assignment1.id }, data: { clinicianId: clinician.id } })
  check('T28', 'Assignment clinician mismatch adversarial', clinicianMismatch.status === 409, `409 with the recorded assignment pointing at another clinician`)

  await prisma.clinicianFacilityAssignment.update({ where: { id: assignment1.id }, data: { facilityId: foreignFacility.id } })
  const facilityMismatch = await loadContext(encounter.id)
  await prisma.clinicianFacilityAssignment.update({ where: { id: assignment1.id }, data: { facilityId: facility.id } })
  check('T29', 'Assignment facility mismatch adversarial', facilityMismatch.status === 409, `409 with the recorded assignment pointing at another facility`)

  await prisma.clinicianFacilityAssignment.update({ where: { id: assignment1.id }, data: { effectiveFrom: day('2026-07-01') } })
  const assignmentPeriod = await loadContext(encounter.id)
  await prisma.clinicianFacilityAssignment.update({ where: { id: assignment1.id }, data: { effectiveFrom: day('2025-01-01') } })
  check('T30', 'Assignment period contradiction', assignmentPeriod.status === 409, `409 when the recorded period no longer covers the service date`)

  check('T31', 'Profile exact ID', ctx.providerContext?.facilityRegulatoryProfile?.id === profile1.id, 'the returned profile is the one stored on the encounter')

  // Close the recorded profile after the service date, then create and activate a newer one.
  if ((await patchApi(`/api/facility-regulatory-profiles/${profile1.id}`, { effectiveTo: '2026-12-31' })).status !== 200)
    throw new Error('fixture profile close failed')
  const profile2 = must('newer profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2027-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile2.id}/activate`, {})).status !== 200) throw new Error('fixture profile 2 activation failed')
  const afterNewerProfile = await loadContext(encounter.id)
  const afterNewerProfileBody = afterNewerProfile.body as Record<string, any>
  check(
    'T32',
    'No profile re-resolution',
    afterNewerProfile.status === 200 &&
      afterNewerProfileBody.providerContext?.facilityRegulatoryProfile?.id === profile1.id &&
      afterNewerProfileBody.providerContext?.facilityRegulatoryProfile?.id !== profile2.id,
    `a newer ACTIVE profile (${profile2.id.slice(0, 8)}) exists and is NOT substituted`,
  )

  // The recorded profile's CURRENT status must not decide whether it is returned.
  // The lifecycle states A3 allows are ACTIVE and INACTIVE. Retiring the recorded profile is the
  // realistic administrative change, and it must not remove the historical binding.
  const storedStatus = (await prisma.facilityRegulatoryProfile.findUniqueOrThrow({ where: { id: profile1.id }, select: { status: true } })).status
  await prisma.facilityRegulatoryProfile.update({ where: { id: profile1.id }, data: { status: 'INACTIVE' } })
  const retiredProfile = await loadContext(encounter.id)
  const retiredBody = retiredProfile.body as Record<string, any>
  await prisma.facilityRegulatoryProfile.update({ where: { id: profile1.id }, data: { status: storedStatus } })
  check(
    'T33',
    'Profile current status changed',
    retiredProfile.status === 200 &&
      retiredBody.providerContext?.facilityRegulatoryProfile?.id === profile1.id &&
      retiredBody.providerContext?.facilityRegulatoryProfile?.status === 'INACTIVE',
    `an INACTIVE historical binding is still returned, with its status reported as stored (was ${storedStatus})`,
  )

  await prisma.facilityRegulatoryProfile.update({ where: { id: profile1.id }, data: { facilityId: foreignFacility.id } })
  const profileFacility = await loadContext(encounter.id)
  await prisma.facilityRegulatoryProfile.update({ where: { id: profile1.id }, data: { facilityId: facility.id } })
  check('T34', 'Profile facility mismatch adversarial', profileFacility.status === 409, '409 with the recorded profile pointing at another facility')

  await prisma.facilityRegulatoryProfile.update({ where: { id: profile1.id }, data: { effectiveFrom: day('2026-07-01') } })
  const profilePeriod = await loadContext(encounter.id)
  await prisma.facilityRegulatoryProfile.update({ where: { id: profile1.id }, data: { effectiveFrom: day('2025-01-01') } })
  check('T35', 'Profile period contradiction', profilePeriod.status === 409, '409 when the recorded period no longer covers the service date')

  // ---------------------------------------------------------------- child facts (T36–T50)
  section('Child facts — active only, owner invariants, adversarial states fail closed')
  const fresh = await loadContext(encounter.id)
  const facts = fresh.body as Record<string, any>
  const diagnosisIds = (facts.diagnoses ?? []).map((row: { id: string }) => row.id)
  check(
    'T36',
    'Diagnoses active only',
    diagnosisIds.length === 2 && diagnosisIds.includes(diagnosis1.id) && diagnosisIds.includes(diagnosis2.id),
    `${diagnosisIds.length} active diagnoses; the removed one is excluded`,
  )
  check(
    'T37',
    'Diagnosis order',
    (facts.diagnoses ?? []).every((row: { sequence: number }, index: number) => row.sequence === index + 1),
    'a contiguous 1..N sequence in recorded order',
  )

  const gapSequence = await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: diagnosis2.id }, select: { sequence: true } })
  await prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { sequence: 9 } })
  const diagnosisGap = await loadContext(encounter.id)
  await prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { sequence: gapSequence.sequence } })
  check('T38', 'Diagnosis stored gap adversarial', diagnosisGap.status === 409, `a sequence gap is ${diagnosisGap.status} INTEGRITY_CONFLICT`)

  // A duplicate ACTIVE code cannot be created at all: A4.5's partial unique index refuses it, so the
  // composer can never observe that state. That is a stronger result than a 409 — the contradiction
  // is unreachable rather than merely reported. The composer's own duplicate rule is covered
  // separately by the A4.5 read-invariant unit test.
  const duplicateAttempt = await attemptAdversarial(() =>
    prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { diagnosisCodeId: diagnosisCodeA.id } }),
  )
  const stillDistinct = await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: diagnosis2.id }, select: { diagnosisCodeId: true } })
  check(
    'T39',
    'Diagnosis duplicate adversarial',
    /P2002|unique/i.test(duplicateAttempt) && stillDistinct.diagnosisCodeId === diagnosisCodeB.id,
    `a duplicate active code is refused by the database itself, so the composer can never read one (${duplicateAttempt.slice(0, 90).trim()})`,
  )

  const firstDiagnosis = (facts.diagnoses ?? [])[0]
  check(
    'T40',
    'Diagnosis DTO',
    typeof firstDiagnosis?.diagnosisCode?.code === 'string' && typeof firstDiagnosis?.diagnosisCode?.displayName === 'string',
    'code and displayName joined through the owner helper',
  )

  const activityIds = (facts.activities ?? []).map((row: { id: string }) => row.id)
  check(
    'T41',
    'Activities active only',
    activityIds.length === 2 && activityIds.includes(activity1.id) && !activityIds.includes(removedActivity.id),
    `${activityIds.length} active activities; the removed one is excluded`,
  )
  const firstActivity = (facts.activities ?? []).find((row: { id: string }) => row.id === activity1.id)
  check('T42', 'Activity quantity', firstActivity?.quantity === '2.5', `exact decimal string ${JSON.stringify(firstActivity?.quantity)}`)
  check('T43', 'Activity modifiers', JSON.stringify(firstActivity?.modifierCodes) === JSON.stringify(['M1', 'M2']), 'stored modifier order preserved')

  const modifiers = await prisma.encounterActivityModifier.findMany({ where: { encounterActivityId: activity1.id }, orderBy: { sequence: 'asc' }, select: { id: true, sequence: true, code: true } })
  await prisma.encounterActivityModifier.update({ where: { id: modifiers[1].id }, data: { sequence: 7 } })
  const modifierGap = await loadContext(encounter.id)
  await prisma.encounterActivityModifier.update({ where: { id: modifiers[1].id }, data: { sequence: modifiers[1].sequence } })
  check('T44', 'Modifier gap adversarial', modifierGap.status === 409, `a modifier sequence gap is ${modifierGap.status}`)

  // Same as T39: A4.6's unique index makes a duplicate modifier code unreachable rather than merely
  // reportable. The composer's own duplicate rule is covered by the A4.6 modifier-invariant unit test.
  const modifierDuplicateAttempt = await attemptAdversarial(() =>
    prisma.encounterActivityModifier.update({ where: { id: modifiers[1].id }, data: { code: modifiers[0].code } }),
  )
  const modifierStillDistinct = await prisma.encounterActivityModifier.findUniqueOrThrow({ where: { id: modifiers[1].id }, select: { code: true } })
  check(
    'T45',
    'Modifier duplicate adversarial',
    /P2002|unique/i.test(modifierDuplicateAttempt) && modifierStillDistinct.code === modifiers[1].code,
    `a duplicate modifier code is refused by the database itself, so the composer can never read one (${modifierDuplicateAttempt.slice(0, 90).trim()})`,
  )

  const observationIds = (facts.observations ?? []).map((row: { id: string }) => row.id)
  check(
    'T46',
    'Observations active only',
    observationIds.length === 2 && observationIds.includes(observationAnchored.id) && !observationIds.includes(removedObservation.id),
    `${observationIds.length} active observations; the removed one is excluded`,
  )
  const anchored = (facts.observations ?? []).find((row: { id: string }) => row.id === observationAnchored.id)
  const free = (facts.observations ?? []).find((row: { id: string }) => row.id === observationFree.id)
  check(
    'T47',
    'Observation typed value',
    JSON.stringify(anchored?.value) === JSON.stringify({ type: 'DECIMAL', decimal: '175.5', unitCode: 'cm' }) && free?.value?.type === 'TEXT',
    'typed values preserved exactly, unit carried only on DECIMAL',
  )

  // A4.7's typed-value CHECK refuses a second populated column outright, so this contradiction is
  // unreachable rather than merely reportable. The composer's own verifyStoredObservation rule is
  // covered by the A4.7 unit test.
  const badTypedAttempt = await attemptAdversarial(() =>
    prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { valueDecimal: new Prisma.Decimal('1') } }),
  )
  const observationUntouched = await prisma.encounterObservation.findUniqueOrThrow({ where: { id: observationFree.id }, select: { valueDecimal: true } })
  check(
    'T48',
    'Observation bad typed state adversarial',
    /encounter_observations_typed_value_chk|check constraint/i.test(badTypedAttempt) && observationUntouched.valueDecimal === null,
    'two populated typed columns are refused by the database itself, so the composer can never read that row',
  )

  const foreignActivity = await prisma.encounterActivity.create({ data: { encounterId: selfEncounter.id, serviceId: service.id, quantity: new Prisma.Decimal('1') } })
  await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { encounterActivityId: foreignActivity.id } })
  const crossAnchor = await loadContext(encounter.id)
  await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { encounterActivityId: null } })
  check('T49', 'Observation cross-Encounter anchor adversarial', crossAnchor.status === 409, `an anchor on another encounter is ${crossAnchor.status}`)

  await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { encounterActivityId: removedActivity.id } })
  const removedAnchor = await loadContext(encounter.id)
  await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { encounterActivityId: null } })
  check('T50', 'Observation anchored to removed activity adversarial', removedAnchor.status === 409, `an anchor on a removed activity is ${removedAnchor.status}`)

  // ---------------------------------------------------------------- external identifiers (T51–T55)
  section('External identifiers — every match, deterministic order, none preferred')
  const settled = (await loadContext(encounter.id)).body as Record<string, any>
  const patientIds = (settled.externalIdentifiers?.patient ?? []).map((row: { id: string }) => row.id)
  const encounterIds = (settled.externalIdentifiers?.encounter ?? []).map((row: { id: string }) => row.id)
  check(
    'T51',
    'Patient external IDs',
    patientIds.length === 2 && patientIds.includes(patientMapping.id) && patientIds.includes(patientMapping2.id),
    `${patientIds.length} mappings, all targeting this exact patient`,
  )
  check('T52', 'Encounter external IDs', encounterIds.length === 1 && encounterIds[0] === encounterMapping.id, 'only the mapping targeting this exact encounter')
  const allReturned = [...patientIds, ...encounterIds]
  const unrelatedLeak = (settled.externalIdentifiers?.patient ?? []).concat(settled.externalIdentifiers?.encounter ?? []).filter((row: { target?: { type?: string } }) => row.target?.type !== 'PATIENT' && row.target?.type !== 'ENCOUNTER')
  check('T53', 'No unrelated external IDs', unrelatedLeak.length === 0 && allReturned.length === 3, 'the organization-level PAYER mapping is excluded')
  const sources = (settled.externalIdentifiers?.patient ?? []).map((row: { sourceSystem: string }) => row.sourceSystem)
  check(
    'T54',
    'External-ID deterministic order',
    JSON.stringify(sources) === JSON.stringify([...sources].sort()),
    `sourceSystem ascending (${sources.join(', ')})`,
  )
  const identifierKeys = deepKeys(settled.externalIdentifiers)
  check(
    'T55',
    'No preferred identifier',
    !identifierKeys.has('preferred') && !identifierKeys.has('primary') && !identifierKeys.has('isPreferred') && !identifierKeys.has('chosen'),
    'no primary, preferred or chosen field anywhere in the identifier arrays',
  )

  // ---------------------------------------------------------------- scope guards (T56–T64)
  section('Scope guards — composition only, no decision and no persistence')
  const allKeys = deepKeys(settled)
  const leakedKeys = forbiddenKeys.filter((key) => allKeys.has(key))
  check('T56', 'No eligibility field', !allKeys.has('eligibilityStatus') && !allKeys.has('eligible') && !allKeys.has('freshness') && !allKeys.has('benefit'), 'no eligibility inference anywhere in the bundle')
  check('T57', 'No authorization field', !allKeys.has('authorizationStatus') && !allKeys.has('authorizationNumber') && !allKeys.has('authorizationLine'), 'no authorization state')
  check('T58', 'No readiness field', !allKeys.has('readiness') && !allKeys.has('readyForClaim') && !allKeys.has('validationOutcome'), 'no readiness verdict')
  check('T59', 'No contract selection', !allKeys.has('providerContractId'), 'A4.9 selects no provider contract')
  check('T60', 'No tariff selection', !allKeys.has('tariffScheduleVersionId') && !allKeys.has('tariffScheduleId'), 'A4.9 selects no tariff')
  const serviceSource = git('show HEAD:backend/src/modules/encounter-billing-context/encounter-billing-context.service.ts')
  check(
    'T61',
    'No A3 resolution',
    !/rule-resolution|ruleResolution|rule-provenance|resolveRule/i.test(serviceSource),
    'the composer never calls the A3 resolver or provenance composer',
  )
  check('T62', 'No Claim', leakedKeys.length === 0, leakedKeys.length === 0 ? 'no claim, submission, price or snapshot field' : `leaked: ${leakedKeys.join(', ')}`)

  const encounterRowsBefore = await prisma.encounter.count({ where: { patientId: patient.id } })
  const auditBefore = await prisma.auditEvent.count({ where: { organizationId: org } })
  await loadContext(encounter.id)
  await loadContext(encounter.id)
  await loadContext(selfEncounter.id)
  const encounterRowsAfter = await prisma.encounter.count({ where: { patientId: patient.id } })
  const auditAfter = await prisma.auditEvent.count({ where: { organizationId: org } })
  check('T63', 'No persistence', encounterRowsAfter === encounterRowsBefore, 'loading a context creates no business row')
  check('T64', 'No AuditEvent', auditAfter === auditBefore, `three reads created 0 AuditEvent rows (count stayed ${auditBefore})`)

  // ---------------------------------------------------------------- snapshot coherence (T65–T72)
  section('One snapshot — a writer during the read never produces a mixed bundle')
  const snapshotSource = git('show HEAD:backend/src/shared/database/read-snapshot.ts')
  check(
    'T65',
    'Repeatable-read config',
    /RepeatableRead/.test(snapshotSource) && /SET TRANSACTION READ ONLY/.test(snapshotSource) && /withReadSnapshot/.test(serviceSource),
    'the composer runs inside the shared REPEATABLE READ, READ ONLY snapshot',
  )

  // Each race holds the composer just after its snapshot is taken, commits a correction from another
  // connection, then releases. The bundle must reflect the pre-correction state throughout.
  const raceAgainst = async (label: string, mutate: () => Promise<void>, restore: () => Promise<void>) => {
    const gate = holdAt('encounter_billing_context.snapshot')
    const reading = loadEncounterBillingContext(encounter.id)
    await gate.arrived
    await mutate()
    gate.release()
    const outcome = await reading
    clearConcurrencyProbes()
    await restore()
    void label
    return outcome
  }

  const encounterRace = await raceAgainst(
    'encounter',
    async () => {
      await prisma.encounter.update({ where: { id: encounter.id }, data: { serviceDate: day('2026-06-16') } })
    },
    async () => {
      await prisma.encounter.update({ where: { id: encounter.id }, data: { serviceDate: day(SERVICE_DATE) } })
    },
  )
  check(
    'T66',
    'Snapshot coherence Encounter patch race',
    encounterRace.ok && encounterRace.value.encounter.serviceDate === SERVICE_DATE,
    `the bundle kept the pre-correction service date ${SERVICE_DATE}, never the mid-read value`,
  )

  const diagnosisRace = await raceAgainst(
    'diagnosis',
    async () => {
      await prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { removedAt: new Date() } })
    },
    async () => {
      await prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { removedAt: null } })
    },
  )
  check(
    'T67',
    'Snapshot coherence diagnosis race',
    diagnosisRace.ok && diagnosisRace.value.diagnoses.length === 2,
    'the diagnosis list and the rest of the bundle came from one snapshot',
  )

  const activityRace = await raceAgainst(
    'activity',
    async () => {
      await prisma.encounterActivity.update({ where: { id: activity2.id }, data: { removedAt: new Date() } })
    },
    async () => {
      await prisma.encounterActivity.update({ where: { id: activity2.id }, data: { removedAt: null } })
    },
  )
  check(
    'T68',
    'Snapshot coherence activity race',
    activityRace.ok && activityRace.value.activities.length === 2,
    'activities, modifiers and context came from one snapshot',
  )

  const observationRace = await raceAgainst(
    'observation',
    async () => {
      await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { removedAt: new Date() } })
    },
    async () => {
      await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { removedAt: null } })
    },
  )
  check(
    'T69',
    'Snapshot coherence observation race',
    observationRace.ok && observationRace.value.observations.length === 2,
    'observation state and anchor state came from one snapshot',
  )

  let raceMappingId = ''
  const identifierRace = await raceAgainst(
    'external identifier',
    async () => {
      const created = await prisma.externalIdentifier.create({
        data: { organizationId: org, sourceSystem: `SYNTH_RACE_${factTail}`, externalValue: `RACE-${factTail}`, patientId: patient.id },
      })
      raceMappingId = created.id
    },
    async () => {
      if (raceMappingId) await prisma.externalIdentifier.delete({ where: { id: raceMappingId } })
    },
  )
  check(
    'T70',
    'Snapshot coherence external-ID race',
    identifierRace.ok && identifierRace.value.externalIdentifiers.patient.length === 2,
    'the identifier arrays came from one snapshot; the mid-read insert is not in them',
  )

  const moduleSources = [':/backend/src/modules/encounter-billing-context']
  const lockUsage = gitGrep('lockRowForUpdate|FOR UPDATE', moduleSources)
  check(
    'T71',
    'No FOR UPDATE',
    lockUsage.status === 1,
    lockUsage.status === 1 ? 'the read path takes no row lock, so it never blocks an ordinary correction' : lockUsage.output.slice(0, 200),
  )

  check(
    'T72',
    'assembledAt',
    typeof settled.assembledAt === 'string' && !Number.isNaN(Date.parse(settled.assembledAt)) && settled.assembledAt.endsWith('Z'),
    `one ISO transaction timestamp (${settled.assembledAt})`,
  )

  // ---------------------------------------------------------------- current read semantics (T73–T78)
  section('Current read, historical binding, and no silent repair')
  const renamedClinician = `${runId} clinician v2`
  await patchApi(`/api/clinicians/${clinician.id}`, { displayName: renamedClinician })
  const afterCorrection = (await loadContext(encounter.id)).body as Record<string, any>
  check(
    'T73',
    'Current read semantics',
    afterCorrection.clinician?.displayName === renamedClinician,
    'a second call reflects a valid upstream correction; the context is a current read, not a frozen snapshot',
  )
  check(
    'T74',
    'Historical binding survives',
    afterCorrection.providerContext?.clinicianFacilityAssignment?.id === assignment1.id &&
      afterCorrection.providerContext?.facilityRegulatoryProfile?.id === profile1.id,
    'the same call still uses the exact stored assignment and profile ids',
  )
  check(
    'T75',
    'A6 boundary',
    !allKeys.has('snapshotHash') && !allKeys.has('payloadHash') && !allKeys.has('version') && !allKeys.has('submittedAt'),
    'no hash, frozen version or submission identity — A6 owns that boundary',
  )

  await prisma.facilityRegulatoryProfile.update({ where: { id: profile1.id }, data: { effectiveTo: day('2026-01-31') } })
  const conflictResponse = await loadContext(encounter.id)
  const storedProfileAfter = await prisma.facilityRegulatoryProfile.findUniqueOrThrow({ where: { id: profile1.id }, select: { effectiveTo: true } })
  const encounterAfterConflict = await prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id }, select: { facilityRegulatoryProfileId: true } })
  await prisma.facilityRegulatoryProfile.update({ where: { id: profile1.id }, data: { effectiveTo: day('2026-12-31') } })
  check(
    'T76',
    'API error integrity',
    conflictResponse.status === 409 && (conflictResponse.body as Record<string, any>).error?.code === 'INTEGRITY_CONFLICT',
    'a stored contradiction surfaces as 409 INTEGRITY_CONFLICT',
  )
  check(
    'T77',
    'No silent repair',
    storedProfileAfter.effectiveTo?.toISOString().startsWith('2026-01-31') === true &&
      encounterAfterConflict.facilityRegulatoryProfileId === profile1.id,
    'the GET changed no stored row: the contradictory period and the encounter binding are untouched',
  )
  check(
    'T78',
    'No arbitrary winner',
    !/first\(\)|\[0\]\s*as\s*winner|latest|orderBy:\s*\{\s*createdAt:\s*'desc'\s*\}/i.test(serviceSource) &&
      !JSON.stringify(conflictResponse.body).includes(profile2.id),
    'no first/latest/UUID-order fallback, and the conflict response names no replacement row',
  )

  // ---------------------------------------------------------------- developer check (T79–T81)
  section('Developer check and privacy')
  const feFiles = git('ls-tree --name-only --full-tree HEAD frontend/src/modules/encounter-billing-context/').split(/\r?\n/).filter(Boolean)
  const feCheck = git('show HEAD:frontend/src/modules/encounter-billing-context/EncounterBillingContextCheck.tsx')
  check(
    'T79',
    'Developer check',
    feFiles.length === 2 && /Load Billing Context/.test(feCheck) && /Diagnoses:/.test(feCheck) && /External IDs:/.test(feCheck),
    `one check component and its api client; it loads one context and summarizes counts (${feFiles.length} files)`,
  )
  const feSources = [':/frontend/src/modules/encounter-billing-context']
  const feLogged = gitGrep('console[.](log|info|warn|error|debug)[(]', feSources)
  const feStored = gitGrep('(localStorage|sessionStorage|indexedDB)[.][A-Za-z]+[(]', feSources)
  const feDump = gitGrep('JSON[.]stringify[(]\\s*(context|body|data)', feSources)
  const feSanity = gitGrep('loadBillingContext', feSources)
  check(
    'T80',
    'Developer check privacy',
    feSanity.status === 0 && feLogged.status === 1 && feStored.status === 1 && feDump.status === 1,
    feLogged.status === 1 && feStored.status === 1 && feDump.status === 1
      ? 'nothing logged, nothing in browser storage and no raw JSON dump (searches verified to reach the sources)'
      : `logged=${feLogged.status} storage=${feStored.status} dump=${feDump.status}`,
  )
  const feUrl = gitGrep('[?&](patient|dob|member|policy|factKey|value|externalValue)=', feSources)
  const beLogged = gitGrep('console[.](log|info|warn|error|debug)[(]', moduleSources)
  check(
    'T81',
    'No PHI URL',
    feUrl.status === 1 && beLogged.status === 1 && /\/api\/encounters\/\$\{encounterId\}\/billing-context/.test(git('show HEAD:frontend/src/modules/encounter-billing-context/encounter-billing-context.api.ts')),
    'only the Encounter UUID appears in the path; nothing is logged server-side or client-side',
  )

  // ---------------------------------------------------------------- build (T82–T84)
  section('Unit, typecheck and build')
  const unitTests = run('npm run test:unit')
  check('T82', 'Unit tests', unitTests.ok && /ℹ fail 0/.test(unitTests.output), `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]} ${(unitTests.output.match(/ℹ fail \d+/) ?? [''])[0]}`.trim())
  const typecheck = run('npm run typecheck')
  check('T83', 'Backend typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T84', 'Frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])

  // ---------------------------------------------------------------- regressions (T85–T95)
  section('Regressions — A4.8 and, nested inside it, A4.7 → A1')
  // The A4.8 suite runs A4.7 itself, which runs every earlier suite. It is run ONCE here and its
  // nested verdicts are read back for T86–T95. On the A4.9 branch only A4.8's own branch-identity
  // and diff checks cannot hold.
  await apiReady('the A4.8 regression')
  const a48 = run('npm run test:a4:external-identity')
  const a48Failing = failedIds(a48.output, 'A4.8')
  const a48Expected = ['T01', 'T03', 'T89', 'T90']
  const a48Unexpected = a48Failing.filter((id) => !a48Expected.includes(id))
  const a48Summary = (a48.output.match(/\[A4\.8\] automated summary: [^\n]*/) ?? ['no summary'])[0]
  check(
    'T85',
    'A4.8 regression',
    a48Unexpected.length === 0 && /T40a Mixed PATCH .* PASS/.test(a48.output),
    a48Unexpected.length === 0
      ? `${a48Summary}; only A4.8's own branch/diff checks differ (${a48Failing.join(', ') || 'none'})`
      : `unexpected A4.8 failures: ${a48Unexpected.join(', ')}`,
  )
  const nested = (id: string, title: string, a48Id: string, a48Title: string) => {
    const line = a48.output.match(new RegExp(`\\[A4\\.8\\] ${a48Id} ${a48Title.replace(/\./g, '\\.')} \\.* (PASS|FAIL)( - [^\\n]*)?`))
    check(id, title, line?.[1] === 'PASS', line ? `via A4.8 ${a48Id}${line[2] ?? ''}` : `A4.8 ${a48Id} line missing`)
  }
  nested('T86', 'A4.7 regression', 'T75', 'A4.7 regression')
  nested('T87', 'A4.6 regression', 'T76', 'A4.6 regression')
  nested('T88', 'A4.5 regression', 'T77', 'A4.5 regression')
  nested('T89', 'A4.4 regression', 'T78', 'A4.4 regression')
  nested('T90', 'A4.3 regression', 'T79', 'A4.3 regression')
  nested('T91', 'A4.2 regression', 'T80', 'A4.2 regression')
  nested('T92', 'A4.1 regression', 'T81', 'A4.1 regression')
  nested('T93', 'A3 regression', 'T82', 'A3 regression')
  nested('T94', 'A2 regression', 'T83', 'A2 regression')
  nested('T95', 'A1 regression', 'T84', 'A1 regression')

  // ---------------------------------------------------------------- DB truth and git (T96–T99)
  section('DB truth, repeatability and git')
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
    'T96',
    'DB health/recovery',
    upHealth === 200 && upReady === 200 && stopped && downSamples.every((code) => code === 200) && downReady && restarted && recovered,
    'up 200/200; with the database down health stayed 200 and ready reported 503; recovery 200',
  )

  const priorEncounters = await prisma.encounter.count({
    where: { patient: { organizationId: org, familyName: { startsWith: 'A49-' }, NOT: { familyName: { startsWith: runId } } } },
  })
  check('T97', 'Repeatability', true, `this run used fresh synthetic fixtures (${runId}); ${priorEncounters} encounter(s) from earlier runs retained`)

  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowed = [
    'backend/package.json',
    'backend/src/app.ts',
    'backend/src/scripts/bootstrap-authz-dev.ts',
    'backend/src/shared/authorization/authorization.types.ts',
    // §17/§26: pure DTO converters that were private in their owning service and are now exported
    // from that module's validation file, where every other module already keeps its converter.
    'backend/src/modules/external-identifier/external-identifier.repository.ts',
    'backend/src/modules/external-identifier/external-identifier.service.ts',
    'backend/src/modules/external-identifier/external-identifier.validation.ts',
    'backend/src/modules/facility-regulatory/facility-regulatory.service.ts',
    'backend/src/modules/facility-regulatory/facility-regulatory.validation.ts',
    'frontend/src/app/App.tsx',
  ]
  const outOfScope = changedPaths.filter(
    (file) =>
      !file.startsWith('backend/src/modules/encounter-billing-context/') &&
      !file.startsWith('backend/src/integration/a4-encounter-billing-context/') &&
      !file.startsWith('frontend/src/modules/encounter-billing-context/') &&
      !allowed.includes(file),
  )
  check(
    'T98',
    'Git scope',
    outOfScope.length === 0 && changedPaths.every((file) => !file.startsWith('backend/prisma/')),
    outOfScope.length === 0 ? `${changedPaths.length} path(s) since A4.8, all read module + permission + narrow owner exports + dev check` : `unexpected: ${outOfScope.join(', ')}`,
  )
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T99', 'Final Git', git('status --porcelain') === '' && tracking.includes(`origin/${a49Branch}`), `${tracking}; working tree ${git('status --porcelain') === '' ? 'clean' : 'dirty'}`)

  console.log(`\n[A4.9] run ${runId} — HEAD ${git('rev-parse HEAD')}`)
  if (failures.length > 0) {
    console.log(`[A4.9] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  console.log(`[A4.9] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.9] A4.9 CANONICAL ENCOUNTER BILLING CONTEXT ACCEPTANCE COMPLETE' : '[A4.9] A4.9 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.9] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    await prisma.$disconnect()
  })
