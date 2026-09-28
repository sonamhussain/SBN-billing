import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateFreshness,
  isVerificationUuid,
  normalizeEvidenceVersionId,
  normalizeRequestedAt,
  normalizeRequirementFlag,
  normalizeRespondedAt,
  normalizeValidThrough,
  normalizeVerificationMethod,
  normalizeVerificationStatus,
  toVerificationDto,
  validateVerificationBody,
  verificationAuditSnapshot,
} from './eligibility-verification.validation.ts'

// A5.2 — the pure validation and freshness rules. Synthetic values only; no database access.

const NOW = new Date('2026-09-28T12:00:00.000Z')
const EVIDENCE = '11111111-1111-4111-8111-111111111111'

const body = (overrides: Record<string, unknown> = {}) => ({
  verificationMethod: 'PORTAL',
  status: 'ELIGIBLE',
  requestedAt: '2026-09-28T09:00:00.000Z',
  respondedAt: '2026-09-28T09:05:00.000Z',
  validThrough: '2026-09-29T23:59:59.000Z',
  authorizationRequired: false,
  referralRequired: null,
  requestEvidenceVersionId: null,
  responseEvidenceVersionId: EVIDENCE,
  ...overrides,
})

// ---------------------------------------------------------------- method and status

test('every approved verification method is accepted', () => {
  for (const method of ['ELECTRONIC', 'PORTAL', 'MANUAL', 'OTHER']) {
    const outcome = normalizeVerificationMethod(method)
    assert.equal(outcome.ok, true)
  }
})

test('a method outside the approved set is refused', () => {
  for (const method of ['FAX', 'electronic', '', 42, null, undefined]) {
    assert.equal(normalizeVerificationMethod(method).ok, false)
  }
})

test('every approved status is accepted', () => {
  for (const status of ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN']) {
    assert.equal(normalizeVerificationStatus(status).ok, true)
  }
})

test('ACTIVE and INACTIVE are refused as eligibility statuses', () => {
  // Registration words. Accepting them as aliases is how membership silently becomes eligibility.
  assert.equal(normalizeVerificationStatus('ACTIVE').ok, false)
  assert.equal(normalizeVerificationStatus('INACTIVE').ok, false)
})

test('an unknown status is refused rather than mapped to UNKNOWN', () => {
  // Mapping an unrecognised result onto UNKNOWN would silently record an answer the source never
  // gave; the caller is told the value is not part of the vocabulary instead.
  assert.equal(normalizeVerificationStatus('PENDING').ok, false)
  assert.equal(normalizeVerificationStatus('eligible').ok, false)
})

// ---------------------------------------------------------------- timestamps

