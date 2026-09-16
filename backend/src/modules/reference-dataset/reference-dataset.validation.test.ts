import test from 'node:test'
import assert from 'node:assert/strict'
import {
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
