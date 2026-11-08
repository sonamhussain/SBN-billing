import test from 'node:test'
import assert from 'node:assert/strict'
import type { CanonicalClaimPayloadV1 } from '../claim-payload/claim-payload.types.ts'
import { codingSectionOf, encodeCanonicalPayloadV2, type CanonicalClaimPayloadV2, type RecordedReceipt } from '../claim-payload/claim-payload.v2.ts'
import { type FrozenReceiptFacts, verifyFrozenCoding } from './coding-validation.frozen.ts'

// CRG-01 Checkpoint B, H5 (review F05) — the frozen coding section is verified entry by entry against the immutable
// receipts: swapped receipts and every altered coding field are refused. Synthetic identifiers only; the golden
// claim is a copy of the A6.6 payload shape (no A6 test is edited).

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const FP = 'a'.repeat(64)
const MANIFEST = 'c'.repeat(64)

const claim = (): CanonicalClaimPayloadV1 => ({
  schemaVersion: 'A6-PAYLOAD-1',
  header: {
    claimId: id(1), claimContractVersion: 'A6-CLAIM-1', handoffSchemaVersion: 'PreClaimA6HandoffV2', encounterId: id(2), serviceDate: '2026-06-15', facilityId: id(3),
    facilityRegulatoryProfileId: id(4), jurisdictionCode: 'AE-DU', assessedValidationRunId: id(5), readinessAssessmentId: id(6), readinessPolicyVersion: 'A5-READY-2', draftAssessmentId: id(7),
    draftContractVersion: 'A6-DRAFT-1', draftFingerprint: FP, pricingRunId: id(8), pricingContractVersion: 'A6-PRICE-1', approvalDecisionId: id(9),
  },
  commercial: { providerContractId: id(10), tariffScheduleId: id(11), tariffScheduleVersionId: id(12), payerId: id(13), tpaId: null, networkId: id(14), insuranceProductId: null, currencyCode: 'AED' },
  lines: [
    { claimLineId: id(21), sequence: 1, encounterActivityId: id(31), serviceId: null, procedureCodeId: id(41), quantity: '1.0000', unitCode: null, modifierCodes: [], pricingLineResultId: id(51), tariffRateId: id(61), unitTariffAmount: '125.2500', extendedAmount: '125.25', currencyCode: 'AED', claimDiagnosisIds: [id(71)] },
    { claimLineId: id(22), sequence: 2, encounterActivityId: id(32), serviceId: id(42), procedureCodeId: null, quantity: '1.0000', unitCode: null, modifierCodes: [], pricingLineResultId: id(52), tariffRateId: id(62), unitTariffAmount: '12.1250', extendedAmount: '12.13', currencyCode: 'AED', claimDiagnosisIds: [id(71)] },
  ],
  diagnoses: [
    { claimDiagnosisId: id(71), sequence: 1, encounterDiagnosisId: id(81), roleCode: 'PRIMARY', diagnosisCodeId: id(91) },
    { claimDiagnosisId: id(72), sequence: 2, encounterDiagnosisId: id(82), roleCode: 'SECONDARY', diagnosisCodeId: id(92) },
  ],
  financial: { totalExtendedAmount: '137.38', currencyCode: 'AED' },
  evidence: {
    validationFindingIds: [id(101)], eligibilityVerificationIds: [], priorAuthorizationVersionIds: [], authorizationLineIds: [], evidenceRequirementIds: [], evidenceArtifactVersionIds: [],
    ruleVersionIds: [], governingSourceVersionIds: [], referenceDatasetVersionIds: [],
  },
  approval: { reviewContractVersion: 'A6-REVIEW-1', decisionId: id(9), reviewedAssessmentId: id(7), reviewFingerprint: FP, reviewerUserId: id(131) },
})

// The immutable receipts of the run: two diagnoses (ICD-10-CM) and one procedure-coded activity (CPT).
const facts = (): FrozenReceiptFacts[] => [
  { receiptId: id(901), subjectKind: 'DIAGNOSIS', targetId: id(81), masterCodeId: id(91), decisionCode: 'APPLICABLE', codeSystem: 'ICD-10-CM', referenceDatasetVersionId: id(800), membershipId: id(701), sourceRowSha256: '1'.repeat(64) },
  { receiptId: id(902), subjectKind: 'DIAGNOSIS', targetId: id(82), masterCodeId: id(92), decisionCode: 'APPLICABLE', codeSystem: 'ICD-10-CM', referenceDatasetVersionId: id(800), membershipId: id(702), sourceRowSha256: '2'.repeat(64) },
  { receiptId: id(951), subjectKind: 'PROCEDURE', targetId: id(31), masterCodeId: id(41), decisionCode: 'APPLICABLE', codeSystem: 'CPT', referenceDatasetVersionId: id(810), membershipId: id(751), sourceRowSha256: '3'.repeat(64) },
]
const byTarget = (rows: FrozenReceiptFacts[]) =>
  new Map<string, RecordedReceipt>(rows.map((r) => [r.targetId, { receiptId: r.receiptId, decisionCode: r.decisionCode, codeSystem: r.codeSystem, referenceDatasetVersionId: r.referenceDatasetVersionId, membershipId: r.membershipId, sourceRowSha256: r.sourceRowSha256 }]))
