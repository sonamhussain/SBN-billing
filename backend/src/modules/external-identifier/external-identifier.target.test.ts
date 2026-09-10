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
}

test('all approved target types are recognized', () => {
  for (const type of targetTypes) {
    assert.equal(isTargetType(type), true)
  }
})

test('unknown target type is rejected', () => {
  assert.equal(isTargetType('CLAIM'), false)
  assert.equal(isTargetType(42), false)
  assert.equal(isTargetType(undefined), false)
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
})

test('deriveTargetFromRecord reads the one non-null column', () => {
  assert.deepEqual(deriveTargetFromRecord({ ...emptyColumns, payerId: 'p1' }), { type: 'PAYER', id: 'p1' })
  assert.deepEqual(deriveTargetFromRecord({ ...emptyColumns, clinicianId: 'c1' }), { type: 'CLINICIAN', id: 'c1' })
  assert.deepEqual(deriveTargetFromRecord({ ...emptyColumns, organizationTargetId: 'o1' }), {
    type: 'ORGANIZATION',
    id: 'o1',
  })
})

test('deriveTargetFromRecord throws when no target column is set', () => {
  assert.throws(() => deriveTargetFromRecord(emptyColumns))
})
