import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRevenueSourceEvidenceBody } from './revenue-evidence.validation.ts'

// A7.1 — the strict registration request. Synthetic references only.

test('the exact INTERNAL_SYNTHETIC request is accepted unchanged', () => {
  assert.deepEqual(validateRevenueSourceEvidenceBody({ sourceKind: 'INTERNAL_SYNTHETIC', sourceReference: 'SYN-RSE-0001' }), {
    ok: true,
    value: { sourceKind: 'INTERNAL_SYNTHETIC', sourceReference: 'SYN-RSE-0001' },
  })
})

test('EXTERNAL_VERIFIED is refused: no authenticated integration artifact exists', () => {
  const result = validateRevenueSourceEvidenceBody({ sourceKind: 'EXTERNAL_VERIFIED', sourceReference: 'SYN-RSE-0001' })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /EXTERNAL_VERIFIED is not available/)
})

test('any other, missing or lower-case kind is refused', () => {
  for (const sourceKind of ['internal_synthetic', 'PAYER', '', null, undefined, 1]) {
    assert.equal(validateRevenueSourceEvidenceBody({ sourceKind, sourceReference: 'SYN-RSE-0001' }).ok, false, String(sourceKind))
  }
})

test('the reference must be opaque: no URL, token, e-mail, space, lower case or free text', () => {
  for (const sourceReference of ['https://payer.example/claim?id=1', 'syn-rse-0001', 'SYN RSE 0001', 'a@b.c', 'AB', '-SYN', 'X'.repeat(65), 'SYN/RSE', 'SYN:RSE', 'SYN=1', '', null, 42]) {
    assert.equal(validateRevenueSourceEvidenceBody({ sourceKind: 'INTERNAL_SYNTHETIC', sourceReference }).ok, false, String(sourceReference))
  }
  for (const sourceReference of ['ABC', 'SYN.RSE_0001-A', 'X'.repeat(64), '0SYN']) {
    assert.equal(validateRevenueSourceEvidenceBody({ sourceKind: 'INTERNAL_SYNTHETIC', sourceReference }).ok, true, sourceReference)
  }
})

test('server-owned, monetary, verdict and status fields are refused by name', () => {
  for (const field of ['organizationId', 'claimSubmissionId', 'sourceVersion', 'sourceDigestSha256', 'receivedAt', 'recordedByUserId', 'verified', 'status', 'paidAmount', 'amount', 'currency', 'denialReason', 'externalTimestamp', 'payload', 'rawMessage', 'note']) {
    const result = validateRevenueSourceEvidenceBody({ sourceKind: 'INTERNAL_SYNTHETIC', sourceReference: 'SYN-RSE-0001', [field]: 'x' })
    assert.equal(result.ok, false, field)
    assert.match(result.ok ? '' : result.message, /cannot be supplied/, field)
  }
})

test('an unknown field or a non-object body is refused', () => {
  assert.match((validateRevenueSourceEvidenceBody({ sourceKind: 'INTERNAL_SYNTHETIC', sourceReference: 'SYN-RSE-0001', extra: 1 }) as { message: string }).message, /unknown field/)
  for (const body of [null, [], 'INTERNAL_SYNTHETIC', 42, undefined]) assert.equal(validateRevenueSourceEvidenceBody(body).ok, false)
})
