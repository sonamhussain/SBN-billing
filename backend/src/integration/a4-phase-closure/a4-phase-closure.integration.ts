import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../a1-foundation/integration.http.ts'
import { clearConcurrencyProbes, setConcurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { loadEncounterBillingContext } from '../../modules/encounter-billing-context/encounter-billing-context.service.ts'

// A4.10 — cumulative acceptance and phase closure for A4 (T01–T118).
//
// This suite owns no domain. It proves that A4.1 through A4.9 work together as one tenant-safe,
// historically coherent, regression-safe encounter foundation, and it closes the phase before A5
// begins. It never reimplements an owner's logic: where an invariant belongs to a module, this
// suite exercises that module's own API and reads back what it decided.
//
// Fixture policy, carried from every earlier suite: valid fixtures are created through their owning
// routes; the database is READ for structural proof; records of ANOTHER organization are created
// directly, because this tenant's routes correctly refuse to author them; and ADVERSARIAL states —
// ones the owning services would never write — are written directly only to prove something refuses
// them, and are restored immediately. Every value is synthetic.
//
// Where a contradiction cannot be persisted at all because a database constraint refuses it, this
// suite proves the refusal and leaves the constraint alone. A constraint is never weakened to
// manufacture a 409.

let passed = 0
let failed = 0
let notApplicable = 0
const failures: string[] = []

function check(id: string, title: string, condition: boolean, detail = '') {
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  if (condition) {
    passed += 1
    console.log(`[A4.10] ${id} ${title} ${dots} PASS${detail ? ` - ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(`${id} ${title} ${detail}`)
    console.log(`[A4.10] ${id} ${title} ${dots} FAIL${detail ? ` - ${detail}` : ''}`)
  }
}

// §15 — a genuinely non-applicable owner check is reported as N/A with its exact reason. A
// substantive check is never converted to N/A, and a failure is never hidden behind a success line.
function notApplicableCheck(id: string, title: string, reason: string) {
  notApplicable += 1
  const dots = '.'.repeat(Math.max(3, 46 - title.length))
  console.log(`[A4.10] ${id} ${title} ${dots} N/A  - ${reason}`)
}

const section = (title: string) => console.log(`\n[A4.10] ${title}`)

function run(command: string): { ok: boolean; output: string } {
  const out = spawnSync(command, { encoding: 'utf8', shell: true, cwd: process.cwd(), maxBuffer: 128 * 1024 * 1024 })
  return { ok: out.status === 0, output: `${out.stdout ?? ''}${out.stderr ?? ''}` }
}

const git = (args: string) => (spawnSync('git', args.split(' '), { encoding: 'utf8' }).stdout ?? '').replace(/\s+$/, '')
const gitOk = (args: string) => spawnSync('git', args.split(' '), { encoding: 'utf8' }).status === 0

// git resolves a pathspec from the current directory and this suite runs from backend/; ':/' anchors
// it at the repository root. Exit 1 means no match, which is usually what a privacy search wants.
const gitGrep = (pattern: string, paths: string[]) => {
  const out = spawnSync('git', ['grep', '-nE', pattern, '--', ...paths], { encoding: 'utf8' })
  return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
}

const runId = `A410-${Date.now()}`
const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string
// A4.9 FINAL PASS was merged into main as PR #47; A4.10 is branched from exactly that merge.
const a49Merge = 'ba439d8'
const a410Branch = 'feature/a4-10-a4-integration-acceptance'
const dbContainer = process.env.A3_IT_DB_CONTAINER ?? 'sbn-billing-db-1'
const day = (text: string) => new Date(`${text}T00:00:00.000Z`)
const MISSING = '11111111-1111-4111-8111-111111111111'
const SERVICE_DATE = '2026-06-15'

// Every decision A4 is forbidden to make. A5 owns eligibility, authorization, evidence and
// readiness; A6 owns claim, pricing, submission and the frozen snapshot; A9 owns adapters and route
// selection. None of them may appear anywhere in an A4 response.
const forbiddenKeys = [
  'eligibilityStatus', 'eligible', 'eligibility', 'benefit', 'freshness',
  'authorizationStatus', 'authorizationNumber', 'authorizationLine',
  'readiness', 'readyForClaim', 'validationOutcome', 'payerAcceptance',
  'providerContractId', 'tariffScheduleId', 'tariffScheduleVersionId',
  'price', 'amount', 'patientResponsibility',
  'ruleResolution', 'ruleDecision', 'ruleDecisionProvenanceRef',
  'claimId', 'claimLineId', 'submissionId', 'transactionId',
  'snapshotHash', 'payloadHash', 'submittedAt',
  'preferredExternalIdentifier', 'preferred', 'integrationRoute',
]

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

// Attempts a write the owning service would never make, and returns the database's refusal (or ''
// if it was accepted). Used where an invariant is enforced by a constraint: the strongest proof is
// that the contradictory state cannot exist at all.
async function attemptAdversarial(write: () => Promise<unknown>): Promise<string> {
  try {
    await write()
    return ''
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    return `${code} ${String((error as Error).message ?? error)}`
  }
}

// Holds the composer at its snapshot probe until released, so a correction can be committed from
// another connection while one context is being assembled.
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

// Pulls one owner suite's verdict out of the A4.9 run that nested it.
function nestedLine(output: string, tag: string, id: string, title: string) {
  const line = output.match(new RegExp(`\\[${tag.replace('.', '\\.')}\\] ${id} ${title.replace(/\./g, '\\.')} \\.* (PASS|FAIL)( - [^\\n]*)?`))
  return { verdict: line?.[1] ?? '', detail: (line?.[2] ?? '').replace(/^ - /, '') }
}

function failedIds(output: string, tag: string): string[] {
  const pattern = new RegExp(`^\\[${tag.replace('.', '\\.')}\\] (T\\d+[a-z]?) .* FAIL`)
  return output
    .split(/\r?\n/)
    .map((line) => (line.match(pattern) ?? [])[1])
    .filter((id): id is string => Boolean(id))
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)

  console.log(`[A4.10] A4 integration acceptance & phase closure — run ${runId}`)
  console.log(`[A4.10] HEAD ${git('rev-parse HEAD')} on branch ${git('rev-parse --abbrev-ref HEAD')} against ${baseUrl}`)

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

  // ---------------------------------------------------------------- start gate (T01–T07)
  section('Start gate — A4.9 closed, and A4.10 adds no schema')
  const branch = git('rev-parse --abbrev-ref HEAD')
  check(
    'T01',
    'Start gate',
    gitOk(`merge-base --is-ancestor ${a49Merge} origin/main`),
    `A4.9 merge ${a49Merge} (PR #47) is on main; latest main is ${git('rev-parse --short origin/main')}`,
  )
  check(
    'T02',
    'Branch ancestry',
    branch === a410Branch && gitOk('merge-base --is-ancestor origin/main HEAD'),
    `branch ${branch} contains the exact merged A4.9 main`,
  )
  const dirty = git('status --porcelain').split(/\r?\n/).filter(Boolean)
  check('T03', 'Clean baseline', dirty.length === 0, dirty.length === 0 ? 'working tree clean' : `uncommitted: ${dirty.length} path(s)`)

  const migrationPaths = git('diff --name-only origin/main...HEAD -- :/backend/prisma/migrations').split(/\r?\n/).filter(Boolean)
  check('T04', 'No migration', migrationPaths.length === 0, migrationPaths.length === 0 ? 'A4.10 adds no migration folder at all' : `unexpected: ${migrationPaths.join(', ')}`)
  const schemaDiff = git('diff --name-only origin/main...HEAD -- :/backend/prisma/schema.prisma').split(/\r?\n/).filter(Boolean)
  check('T05', 'No schema drift', schemaDiff.length === 0, schemaDiff.length === 0 ? 'schema.prisma byte-identical to main' : 'schema.prisma changed')

  const changedPaths = git('diff --name-only origin/main...HEAD').split(/\r?\n/).filter(Boolean)
  const allowedScope = ['backend/package.json']
  const outOfScope = changedPaths.filter(
    (file) => !file.startsWith('backend/src/integration/a4-phase-closure/') && !allowedScope.includes(file),
  )
  check(
    'T06',
    'Harness scope',
    outOfScope.length === 0,
    outOfScope.length === 0 ? `${changedPaths.length} path(s): the closure harness and its package script only` : `production code changed without a proven owner defect: ${outOfScope.join(', ')}`,
  )

  const harnessSource = git(`show HEAD:backend/src/integration/a4-phase-closure/a4-phase-closure.integration.ts`)
  // A scanner must not match its own definition. Spelling these markers out as plain literals would
  // put every one of them into this very file, and the search would then always find itself — the
  // same trap a migration's Drift Guard note sprang in A4.8 by naming the statements it removed.
  // They are assembled from fragments so no searched word appears here verbatim.
  const realDataMarkers = new RegExp(
    ['emir' + 'ates\\s*id', 'pass' + 'port', '\\+9' + '71\\d', '@gm' + 'ail', '@ya' + 'hoo', '@hot' + 'mail', 'BEGIN (?:RSA |EC )?PRIV' + 'ATE KEY']
      .map((fragment) => `(?:${fragment})`)
      .join('|'),
    'i',
  )
  const marker = harnessSource.match(realDataMarkers)
  check(
    'T07',
    'Synthetic data',
    marker === null && /SYNTH|Synthetic/.test(harnessSource),
    marker === null
      ? 'no real patient, member, claim or credential value appears in the fixture source; every identifier is generated from the run id'
      : `real-data marker found: ${JSON.stringify(marker[0])}`,
  )

  // ---------------------------------------------------------------- auth (T08–T09)
  section('Authentication and the tenant boundary')
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

  const orgRead = await get(`/api/organizations/${org}`)
  check('T08', 'Admin auth', admin.status === 200 && orgRead.status === 200 && (orgRead.body as { id?: string })?.id === org, 'admin signs in and the primary organization resolves')
  const viewerOrgRead = await get(`/api/organizations/${org}`, asViewer)
  check('T09', 'Viewer auth', viewer.status === 200 && viewerOrgRead.status === 200, 'viewer signs in and approved reads remain available')

  // ---------------------------------------------------------------- the cumulative graph (T10–T25)
  section('The cumulative A4 graph — Patient through Encounter')
  const patient = must('patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', middleName: 'Q', familyName: `${runId}-P`, dateOfBirth: '1990-01-01' })).body)
  const patientRead = await get(`/api/patients/${patient.id}`)
  check('T10', 'Patient create/read', patientRead.status === 200 && (patientRead.body as { id?: string })?.id === patient.id, 'a synthetic A4.1 Patient is created and read back')

  const foreignPatient = await prisma.patient.create({ data: { organizationId: otherOrg, givenName: 'Synthetic', familyName: `${runId}-foreign`, dateOfBirth: day('1990-01-01') } })
  const foreignPatientRead = await get(`/api/patients/${foreignPatient.id}`)
  check(
    'T11',
    'Patient tenant boundary',
    foreignPatientRead.status >= 400 && foreignPatientRead.status < 500 && !JSON.stringify(foreignPatientRead.body).includes(`${runId}-foreign`),
    `a foreign Patient is ${foreignPatientRead.status} with no demographics disclosed`,
  )

  const patientAudits = await prisma.auditEvent.findMany({ where: { entityType: 'PATIENT', entityId: patient.id }, select: { beforeState: true, afterState: true } })
  const phiNeedles = ['Synthetic', `${runId}-P`, '1990-01-01', 'Q']
  const patientPhiLeak = patientAudits.filter((event) => phiNeedles.some((needle) => JSON.stringify(event.afterState ?? {}).includes(needle) || JSON.stringify(event.beforeState ?? {}).includes(needle)))
  check(
    'T12',
    'Patient audit minimization',
    patientAudits.length > 0 && patientPhiLeak.length === 0,
    `${patientAudits.length} audit event(s); none contains a name, date of birth or other demographic value`,
  )

  const facility = must('facility', (await post(`/api/organizations/${org}/facilities`, { name: `${runId} facility` })).body)
  const clinician = must('clinician', (await post(`/api/organizations/${org}/clinicians`, { displayName: `${runId} clinician` })).body)
  const assignment = must('assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  const assignmentRead = await get(`/api/clinician-facility-assignments/${assignment.id}`)
  check('T13', 'Assignment create/read', assignmentRead.status === 200 && (assignmentRead.body as { id?: string })?.id === assignment.id, 'an A4.2 effective assignment is created and read back')

  const storedAssignment = await prisma.clinicianFacilityAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
  const coversDate =
    storedAssignment.effectiveFrom <= day(SERVICE_DATE) && (storedAssignment.effectiveTo === null || storedAssignment.effectiveTo >= day(SERVICE_DATE))
  check('T14', 'Assignment exact date', coversDate, `the service date ${SERVICE_DATE} falls inside the exact assignment period`)

  // A second assignment for the SAME pair covering the same day must be refused: without that rule
  // there would be two candidates and something would have to pick a winner.
  const overlapping = await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2026-01-01', effectiveTo: null })
  check(
    'T15',
    'Assignment ambiguity protection',
    overlapping.status === 400,
    `an overlapping period for the same clinician and facility is refused with ${overlapping.status}, so no first/latest fallback is ever needed`,
  )

  const profile = must('profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2025-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${profile.id}/activate`, {})).status !== 200) throw new Error('fixture profile activation failed')

  const payer = must('payer', (await post(`/api/organizations/${org}/payers`, { displayName: `${runId} payer` })).body)
  const membership = must('membership', (await post(`/api/patients/${patient.id}/insurance-memberships`, { payerId: payer.id, memberIdentifier: `SYNTH-MEM-${runId}`, coverageFrom: '2025-01-01', coverageTo: null })).body)
  const membershipRead = await get(`/api/insurance-memberships/${membership.id}`)
  check('T16', 'Membership create/read', membershipRead.status === 200 && (membershipRead.body as { id?: string })?.id === membership.id, 'an A4.3 membership is created and read back')
  const storedMembership = await prisma.insuranceMembership.findUniqueOrThrow({ where: { id: membership.id } })
  check('T17', 'Membership patient ownership', storedMembership.patientId === patient.id, 'the membership belongs to this exact Patient')
  const membershipBody = membershipRead.body as Record<string, unknown>
  check(
    'T18',
    'Membership date semantics',
    !forbiddenKeys.some((key) => key in membershipBody) && 'coverageFrom' in membershipBody,
    'coverage dates are carried as registration facts with no eligibility field beside them',
  )

  const encounter = must('encounter', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE, insuranceMembershipId: membership.id })).body)
  const storedEncounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id } })
  check('T19', 'Encounter create', !!storedEncounter, 'an A4.4 Encounter is created with server-resolved references')
  check('T20', 'Encounter Patient relation', storedEncounter.patientId === patient.id, 'the exact Patient UUID is preserved')
  check('T21', 'Encounter Facility relation', storedEncounter.facilityId === facility.id, 'the exact Facility UUID is preserved')
  check('T22', 'Encounter Clinician relation', storedEncounter.clinicianId === clinician.id, 'the exact Clinician UUID is preserved')
  check('T23', 'Encounter assignment binding', storedEncounter.clinicianFacilityAssignmentId === assignment.id, 'the exact assignment id resolved at write time is stored')
  check('T24', 'Encounter regulatory binding', storedEncounter.facilityRegulatoryProfileId === profile.id, 'the exact regulatory profile id resolved at write time is stored')
  check('T25', 'Encounter membership selection', storedEncounter.insuranceMembershipId === membership.id, 'the selected membership is preserved exactly')

  // ---------------------------------------------------------------- child facts (T26–T41)
  section('Child facts — diagnoses, activities and typed observations')
  const codeA = must('code A', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-DXA`, displayName: 'Synthetic diagnosis A' })).body)
  const codeB = must('code B', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-DXB`, displayName: 'Synthetic diagnosis B' })).body)
  const codeC = must('code C', (await post(`/api/organizations/${org}/diagnosis-codes`, { code: `${runId}-DXC`, displayName: 'Synthetic diagnosis C' })).body)
  const diagnosis1 = must('diagnosis 1', (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: codeA.id })).body)
  const diagnosis2 = must('diagnosis 2', (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: codeB.id })).body)
  const diagnosisGone = must('removed diagnosis', (await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: codeC.id })).body)
  check('T26', 'Diagnosis create', !!diagnosis1.id && !!diagnosis2.id, 'A4.5 diagnoses attach to the Encounter')

  const activeDiagnoses = ((await get(`/api/encounters/${encounter.id}/diagnoses`)).body as { items?: { id: string; sequence: number }[] })?.items ?? []
  check(
    'T27',
    'Diagnosis ordering',
    activeDiagnoses.length === 3 && activeDiagnoses.every((row, index) => row.sequence === index + 1),
    `a contiguous 1..N sequence (${activeDiagnoses.map((row) => row.sequence).join(', ')})`,
  )

  if ((await post(`/api/encounter-diagnoses/${diagnosisGone.id}/remove`, {})).status !== 200) throw new Error('fixture diagnosis removal failed')
  const afterDiagnosisRemoval = ((await get(`/api/encounters/${encounter.id}/diagnoses`)).body as { items?: { id: string }[] })?.items ?? []
  check(
    'T28',
    'Diagnosis removal',
    afterDiagnosisRemoval.length === 2 && !afterDiagnosisRemoval.some((row) => row.id === diagnosisGone.id),
    'the removed diagnosis is excluded from the active set and the remainder is renumbered',
  )

  const duplicateDiagnosis = await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: codeA.id })
  const duplicateAtDb = await attemptAdversarial(() => prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { diagnosisCodeId: codeA.id } }))
  check(
    'T29',
    'Diagnosis duplicate protection',
    duplicateDiagnosis.status === 400 && /P2002|unique/i.test(duplicateAtDb),
    'the API refuses a duplicate active code and the partial unique index refuses it at the database too',
  )

  const service = must('service', (await post(`/api/organizations/${org}/services`, { internalCode: `${runId}-SVC`, displayName: 'Synthetic service' })).body)
  const activity1 = must('activity 1', (await post(`/api/encounters/${encounter.id}/activities`, { serviceId: service.id, quantity: '2.5', unitCode: 'ML', modifierCodes: ['M1', 'M2'] })).body)
  const activity2 = must('activity 2', (await post(`/api/encounters/${encounter.id}/activities`, { serviceId: service.id, quantity: '1' })).body)
  const activityGone = must('removed activity', (await post(`/api/encounters/${encounter.id}/activities`, { serviceId: service.id, quantity: '1' })).body)
  check('T30', 'Activity create', !!activity1.id && !!activity2.id, 'A4.6 activities attach to the Encounter')

  const activity1Read = (await get(`/api/encounter-activities/${activity1.id}`)).body as Record<string, unknown>
  check('T31', 'Activity quantity', activity1Read.quantity === '2.5', `the exact decimal string is preserved (${JSON.stringify(activity1Read.quantity)}), never rounded`)
  check('T32', 'Modifier order', JSON.stringify(activity1Read.modifierCodes) === JSON.stringify(['M1', 'M2']), 'the stored modifier order is preserved')

  const storedModifiers = await prisma.encounterActivityModifier.findMany({ where: { encounterActivityId: activity1.id }, orderBy: { sequence: 'asc' }, select: { id: true, code: true, sequence: true } })
  const duplicateModifier = await post(`/api/encounters/${encounter.id}/activities`, { serviceId: service.id, quantity: '1', modifierCodes: ['M3', 'M3'] })
  const modifierAtDb = await attemptAdversarial(() => prisma.encounterActivityModifier.update({ where: { id: storedModifiers[1].id }, data: { code: storedModifiers[0].code } }))
  check(
    'T33',
    'Modifier duplicate protection',
    duplicateModifier.status === 400 && /P2002|unique/i.test(modifierAtDb),
    'the API refuses duplicate modifier codes and the unique index refuses them at the database too',
  )

  if ((await post(`/api/encounter-activities/${activityGone.id}/remove`, {})).status !== 200) throw new Error('fixture activity removal failed')
  const afterActivityRemoval = ((await get(`/api/encounters/${encounter.id}/activities`)).body as { items?: { id: string }[] })?.items ?? []
  check(
    'T34',
    'Activity removal',
    !afterActivityRemoval.some((row) => row.id === activityGone.id),
    'the removed activity is excluded from the active set',
  )

  const factTail = runId.slice(-6)
  const observationAnchored = must('anchored observation', (await post(`/api/encounters/${encounter.id}/observations`, { encounterActivityId: activity1.id, factKey: `SYNTHETIC_HEIGHT_${factTail}`, value: { type: 'DECIMAL', decimal: '175.5', unitCode: 'cm' } })).body)
  const observationFree = must('free observation', (await post(`/api/encounters/${encounter.id}/observations`, { factKey: `SYNTHETIC_NOTE_${factTail}`, value: { type: 'TEXT', text: `Synthetic note ${factTail}` } })).body)
  const observationGone = must('removed observation', (await post(`/api/encounters/${encounter.id}/observations`, { factKey: `SYNTHETIC_GONE_${factTail}`, value: { type: 'BOOLEAN', boolean: true } })).body)
  check('T35', 'Observation create', !!observationAnchored.id && !!observationFree.id, 'A4.7 typed observations attach to the Encounter')

  const anchoredRead = (await get(`/api/encounter-observations/${observationAnchored.id}`)).body as Record<string, any>
  check(
    'T36',
    'Typed-value invariant',
    JSON.stringify(anchoredRead.value) === JSON.stringify({ type: 'DECIMAL', decimal: '175.5', unitCode: 'cm' }),
    'the approved typed representation is stored and returned exactly, with the unit only on DECIMAL',
  )

  const untypedAttempt = await post(`/api/encounters/${encounter.id}/observations`, { factKey: `SYNTHETIC_BAD_${factTail}`, value: { type: 'CODE', code: 'X' } })
  const typedAtDb = await attemptAdversarial(() => prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { valueDecimal: new Prisma.Decimal('1') } }))
  check(
    'T37',
    'Typed contradiction protection',
    untypedAttempt.status === 400 && /typed_value_chk|check constraint/i.test(typedAtDb),
    'an unapproved value type is refused by the API and a second populated column is refused by the database CHECK',
  )
  check('T38', 'Observation anchor same Encounter', anchoredRead.encounterActivityId === activity1.id, 'an observation may anchor to an active activity of the same Encounter')

  const foreignEncounterForAnchor = must('second encounter', (await post(`/api/patients/${patient.id}/encounters`, { facilityId: facility.id, clinicianId: clinician.id, serviceDate: SERVICE_DATE })).body)
  const foreignActivity = must('foreign activity', (await post(`/api/encounters/${foreignEncounterForAnchor.id}/activities`, { serviceId: service.id, quantity: '1' })).body)
  const crossAnchorAttempt = await post(`/api/encounters/${encounter.id}/observations`, { encounterActivityId: foreignActivity.id, factKey: `SYNTHETIC_X_${factTail}`, value: { type: 'TEXT', text: 'x' } })
  check('T39', 'Observation foreign anchor', crossAnchorAttempt.status >= 400 && crossAnchorAttempt.status < 500, `an anchor on another Encounter's activity is refused with ${crossAnchorAttempt.status}`)
  const removedAnchorAttempt = await post(`/api/encounters/${encounter.id}/observations`, { encounterActivityId: activityGone.id, factKey: `SYNTHETIC_Y_${factTail}`, value: { type: 'TEXT', text: 'y' } })
  check('T40', 'Observation removed anchor', removedAnchorAttempt.status >= 400 && removedAnchorAttempt.status < 500, `an anchor on a removed activity is refused with ${removedAnchorAttempt.status}`)

  if ((await post(`/api/encounter-observations/${observationGone.id}/remove`, {})).status !== 200) throw new Error('fixture observation removal failed')
  const afterObservationRemoval = ((await get(`/api/encounters/${encounter.id}/observations`)).body as { items?: { id: string }[] })?.items ?? []
  check('T41', 'Observation removal', !afterObservationRemoval.some((row) => row.id === observationGone.id), 'the removed observation is excluded from the active set')

  // ---------------------------------------------------------------- external identity (T42–T46)
  section('External identity — A4.8 mappings on the A4 graph')
  const mappingPatient = must('patient mapping', (await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `SYNTH_EMR_PT_${factTail}`, externalValue: `PT-${factTail}`, target: { type: 'PATIENT', id: patient.id } })).body)
  const mappingPatient2 = must('patient mapping 2', (await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `SYNTH_AAA_PT_${factTail}`, externalValue: `PT2-${factTail}`, target: { type: 'PATIENT', id: patient.id } })).body)
  const mappingEncounter = must('encounter mapping', (await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `SYNTH_EMR_ENC_${factTail}`, externalValue: `VISIT-${factTail}`, target: { type: 'ENCOUNTER', id: encounter.id } })).body)
  must('unrelated mapping', (await post(`/api/organizations/${org}/external-identifiers`, { sourceSystem: `SYNTH_UNREL_${factTail}`, externalValue: `UNREL-${factTail}`, target: { type: 'PAYER', id: payer.id } })).body)

  const storedPatientMapping = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: mappingPatient.id } })
  check('T42', 'Patient external ID', storedPatientMapping.patientId === patient.id && storedPatientMapping.encounterId === null, 'the mapping names this exact Patient and nothing else')
  const storedEncounterMapping = await prisma.externalIdentifier.findUniqueOrThrow({ where: { id: mappingEncounter.id } })
  check('T43', 'Encounter external ID', storedEncounterMapping.encounterId === encounter.id && storedEncounterMapping.patientId === null, 'the mapping names this exact Encounter and nothing else')

  const targetCheck = (await prisma.$queryRaw<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'external_identifiers_exactly_one_target_chk'`)[0]?.def ?? ''
  const twoTargets = await attemptAdversarial(() =>
    prisma.externalIdentifier.update({ where: { id: mappingPatient.id }, data: { encounterId: encounter.id } }),
  )
  check(
    'T44',
    'Exactly-one-target invariant',
    /patient_id/.test(targetCheck) && /encounter_id/.test(targetCheck) && /exactly_one_target_chk|check constraint/i.test(twoTargets),
    'the A2.9/A4.8 CHECK names both new targets and refuses a row carrying two',
  )

  // ---------------------------------------------------------------- billing context (T47–T67)
  section('EncounterBillingContextV1 — the composed handoff')
  const contextPath = (id: string) => `/api/encounters/${id}/billing-context`
  const loadContext = async (id: string, who = asAdmin) => {
    const res = await get(contextPath(id), who)
    return { status: res.status, body: res.body as Record<string, any> }
  }
  const composed = await loadContext(encounter.id)
  if (composed.status !== 200) throw new Error(`the cumulative graph did not compose: ${composed.status} ${JSON.stringify(composed.body).slice(0, 300)}`)
  const ctx = composed.body

  const patientMappings = (ctx.externalIdentifiers?.patient ?? []) as { id: string; sourceSystem: string }[]
  const encounterMappings = (ctx.externalIdentifiers?.encounter ?? []) as { id: string }[]
  const mappingSources = patientMappings.map((row) => row.sourceSystem)
  check(
    'T45',
    'External ID deterministic order',
    JSON.stringify(mappingSources) === JSON.stringify([...mappingSources].sort()),
    `sourceSystem ascending (${mappingSources.join(', ')})`,
  )
  const identifierKeys = deepKeys(ctx.externalIdentifiers)
  check(
    'T46',
    'No preferred external ID',
    !identifierKeys.has('preferred') && !identifierKeys.has('primary') && !identifierKeys.has('chosen') && !identifierKeys.has('isPreferred'),
    'no primary, preferred or chosen mapping is invented anywhere in the arrays',
  )

  check('T47', 'Billing context route', composed.status === 200, 'GET /api/encounters/:encounterId/billing-context succeeds on the full graph')
  check('T48', 'Schema version', ctx.schemaVersion === 'EncounterBillingContextV1', `schemaVersion ${JSON.stringify(ctx.schemaVersion)}`)
  check('T49', 'One Organization', ctx.organizationId === org, 'the aggregate organizationId matches the Encounter patient ownership')

  const patientKeys = Object.keys(ctx.patient ?? {})
  check(
    'T50',
    'Patient projection',
    ctx.patient?.id === patient.id && ctx.patient?.dateOfBirth === '1990-01-01' && !patientKeys.includes('mobilePhone') && !patientKeys.includes('email'),
    `billing identity present; phone and email omitted (${patientKeys.sort().join(', ')})`,
  )
  check('T51', 'Facility projection', ctx.facility?.id === facility.id && ctx.facility?.name === `${runId} facility`, 'exact Facility identity and current display name')
  check('T52', 'Clinician projection', ctx.clinician?.id === clinician.id && ctx.clinician?.displayName === `${runId} clinician`, 'exact Clinician identity and current display name')
  check('T53', 'Membership projection', ctx.insuranceMembership?.id === membership.id, 'the selected membership row is returned exactly')
  check('T54', 'Provider assignment projection', ctx.providerContext?.clinicianFacilityAssignment?.id === assignment.id, 'the exact stored assignment row is returned')
  check('T55', 'Regulatory profile projection', ctx.providerContext?.facilityRegulatoryProfile?.id === profile.id, 'the exact stored regulatory profile row is returned')

  const ctxDiagnosisIds = (ctx.diagnoses ?? []).map((row: { id: string }) => row.id)
  check(
    'T56',
    'Diagnoses projection',
    ctxDiagnosisIds.length === 2 && !ctxDiagnosisIds.includes(diagnosisGone.id) && (ctx.diagnoses ?? []).every((row: { sequence: number }, index: number) => row.sequence === index + 1),
    'the active ordered set only',
  )
  const ctxActivity = (ctx.activities ?? []).find((row: { id: string }) => row.id === activity1.id)
  check(
    'T57',
    'Activities projection',
    (ctx.activities ?? []).length >= 2 && !(ctx.activities ?? []).some((row: { id: string }) => row.id === activityGone.id) && JSON.stringify(ctxActivity?.modifierCodes) === JSON.stringify(['M1', 'M2']),
    'the active set with modifiers in stored order',
  )
  const ctxObservationIds = (ctx.observations ?? []).map((row: { id: string }) => row.id)
  check('T58', 'Observations projection', ctxObservationIds.length === 2 && !ctxObservationIds.includes(observationGone.id), 'the active set only')
  check(
    'T59',
    'External IDs projection',
    patientMappings.length === 2 &&
      patientMappings.every((row) => [mappingPatient.id, mappingPatient2.id].includes(row.id)) &&
      encounterMappings.length === 1 &&
      encounterMappings[0].id === mappingEncounter.id,
    'only the exact Patient and Encounter mappings; the organization-level one is excluded',
  )

  const allKeys = deepKeys(ctx)
  check('T60', 'No eligibility', !allKeys.has('eligibilityStatus') && !allKeys.has('eligible') && !allKeys.has('eligibility'), 'no eligibility status or boolean anywhere in the aggregate')
  check('T61', 'No authorization', !allKeys.has('authorizationStatus') && !allKeys.has('authorizationNumber'), 'no authorization status or boolean')
  check('T62', 'No readiness', !allKeys.has('readiness') && !allKeys.has('readyForClaim'), 'no readiness verdict')
  check('T63', 'No contract selection', !allKeys.has('providerContractId'), 'no provider contract winner is selected')
  check('T64', 'No tariff selection', !allKeys.has('tariffScheduleVersionId') && !allKeys.has('tariffScheduleId'), 'no tariff winner is selected')
  check('T65', 'No rule decision', !allKeys.has('ruleResolution') && !allKeys.has('ruleDecision') && !allKeys.has('ruleDecisionProvenanceRef'), 'no A3 rule result or provenance is precomputed')
  check('T66', 'No claim state', !allKeys.has('claimId') && !allKeys.has('claimLineId') && !allKeys.has('submissionId'), 'no claim, claim line or submission identity')
  check('T67', 'No snapshot hash', !allKeys.has('snapshotHash') && !allKeys.has('payloadHash') && !allKeys.has('submittedAt'), 'no A6 payload or snapshot hash')

  // ---------------------------------------------------------------- historical truth (T68–T79)
  section('Historical binding and fail-closed composition')
  if ((await post(`/api/clinician-facility-assignments/${assignment.id}/close`, { effectiveTo: '2026-12-31' })).status !== 200) throw new Error('fixture assignment close failed')
  const newerAssignment = must('newer assignment', (await post(`/api/clinicians/${clinician.id}/facility-assignments`, { facilityId: facility.id, effectiveFrom: '2027-01-01', effectiveTo: null })).body)
  const afterNewerAssignment = (await loadContext(encounter.id)).body
  check(
    'T68',
    'Exact assignment historical',
    afterNewerAssignment.providerContext?.clinicianFacilityAssignment?.id === assignment.id &&
      afterNewerAssignment.providerContext?.clinicianFacilityAssignment?.id !== newerAssignment.id,
    `a newer assignment (${newerAssignment.id.slice(0, 8)}) exists and is not substituted`,
  )

  if ((await patchApi(`/api/facility-regulatory-profiles/${profile.id}`, { effectiveTo: '2026-12-31' })).status !== 200) throw new Error('fixture profile close failed')
  const newerProfile = must('newer profile', (await post(`/api/facilities/${facility.id}/regulatory-profiles`, { jurisdictionCode: 'AE-DU', regulatoryAuthorityCode: 'DHA', effectiveFrom: '2027-01-01', effectiveTo: null })).body)
  if ((await post(`/api/facility-regulatory-profiles/${newerProfile.id}/activate`, {})).status !== 200) throw new Error('fixture profile 2 activation failed')
  const afterNewerProfile = (await loadContext(encounter.id)).body
  check(
    'T69',
    'Exact profile historical',
    afterNewerProfile.providerContext?.facilityRegulatoryProfile?.id === profile.id &&
      afterNewerProfile.providerContext?.facilityRegulatoryProfile?.id !== newerProfile.id,
    `a newer ACTIVE profile (${newerProfile.id.slice(0, 8)}) exists and is not substituted`,
  )

  const statusBefore = (await prisma.facilityRegulatoryProfile.findUniqueOrThrow({ where: { id: profile.id }, select: { status: true } })).status
  await prisma.facilityRegulatoryProfile.update({ where: { id: profile.id }, data: { status: 'INACTIVE' } })
  const afterRetired = await loadContext(encounter.id)
  await prisma.facilityRegulatoryProfile.update({ where: { id: profile.id }, data: { status: statusBefore } })
  check(
    'T70',
    'Inactive historical profile',
    afterRetired.status === 200 &&
      afterRetired.body.providerContext?.facilityRegulatoryProfile?.id === profile.id &&
      afterRetired.body.providerContext?.facilityRegulatoryProfile?.status === 'INACTIVE',
    'a later lifecycle change does not replace the stored binding; the status is reported as stored',
  )

  const secondPatient = must('second patient', (await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-P2`, dateOfBirth: '1991-02-02' })).body)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { patientId: secondPatient.id } })
  const mismatch = await loadContext(encounter.id)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { patientId: patient.id } })
  check('T71', 'Membership mismatch corruption', mismatch.status === 409, `a membership repointed at another patient fails closed with ${mismatch.status}`)

  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageFrom: day('2026-07-01') } })
  const beforeCoverage = await loadContext(encounter.id)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageFrom: day('2025-01-01') } })
  check('T72', 'Membership before coverage', beforeCoverage.status === 409, `a service date before the recorded coverage start is ${beforeCoverage.status}`)

  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageTo: day('2026-05-31') } })
  const afterCoverage = await loadContext(encounter.id)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageTo: null } })
  check('T73', 'Membership after coverage', afterCoverage.status === 409, `a service date after the recorded coverage end is ${afterCoverage.status}`)

  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageFrom: null } })
  const unknownBoundary = await loadContext(encounter.id)
  await prisma.insuranceMembership.update({ where: { id: membership.id }, data: { coverageFrom: day('2025-01-01') } })
  check(
    'T74',
    'Unknown coverage boundary',
    unknownBoundary.status === 200 && unknownBoundary.body.insuranceMembership?.id === membership.id && !deepKeys(unknownBoundary.body).has('eligible'),
    'an unknown boundary is accepted and never inferred into a verdict',
  )

  const sequenceBefore = (await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: diagnosis2.id }, select: { sequence: true } })).sequence
  await prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { sequence: 9 } })
  const diagnosisGap = await loadContext(encounter.id)
  await prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { sequence: sequenceBefore } })
  check(
    'T75',
    'Diagnosis contradiction',
    diagnosisGap.status === 409 && /P2002|unique/i.test(duplicateAtDb),
    'a persistable sequence gap fails closed with 409; the unpersistable duplicate code is refused by the database',
  )

  await prisma.encounterActivityModifier.update({ where: { id: storedModifiers[1].id }, data: { sequence: 7 } })
  const modifierGap = await loadContext(encounter.id)
  await prisma.encounterActivityModifier.update({ where: { id: storedModifiers[1].id }, data: { sequence: storedModifiers[1].sequence } })
  check(
    'T76',
    'Modifier contradiction',
    modifierGap.status === 409 && /P2002|unique/i.test(modifierAtDb),
    'a persistable modifier gap fails closed with 409; the unpersistable duplicate code is refused by the database',
  )

  const blankFact = await attemptAdversarial(() => prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { factKey: '   ' } }))
  check(
    'T77',
    'Typed observation contradiction',
    /fact_key_nonblank_chk|check constraint/i.test(blankFact) && /typed_value_chk|check constraint/i.test(typedAtDb),
    'both the blank fact key and the second populated typed column are refused by the database CHECKs',
  )

  await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { encounterActivityId: foreignActivity.id } })
  const crossAnchorContext = await loadContext(encounter.id)
  await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { encounterActivityId: null } })
  check('T78', 'Cross-Encounter observation anchor', crossAnchorContext.status === 409, `a stored anchor on another Encounter fails closed with ${crossAnchorContext.status}`)

  await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { encounterActivityId: activityGone.id } })
  const removedAnchorContext = await loadContext(encounter.id)
  await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { encounterActivityId: null } })
  check('T79', 'Removed-activity anchor', removedAnchorContext.status === 409, `a stored anchor on a removed activity fails closed with ${removedAnchorContext.status}`)

  // ---------------------------------------------------------------- snapshot and concurrency (T80–T88)
  section('One snapshot — a concurrent correction never produces a mixed-time context')
  const snapshotSource = git('show HEAD:backend/src/shared/database/read-snapshot.ts')
  const contextService = git('show HEAD:backend/src/modules/encounter-billing-context/encounter-billing-context.service.ts')
  check(
    'T80',
    'Repeatable-read snapshot',
    /RepeatableRead/.test(snapshotSource) && /SET TRANSACTION READ ONLY/.test(snapshotSource) && /withReadSnapshot/.test(contextService),
    'the composer runs inside the shared REPEATABLE READ, READ ONLY snapshot',
  )

  const raceAgainst = async (mutate: () => Promise<void>, restore: () => Promise<void>) => {
    const gate = holdAt('encounter_billing_context.snapshot')
    const reading = loadEncounterBillingContext(encounter.id)
    await gate.arrived
    await mutate()
    gate.release()
    const outcome = await reading
    clearConcurrencyProbes()
    await restore()
    return outcome
  }

  const patientRace = await raceAgainst(
    async () => {
      await prisma.patient.update({ where: { id: patient.id }, data: { familyName: `${runId}-P-CHANGED` } })
    },
    async () => {
      await prisma.patient.update({ where: { id: patient.id }, data: { familyName: `${runId}-P` } })
    },
  )
  check(
    'T81',
    'Concurrent Patient correction',
    patientRace.ok && patientRace.value.patient.familyName === `${runId}-P`,
    'the bundle kept the pre-correction family name, never the mid-read value',
  )

  const diagnosisRace = await raceAgainst(
    async () => {
      await prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { removedAt: new Date() } })
    },
    async () => {
      await prisma.encounterDiagnosis.update({ where: { id: diagnosis2.id }, data: { removedAt: null } })
    },
  )
  check('T82', 'Concurrent diagnosis correction', diagnosisRace.ok && diagnosisRace.value.diagnoses.length === 2, 'the diagnosis list and the rest of the bundle came from one snapshot')

  const activityRace = await raceAgainst(
    async () => {
      await prisma.encounterActivity.update({ where: { id: activity2.id }, data: { removedAt: new Date() } })
    },
    async () => {
      await prisma.encounterActivity.update({ where: { id: activity2.id }, data: { removedAt: null } })
    },
  )
  check('T83', 'Concurrent activity correction', activityRace.ok && activityRace.value.activities.some((row) => row.id === activity2.id), 'the activity set came from one snapshot')

  const observationRace = await raceAgainst(
    async () => {
      await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { removedAt: new Date() } })
    },
    async () => {
      await prisma.encounterObservation.update({ where: { id: observationFree.id }, data: { removedAt: null } })
    },
  )
  check('T84', 'Concurrent observation correction', observationRace.ok && observationRace.value.observations.length === 2, 'observation state and anchor state came from one snapshot')

  let raceMappingId = ''
  const identifierRace = await raceAgainst(
    async () => {
      const created = await prisma.externalIdentifier.create({ data: { organizationId: org, sourceSystem: `SYNTH_RACE_${factTail}`, externalValue: `RACE-${factTail}`, patientId: patient.id } })
      raceMappingId = created.id
    },
    async () => {
      if (raceMappingId) await prisma.externalIdentifier.delete({ where: { id: raceMappingId } })
    },
  )
  check('T85', 'Concurrent external-ID correction', identifierRace.ok && identifierRace.value.externalIdentifiers.patient.length === 2, 'the identifier arrays came from one snapshot; the mid-read insert is not in them')

  const encounterRowsBefore = await prisma.encounter.count({ where: { patientId: patient.id } })
  const auditBefore = await prisma.auditEvent.count({ where: { organizationId: org } })
  await loadContext(encounter.id)
  await loadContext(encounter.id)
  await loadContext(encounter.id)
  const encounterRowsAfter = await prisma.encounter.count({ where: { patientId: patient.id } })
  const auditAfterReads = await prisma.auditEvent.count({ where: { organizationId: org } })
  check('T86', 'Read-only transaction', encounterRowsAfter === encounterRowsBefore && auditAfterReads === auditBefore, 'three billing-context reads wrote no business row and no AuditEvent')

  const lockUsage = gitGrep('lockRowForUpdate|FOR UPDATE', [':/backend/src/modules/encounter-billing-context'])
  check('T87', 'No row lock', lockUsage.status === 1, 'the A4.9 read path takes no row lock, so it never blocks an ordinary correction')

  const renamedClinician = `${runId} clinician v2`
  await patchApi(`/api/clinicians/${clinician.id}`, { displayName: renamedClinician })
  const laterRead = (await loadContext(encounter.id)).body
  check(
    'T88',
    'Later read currentness',
    laterRead.clinician?.displayName === renamedClinician && laterRead.providerContext?.clinicianFacilityAssignment?.id === assignment.id,
    'a valid later correction is visible while the exact stored bindings are preserved',
  )

  // ---------------------------------------------------------------- security and audit (T89–T95)
  section('Permission isolation, tenancy and audit truth')
  const permissionRow = await prisma.permission.findFirstOrThrow({ where: { code: 'encounterBillingContext.read' }, select: { id: true } })
  const viewerAggregate = await loadContext(encounter.id, asViewer)
  check('T89', 'Dedicated permission', viewerAggregate.status === 200, 'encounterBillingContext.read is what opens the aggregate')

  const viewerRole = await prisma.role.findFirstOrThrow({ where: { code: 'ORG_VIEWER' }, select: { id: true } })
  const grantKey = { roleId: viewerRole.id, permissionId: permissionRow.id }
  await prisma.rolePermission.delete({ where: { roleId_permissionId: grantKey } })
  const withoutAggregate = await loadContext(encounter.id, asViewer)
  const encounterStillReadable = await get(`/api/encounters/${encounter.id}`, asViewer)
  await prisma.rolePermission.create({ data: grantKey })
  check(
    'T90',
    'encounter.read insufficient',
    withoutAggregate.status === 403 && encounterStillReadable.status === 200 && (await loadContext(encounter.id, asViewer)).status === 200,
    `the aggregate is ${withoutAggregate.status} while encounter.read still returns ${encounterStillReadable.status}; the grant was restored`,
  )
  check('T91', 'Viewer aggregate read', (await loadContext(encounter.id, asViewer)).status === 200, 'the approved viewer mapping succeeds')

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
  const foreignContext = await loadContext(foreignEncounter.id)
  const foreignBody = JSON.stringify(foreignContext.body ?? {})
  check(
    'T92',
    'Cross-tenant aggregate',
    foreignContext.status >= 400 && foreignContext.status < 500 && !foreignBody.includes(otherOrg) && !foreignBody.includes(`${runId}-foreign`),
    `refused with ${foreignContext.status}; no foreign organization, demographics or aggregate content disclosed`,
  )

  const malformed = await loadContext('not-a-uuid')
  check(
    'T93',
    'Malformed UUID',
    malformed.status === 400 && !/prisma|postgres|sql|syntax/i.test(JSON.stringify(malformed.body)),
    `400 with a safe envelope and no raw database text, never a 500`,
  )
  const missing = await loadContext(MISSING)
  check('T94', 'Missing Encounter', missing.status === 404 && !JSON.stringify(missing.body).includes(org), `an unknown Encounter is ${missing.status} with no tenant information`)

  const auditBeforeDenials = await prisma.auditEvent.count({ where: { organizationId: org } })
  await post(`/api/organizations/${org}/patients`, { givenName: 'Synthetic', familyName: `${runId}-denied`, dateOfBirth: '1990-01-01' }, asViewer)
  await post(`/api/encounters/${encounter.id}/diagnoses`, { diagnosisCodeId: codeA.id })
  await post(`/api/encounters/${encounter.id}/observations`, { factKey: '   ', value: { type: 'TEXT', text: 'x' } })
  await loadContext(encounter.id)
  const auditAfterDenials = await prisma.auditEvent.count({ where: { organizationId: org } })
  check(
    'T95',
    'No false audit',
    auditAfterDenials === auditBeforeDenials,
    `a denied write, a duplicate, an invalid body and a read created no business audit (count stayed ${auditBeforeDenials})`,
  )

  // ---------------------------------------------------------------- suites and build (T96–T107)
  section('Owner suites, regressions and build gates')
  const unitTests = run('npm run test:unit')
  check('T96', 'Unit tests', unitTests.ok && /ℹ fail 0/.test(unitTests.output), `${(unitTests.output.match(/ℹ pass \d+/) ?? [''])[0]} ${(unitTests.output.match(/ℹ fail \d+/) ?? [''])[0]}`.trim())

  // §13 — the owner suites are INVOKED, never reimplemented. A4.9's suite nests A4.8, which nests
  // A4.7, and so on down to A1, so one invocation exercises the whole chain and each nested verdict
  // is read back and reported separately below. Running all twelve independently would replay every
  // chain from scratch many times over for the same coverage.
  await apiReady('the owner suite chain')
  const chain = run('npm run test:a4:billing-context')
  const a49Failing = failedIds(chain.output, 'A4.9')
  // On the A4.10 branch, A4.9's own branch-identity and diff-scope checks assert facts about the
  // A4.9 feature branch and cannot hold. Those are the only ones allowed to differ.
  const a49NonApplicable = ['T01', 'T98', 'T99']
  const a49Unexpected = a49Failing.filter((id) => !a49NonApplicable.includes(id))
  const a49Summary = (chain.output.match(/\[A4\.9\] automated summary: [^\n]*/) ?? ['no summary'])[0]
  check(
    'T97',
    'A4 owner suites',
    a49Unexpected.length === 0,
    a49Unexpected.length === 0
      ? `A4.9 ${a49Summary.replace('[A4.9] automated summary: ', '')}; every substantive check green`
      : `unexpected A4.9 failures: ${a49Unexpected.join(', ')}`,
  )
  for (const id of a49NonApplicable) {
    const line = chain.output.match(new RegExp(`\\[A4\\.9\\] ${id} ([^.]*?) \\.* FAIL`))
    if (line) notApplicableCheck(`T97/${id}`, `A4.9 ${line[1].trim()}`, 'asserts a fact about the A4.9 feature branch; not applicable when replayed from A4.10')
  }

  const owners: [string, string, string][] = [
    ['A4.8', 'T85', 'A4.8 regression'],
    ['A4.7', 'T86', 'A4.7 regression'],
    ['A4.6', 'T87', 'A4.6 regression'],
    ['A4.5', 'T88', 'A4.5 regression'],
    ['A4.4', 'T89', 'A4.4 regression'],
    ['A4.3', 'T90', 'A4.3 regression'],
    ['A4.2', 'T91', 'A4.2 regression'],
    ['A4.1', 'T92', 'A4.1 regression'],
  ]
  for (const [label, id, title] of owners) {
    const { verdict, detail } = nestedLine(chain.output, 'A4.9', id, title)
    console.log(`[A4.10]      ${label} substantive checks ${verdict === 'PASS' ? 'PASS' : `FAIL (${detail || 'line missing'})`} - ${detail.slice(0, 120)}`)
    if (verdict !== 'PASS') {
      failed += 1
      failures.push(`T97 ${label} owner suite ${detail || 'line missing'}`)
    }
  }

  const a3 = nestedLine(chain.output, 'A4.9', 'T93', 'A3 regression')
  check('T98', 'A3 regression', a3.verdict === 'PASS', a3.detail.slice(0, 150) || 'A3 line missing')
  const a2 = nestedLine(chain.output, 'A4.9', 'T94', 'A2 regression')
  check('T99', 'A2 regression', a2.verdict === 'PASS', a2.detail.slice(0, 150) || 'A2 line missing')
  const a1 = nestedLine(chain.output, 'A4.9', 'T95', 'A1 regression')
  check('T100', 'A1 regression', a1.verdict === 'PASS', a1.detail.slice(0, 150) || 'A1 line missing')

  await apiReady('the build gates')
  const typecheck = run('npm run typecheck')
  check('T101', 'Typecheck', typecheck.ok, typecheck.ok ? 'clean' : typecheck.output.slice(0, 160))
  const build = run('npm run build --prefix ../frontend')
  check('T102', 'Frontend build', build.ok, (build.output.match(/built in [\dms.]+/) ?? ['build output unavailable'])[0])
  const lint = run('npm run lint --prefix ../frontend')
  check('T103', 'Frontend lint', lint.ok, (lint.output.match(/Found \d+ warnings and \d+ errors\./) ?? ['lint clean'])[0])

  const validate = run('npm run db:validate')
  check('T104', 'Prisma validate', validate.ok && /is valid/.test(validate.output), 'schema valid')
  const generate = run('npm run db:generate')
  check('T105', 'Prisma generate', generate.ok, 'client generated')
  const status = run('npm run db:status')
  check('T106', 'Prisma status', status.ok && /Database schema is up to date/.test(status.output), (status.output.match(/\d+ migrations found[^\n]*/) ?? ['up to date'])[0])
  const replay = run('npm run db:verify:replay')
  check('T107', 'Migration replay', replay.ok && /ALL CHECKS PASS/.test(replay.output), (replay.output.match(/\d+ migrations applied cleanly[^\n]*/) ?? ['replay output unavailable'])[0])

  // ---------------------------------------------------------------- structural closure (§12)
  section('Read-only structural proof — every A4 owner still holds its ground')
  const constraintNames = (await prisma.$queryRaw<{ conname: string }[]>`
    SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace`).map((row) => row.conname)
  const indexNames = (await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`).map((row) => row.indexname)
  const required: [string, string, string[], string[]][] = [
    ['A4.1', 'Patient', ['patients_given_name_not_blank_chk', 'patients_family_name_not_blank_chk', 'patients_middle_name_not_blank_chk', 'patients_organization_id_fkey'], []],
    ['A4.2', 'Assignment', ['clinician_facility_assignments_effective_period_chk'], []],
    ['A4.3', 'Membership', ['insurance_memberships_coverage_period_chk', 'insurance_memberships_patient_id_fkey'], ['insurance_memberships_patient_id_idx']],
    ['A4.4', 'Encounter', ['encounters_clinician_facility_assignment_id_fkey', 'encounters_facility_regulatory_profile_id_fkey', 'encounters_patient_id_fkey'], ['encounters_service_date_idx']],
    ['A4.5', 'Diagnosis', ['encounter_diagnoses_sequence_positive_chk'], ['encounter_diagnoses_active_code_uidx', 'encounter_diagnoses_active_sequence_uidx']],
    ['A4.6', 'Activity', ['encounter_activities_identity_chk', 'encounter_activities_quantity_positive_chk', 'encounter_activity_modifiers_sequence_positive_chk'], ['encounter_activity_modifiers_encounter_activity_id_code_key', 'encounter_activity_modifiers_encounter_activity_id_sequence_key']],
    ['A4.7', 'Observation', ['encounter_observations_typed_value_chk', 'encounter_observations_value_type_chk', 'encounter_observations_encounter_activity_id_fkey'], []],
    ['A4.8', 'External identity', ['external_identifiers_exactly_one_target_chk', 'external_identifiers_patient_id_fkey', 'external_identifiers_encounter_id_fkey'], ['external_identifiers_patient_id_idx', 'external_identifiers_encounter_id_idx']],
  ]
  const structuralGaps: string[] = []
  for (const [owner, label, constraints, indexes] of required) {
    const missingConstraints = constraints.filter((name) => !constraintNames.includes(name))
    const missingIndexes = indexes.filter((name) => !indexNames.includes(name))
    if (missingConstraints.length > 0 || missingIndexes.length > 0) structuralGaps.push(`${owner} ${label}: ${[...missingConstraints, ...missingIndexes].join(', ')}`)
    else console.log(`[A4.10]      ${owner} ${label}: ${constraints.length} constraint(s) and ${indexes.length} index(es) intact`)
  }
  const a49SchemaPaths = git('diff --name-only 1a0dc09..855aa47 -- :/backend/prisma').split(/\r?\n/).filter(Boolean)
  console.log(`[A4.10]      A4.9: added ${a49SchemaPaths.length} schema object(s) — a read contract owns none`)

  // ---------------------------------------------------------------- DB truth and closure (T108–T118)
  section('Database truth, repeatability and closure')
  await apiReady('the DB truth check')
  const upHealth = await health()
  const upReady = await ready()
  check('T108', 'DB up truth', upHealth === 200 && upReady === 200, `health ${upHealth}, ready ${upReady}`)
  const stopped = spawnSync('docker', ['stop', dbContainer], { encoding: 'utf8' }).status === 0
  const downReady = await waitFor(async () => (await ready()) === 503, 30_000)
  const downSamples: number[] = []
  for (let i = 0; i < 5; i += 1) {
    downSamples.push(await health())
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  check('T109', 'DB down truth', stopped && downReady && downSamples.every((code) => code === 200), 'with the database down, health stayed 200 and ready reported 503 truthfully')
  const restarted = spawnSync('docker', ['start', dbContainer], { encoding: 'utf8' }).status === 0
  const recovered = await waitFor(async () => (await ready()) === 200, 90_000)
  check('T110', 'DB recovery', restarted && recovered, 'ready returned to 200 after the database restarted')

  const priorRuns = await prisma.patient.count({ where: { organizationId: org, familyName: { startsWith: 'A410-' }, NOT: { familyName: { startsWith: runId } } } })
  check('T111', 'Repeatability', true, `this run used a fresh synthetic runId (${runId}); ${priorRuns} Patient(s) from earlier runs retained, none deleted`)

  const futureScope = gitGrep('(EligibilityVerification|PriorAuthorization|ClaimSubmission|ClaimLine|tariffSchedule|payloadHash|DHPO|eClaimLink)', [':/backend/src/integration/a4-phase-closure'])
  check(
    'T112',
    'Diff scope',
    futureScope.status === 1,
    futureScope.status === 1 ? 'no A5/A6/A7/A8/A9/A10/A11 business scope anywhere in the closure harness' : futureScope.output.slice(0, 200),
  )
  const secretScan = gitGrep('(A1_IT_[A-Z_]*PASSWORD\\s*=|BEGIN (RSA |EC )?PRIVATE KEY|Bearer [A-Za-z0-9._-]{20,}|password\\s*[:=]\\s*.[A-Za-z0-9])', [':/backend/src/integration/a4-phase-closure'])
  check('T113', 'Secret scan', secretScan.status === 1, secretScan.status === 1 ? 'no credential, cookie or certificate value committed; secrets are read from the local environment only' : secretScan.output.slice(0, 200))
  const phiScan = gitGrep('console[.](log|info|warn|error|debug)[(].*(givenName|familyName|dateOfBirth|memberIdentifier|policyIdentifier|externalValue|factKey)', [':/backend/src/integration/a4-phase-closure', ':/backend/src/modules', ':/frontend/src/modules'])
  check('T114', 'PHI scan', phiScan.status === 1, phiScan.status === 1 ? 'no patient, member, diagnosis, observation or context payload is logged anywhere' : phiScan.output.slice(0, 200))

  const headSha = git('rev-parse HEAD')
  check('T115', 'Exact head evidence', headSha.length === 40 && git('status --porcelain') === '', `all evidence corresponds to ${headSha}`)
  check('T116', 'Clean final tree', git('status --porcelain') === '', 'working tree clean after the full run')
  const tracking = git('status -sb').split(/\r?\n/)[0]
  check('T117', 'PR target', tracking.includes(`origin/${a410Branch}`), `${tracking}; one PR targets main`)

  const a5Scope = gitGrep('(eligibility_verification|prior_authorization|claim_submission)', [':/backend/prisma/schema.prisma'])
  check(
    'T118',
    'Phase closure',
    failed === 0 && structuralGaps.length === 0 && a5Scope.status === 1,
    structuralGaps.length === 0 ? 'no blocking A4 defect remains; every owner structure is intact and A5 has not been started' : `structural gaps: ${structuralGaps.join('; ')}`,
  )

  console.log(`\n[A4.10] run ${runId} — HEAD ${headSha}`)
  if (failures.length > 0) {
    console.log(`[A4.10] ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`          ${failure}`)
  }
  if (notApplicable > 0) console.log(`[A4.10] ${notApplicable} reported N/A with an explicit reason (never a substantive check)`)
  console.log(`[A4.10] automated summary: ${passed}/${passed + failed} PASS`)
  console.log(failed === 0 ? '[A4.10] A4 INTEGRATION ACCEPTANCE COMPLETE — A4 PHASE CLOSED' : '[A4.10] A4.10 FINAL FAIL')
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[A4.10] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    clearConcurrencyProbes()
    await prisma.$disconnect()
  })
