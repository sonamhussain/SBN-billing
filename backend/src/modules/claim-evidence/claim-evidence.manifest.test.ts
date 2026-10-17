import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { CanonicalClaimPayloadV1 } from '../claim-payload/claim-payload.types.ts'
import { packageSealSha256, SEAL_DOMAIN, SealInputError, uuidBytes } from './claim-evidence.hash.ts'
import { buildEvidenceManifest, encodeEvidenceManifest, evidenceReferencesFromPayload, EvidenceIncompleteError, ManifestEncodingError } from './claim-evidence.manifest.ts'
import { evidenceReferenceKinds, evidenceRoleOf, type EvidenceManifestV1, type OwnerVersionFacts } from './claim-evidence.types.ts'

// A6.7 — the A6-EVIDENCE-1 manifest, its strict encoder and the A6-SUBMISSION-1 seal. Synthetic
// identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const HASH = 'c'.repeat(64)
const PAYLOAD_SHA = 'b'.repeat(64)

// A synthetic approved payload: two lines (out of id order), two diagnoses and one reference of each A5.9
// kind; the dataset list repeats nothing (the composer already sorts and deduplicates).
const payload = (): CanonicalClaimPayloadV1 => ({
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
    draftFingerprint: 'a'.repeat(64),
    pricingRunId: id(8),
    pricingContractVersion: 'A6-PRICE-1',
    approvalDecisionId: id(9),
  },
  commercial: { providerContractId: id(10), tariffScheduleId: id(11), tariffScheduleVersionId: id(12), payerId: id(13), tpaId: null, networkId: null, insuranceProductId: null, currencyCode: 'AED' },
  lines: [
    { claimLineId: id(21), sequence: 1, encounterActivityId: id(32), serviceId: id(40), procedureCodeId: null, quantity: '1.0000', unitCode: null, modifierCodes: [], pricingLineResultId: id(52), tariffRateId: id(60), unitTariffAmount: '10.0000', extendedAmount: '10.00', currencyCode: 'AED', claimDiagnosisIds: [id(71)] },
    { claimLineId: id(22), sequence: 2, encounterActivityId: id(31), serviceId: id(40), procedureCodeId: null, quantity: '1.0000', unitCode: null, modifierCodes: [], pricingLineResultId: id(51), tariffRateId: id(60), unitTariffAmount: '10.0000', extendedAmount: '10.00', currencyCode: 'AED', claimDiagnosisIds: [id(71)] },
  ],
  diagnoses: [
    { claimDiagnosisId: id(71), sequence: 1, encounterDiagnosisId: id(82), roleCode: 'PRINCIPAL', diagnosisCodeId: id(90) },
    { claimDiagnosisId: id(72), sequence: 2, encounterDiagnosisId: id(81), roleCode: 'SECONDARY', diagnosisCodeId: id(91) },
  ],
  financial: { totalExtendedAmount: '20.00', currencyCode: 'AED' },
  evidence: {
    validationFindingIds: [id(101), id(102)],
    eligibilityVerificationIds: [id(111)],
    priorAuthorizationVersionIds: [id(121)],
    authorizationLineIds: [id(131)],
    evidenceRequirementIds: [id(141)],
    evidenceArtifactVersionIds: [id(151)],
    ruleVersionIds: [id(161), id(162)],
    governingSourceVersionIds: [id(171)],
    referenceDatasetVersionIds: [id(181)],
  },
  approval: { reviewContractVersion: 'A6-REVIEW-1', decisionId: id(9), reviewedAssessmentId: id(7), reviewFingerprint: 'a'.repeat(64), reviewerUserId: id(99) },
})

// The owners' parents: two rule versions of the same rule, each other version its own parent.
const owners = (): OwnerVersionFacts => ({
  priorAuthorizationOfVersion: new Map([[id(121), id(120)]]),
  evidenceArtifactOfVersion: new Map([[id(151), { evidenceArtifactId: id(150), contentHash: HASH }]]),
  ruleOfVersion: new Map([
    [id(161), id(160)],
    [id(162), id(160)],
  ]),
  sourceOfVersion: new Map([[id(171), id(170)]]),
  datasetOfVersion: new Map([[id(181), id(180)]]),
})

