import test from 'node:test'
import assert from 'node:assert/strict'
import {
  authorizationAuditSnapshot,
  eligibilityContextMatches,
  isAuthorizationUuid,
  nextVersionNumber,
  normalizeAuthorizationReference,
  normalizeAuthorizationStatus,
  normalizeEvidenceLinks,
  normalizeEvidenceRole,
  normalizeOptionalDate,
  normalizeOptionalInstant,
  normalizeVersionKind,
  toVersionDto,
  validateVersionBody,
  versionAuditSnapshot,
} from './prior-authorization.validation.ts'

// A5.3 — the pure validation rules. Synthetic values only; no database access.

const EV1 = '11111111-1111-4111-8111-111111111111'
const EV2 = '22222222-2222-4222-8222-222222222222'

const body = (overrides: Record<string, unknown> = {}) => ({
  versionKind: 'INITIAL',
  status: 'REQUESTED',
  authorizationReference: null,
  eligibilityVerificationId: null,
  requestedAt: '2026-09-29T08:00:00.000Z',
  respondedAt: null,
  validFrom: null,
  validThrough: null,
  evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: EV1 }],
  ...overrides,
})

// ---------------------------------------------------------------- vocabulary

test('every approved version kind is accepted', () => {
  for (const kind of ['INITIAL', 'RESPONSE', 'AMENDMENT', 'EXTENSION', 'CORRECTION'])
    assert.equal(normalizeVersionKind(kind).ok, true)
})

test('a version kind outside the approved set is refused', () => {
  for (const kind of ['RENEWAL', 'initial', '', 42, null, undefined]) assert.equal(normalizeVersionKind(kind).ok, false)
})

test('every approved status is accepted', () => {
  for (const status of ['REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN'])
    assert.equal(normalizeAuthorizationStatus(status).ok, true)
})

test('EXPIRED and ACTIVE are refused as authorization statuses', () => {
  // Validity is validFrom/validThrough. A derived expiry column would go stale the moment the clock
  // moved past it, and deciding whether an authorization still applies belongs to A5.4 and A5.8.
  assert.equal(normalizeAuthorizationStatus('EXPIRED').ok, false)
  assert.equal(normalizeAuthorizationStatus('ACTIVE').ok, false)
})

test('every approved evidence role is accepted and anything else is refused', () => {
  for (const role of ['REQUEST', 'RESPONSE', 'SUPPORTING']) assert.equal(normalizeEvidenceRole(role).ok, true)
  for (const role of ['APPROVAL_LETTER', 'request', '', 42, null]) assert.equal(normalizeEvidenceRole(role).ok, false)
})

// ---------------------------------------------------------------- first version vs append

test('the first version must be INITIAL', () => {
  assert.equal(validateVersionBody(body(), 'first').ok, true)
  const outcome = validateVersionBody(body({ versionKind: 'RESPONSE', status: 'APPROVED', respondedAt: '2026-09-29T09:00:00.000Z', evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: EV1 }] }), 'first')
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /must be INITIAL/)
})

test('a later version must not be INITIAL', () => {
  const outcome = validateVersionBody(body(), 'append')
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /only the first version may be INITIAL/)
})

// ---------------------------------------------------------------- authorization reference

