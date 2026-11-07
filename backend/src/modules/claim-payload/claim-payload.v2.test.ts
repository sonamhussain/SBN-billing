import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { encodeCanonicalPayload, PayloadEncodingError } from './claim-payload.serializer.ts'
import type { CanonicalClaimPayloadV1 } from './claim-payload.types.ts'
import { codingSectionOf, encodeCanonicalPayloadV2, payloadSchemaV2, type CanonicalClaimPayloadV2, type RecordedReceipt } from './claim-payload.v2.ts'
import { payloadSchema } from './claim-payload.serializer.ts'

// CRG-01 Checkpoint B — A6-PAYLOAD-2: the A6-PAYLOAD-1 key order exactly, then the coding section; a separate encoder;
// the A6-PAYLOAD-1 golden vector unchanged (CRG-081–CRG-083). Synthetic identifiers only; this file copies the A6.6
// golden payload rather than editing the A6.6 test.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const FP = 'a'.repeat(64)

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


const A6_PAYLOAD_1_GOLDEN_SHA256 = '155ad44f6d1fe8d7bb17791cc809d40b74d878f01171d4c0a148df027de80685'

const applicable = (n: number): RecordedReceipt => ({ receiptId: id(900 + n), decisionCode: 'APPLICABLE', codeSystem: n < 50 ? 'ICD-10-CM' : 'CPT', referenceDatasetVersionId: id(800), membershipId: id(700 + n), sourceRowSha256: 'b'.repeat(64) })
const receipts = () => new Map<string, RecordedReceipt>([[id(81), applicable(1)], [id(82), applicable(2)], [id(31), applicable(51)]])
const v2 = (): CanonicalClaimPayloadV2 => {
  const base = golden()
  const coding = codingSectionOf(base, 'c'.repeat(64), receipts())
  if (!coding.ok) throw new Error(coding.detail)
  return { ...base, schemaVersion: 'A6-PAYLOAD-2', header: { ...base.header, handoffSchemaVersion: 'PreClaimA6HandoffV2', readinessPolicyVersion: 'A5-READY-2' }, coding: coding.value }
}
const reversed = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(reversed) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)])) : value

test('A6-PAYLOAD-1 golden vector is unchanged beside A6-PAYLOAD-2 (CRG-081)', () => {
  assert.equal(encodeCanonicalPayload(golden(), 2).sha256, A6_PAYLOAD_1_GOLDEN_SHA256)
  assert.deepEqual(payloadSchemaV2.slice(0, payloadSchema.length), payloadSchema)
  assert.equal(payloadSchemaV2[payloadSchemaV2.length - 1][0], 'coding')
})

test('the coding section binds each diagnosis and each procedure-coded line to its exact receipt (CRG-082)', () => {
  const coding = v2().coding
  assert.deepEqual(coding.diagnoses.map((d) => [d.claimDiagnosisId, d.receiptId]), [[id(71), id(901)], [id(72), id(902)]])
  assert.deepEqual(coding.lines.map((l) => [l.claimLineId, l.receiptId]), [[id(21), id(951)]])
  assert.equal(codingSectionOf(golden(), 'c'.repeat(64), new Map([[id(81), applicable(1)], [id(31), applicable(51)]])).ok, false)
  assert.equal(codingSectionOf(golden(), 'c'.repeat(64), new Map([...receipts(), [id(32), applicable(52)]])).ok, false)
  assert.equal(codingSectionOf(golden(), 'c'.repeat(64), new Map([...receipts(), [id(81), { ...applicable(1), decisionCode: 'CODE_NOT_IN_RELEASE', membershipId: null }]])).ok, false)
})

test('A6-PAYLOAD-2 is canonical, deterministic and refuses any other version or extra key (CRG-083)', () => {
  const first = encodeCanonicalPayloadV2(v2(), 2)
  for (let i = 0; i < 50; i += 1) assert.equal(encodeCanonicalPayloadV2(reversed(v2()) as CanonicalClaimPayloadV2, 2).sha256, first.sha256)
  assert.equal(first.sha256, createHash('sha256').update(first.bytes).digest('hex'))
  assert.ok(first.text.endsWith('"coding":{"manifestSha256":"' + 'c'.repeat(64) + '","diagnoses":[' + first.text.split('"diagnoses":[').pop()))
  assert.throws(() => encodeCanonicalPayloadV2({ ...v2(), schemaVersion: 'A6-PAYLOAD-1' } as unknown as CanonicalClaimPayloadV2, 2), PayloadEncodingError)
  assert.throws(() => encodeCanonicalPayloadV2({ ...v2(), extra: 1 } as unknown as CanonicalClaimPayloadV2, 2), PayloadEncodingError)
  assert.throws(() => encodeCanonicalPayload(v2() as unknown as CanonicalClaimPayloadV1, 2), PayloadEncodingError)
})