test('requestedAt is optional and absent means unknown', () => {
  assert.deepEqual(normalizeRequestedAt(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeRequestedAt(null), { ok: true, value: null })
})

test('requestedAt must be a strict instant when supplied', () => {
  for (const value of ['2026-09-28', 'not-a-date', 42, '']) {
    assert.equal(normalizeRequestedAt(value).ok, false)
  }
})

test('respondedAt is required and must be a strict instant', () => {
  assert.equal(normalizeRespondedAt(undefined, NOW).ok, false)
  assert.equal(normalizeRespondedAt(null, NOW).ok, false)
  assert.equal(normalizeRespondedAt('2026-09-28', NOW).ok, false)
  assert.equal(normalizeRespondedAt('2026-09-28T09:00:00.000Z', NOW).ok, true)
})

test('respondedAt tolerates a minute of clock skew but refuses a response that has not happened', () => {
  const skew = new Date(NOW.getTime() + 60 * 1000).toISOString()
  const ahead = new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString()
  assert.equal(normalizeRespondedAt(skew, NOW).ok, true)
  assert.equal(normalizeRespondedAt(ahead, NOW).ok, false)
})

test('validThrough is optional and null means no boundary is known', () => {
  assert.deepEqual(normalizeValidThrough(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeValidThrough(null), { ok: true, value: null })
})

test('a response earlier than its own request is refused', () => {
  const outcome = validateVerificationBody(
    body({ requestedAt: '2026-09-28T09:05:00.000Z', respondedAt: '2026-09-28T09:00:00.000Z' }),
    NOW,
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /respondedAt/)
})

test('a validity boundary earlier than the response is refused', () => {
  const outcome = validateVerificationBody(
    body({ respondedAt: '2026-09-28T09:05:00.000Z', validThrough: '2026-09-28T09:00:00.000Z' }),
    NOW,
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /validThrough/)
})

test('a validity boundary equal to the response instant is accepted', () => {
  const at = '2026-09-28T09:05:00.000Z'
  assert.equal(validateVerificationBody(body({ respondedAt: at, validThrough: at }), NOW).ok, true)
})

// ---------------------------------------------------------------- requirement flags

test('a requirement flag keeps true, false and null apart', () => {
  assert.deepEqual(normalizeRequirementFlag(true, 'authorizationRequired'), { ok: true, value: true })
  assert.deepEqual(normalizeRequirementFlag(false, 'authorizationRequired'), { ok: true, value: false })
  // Not supplied is not the same answer as an explicit false.
  assert.deepEqual(normalizeRequirementFlag(null, 'authorizationRequired'), { ok: true, value: null })
  assert.deepEqual(normalizeRequirementFlag(undefined, 'authorizationRequired'), { ok: true, value: null })
})

test('a non-boolean requirement flag is refused rather than coerced', () => {
  for (const value of ['true', 'false', 1, 0, '']) {
    assert.equal(normalizeRequirementFlag(value, 'referralRequired').ok, false)
  }
})

// ---------------------------------------------------------------- evidence linkage

test('the response evidence version is required', () => {
  assert.equal(normalizeEvidenceVersionId(undefined, 'responseEvidenceVersionId', true).ok, false)
  assert.equal(normalizeEvidenceVersionId(null, 'responseEvidenceVersionId', true).ok, false)
  const body1 = body()
  delete (body1 as Record<string, unknown>).responseEvidenceVersionId
  assert.equal(validateVerificationBody(body1, NOW).ok, false)
  assert.equal(validateVerificationBody(body({ responseEvidenceVersionId: null }), NOW).ok, false)
})

test('the request evidence version is optional', () => {
  assert.deepEqual(normalizeEvidenceVersionId(undefined, 'requestEvidenceVersionId', false), { ok: true, value: null })
  assert.deepEqual(normalizeEvidenceVersionId(null, 'requestEvidenceVersionId', false), { ok: true, value: null })
})

test('an evidence version that is not a UUID is refused', () => {
  assert.equal(normalizeEvidenceVersionId('not-a-uuid', 'responseEvidenceVersionId', true).ok, false)
  assert.equal(normalizeEvidenceVersionId(42, 'responseEvidenceVersionId', true).ok, false)
})

// ---------------------------------------------------------------- body shape

test('a server-owned field is refused by name', () => {
  for (const field of ['id', 'encounterId', 'insuranceMembershipId', 'serviceDate', 'payerId', 'tpaId', 'networkId', 'insuranceProductId', 'freshness', 'createdAt']) {
    const outcome = validateVerificationBody(body({ [field]: 'anything' }), NOW)
    assert.equal(outcome.ok, false, `${field} should be refused`)
    assert.match(outcome.ok === false ? outcome.message : '', new RegExp(field))
  }
})

test('an unknown field is refused and named', () => {
  const outcome = validateVerificationBody(body({ copayAmount: 50 }), NOW)
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /copayAmount/)
})

test('a valid body is accepted and normalized', () => {
  const outcome = validateVerificationBody(body(), NOW)
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.equal(outcome.value.status, 'ELIGIBLE')
    assert.equal(outcome.value.authorizationRequired, false)
    assert.equal(outcome.value.referralRequired, null)
    assert.equal(outcome.value.requestEvidenceVersionId, null)
    assert.equal(outcome.value.responseEvidenceVersionId, EVIDENCE)
  }
})

test('a body that is not an object is refused', () => {
  for (const value of [null, undefined, 'x', 42, []]) {
    assert.equal(validateVerificationBody(value, NOW).ok, false)
  }
})

// ---------------------------------------------------------------- freshness

test('a null validity boundary is UNKNOWN, not stale', () => {
  // Nothing was recorded, so nothing has expired — and nothing is known to still hold either.
  assert.equal(evaluateFreshness(null, NOW), 'UNKNOWN')
})