test('the authorization reference is optional', () => {
  assert.deepEqual(normalizeAuthorizationReference(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeAuthorizationReference(null), { ok: true, value: null })
})

test('the authorization reference is trimmed but its case is preserved', () => {
  // A payer reference is theirs, not ours to normalize.
  assert.deepEqual(normalizeAuthorizationReference('  AuTh-XyZ-42  '), { ok: true, value: 'AuTh-XyZ-42' })
})

test('a blank, oversize or control-bearing reference is refused', () => {
  assert.equal(normalizeAuthorizationReference('   ').ok, false)
  assert.equal(normalizeAuthorizationReference('x'.repeat(129)).ok, false)
  assert.equal(normalizeAuthorizationReference('AUTH\n123').ok, false)
  assert.equal(normalizeAuthorizationReference('AUTH\u0000123').ok, false)
  assert.equal(normalizeAuthorizationReference(42).ok, false)
})

test('a reference of exactly the maximum length is accepted', () => {
  assert.equal(normalizeAuthorizationReference('x'.repeat(128)).ok, true)
})

// ---------------------------------------------------------------- timestamps and validity

test('requestedAt and respondedAt are optional instants', () => {
  assert.deepEqual(normalizeOptionalInstant(undefined, 'requestedAt'), { ok: true, value: null })
  assert.deepEqual(normalizeOptionalInstant(null, 'respondedAt'), { ok: true, value: null })
  assert.equal(normalizeOptionalInstant('2026-09-29', 'requestedAt').ok, false)
  assert.equal(normalizeOptionalInstant('not-a-date', 'requestedAt').ok, false)
})

test('validFrom and validThrough are optional calendar dates', () => {
  assert.deepEqual(normalizeOptionalDate(undefined, 'validFrom'), { ok: true, value: null })
  assert.deepEqual(normalizeOptionalDate(null, 'validThrough'), { ok: true, value: null })
  assert.equal(normalizeOptionalDate('2026-02-31', 'validFrom').ok, false)
  assert.equal(normalizeOptionalDate('2026-09-29T08:00:00.000Z', 'validFrom').ok, false)
})

test('a response earlier than its own request is refused', () => {
  const outcome = validateVersionBody(
    body({ requestedAt: '2026-09-29T09:00:00.000Z', respondedAt: '2026-09-29T08:00:00.000Z' }),
    'first',
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /respondedAt/)
})

test('a validity window that ends before it begins is refused', () => {
  const outcome = validateVersionBody(body({ validFrom: '2026-10-01', validThrough: '2026-09-30' }), 'first')
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /validThrough/)
})

test('a validity window of a single day is accepted', () => {
  assert.equal(validateVersionBody(body({ validFrom: '2026-10-01', validThrough: '2026-10-01' }), 'first').ok, true)
})

// ---------------------------------------------------------------- decisions need a response

test('a decided status requires a response instant', () => {
  for (const status of ['APPROVED', 'PARTIALLY_APPROVED', 'DENIED']) {
    const outcome = validateVersionBody(
      body({ versionKind: 'RESPONSE', status, respondedAt: null, evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: EV1 }] }),
      'append',
    )
    assert.equal(outcome.ok, false, `${status} should require respondedAt`)
    assert.match(outcome.ok === false ? outcome.message : '', /respondedAt/)
  }
})

test('a decided status requires RESPONSE evidence', () => {
  const outcome = validateVersionBody(
    body({ versionKind: 'CORRECTION', status: 'APPROVED', respondedAt: '2026-09-29T09:00:00.000Z', evidenceLinks: [{ role: 'SUPPORTING', evidenceArtifactVersionId: EV1 }] }),
    'append',
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /RESPONSE evidence/)
})

test('RESPONSE, AMENDMENT and EXTENSION each require RESPONSE evidence', () => {
  for (const kind of ['RESPONSE', 'AMENDMENT', 'EXTENSION']) {
    const outcome = validateVersionBody(
      body({ versionKind: kind, status: 'PENDING', evidenceLinks: [{ role: 'SUPPORTING', evidenceArtifactVersionId: EV1 }] }),
      'append',
    )
    assert.equal(outcome.ok, false, `${kind} should require RESPONSE evidence`)
  }
})

test('REQUESTED, PENDING and UNKNOWN need neither a response instant nor RESPONSE evidence', () => {
  for (const status of ['REQUESTED', 'PENDING', 'UNKNOWN'])
    assert.equal(validateVersionBody(body({ status }), 'first').ok, true, `${status} should be accepted`)
})

