import test from 'node:test'
import assert from 'node:assert/strict'
import { refusedReadRequest, validateDatasetCodeSystem, validateReleaseImport, validateRetirementClassification, validateRightsDecision } from './coding-release.validation.ts'

// CRG-01 FINAL Checkpoint A — the strict maintenance inputs and the read's refusal of selectors. Synthetic values only.

const D = '00000000-0000-4000-8000-0000000000d1'
const V = '00000000-0000-4000-8000-0000000000e1'
const sha = (c: string) => c.repeat(64)
const row = (n: number, o: Record<string, unknown> = {}) => ({ sourceRowId: `row-${n}`, code: `C${n}`, sourceRowSha256: sha('a'), ...o })
const importBody = (o: Record<string, unknown> = {}) => ({ datasetVersionId: V, sourceFileSha256: sha('b'), sourceUri: 'synthetic:test', publisher: 'Synthetic', expectedRowCount: 1, rows: [row(1)], ...o })

test('a dataset identity is exactly a dataset id, one controlled code system and one purpose (CRG-011, 012)', () => {
  assert.deepEqual(validateDatasetCodeSystem({ datasetId: D.toUpperCase(), codeSystem: 'ICD-10-CM', purpose: 'CLAIM_CODING' }), { ok: true, value: { datasetId: D, codeSystem: 'ICD-10-CM', purpose: 'CLAIM_CODING' } })
  for (const body of [
    { datasetId: D, codeSystem: 'icd-10-cm', purpose: 'CLAIM_CODING' }, { datasetId: D, codeSystem: 'ICD-9', purpose: 'CLAIM_CODING' }, { datasetId: D, codeSystem: 'CPT', purpose: 'CLINICAL' },
    { datasetId: D, codeSystem: 'CPT' }, { datasetId: 'not-a-uuid', codeSystem: 'CPT', purpose: 'CLAIM_CODING' }, { datasetId: D, codeSystem: 'CPT', purpose: 'CLAIM_CODING', jurisdictionCode: 'AE-DU' }, null, [],
  ]) {
    assert.equal(validateDatasetCodeSystem(body).ok, false, JSON.stringify(body))
  }
})

test('a rights decision is controlled and carries a basis reference (CRG-008, 027)', () => {
  assert.deepEqual(validateRightsDecision({ jurisdictionCode: ' ae-du ', authorityCode: 'syn-1', codeSystem: 'CPT', rightsStatus: 'BLOCKED', decisionReference: 'register SRC-01 C5' }), {
    ok: true,
    value: { jurisdictionCode: 'AE-DU', authorityCode: 'SYN-1', codeSystem: 'CPT', rightsStatus: 'BLOCKED', decisionReference: 'register SRC-01 C5' },
  })
  for (const body of [
    { jurisdictionCode: 'AE-DU', authorityCode: 'DHA', codeSystem: 'CPT', rightsStatus: 'MAYBE', decisionReference: 'x' }, { jurisdictionCode: 'AE DU', authorityCode: 'DHA', codeSystem: 'CPT', rightsStatus: 'APPROVED', decisionReference: 'x' },
    { jurisdictionCode: 'AE-DU', authorityCode: 'DHA', codeSystem: 'CPT', rightsStatus: 'APPROVED', decisionReference: '' }, { jurisdictionCode: 'AE-DU', authorityCode: 'DHA', codeSystem: 'CPT', rightsStatus: 'APPROVED' },
    { jurisdictionCode: 'AE-DU', authorityCode: 'DHA', codeSystem: 'CPT', rightsStatus: 'APPROVED', decisionReference: 'x', expiresAt: '2027-01-01' },
  ]) {
    assert.equal(validateRightsDecision(body).ok, false, JSON.stringify(body))
  }
})

test('an import is a fingerprinted, counted set of unique source rows, never descriptor text (CRG-021–024, 028)', () => {
  assert.deepEqual(validateReleaseImport(importBody({ rows: [row(1, { code: ' c1 ' })] })).ok, true)
  for (const body of [
    importBody({ sourceFileSha256: sha('B') }), importBody({ sourceFileSha256: undefined }), importBody({ sourceUri: 'http://insecure.invalid/x' }), importBody({ publisher: '' }),
    importBody({ expectedRowCount: 0 }), importBody({ expectedRowCount: 1.5 }), importBody({ rows: [] }), importBody({ rows: [row(1, { descriptor: 'licensed text' })] }),
    importBody({ rows: [row(1), row(1)] }), importBody({ rows: [row(1), row(2, { code: 'C1' })] }), importBody({ rows: [row(1, { code: 'C 1' })] }), importBody({ rows: [row(1, { sourceRowId: ' bad id' })] }),
    importBody({ rows: [row(1, { sourceRowSha256: 'abc' })] }), importBody({ datasetVersionId: 'x' }), importBody({ effectiveFrom: '2027-01-01' }),
    importBody({ rows: Array.from({ length: 5001 }, (_, i) => row(i)) }),
  ]) {
    assert.equal(validateReleaseImport(body).ok, false, JSON.stringify(body).slice(0, 140))
  }
})

test('a retirement classification is one controlled value for one edition (CRG-037, 038)', () => {
  assert.deepEqual(validateRetirementClassification({ datasetVersionId: V, classification: 'PROSPECTIVE' }), { ok: true, value: { datasetVersionId: V, classification: 'PROSPECTIVE' } })
  for (const body of [{ datasetVersionId: V, classification: 'prospective' }, { datasetVersionId: V, classification: 'UNKNOWN' }, { datasetVersionId: V }, { datasetVersionId: V, classification: 'PROSPECTIVE', reason: 'x' }])
    assert.equal(validateRetirementClassification(body).ok, false, JSON.stringify(body))
})

test('the read takes no query and no body (CRG-048)', () => {
  assert.equal(refusedReadRequest({}, undefined), null)
  assert.equal(refusedReadRequest({}, {}), null)
  assert.notEqual(refusedReadRequest({ asOf: '2027-01-01' }, undefined), null)
  assert.notEqual(refusedReadRequest({ edition: 'latest' }, undefined), null)
  assert.notEqual(refusedReadRequest({}, { serviceDate: '2027-01-01' }), null)
})