const identity = { claimId: id(1), draftAssessmentId: id(7), approvalReviewEventId: id(9), pricingRunId: id(8) }
const manifestOf = () => buildEvidenceManifest(identity, PAYLOAD_SHA, evidenceReferencesFromPayload(payload(), owners()))

test('the manifest names exactly the payload references, in kind order then reference and version id', () => {
  const entries = manifestOf().entries
  assert.deepEqual(
    entries.map((entry) => [entry.ordinal, entry.referenceKind, entry.referenceId, entry.referenceVersionId]),
    [
      [1, 'VALIDATION_RUN', id(5), null],
      [2, 'READINESS_ASSESSMENT', id(6), null],
      [3, 'VALIDATION_FINDING', id(101), null],
      [4, 'VALIDATION_FINDING', id(102), null],
      [5, 'ENCOUNTER_ACTIVITY', id(31), null],
      [6, 'ENCOUNTER_ACTIVITY', id(32), null],
      [7, 'ENCOUNTER_DIAGNOSIS', id(81), null],
      [8, 'ENCOUNTER_DIAGNOSIS', id(82), null],
      [9, 'ELIGIBILITY_VERIFICATION', id(111), null],
      [10, 'PRIOR_AUTHORIZATION_VERSION', id(120), id(121)],
      [11, 'AUTHORIZATION_LINE', id(131), null],
      [12, 'EVIDENCE_REQUIREMENT', id(141), null],
      [13, 'EVIDENCE_ARTIFACT_VERSION', id(150), id(151)],
      [14, 'RULE_VERSION', id(160), id(161)],
      [15, 'RULE_VERSION', id(160), id(162)],
      [16, 'RULE_SOURCE_VERSION', id(170), id(171)],
      [17, 'REFERENCE_DATASET_VERSION', id(180), id(181)],
      [18, 'PRICING_RUN', id(8), null],
      [19, 'PRICING_LINE_RESULT', id(51), null],
      [20, 'PRICING_LINE_RESULT', id(52), null],
      [21, 'DRAFT_ASSESSMENT', id(7), null],
      [22, 'REVIEW_EVENT', id(9), null],
    ],
  )
  assert.ok(entries.every((entry) => entry.evidenceRole === evidenceRoleOf[entry.referenceKind]))
  assert.deepEqual(
    entries.filter((entry) => entry.contentHash !== null).map((entry) => [entry.referenceKind, entry.contentHash]),
    [['EVIDENCE_ARTIFACT_VERSION', HASH]],
  )
})

test('the kind vocabulary has seventeen kinds, each with one role', () => {
  assert.equal(evidenceReferenceKinds.length, 17)
  assert.equal(new Set(evidenceReferenceKinds).size, 17)
  assert.deepEqual(Object.keys(evidenceRoleOf).sort(), [...evidenceReferenceKinds].sort())
})

test('the order and bytes do not depend on input order, and exact duplicates collapse', () => {
  const references = evidenceReferencesFromPayload(payload(), owners())
  const shuffled = [...references].reverse().concat(references.slice(0, 3))
  assert.equal(encodeEvidenceManifest(buildEvidenceManifest(identity, PAYLOAD_SHA, shuffled)).text, encodeEvidenceManifest(manifestOf()).text)
})