test('a retrospective INITIAL approval is accepted when it carries its response', () => {
  // A case recorded after the payer already answered is legitimate; the rule is about evidence, not
  // about the order events were entered in.
  const outcome = validateVersionBody(
    body({ status: 'APPROVED', respondedAt: '2026-09-29T09:00:00.000Z', evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: EV1 }] }),
    'first',
  )
  assert.equal(outcome.ok, true)
})

// ---------------------------------------------------------------- evidence links

test('at least one evidence link is required', () => {
  assert.equal(normalizeEvidenceLinks([]).ok, false)
  assert.equal(normalizeEvidenceLinks(undefined).ok, false)
  assert.equal(normalizeEvidenceLinks(null).ok, false)
  assert.equal(normalizeEvidenceLinks({}).ok, false)
})

test('the same evidence version in the same role twice is refused', () => {
  const outcome = normalizeEvidenceLinks([
    { role: 'RESPONSE', evidenceArtifactVersionId: EV1 },
    { role: 'RESPONSE', evidenceArtifactVersionId: EV1 },
  ])
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /repeat/)
})

test('the same evidence version in two different roles is allowed', () => {
  // One document can legitimately be both the response and supporting material.
  const outcome = normalizeEvidenceLinks([
    { role: 'RESPONSE', evidenceArtifactVersionId: EV1 },
    { role: 'SUPPORTING', evidenceArtifactVersionId: EV1 },
  ])
  assert.equal(outcome.ok, true)
})

test('an unknown field inside an evidence link is refused', () => {
  const outcome = normalizeEvidenceLinks([{ role: 'REQUEST', evidenceArtifactVersionId: EV1, documentType: 'APPROVAL' }])
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /documentType/)
})

test('an evidence link with a non-UUID version is refused', () => {
  assert.equal(normalizeEvidenceLinks([{ role: 'REQUEST', evidenceArtifactVersionId: 'not-a-uuid' }]).ok, false)
})

// ---------------------------------------------------------------- body shape

test('a server-owned field is refused by name', () => {
  for (const field of ['id', 'priorAuthorizationId', 'version', 'encounterId', 'insuranceMembershipId', 'payerId', 'tpaId', 'networkId', 'insuranceProductId', 'facilityId', 'clinicianId', 'serviceDate', 'createdByUserId', 'createdAt', 'isCurrent', 'isSatisfied']) {
    const outcome = validateVersionBody(body({ [field]: 'anything' }), 'first')
    assert.equal(outcome.ok, false, `${field} should be refused`)
    assert.match(outcome.ok === false ? outcome.message : '', new RegExp(field))
  }
})

test('an unknown field is refused and named', () => {
  const outcome = validateVersionBody(body({ approvedQuantity: 3 }), 'first')
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /approvedQuantity/)
})

test('a body that is not an object is refused', () => {
  for (const value of [null, undefined, 'x', 42, []]) assert.equal(validateVersionBody(value, 'first').ok, false)
})

test('the eligibility link is optional and must be a UUID when supplied', () => {
  assert.equal(validateVersionBody(body({ eligibilityVerificationId: null }), 'first').ok, true)
  assert.equal(validateVersionBody(body({ eligibilityVerificationId: EV2 }), 'first').ok, true)
  assert.equal(validateVersionBody(body({ eligibilityVerificationId: 'not-a-uuid' }), 'first').ok, false)
})

// ---------------------------------------------------------------- numbering and context match

test('the next version number follows the maximum, starting at 1', () => {
  assert.equal(nextVersionNumber(null), 1)
  assert.equal(nextVersionNumber(1), 2)
  assert.equal(nextVersionNumber(7), 8)
})

const context = (overrides: Record<string, unknown> = {}) => ({
  encounterId: '33333333-3333-4333-8333-333333333333',
  insuranceMembershipId: '44444444-4444-4444-8444-444444444444',
  payerId: '55555555-5555-4555-8555-555555555555',
  tpaId: null,
  networkId: null,
  insuranceProductId: null,
  serviceDate: new Date('2026-06-15T00:00:00.000Z'),
  ...overrides,
}) as Parameters<typeof eligibilityContextMatches>[0]

