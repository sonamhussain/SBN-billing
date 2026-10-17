import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Prisma } from '../../../generated/prisma/client.ts'
import { encodeCanonicalPayload, exactDecimalText, PayloadEncodingError } from './claim-payload.serializer.ts'
import { PAYLOAD_SCHEMA_VERSION, type CanonicalClaimPayloadV1 } from './claim-payload.types.ts'
import { validatePreviewBody } from './claim-payload.validation.ts'

// A6.6 — the A6-PAYLOAD-1 request, encoder and golden vector. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const FP = 'a'.repeat(64)

// The synthetic golden payload: two lines (one with modifiers, one with a null service and unit), two
// diagnoses, nullable commercial ids, an AED 2-decimal charge of 0.00 and Unicode in a code value.
const golden = (): CanonicalClaimPayloadV1 => ({
  schemaVersion: 'A6-PAYLOAD-1',
  header: {
    claimId: id(1),
    claimContractVersion: 'A6-CLAIM-1',
    handoffSchemaVersion: 'PreClaimA6HandoffV1',
    encounterId: id(2),
    serviceDate: '2026-06-15',
    facilityId: id(3),
    facilityRegulatoryProfileId: id(4),
    jurisdictionCode: 'AE-DU',
    assessedValidationRunId: id(5),
    readinessAssessmentId: id(6),
    readinessPolicyVersion: 'A5-READY-1',
    draftAssessmentId: id(7),
    draftContractVersion: 'A6-DRAFT-1',
    draftFingerprint: FP,
    pricingRunId: id(8),
    pricingContractVersion: 'A6-PRICE-1',
    approvalDecisionId: id(9),
  },
  commercial: { providerContractId: id(10), tariffScheduleId: id(11), tariffScheduleVersionId: id(12), payerId: id(13), tpaId: null, networkId: id(14), insuranceProductId: null, currencyCode: 'AED' },
  lines: [
    {
      claimLineId: id(21),
      sequence: 1,
      encounterActivityId: id(31),
      serviceId: null,
      procedureCodeId: id(41),
      quantity: '2.5000',
      unitCode: 'mL·µ',
      modifierCodes: ['M2', 'M1'],
      pricingLineResultId: id(51),
      tariffRateId: id(61),
      unitTariffAmount: '125.2500',
      extendedAmount: '313.13',
      currencyCode: 'AED',
      claimDiagnosisIds: [id(71), id(72)],
    },
    {
      claimLineId: id(22),
      sequence: 2,
      encounterActivityId: id(32),
      serviceId: id(42),
      procedureCodeId: null,
      quantity: '1.0000',
      unitCode: null,
      modifierCodes: [],
      pricingLineResultId: id(52),
      tariffRateId: id(62),
      unitTariffAmount: '0.0000',
      extendedAmount: '0.00',
      currencyCode: 'AED',
      claimDiagnosisIds: [id(71)],
    },
  ],
  diagnoses: [
    { claimDiagnosisId: id(71), sequence: 1, encounterDiagnosisId: id(81), roleCode: 'PRIMARY', diagnosisCodeId: id(91) },
    { claimDiagnosisId: id(72), sequence: 2, encounterDiagnosisId: id(82), roleCode: 'SECONDARY', diagnosisCodeId: id(92) },
  ],
  financial: { totalExtendedAmount: '313.13', currencyCode: 'AED' },
  evidence: {
    validationFindingIds: [id(101), id(102)],
    eligibilityVerificationIds: [],
    priorAuthorizationVersionIds: [],
    authorizationLineIds: [],
    evidenceRequirementIds: [],
    evidenceArtifactVersionIds: [id(111)],
    ruleVersionIds: [id(121), id(122)],
    governingSourceVersionIds: [],
    referenceDatasetVersionIds: [],
  },
  approval: { reviewContractVersion: 'A6-REVIEW-1', decisionId: id(9), reviewedAssessmentId: id(7), reviewFingerprint: FP, reviewerUserId: id(131) },
})

// Frozen byte-for-byte: any change to the A6-PAYLOAD-1 key order, escaping or number format changes these.
const GOLDEN_SHA256 = '155ad44f6d1fe8d7bb17791cc809d40b74d878f01171d4c0a148df027de80685'
const GOLDEN_LENGTH = 3620

// Rebuilds a value with every object's keys in reverse insertion order (same semantics, different order).
const reversed = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(reversed) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)])) : value

const refusal = (mutate: (p: any) => void) => {
  const payload = structuredClone(golden()) as any
  mutate(payload)
  try {
    encodeCanonicalPayload(payload, 2)
    return 'ENCODED'
  } catch (error) {
    assert.ok(error instanceof PayloadEncodingError)
    return error.path
  }
}

