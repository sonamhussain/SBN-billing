import test from 'node:test'
import assert from 'node:assert/strict'
import {
  changedFields,
  decideEncounterContext,
  isEncounterUuid,
  mergeEncounter,
  toEncounterDto,
  validateCreateInput,
  validateUpdateInput,
  type ContextFacts,
  type EncounterWriteInput,
} from './encounter.validation.ts'
import { encounterAuditSnapshot } from '../audit/audit.snapshot.ts'

// A4.4 — the pure validation, recorded-period and zero/one/many context rules. Synthetic values only.

const d = (text: string) => new Date(`${text}T00:00:00.000Z`)
const ORG = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const PATIENT = '11111111-1111-4111-8111-111111111111'
const OTHER_PATIENT = '11111111-1111-4111-8111-222222222222'
const FAC = '22222222-2222-4222-8222-222222222222'
const CLIN = '33333333-3333-4333-8333-333333333333'
const MEM = '44444444-4444-4444-8444-444444444444'
const ASSIGN = '55555555-5555-4555-8555-555555555555'
const PROFILE = '66666666-6666-4666-8666-666666666666'

const stored: EncounterWriteInput = { facilityId: FAC, clinicianId: CLIN, insuranceMembershipId: MEM, serviceDate: d('2026-09-23') }

test('an encounter id must be UUID-shaped', () => {
  assert.equal(isEncounterUuid(FAC), true)
  assert.equal(isEncounterUuid('nope'), false)
  assert.equal(isEncounterUuid(7), false)
})

test('a self-pay create needs facility, clinician and a strict service date; membership becomes null', () => {
  assert.deepEqual(validateCreateInput({ facilityId: FAC, clinicianId: CLIN, serviceDate: '2026-09-23' }), {
    ok: true,
    value: { facilityId: FAC, clinicianId: CLIN, insuranceMembershipId: null, serviceDate: d('2026-09-23') },
  })
  const withMembership = validateCreateInput({ facilityId: FAC, clinicianId: CLIN, insuranceMembershipId: MEM, serviceDate: '2026-09-23' })
  assert.equal(withMembership.ok && withMembership.value.insuranceMembershipId, MEM)
})

test('the service date is strict, and a future date is not rejected merely for being future', () => {
  for (const bad of ['2026-02-31', '2026-09-23T00:00:00.000Z', '23/09/2026', '', null, 20260923]) {
    assert.equal(validateCreateInput({ facilityId: FAC, clinicianId: CLIN, serviceDate: bad }).ok, false, String(bad))
  }
  assert.equal(validateCreateInput({ facilityId: FAC, clinicianId: CLIN, serviceDate: '2099-12-31' }).ok, true)
})

test('create rejects missing or malformed references', () => {
  for (const body of [
    { clinicianId: CLIN, serviceDate: '2026-09-23' },
    { facilityId: FAC, serviceDate: '2026-09-23' },
    { facilityId: 'x', clinicianId: CLIN, serviceDate: '2026-09-23' },
    { facilityId: FAC, clinicianId: CLIN, insuranceMembershipId: 'x', serviceDate: '2026-09-23' },
  ]) {
    assert.equal(validateCreateInput(body).ok, false, JSON.stringify(body))
  }
  assert.equal(validateCreateInput(null).ok, false)
  assert.equal(validateCreateInput([]).ok, false)
})

test('the client can never supply the patient, the resolved context or server timestamps', () => {
  const base = { facilityId: FAC, clinicianId: CLIN, serviceDate: '2026-09-23' }
  for (const field of ['id', 'patientId', 'clinicianFacilityAssignmentId', 'facilityRegulatoryProfileId', 'createdAt', 'updatedAt']) {
    const outcome = validateCreateInput({ ...base, [field]: ASSIGN })
    assert.equal(outcome.ok, false, field)
    if (!outcome.ok) assert.match(outcome.message, new RegExp(field))
  }
  for (const field of ['status', 'eligible', 'claimId', 'specialtyId', 'diagnosisId', 'organizationId', 'price']) {
    assert.equal(validateCreateInput({ ...base, [field]: 'x' }).ok, false, field)
  }
})

test('a patch carries only what it supplies; membership may be cleared, the rest may not', () => {
  assert.deepEqual(validateUpdateInput({ insuranceMembershipId: null }), { ok: true, value: { insuranceMembershipId: null } })
  assert.deepEqual(validateUpdateInput({ serviceDate: '2026-10-01' }), { ok: true, value: { serviceDate: d('2026-10-01') } })
  for (const body of [{}, { facilityId: null }, { clinicianId: null }, { serviceDate: null }, { patientId: PATIENT }, { facilityRegulatoryProfileId: PROFILE }, { notes: 'x' }]) {
    assert.equal(validateUpdateInput(body).ok, false, JSON.stringify(body))
  }
})

test('the merged state and changed fields drive every correction', () => {
  const merged = mergeEncounter(stored, { serviceDate: d('2026-10-01'), insuranceMembershipId: null })
  assert.deepEqual(merged, { facilityId: FAC, clinicianId: CLIN, insuranceMembershipId: null, serviceDate: d('2026-10-01') })
  assert.deepEqual(changedFields(stored, { facilityId: FAC, serviceDate: d('2026-09-23') }), [])
  assert.deepEqual(changedFields(stored, { clinicianId: OTHER, insuranceMembershipId: null }), ['clinicianId', 'insuranceMembershipId'])
})