test('an eligibility verification describing the same situation matches', () => {
  assert.equal(eligibilityContextMatches(context(), context()), true)
})

test('a difference in any part of the context is a mismatch', () => {
  const base = context()
  for (const [field, value] of [
    ['encounterId', '99999999-9999-4999-8999-999999999999'],
    ['insuranceMembershipId', '99999999-9999-4999-8999-999999999999'],
    ['payerId', '99999999-9999-4999-8999-999999999999'],
    ['tpaId', '99999999-9999-4999-8999-999999999999'],
    ['networkId', '99999999-9999-4999-8999-999999999999'],
    ['insuranceProductId', '99999999-9999-4999-8999-999999999999'],
    ['serviceDate', new Date('2026-06-16T00:00:00.000Z')],
  ] as const) {
    assert.equal(eligibilityContextMatches(base, context({ [field]: value })), false, `${field} should not match`)
  }
})

// ---------------------------------------------------------------- DTOs and audit

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    priorAuthorizationId: '77777777-7777-4777-8777-777777777777',
    version: 1,
    versionKind: 'INITIAL',
    status: 'REQUESTED',
    authorizationReference: null,
    eligibilityVerificationId: null,
    requestedAt: null,
    respondedAt: null,
    validFrom: new Date('2026-10-01T00:00:00.000Z'),
    validThrough: null,
    createdByUserId: '88888888-8888-4888-8888-888888888888',
    createdAt: new Date('2026-09-29T09:06:00.000Z'),
    evidenceLinks: [{ id: 'link-1', evidenceArtifactVersionId: EV1, role: 'REQUEST', createdAt: new Date('2026-09-29T09:06:00.000Z') }],
    ...overrides,
  } as Parameters<typeof toVersionDto>[0]
}

test('the version DTO renders validity as calendar dates and carries no evidence metadata', () => {
  const dto = toVersionDto(stored())
  assert.equal(dto.validFrom, '2026-10-01')
  assert.equal(dto.validThrough, null)
  assert.equal(dto.evidenceLinks.length, 1)
  assert.equal(dto.evidenceLinks[0].role, 'REQUEST')
  const linkKeys = Object.keys(dto.evidenceLinks[0])
  for (const forbidden of ['storageRef', 'contentHash', 'documentType']) assert.equal(linkKeys.includes(forbidden), false)
})

test('the version DTO exposes no line scope and no current-state flag', () => {
  const keys = Object.keys(toVersionDto(stored()))
  for (const forbidden of ['serviceId', 'procedureCodeId', 'diagnosisCodeId', 'requestedQuantity', 'approvedQuantity', 'isCurrent', 'isSatisfied'])
    assert.equal(keys.includes(forbidden), false, `${forbidden} belongs to A5.4, not A5.3`)
})

test('the parent audit snapshot carries only the identity and the moment', () => {
  const snapshot = authorizationAuditSnapshot({ id: 'abc', createdAt: new Date('2026-09-29T09:06:00.000Z') })
  assert.deepEqual(Object.keys(snapshot).sort(), ['createdAt', 'id'])
})

test('the version audit snapshot adds only the parent and the version number', () => {
  const snapshot = versionAuditSnapshot({ id: 'abc', priorAuthorizationId: 'def', version: 2, createdAt: new Date('2026-09-29T09:06:00.000Z') })
  assert.deepEqual(Object.keys(snapshot).sort(), ['createdAt', 'id', 'priorAuthorizationId', 'version'])
})

test('a UUID is recognised and anything else is not', () => {
  assert.equal(isAuthorizationUuid(EV1), true)
  assert.equal(isAuthorizationUuid('not-a-uuid'), false)
  assert.equal(isAuthorizationUuid(42), false)
})