test('the schema version is fixed', () => {
  assert.equal(PAYLOAD_SCHEMA_VERSION, 'A6-PAYLOAD-1')
})

test('golden vector: exact bytes and SHA-256', () => {
  const encoded = encodeCanonicalPayload(golden(), 2)
  assert.equal(encoded.sha256, createHash('sha256').update(encoded.bytes).digest('hex'))
  assert.equal(encoded.bytes.length, GOLDEN_LENGTH)
  assert.equal(encoded.sha256, GOLDEN_SHA256)
  assert.ok(encoded.text.startsWith('{"schemaVersion":"A6-PAYLOAD-1","header":{"claimId":"00000000-0000-4000-8000-000000000001","claimContractVersion":"A6-CLAIM-1",'))
  assert.ok(encoded.text.includes('"quantity":"2.5000","unitCode":"mL·µ","modifierCodes":["M2","M1"]'))
  assert.ok(encoded.text.includes('"tpaId":null,"networkId":"00000000-0000-4000-8000-000000000014","insuranceProductId":null'))
  assert.ok(encoded.text.includes('"extendedAmount":"0.00"'))
})

test('UTF-8, no BOM, no whitespace, no newline', () => {
  const { text, bytes } = encodeCanonicalPayload(golden(), 2)
  assert.notEqual(bytes[0], 0xef)
  assert.ok(!/\s/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""')))
  assert.ok(!text.endsWith('\n'))
  assert.deepEqual(Buffer.from(bytes.toString('utf8'), 'utf8'), bytes)
  assert.ok(bytes.includes(Buffer.from('mL·µ', 'utf8')))
})

test('key order, time zone and locale never change the bytes', () => {
  const base = encodeCanonicalPayload(golden(), 2)
  assert.equal(encodeCanonicalPayload(reversed(golden()) as CanonicalClaimPayloadV1, 2).sha256, base.sha256)
  const saved = process.env.TZ
  process.env.TZ = 'Pacific/Kiritimati'
  try {
    assert.equal(encodeCanonicalPayload(golden(), 2).sha256, base.sha256)
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
  assert.equal(encodeCanonicalPayload(JSON.parse(JSON.stringify(golden())), 2).sha256, base.sha256)
})

test('semantic changes always change the bytes', () => {
  const base = encodeCanonicalPayload(golden(), 2).sha256
  const variants = [
    (p: any) => (p.lines[0].quantity = '2.5001'),
    (p: any) => (p.lines[0].modifierCodes = ['M1', 'M2']),
    (p: any) => (p.lines[1].claimDiagnosisIds = [id(72)]),
    (p: any) => (p.commercial.tpaId = id(15)),
    (p: any) => (p.header.serviceDate = '2026-06-16'),
    (p: any) => (p.approval.reviewerUserId = id(132)),
  ]
  for (const mutate of variants) {
    const payload = structuredClone(golden()) as any
    mutate(payload)
    assert.notEqual(encodeCanonicalPayload(payload, 2).sha256, base)
  }
})

test('the encoder refuses unknown, missing or undefined keys and non-plain objects', () => {
  assert.equal(refusal((p) => (p.header.extra = 'x')), '$.header')
  assert.equal(refusal((p) => delete p.commercial.tpaId), '$.commercial')
  assert.equal(refusal((p) => (p.commercial.tpaId = undefined)), '$.commercial.tpaId')
  assert.equal(refusal((p) => (p.financial = new Map())), '$.financial')
  assert.equal(refusal((p) => (p.lines = { 0: p.lines[0] })), '$.lines')
})

test('the encoder refuses Number money, scientific notation, signs, wrong scale, NaN and Infinity', () => {
  assert.equal(refusal((p) => (p.financial.totalExtendedAmount = 313.13)), '$.financial.totalExtendedAmount')
  assert.equal(refusal((p) => (p.financial.totalExtendedAmount = '3.1313e2')), '$.financial.totalExtendedAmount')
  assert.equal(refusal((p) => (p.financial.totalExtendedAmount = '-0.00')), '$.financial.totalExtendedAmount')
  assert.equal(refusal((p) => (p.financial.totalExtendedAmount = '313.1')), '$.financial.totalExtendedAmount')
  assert.equal(refusal((p) => (p.financial.totalExtendedAmount = '313,13')), '$.financial.totalExtendedAmount')
  assert.equal(refusal((p) => (p.lines[0].quantity = '2.5')), '$.lines[0].quantity')
  assert.equal(refusal((p) => (p.lines[0].quantity = '02.5000')), '$.lines[0].quantity')
  assert.equal(refusal((p) => (p.lines[0].sequence = Number.NaN)), '$.lines[0].sequence')
  assert.equal(refusal((p) => (p.lines[0].sequence = Number.POSITIVE_INFINITY)), '$.lines[0].sequence')
  assert.equal(refusal((p) => (p.lines[0].sequence = -0)), '$.lines[0].sequence')
  assert.equal(refusal((p) => (p.lines[0].sequence = 1.5)), '$.lines[0].sequence')
})

test('the encoder refuses malformed identifiers, dates, text and fingerprints', () => {
  assert.equal(refusal((p) => (p.header.claimId = 'ABCDEF00-0000-4000-8000-00000000000A')), '$.header.claimId')
  assert.equal(refusal((p) => (p.header.claimId = '')), '$.header.claimId')
  assert.equal(refusal((p) => (p.header.serviceDate = '2026-02-30')), '$.header.serviceDate')
  assert.equal(refusal((p) => (p.header.serviceDate = '2026-06-15T00:00:00Z')), '$.header.serviceDate')
  assert.equal(refusal((p) => (p.header.jurisdictionCode = '')), '$.header.jurisdictionCode')
  assert.equal(refusal((p) => (p.lines[0].unitCode = '\ud800')), '$.lines[0].unitCode')
  assert.equal(refusal((p) => (p.header.draftFingerprint = FP.toUpperCase())), '$.header.draftFingerprint')
  assert.equal(refusal((p) => (p.schemaVersion = 'A6-PAYLOAD-2')), '$.schemaVersion')
})

test('the encoder refuses out-of-order positions and unsorted or duplicated reference sets', () => {
  assert.equal(refusal((p) => p.lines.reverse()), '$.lines[0].sequence')
  assert.equal(refusal((p) => (p.diagnoses[1].sequence = 3)), '$.diagnoses[1].sequence')
  assert.equal(refusal((p) => p.evidence.ruleVersionIds.reverse()), '$.evidence.ruleVersionIds')
  assert.equal(refusal((p) => (p.evidence.validationFindingIds = [id(101), id(101)])), '$.evidence.validationFindingIds')
})

test('the money scale is the currency\'s, and only 0..4 is accepted', () => {
  assert.throws(() => encodeCanonicalPayload(golden(), 4), PayloadEncodingError)
  assert.throws(() => encodeCanonicalPayload(golden(), 5), PayloadEncodingError)
  assert.throws(() => encodeCanonicalPayload(golden(), 1.5), PayloadEncodingError)
})

test('exact decimal text never rounds and never keeps a sign on zero', () => {
  const D = (value: string) => new Prisma.Decimal(value)
  assert.equal(exactDecimalText(D('2.5'), 4, 'q'), '2.5000')
  assert.equal(exactDecimalText(D('125.25'), 4, 'r'), '125.2500')
  assert.equal(exactDecimalText(D('0'), 2, 'm'), '0.00')
  assert.equal(exactDecimalText(D('-0'), 2, 'm'), '0.00')
  assert.equal(exactDecimalText(D('313.13'), 2, 'm'), '313.13')
  assert.throws(() => exactDecimalText(D('313.125'), 2, 'm'), /more precision/)
  assert.throws(() => exactDecimalText(D('-1.00'), 2, 'm'), /negative/)
  assert.throws(() => exactDecimalText(D('NaN'), 2, 'm'), /finite/)
})

test('request: exactly { draftAssessmentId, approvalDecisionId }', () => {
  assert.deepEqual(validatePreviewBody({ draftAssessmentId: id(7), approvalDecisionId: id(9) }), { ok: true, value: { draftAssessmentId: id(7), approvalDecisionId: id(9) } })
  assert.deepEqual(validatePreviewBody({ draftAssessmentId: id(7).toUpperCase(), approvalDecisionId: id(9) }), { ok: true, value: { draftAssessmentId: id(7), approvalDecisionId: id(9) } })
  for (const body of [null, [], 'x', {}, { draftAssessmentId: id(7) }, { approvalDecisionId: id(9) }, { draftAssessmentId: 'nope', approvalDecisionId: id(9) }, { draftAssessmentId: id(7), approvalDecisionId: id(9), jurisdiction: 'US' }])
    assert.equal(validatePreviewBody(body).ok, false, JSON.stringify(body))
  for (const field of ['claimId', 'payload', 'bytes', 'sha256', 'total', 'totalExtendedAmount', 'lines', 'diagnoses', 'jurisdictionCode', 'latest']) {
    const outcome = validatePreviewBody({ draftAssessmentId: id(7), approvalDecisionId: id(9), [field]: 'x' })
    assert.equal(outcome.ok, false)
    assert.match(outcome.ok ? '' : outcome.message, new RegExp(`${field} cannot be supplied`))
  }
})