test('an evaluation instant at or before the boundary is FRESH', () => {
  const boundary = new Date('2026-09-29T00:00:00.000Z')
  assert.equal(evaluateFreshness(boundary, new Date('2026-09-28T23:59:59.000Z')), 'FRESH')
  assert.equal(evaluateFreshness(boundary, boundary), 'FRESH')
})

test('an evaluation instant past the boundary is STALE', () => {
  const boundary = new Date('2026-09-29T00:00:00.000Z')
  assert.equal(evaluateFreshness(boundary, new Date('2026-09-29T00:00:01.000Z')), 'STALE')
})

test('freshness is independent of status: a FRESH UNKNOWN is still UNKNOWN', () => {
  const record = stored({ status: 'UNKNOWN', validThrough: new Date('2026-09-29T00:00:00.000Z') })
  const dto = toVerificationDto(record, new Date('2026-09-28T10:00:00.000Z'))
  assert.equal(dto.freshness.state, 'FRESH')
  // FRESH describes the validity boundary, never the result.
  assert.equal(dto.status, 'UNKNOWN')
})

test('staleness does not rewrite what the verification reported', () => {
  const record = stored({ status: 'ELIGIBLE', validThrough: new Date('2026-09-29T00:00:00.000Z') })
  const dto = toVerificationDto(record, new Date('2026-10-05T10:00:00.000Z'))
  assert.equal(dto.freshness.state, 'STALE')
  assert.equal(dto.status, 'ELIGIBLE')
})

test('the same record is FRESH now and STALE later, and says which instant it was asked about', () => {
  const record = stored({ validThrough: new Date('2026-09-29T00:00:00.000Z') })
  const early = toVerificationDto(record, new Date('2026-09-28T10:00:00.000Z'))
  const late = toVerificationDto(record, new Date('2026-10-01T10:00:00.000Z'))
  assert.equal(early.freshness.state, 'FRESH')
  assert.equal(late.freshness.state, 'STALE')
  assert.equal(early.freshness.evaluatedAt, '2026-09-28T10:00:00.000Z')
  assert.equal(late.freshness.evaluatedAt, '2026-10-01T10:00:00.000Z')
})

// ---------------------------------------------------------------- DTO and audit

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    encounterId: '33333333-3333-4333-8333-333333333333',
    insuranceMembershipId: '44444444-4444-4444-8444-444444444444',
    serviceDate: new Date('2026-06-15T00:00:00.000Z'),
    payerId: '55555555-5555-4555-8555-555555555555',
    tpaId: null,
    networkId: null,
    insuranceProductId: null,
    verificationMethod: 'PORTAL',
    status: 'ELIGIBLE',
    requestedAt: null,
    respondedAt: new Date('2026-09-28T09:05:00.000Z'),
    validThrough: null,
    authorizationRequired: null,
    referralRequired: null,
    requestEvidenceVersionId: null,
    responseEvidenceVersionId: EVIDENCE,
    createdAt: new Date('2026-09-28T09:06:00.000Z'),
    ...overrides,
  } as Parameters<typeof toVerificationDto>[0]
}

test('the DTO renders the service date as a calendar date and carries no evidence metadata', () => {
  const dto = toVerificationDto(stored(), NOW)
  assert.equal(dto.serviceDate, '2026-06-15')
  const keys = Object.keys(dto)
  for (const forbidden of ['storageRef', 'contentHash', 'documentType', 'memberIdentifier', 'policyIdentifier']) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} must not appear in the DTO`)
  }
})

test('the audit snapshot carries only the identity and the moment', () => {
  const snapshot = verificationAuditSnapshot({ id: 'abc', createdAt: new Date('2026-09-28T09:06:00.000Z') })
  assert.deepEqual(Object.keys(snapshot).sort(), ['createdAt', 'id'])
})

test('a UUID is recognised and anything else is not', () => {
  assert.equal(isVerificationUuid(EVIDENCE), true)
  assert.equal(isVerificationUuid('not-a-uuid'), false)
  assert.equal(isVerificationUuid(42), false)
  assert.equal(isVerificationUuid(null), false)
})
