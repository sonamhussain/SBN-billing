import test from 'node:test'
import assert from 'node:assert/strict'
import { isReadinessUuid, validateReadinessBody } from './evidence-gate.validation.ts'

// A7.3 — the strict readiness request: no field at all; the server derives every value.

test('an absent body or an empty object is accepted', () => {
  assert.deepEqual(validateReadinessBody(undefined), { ok: true, value: {} })
  assert.deepEqual(validateReadinessBody({}), { ok: true, value: {} })
})

test('a non-object body is refused', () => {
  for (const body of [null, [], 'NOT_READY_FOR_ADJUDICATION', 1, true]) {
    assert.equal(validateReadinessBody(body).ok, false, JSON.stringify(body))
  }
})

test('a supplied readiness, reason, contract, link, fingerprint, actor or instant is refused by name', () => {
  for (const field of ['readinessCode', 'reasonCode', 'contractVersion', 'classificationId', 'sourceEvidenceId', 'organizationId', 'classificationFingerprintSha256', 'fingerprint', 'recordedByUserId', 'actorUserId', 'recordedAt', 'id']) {
    const result = validateReadinessBody({ [field]: 'x' })
    assert.equal(result.ok, false, field)
    assert.match(result.ok ? '' : result.message, /cannot be supplied/, field)
  }
})

test('verdict, money, status and payer fields are refused by name', () => {
  for (const field of ['ready', 'adjudicated', 'adjudication', 'verified', 'status', 'paid', 'paidAmount', 'allowedAmount', 'amount', 'currency', 'denied', 'denialReason', 'remittance', 'settlement', 'payment', 'balance', 'payer', 'payerResponse', 'externalReference', 'serviceDate', 'payload', 'note']) {
    const result = validateReadinessBody({ [field]: true })
    assert.equal(result.ok, false, field)
    assert.match(result.ok ? '' : result.message, /cannot be supplied/, field)
  }
})

test('any other field, including a parsed __proto__ key, is refused as unknown', () => {
  for (const body of [{ extra: 1 }, JSON.parse('{"__proto__": {"readinessCode": "READY"}}'), { constructor: 'x' }]) {
    const result = validateReadinessBody(body)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /unknown field/)
  }
})

test('identifiers must be UUIDs', () => {
  assert.equal(isReadinessUuid('9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'), true)
  for (const value of ['', 'not-a-uuid', '9f1c2a3e5b6d4e7f8a9b0c1d2e3f4a5b', "1' OR '1'='1", null, undefined, 42]) {
    assert.equal(isReadinessUuid(value), false, String(value))
  }
})