const frozenPayload = (): CanonicalClaimPayloadV2 => {
  const base = claim()
  const coding = codingSectionOf(base, MANIFEST, byTarget(facts()))
  if (!coding.ok) throw new Error(coding.detail)
  return { ...base, schemaVersion: 'A6-PAYLOAD-2', coding: coding.value }
}
const bytesOf = (payload: unknown) => encodeCanonicalPayloadV2(payload as CanonicalClaimPayloadV2, 2).bytes
const rawBytes = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8')
const refused = (bytes: Uint8Array, rows: FrozenReceiptFacts[] = facts(), manifest = MANIFEST, label = '') => {
  const verdict = verifyFrozenCoding(bytes, manifest, rows)
  assert.equal(verdict.ok, false, label)
}

test('an untampered freeze verifies entry by entry against its receipts (H5)', () => {
  assert.deepEqual(verifyFrozenCoding(bytesOf(frozenPayload()), MANIFEST, facts()), { ok: true })
})

test('swapped receipts are refused, in the frozen section and in the recorded receipts (F05)', () => {
  const p = frozenPayload()
  const [d1, d2] = p.coding.diagnoses
  const swappedEntries = { ...p, coding: { ...p.coding, diagnoses: [{ ...d1, receiptId: d2.receiptId, membershipId: d2.membershipId, sourceRowSha256: d2.sourceRowSha256 }, { ...d2, receiptId: d1.receiptId, membershipId: d1.membershipId, sourceRowSha256: d1.sourceRowSha256 }] } }
  refused(bytesOf(swappedEntries), facts(), MANIFEST, 'two frozen diagnoses swap their receipts')
  const swappedTargets = facts().map((r) => (r.receiptId === id(901) ? { ...r, targetId: id(82) } : r.receiptId === id(902) ? { ...r, targetId: id(81) } : r))
  refused(bytesOf(frozenPayload()), swappedTargets, MANIFEST, 'two recorded receipts swap their targets')
  const lineTakesDiagnosisReceipt = { ...p, coding: { ...p.coding, lines: [{ ...p.coding.lines[0], receiptId: d1.receiptId }] } }
  refused(bytesOf(lineTakesDiagnosisReceipt), facts(), MANIFEST, 'a line names a diagnosis receipt')
})

test('every altered coding field of a frozen entry is refused (F05)', () => {
  const p = frozenPayload()
  const alter = (where: 'diagnoses' | 'lines', field: string, value: string) => {
    const entries = p.coding[where].map((entry, i) => (i === 0 ? { ...entry, [field]: value } : entry))
    return bytesOf({ ...p, coding: { ...p.coding, [where]: entries } })
  }
  for (const [field, value] of [
    ['codeSystem', 'ICD-9-CM'], ['referenceDatasetVersionId', id(899)], ['membershipId', id(799)], ['sourceRowSha256', '9'.repeat(64)], ['receiptId', id(999)], ['encounterDiagnosisId', id(89)], ['claimDiagnosisId', id(79)],
  ] as const)
    refused(alter('diagnoses', field, value), facts(), MANIFEST, `diagnosis ${field}`)
  for (const [field, value] of [['codeSystem', 'HCPCS-LEVEL-II'], ['referenceDatasetVersionId', id(899)], ['membershipId', id(799)], ['sourceRowSha256', '9'.repeat(64)], ['encounterActivityId', id(39)], ['claimLineId', id(29)]] as const)
    refused(alter('lines', field, value), facts(), MANIFEST, `line ${field}`)
})

test('every recorded binding fact must match: kind, master, decision, edition, membership, source hash (F05)', () => {
  const bytes = bytesOf(frozenPayload())
  const change = (index: number, o: Partial<FrozenReceiptFacts>) => facts().map((r, i) => (i === index ? { ...r, ...o } : r))
  for (const [index, o] of [
    [0, { masterCodeId: id(92) }], [2, { masterCodeId: id(42) }], [0, { subjectKind: 'PROCEDURE' }], [2, { subjectKind: 'DIAGNOSIS' }], [0, { decisionCode: 'CODE_NOT_IN_RELEASE' }],
    [0, { codeSystem: 'CPT' }], [1, { referenceDatasetVersionId: id(811) }], [1, { membershipId: id(709) }], [2, { sourceRowSha256: '8'.repeat(64) }],
  ] as const)
    refused(bytes, change(index, o), MANIFEST, JSON.stringify(o))
})

test('coverage, order, uniqueness, manifest and shape are exact (F05)', () => {
  const p = frozenPayload()
  refused(bytesOf({ ...p, coding: { ...p.coding, diagnoses: [p.coding.diagnoses[0]] } }), facts(), MANIFEST, 'a frozen diagnosis entry missing')
  refused(bytesOf({ ...p, coding: { ...p.coding, diagnoses: [...p.coding.diagnoses].reverse() } }), facts(), MANIFEST, 'entries out of the claim order')
  refused(bytesOf(p), [...facts(), { ...facts()[0], receiptId: id(903), targetId: id(83) }], MANIFEST, 'a recorded receipt the freeze never binds')
  refused(bytesOf(p), [...facts(), { ...facts()[0] }], MANIFEST, 'a duplicated recorded receipt')
  refused(bytesOf(p), facts(), 'd'.repeat(64), 'another manifest')
  refused(rawBytes({ ...p, coding: { ...p.coding, note: 'x' } }), facts(), MANIFEST, 'an extra key in the coding section')
  refused(rawBytes({ ...p, schemaVersion: 'A6-PAYLOAD-1' }), facts(), MANIFEST, 'a V1 schema version')
  refused(Buffer.from('not json'), facts(), MANIFEST, 'bytes that are not a payload')
})
