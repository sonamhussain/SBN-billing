import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrerequisiteUuid, validatePrerequisiteBody } from './case-prerequisite.validation.ts'

// A7.5 — the strict assessment request: no field at all; the server derives every value.

test('an absent body or an empty object is accepted', () => {
  assert.deepEqual(validatePrerequisiteBody(undefined), { ok: true, value: {} })
  assert.deepEqual(validatePrerequisiteBody({}), { ok: true, value: {} })
})

test('a non-object body is refused', () => {
  for (const body of [null, [], 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 1, true]) {
    assert.equal(validatePrerequisiteBody(body).ok, false, JSON.stringify(body))
  }
})

test('a supplied case, code, basis, digest, actor, organization or instant is refused by name', () => {
  for (const field of ['caseId', 'evidenceCaseId', 'claimSubmissionId', 'sourceEvidenceId', 'assessmentCode', 'basisCode', 'contractVersion', 'caseManifestSha256', 'fingerprint', 'hash', 'organizationId', 'recordedByUserId', 'actorUserId', 'recordedAt', 'date', 'assessmentId']) {
    const result = validatePrerequisiteBody({ [field]: 'x' })
    assert.equal(result.ok, false, field)
    assert.match(result.ok ? '' : result.message, /cannot be supplied/, field)
  }
})

test('closure, money, status and payer fields are refused by name', () => {
  for (const field of ['ready', 'closed', 'closure', 'status', 'latest', 'paid', 'paidAmount', 'amount', 'fee', 'currency', 'balance', 'denied', 'settlement', 'remittance', 'payment', 'payer', 'payload', 'note']) {
    const result = validatePrerequisiteBody({ [field]: true })
    assert.equal(result.ok, false, field)
    assert.match(result.ok ? '' : result.message, /cannot be supplied/, field)
  }
})

test('any other field, including a parsed __proto__ key, is refused as unknown', () => {
  for (const body of [{ extra: 1 }, JSON.parse('{"__proto__": {"assessmentCode": "NO_SOURCE_BASIS"}}'), { constructor: 'x' }]) {
    const result = validatePrerequisiteBody(body)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /unknown field/)
  }
})

test('identifiers must be UUIDs', () => {
  assert.equal(isPrerequisiteUuid('9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'), true)
  for (const value of ['', 'not-a-uuid', '9f1c2a3e5b6d4e7f8a9b0c1d2e3f4a5b', "1' OR '1'='1", null, undefined, 42]) {
    assert.equal(isPrerequisiteUuid(value), false, String(value))
  }
})