const resolved: ContextFacts = {
  patientId: PATIENT,
  patientOrganizationId: ORG,
  serviceDate: d('2026-09-23'),
  clinician: { organizationId: ORG },
  facility: { organizationId: ORG },
  membership: { patientId: PATIENT, coverageFrom: d('2026-01-01'), coverageTo: d('2026-12-31') },
  assignment: { status: 'RESOLVED', id: ASSIGN },
  profile: { kind: 'one', id: PROFILE },
}

test('exactly one assignment and one ACTIVE profile yield the server-resolved context IDs', () => {
  assert.deepEqual(decideEncounterContext(resolved), { ok: true, clinicianFacilityAssignmentId: ASSIGN, facilityRegulatoryProfileId: PROFILE })
  assert.equal(decideEncounterContext({ ...resolved, membership: 'not-supplied' }).ok, true, 'self-pay')
})

test('zero or several assignment/profile matches fail closed; nothing is chosen by order', () => {
  const cases: Partial<ContextFacts>[] = [
    { assignment: { status: 'NO_MATCH' } },
    { assignment: { status: 'INTEGRITY_CONFLICT', matchedIds: [ASSIGN, PROFILE] } },
    { profile: { kind: 'none' } },
    { profile: { kind: 'many', profileIds: [PROFILE, ASSIGN] } },
  ]
  for (const patch of cases) {
    const decision = decideEncounterContext({ ...resolved, ...patch })
    assert.equal(decision.ok, false, JSON.stringify(patch))
    if (!decision.ok) assert.equal(decision.code, 'VALIDATION_ERROR')
  }
})

test('missing or foreign masters, and another patient\'s membership, are refused identically as not found', () => {
  const cases: [Partial<ContextFacts>, string][] = [
    [{ clinician: null }, 'clinician not found'],
    [{ clinician: { organizationId: OTHER } }, 'clinician not found'],
    [{ facility: { organizationId: OTHER } }, 'facility not found'],
    [{ membership: null }, 'insurance membership not found'],
    [{ membership: { patientId: OTHER_PATIENT, coverageFrom: null, coverageTo: null } }, 'insurance membership not found'],
  ]
  for (const [patch, message] of cases) {
    assert.deepEqual(decideEncounterContext({ ...resolved, ...patch }), { ok: false, code: 'NOT_FOUND', message })
  }
})

test('recorded membership boundaries: inclusive, unknown never invented, outside refused', () => {
  const at = (date: string, coverageFrom: string | null, coverageTo: string | null) =>
    decideEncounterContext({
      ...resolved,
      serviceDate: d(date),
      membership: { patientId: PATIENT, coverageFrom: coverageFrom ? d(coverageFrom) : null, coverageTo: coverageTo ? d(coverageTo) : null },
    }).ok
  assert.equal(at('2026-01-01', '2026-01-01', '2026-12-31'), true, 'on coverageFrom')
  assert.equal(at('2026-12-31', '2026-01-01', '2026-12-31'), true, 'on coverageTo')
  assert.equal(at('2025-12-31', '2026-01-01', '2026-12-31'), false, 'the day before')
  assert.equal(at('2027-01-01', '2026-01-01', '2026-12-31'), false, 'the day after')
  assert.equal(at('1990-01-01', null, null), true, 'both unknown')
  assert.equal(at('2030-01-01', '2026-01-01', null), true, 'open end')
  assert.equal(at('2027-06-01', null, '2026-12-31'), false, 'after a recorded end with an unknown start')
})

test('the DTO exposes the date-only service date and resolved context, with no eligibility or claim field', () => {
  const dto = toEncounterDto({
    id: PROFILE,
    patientId: PATIENT,
    ...stored,
    clinicianFacilityAssignmentId: ASSIGN,
    facilityRegulatoryProfileId: PROFILE,
    createdAt: new Date('2026-09-24T10:00:00.000Z'),
    updatedAt: new Date('2026-09-24T10:00:00.000Z'),
  })
  assert.equal(dto.serviceDate, '2026-09-23')
  assert.equal(dto.clinicianFacilityAssignmentId, ASSIGN)
  assert.equal(Object.keys(dto).some((key) => /(eligib|status|claim|price|diagnos|specialty|payer|member)/i.test(key) && key !== 'insuranceMembershipId'), false)
})

test('the audit snapshot carries only id, updatedAt and changed field names', () => {
  const snapshot = encounterAuditSnapshot({ id: PROFILE, updatedAt: new Date('2026-09-24T10:00:00.000Z') }, ['serviceDate', 'facilityId'])
  assert.deepEqual(Object.keys(snapshot).sort(), ['changedFields', 'id', 'updatedAt'])
  assert.deepEqual(snapshot.changedFields, ['facilityId', 'serviceDate'])
  assert.deepEqual(Object.keys(encounterAuditSnapshot({ id: PROFILE, updatedAt: new Date() })).sort(), ['id', 'updatedAt'])
})
