import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideDatasetValidationChange,
  isReferenceDatasetUuid,
  isReferenceDatasetValidationStatus,
  normalizeContentHash,
  normalizeDatasetKey,
  normalizeReferenceDatasetAuthorityCode,
  normalizeReferenceDatasetDisplayName,
  normalizeReferenceDatasetJurisdictionCode,
  normalizeReferenceDatasetVersion,
} from './reference-dataset.validation.ts'

test('datasetKey trims correctly', () => {
  assert.equal(normalizeDatasetKey('  ICD10-AE  '), 'ICD10-AE')
})

test('blank datasetKey rejected', () => {
  assert.equal(normalizeDatasetKey('   '), null)
})

test('non-string datasetKey rejected', () => {
  assert.equal(normalizeDatasetKey(1), null)
})

test('display name trims correctly', () => {
  assert.equal(normalizeReferenceDatasetDisplayName('  ICD-10 AE Edition  '), 'ICD-10 AE Edition')
})

test('jurisdictionCode trims correctly', () => {
  assert.equal(normalizeReferenceDatasetJurisdictionCode('  AE-DU  '), 'AE-DU')
})

test('authorityCode trims correctly', () => {
  assert.equal(normalizeReferenceDatasetAuthorityCode('  DHA  '), 'DHA')
})

test('contentHash trims correctly', () => {
  assert.equal(normalizeContentHash('  abc123  '), 'abc123')
})

test('version trims correctly', () => {
  assert.equal(normalizeReferenceDatasetVersion('  2026-Q1  '), '2026-Q1')
})

test('UUID shape is accepted', () => {
  assert.equal(isReferenceDatasetUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isReferenceDatasetUuid('not-a-uuid'), false)
})

test('all approved validation statuses are recognized', () => {
  for (const status of ['UNVALIDATED', 'VALIDATED', 'REJECTED']) {
    assert.equal(isReferenceDatasetValidationStatus(status), true)
  }
})

test('unknown validation status is rejected', () => {
  assert.equal(isReferenceDatasetValidationStatus('APPROVED'), false)
})

// Audit F11 — ACTIVE implies VALIDATED, durably.
test('F11: an ACTIVE version cannot be downgraded to UNVALIDATED or REJECTED', () => {
  const active = { activationStatus: 'ACTIVE', validationStatus: 'VALIDATED' }
  assert.equal(decideDatasetValidationChange(active, 'UNVALIDATED').kind, 'rejected')
  assert.equal(decideDatasetValidationChange(active, 'REJECTED').kind, 'rejected')
})

test('F11: re-confirming VALIDATED on an ACTIVE version stays allowed', () => {
  assert.equal(
    decideDatasetValidationChange({ activationStatus: 'ACTIVE', validationStatus: 'VALIDATED' }, 'VALIDATED').kind,
    'allowed',
  )
})

test('F11: a version that is not in force can still be validated, unvalidated or rejected', () => {
  for (const activationStatus of ['INACTIVE', 'SUPERSEDED']) {
    for (const requested of ['UNVALIDATED', 'VALIDATED', 'REJECTED'] as const) {
      assert.equal(
        decideDatasetValidationChange({ activationStatus, validationStatus: 'UNVALIDATED' }, requested).kind,
        'allowed',
        `${activationStatus} -> ${requested}`,
      )
    }
  }
})

test('F11: RETIRED stays terminal for every requested validation status', () => {
  for (const requested of ['UNVALIDATED', 'VALIDATED', 'REJECTED'] as const) {
    const decision = decideDatasetValidationChange({ activationStatus: 'RETIRED', validationStatus: 'VALIDATED' }, requested)
    assert.equal(decision.kind, 'rejected')
  }
})

test('F11: REJECTED stays terminal for validation, in either direction', () => {
  assert.equal(
    decideDatasetValidationChange({ activationStatus: 'INACTIVE', validationStatus: 'REJECTED' }, 'VALIDATED').kind,
    'rejected',
  )
  assert.equal(
    decideDatasetValidationChange({ activationStatus: 'INACTIVE', validationStatus: 'REJECTED' }, 'UNVALIDATED').kind,
    'rejected',
  )
})

test('F11: the downgrade refusal names the state and the remedy', () => {
  const decision = decideDatasetValidationChange({ activationStatus: 'ACTIVE', validationStatus: 'VALIDATED' }, 'REJECTED')
  assert.equal(decision.kind, 'rejected')
  if (decision.kind !== 'rejected') return
  assert.match(decision.message, /ACTIVE/)
  assert.match(decision.message, /REJECTED/)
  assert.match(decision.message, /retiring it or activating another VALIDATED version/)
})
