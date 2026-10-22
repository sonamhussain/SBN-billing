import test from 'node:test'
import assert from 'node:assert/strict'
import { isEvidenceClassificationUuid, validateClassificationBody } from './evidence-classification.validation.ts'

// A7.2 — the strict classification request: no field at all; the server derives every value.

test('an absent body or an empty object is accepted', () => {
  assert.deepEqual(validateClassificationBody(undefined), { ok: true, value: {} })
  assert.deepEqual(validateClassificationBody({}), { ok: true, value: {} })
})

test('a non-object body is refused', () => {
  for (const body of [null, [], 'INTERNAL_DECLARATION', 1, true]) {
    assert.equal(validateClassificationBody(body).ok, false, JSON.stringify(body))
  }
})

test('a supplied classification, outcome, reason, contract or fingerprint is refused by name', () => {
  for (const field of ['classificationCode', 'normalizationOutcome', 'reasonCode', 'contractVersion', 'sourceFingerprintSha256', 'fingerprint', 'organizationId', 'sourceEvidenceId', 'recordedByUserId', 'recordedAt']) {
    const result = validateClassificationBody({ [field]: 'x' })
    assert.equal(result.ok, false, field)
    assert.match(result.ok ? '' : result.message, /cannot be supplied/, field)
  }
})

test('verification, verdict, payment and status fields are refused by name', () => {
  for (const field of ['verified', 'verificationStatus', 'status', 'paid', 'paidAmount', 'amount', 'currency', 'denied', 'denialReason', 'adjudication', 'remittance', 'payment', 'payer', 'payload', 'note']) {
    const result = validateClassificationBody({ [field]: true })
    assert.equal(result.ok, false, field)
    assert.match(result.ok ? '' : result.message, /cannot be supplied/, field)
  }
})

test('any other field, including a parsed __proto__ key, is refused as unknown', () => {
  for (const body of [{ extra: 1 }, JSON.parse('{"__proto__": {"classificationCode": "EXTERNAL_SOURCE_VERIFIED"}}'), { constructor: 'x' }]) {
    const result = validateClassificationBody(body)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /unknown field/)
  }
})

test('identifiers must be UUIDs', () => {
  assert.equal(isEvidenceClassificationUuid('9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'), true)
  for (const value of ['', 'not-a-uuid', '9f1c2a3e5b6d4e7f8a9b0c1d2e3f4a5b', "1' OR '1'='1", null, undefined, 42]) {
    assert.equal(isEvidenceClassificationUuid(value), false, String(value))
  }
})