test('a missing owner version or a non-SHA-256 artifact hash is incomplete evidence, never a substitute', () => {
  for (const key of ['priorAuthorizationOfVersion', 'evidenceArtifactOfVersion', 'ruleOfVersion', 'sourceOfVersion', 'datasetOfVersion'] as const) {
    const facts = { ...owners(), [key]: new Map() }
    assert.throws(() => evidenceReferencesFromPayload(payload(), facts), EvidenceIncompleteError, key)
  }
  for (const contentHash of ['C'.repeat(64), 'c'.repeat(63), 'not-a-hash', '']) {
    const facts = { ...owners(), evidenceArtifactOfVersion: new Map([[id(151), { evidenceArtifactId: id(150), contentHash }]]) }
    assert.throws(() => evidenceReferencesFromPayload(payload(), facts), EvidenceIncompleteError, contentHash)
  }
})

test('the same reference with two different hashes is refused', () => {
  const references = evidenceReferencesFromPayload(payload(), owners())
  const artifact = references.find((reference) => reference.referenceKind === 'EVIDENCE_ARTIFACT_VERSION')
  assert.ok(artifact)
  assert.throws(() => buildEvidenceManifest(identity, PAYLOAD_SHA, [...references, { ...artifact, contentHash: 'd'.repeat(64) }]), ManifestEncodingError)
})

test('the canonical bytes are compact UTF-8 JSON in the fixed key order', () => {
  const encoded = encodeEvidenceManifest(manifestOf())
  assert.ok(
    encoded.text.startsWith(
      `{"schemaVersion":"A6-EVIDENCE-1","claimId":"${id(1)}","draftAssessmentId":"${id(7)}","approvalReviewEventId":"${id(9)}","pricingRunId":"${id(8)}","payloadSha256":"${PAYLOAD_SHA}","entries":[{"ordinal":1,"referenceKind":"VALIDATION_RUN","referenceId":"${id(5)}","referenceVersionId":null,"contentHash":null,"evidenceRole":"VALIDATION_BASIS"},`,
    ),
  )
  assert.ok(encoded.text.endsWith(`{"ordinal":22,"referenceKind":"REVIEW_EVENT","referenceId":"${id(9)}","referenceVersionId":null,"contentHash":null,"evidenceRole":"HUMAN_APPROVAL"}]}`))
  assert.ok(!/\s/.test(encoded.text))
  assert.deepEqual(JSON.parse(encoded.text), manifestOf())
  assert.equal(encoded.bytes.toString('utf8'), encoded.text)
  assert.equal(encoded.sha256, createHash('sha256').update(encoded.bytes).digest('hex'))
})

test('golden vector: the synthetic manifest always encodes to the same digest', () => {
  const encoded = encodeEvidenceManifest(manifestOf())
  assert.equal(encoded.bytes.length, 4669)
  assert.equal(encoded.sha256, '3b536af22db9f3e8f4c76d4404a5413c510075b00a6445751ce4967aeb2f615b')
})

