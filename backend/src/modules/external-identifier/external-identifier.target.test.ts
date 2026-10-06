import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveTargetFromRecord,
  isTargetType,
  targetForeignKeyColumn,
  targetTypes,
  type PersistedTargetColumns,
} from './external-identifier.target.ts'

const emptyColumns: PersistedTargetColumns = {
  organizationTargetId: null,
  facilityId: null,
  clinicianId: null,
  specialtyId: null,
  payerId: null,
  tpaId: null,
  networkId: null,
  serviceId: null,
  procedureCodeId: null,
  diagnosisCodeId: null,
  patientId: null,
  encounterId: null,
}

test('all approved target types are recognized', () => {
  for (const type of targetTypes) {
    assert.equal(isTargetType(type), true)
  }
})

// A4.8 — the approved set is exactly twelve. This is written as a list rather than a count so that
// adding a thirteenth target has to be a deliberate edit here, not a silent side effect elsewhere.
test('the approved target set is exactly the twelve listed types', () => {
  assert.deepEqual(
    [...targetTypes],
    [
      'ORGANIZATION',
      'FACILITY',
      'CLINICIAN',
      'SPECIALTY',
      'PAYER',
      'TPA',
      'NETWORK',
      'SERVICE',
      'PROCEDURE_CODE',
      'DIAGNOSIS_CODE',
      'PATIENT',
      'ENCOUNTER',
    ],
  )
})

test('unknown target type is rejected', () => {
  assert.equal(isTargetType('CLAIM'), false)
  assert.equal(isTargetType(42), false)
  assert.equal(isTargetType(undefined), false)
})

// The targets A4.8 was explicitly told not to add. If one of these ever starts passing, a target
// was expanded opportunistically rather than through an approved requirement.
test('targets outside the approved set are rejected', () => {
  assert.equal(isTargetType('INSURANCE_MEMBERSHIP'), false)
  assert.equal(isTargetType('ENCOUNTER_ACTIVITY'), false)
  assert.equal(isTargetType('ENCOUNTER_DIAGNOSIS'), false)
  assert.equal(isTargetType('ENCOUNTER_OBSERVATION'), false)
  assert.equal(isTargetType('patient'), false, 'the union is case-sensitive')
})

test('each target type maps to its own FK column', () => {
  assert.equal(targetForeignKeyColumn('ORGANIZATION'), 'organizationTargetId')
  assert.equal(targetForeignKeyColumn('FACILITY'), 'facilityId')
  assert.equal(targetForeignKeyColumn('CLINICIAN'), 'clinicianId')
  assert.equal(targetForeignKeyColumn('SPECIALTY'), 'specialtyId')
  assert.equal(targetForeignKeyColumn('PAYER'), 'payerId')
  assert.equal(targetForeignKeyColumn('TPA'), 'tpaId')
  assert.equal(targetForeignKeyColumn('NETWORK'), 'networkId')
  assert.equal(targetForeignKeyColumn('SERVICE'), 'serviceId')
  assert.equal(targetForeignKeyColumn('PROCEDURE_CODE'), 'procedureCodeId')
  assert.equal(targetForeignKeyColumn('DIAGNOSIS_CODE'), 'diagnosisCodeId')
  assert.equal(targetForeignKeyColumn('PATIENT'), 'patientId')
  assert.equal(targetForeignKeyColumn('ENCOUNTER'), 'encounterId')
})

// Every type must map to a distinct column: two types sharing one column would let a row satisfy
// the exact-one-target CHECK while deriving as the wrong target.
test('no two target types share a foreign key column', () => {
  const columns = targetTypes.map((type) => targetForeignKeyColumn(type))
  assert.equal(new Set(columns).size, columns.length)
  assert.equal(columns.length, 12)
})

test('deriveTargetFromRecord reads the one non-null column', () => {
  assert.deepEqual(deriveTargetFromRecord({ ...emptyColumns, payerId: 'p1' }), { type: 'PAYER', id: 'p1' })
  assert.deepEqual(deriveTargetFromRecord({ ...emptyColumns, clinicianId: 'c1' }), { type: 'CLINICIAN', id: 'c1' })
  assert.deepEqual(deriveTargetFromRecord({ ...emptyColumns, organizationTargetId: 'o1' }), {
    type: 'ORGANIZATION',
    id: 'o1',
  })
  assert.deepEqual(deriveTargetFromRecord({ ...emptyColumns, patientId: 'pt1' }), { type: 'PATIENT', id: 'pt1' })
  assert.deepEqual(deriveTargetFromRecord({ ...emptyColumns, encounterId: 'en1' }), { type: 'ENCOUNTER', id: 'en1' })
})

// Round-trip every type through its own column, so the ordered if-chain cannot silently shadow one
// target with an earlier one.
test('every target type derives back to itself from its own column', () => {
  for (const type of targetTypes) {
    const column = targetForeignKeyColumn(type)
    const record = { ...emptyColumns, [column]: `id-for-${type}` } as PersistedTargetColumns
    assert.deepEqual(deriveTargetFromRecord(record), { type, id: `id-for-${type}` })
  }
})

test('deriveTargetFromRecord throws when no target column is set', () => {
  assert.throws(() => deriveTargetFromRecord(emptyColumns))
})
