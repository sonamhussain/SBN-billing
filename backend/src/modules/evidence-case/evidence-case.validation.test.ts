import test from 'node:test'
import assert from 'node:assert/strict'
import { isCaseUuid, validateCaseBody } from './evidence-case.validation.ts'

// A7.4 — the strict case request: no field at all; the server derives every value.

test('an absent body or an empty object is accepted', () => {
  assert.deepEqual(validateCaseBody(undefined), { ok: true, value: {} })
  assert.deepEqual(validateCaseBody({}), { ok: true, value: {} })
})

test('a non-object body is refused', () => {
  for (const body of [null, [], 'INVENTORY_COMPLETE', 1, true]) {
    assert.equal(validateCaseBody(body).ok, false, JSON.stringify(body))
  }
})

test('a supplied code, count, item list, digest, link, actor or instant is refused by name', () => {
  for (const field of ['assemblyCode', 'sourceCount', 'itemCount', 'items', 'sources', 'sourceEvidenceIds', 'classificationIds', 'readinessIds', 'manifestSha256', 'hash', 'organizationId', 'claimSubmissionId', 'recordedByUserId', 'actorUserId', 'recordedAt', 'caseId']) {
    const result = validateCaseBody({ [field]: 'x' })
    assert.equal(result.ok, false, field)
    assert.match(result.ok ? '' : result.message, /cannot be supplied/, field)
  }
})

test('verdict, money, status and payer fields are refused by name', () => {
  for (const field of ['ready', 'adjudicated', 'status', 'paid', 'paidAmount', 'amount', 'currency', 'balance', 'denied', 'settlement', 'remittance', 'payment', 'payer', 'payload', 'note']) {
    const result = validateCaseBody({ [field]: true })
    assert.equal(result.ok, false, field)
    assert.match(result.ok ? '' : result.message, /cannot be supplied/, field)
  }
})

test('any other field, including a parsed __proto__ key, is refused as unknown', () => {
  for (const body of [{ extra: 1 }, JSON.parse('{"__proto__": {"assemblyCode": "INVENTORY_COMPLETE"}}'), { constructor: 'x' }]) {
    const result = validateCaseBody(body)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /unknown field/)
  }
})

test('identifiers must be UUIDs', () => {
  assert.equal(isCaseUuid('9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'), true)
  for (const value of ['', 'not-a-uuid', '9f1c2a3e5b6d4e7f8a9b0c1d2e3f4a5b', "1' OR '1'='1", null, undefined, 42]) {
    assert.equal(isCaseUuid(value), false, String(value))
  }
})