test('the encoder refuses anything that is not an exact A6-EVIDENCE-1 manifest', () => {
  const broken: [string, (manifest: EvidenceManifestV1) => unknown][] = [
    ['unknown key', (manifest) => ({ ...manifest, extra: 1 })],
    ['missing key', ({ payloadSha256: _omitted, ...rest }) => rest],
    ['wrong schema version', (manifest) => ({ ...manifest, schemaVersion: 'A6-EVIDENCE-2' })],
    ['uppercase claim id', (manifest) => ({ ...manifest, claimId: 'ABCDEF00-0000-4000-8000-000000000001' })],
    ['printed digest not hex', (manifest) => ({ ...manifest, payloadSha256: 'B'.repeat(64) })],
    ['ordinal gap', (manifest) => ({ ...manifest, entries: manifest.entries.map((entry, index) => (index === 3 ? { ...entry, ordinal: 9 } : entry)) })],
    ['out of order', (manifest) => ({ ...manifest, entries: [manifest.entries[1], manifest.entries[0], ...manifest.entries.slice(2)].map((entry, index) => ({ ...entry, ordinal: index + 1 })) })],
    ['duplicate', (manifest) => ({ ...manifest, entries: [manifest.entries[0], ...manifest.entries].map((entry, index) => ({ ...entry, ordinal: index + 1 })) })],
    ['unknown kind', (manifest) => ({ ...manifest, entries: manifest.entries.map((entry, index) => (index === 0 ? { ...entry, referenceKind: 'PAYER_RECEIPT' } : entry)) })],
    ['wrong role', (manifest) => ({ ...manifest, entries: manifest.entries.map((entry, index) => (index === 0 ? { ...entry, evidenceRole: 'HUMAN_APPROVAL' } : entry)) })],
    ['version on a plain kind', (manifest) => ({ ...manifest, entries: manifest.entries.map((entry, index) => (index === 0 ? { ...entry, referenceVersionId: id(500) } : entry)) })],
    ['no version on a versioned kind', (manifest) => ({ ...manifest, entries: manifest.entries.map((entry) => (entry.referenceKind === 'RULE_SOURCE_VERSION' ? { ...entry, referenceVersionId: null } : entry)) })],
    ['hash on a plain kind', (manifest) => ({ ...manifest, entries: manifest.entries.map((entry, index) => (index === 0 ? { ...entry, contentHash: HASH } : entry)) })],
    ['no hash on an artifact version', (manifest) => ({ ...manifest, entries: manifest.entries.map((entry) => (entry.referenceKind === 'EVIDENCE_ARTIFACT_VERSION' ? { ...entry, contentHash: null } : entry)) })],
    ['undefined entry field', (manifest) => ({ ...manifest, entries: manifest.entries.map((entry, index) => (index === 0 ? { ...entry, contentHash: undefined } : entry)) })],
  ]
  for (const [label, mutate] of broken) assert.throws(() => encodeEvidenceManifest(mutate(manifestOf()) as EvidenceManifestV1), ManifestEncodingError, label)
})

test('seal: domain-separated SHA-256 over the 32-byte digests and the 16-byte ids', () => {
  const manifestSha = 'd'.repeat(64)
  const expected = createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from('SBN-A6-SUBMISSION-1\n', 'utf8'),
        Buffer.from(PAYLOAD_SHA, 'hex'),
        Buffer.from(manifestSha, 'hex'),
        ...[id(1), id(7), id(9), id(8)].map((value) => Buffer.from(value.replaceAll('-', ''), 'hex')),
      ]),
    )
    .digest('hex')
  assert.equal(SEAL_DOMAIN, 'SBN-A6-SUBMISSION-1\n')
  assert.equal(packageSealSha256(PAYLOAD_SHA, manifestSha, identity), expected)
  assert.equal(packageSealSha256(PAYLOAD_SHA, manifestSha, identity), 'a30a418a5e4dbbaa391609e2986723fe56e7429dde84567475edb71517d2eb4b')
  assert.equal(uuidBytes(id(1)).length, 16)
})

test('seal: every input changes the seal, and nothing but exact digests and ids is accepted', () => {
  const manifestSha = 'd'.repeat(64)
  const base = packageSealSha256(PAYLOAD_SHA, manifestSha, identity)
  assert.notEqual(packageSealSha256('e'.repeat(64), manifestSha, identity), base)
  assert.notEqual(packageSealSha256(PAYLOAD_SHA, 'e'.repeat(64), identity), base)
  for (const key of ['claimId', 'draftAssessmentId', 'approvalReviewEventId', 'pricingRunId'] as const) assert.notEqual(packageSealSha256(PAYLOAD_SHA, manifestSha, { ...identity, [key]: id(999) }), base, key)
  // Swapping two ids changes the seal: positions are part of the contract.
  assert.notEqual(packageSealSha256(PAYLOAD_SHA, manifestSha, { ...identity, claimId: identity.pricingRunId, pricingRunId: identity.claimId }), base)
  assert.throws(() => packageSealSha256(PAYLOAD_SHA.toUpperCase(), manifestSha, identity), SealInputError)
  assert.throws(() => packageSealSha256(PAYLOAD_SHA, manifestSha, { ...identity, claimId: 'ABCDEF00-0000-4000-8000-000000000001' }), SealInputError)
})
