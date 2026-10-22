import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySource, recordedClassificationAgrees, sourceFingerprintSha256, sourceFingerprintText } from './evidence-classification.classifier.ts'
import type { SourceFacts } from './evidence-classification.types.ts'

// A7.2 — the pure classifier and fingerprint. Synthetic identifiers only.

const ORG = '00000000-0000-4000-8000-000000000001'
const base: SourceFacts = {
  sourceEvidenceId: '00000000-0000-4000-8000-0000000000e1',
  organizationId: ORG,
  claimSubmissionId: '00000000-0000-4000-8000-0000000000f1',
  submissionOrganizationId: ORG,
  sourceKind: 'INTERNAL_SYNTHETIC',
  sourceReference: 'SYN-E1',
  sourceVersion: 'A7-REVENUE-SOURCE-1',
  sourceDigestSha256: null,
  receivedAtMicros: '1792650643051123',
}
const classify = (overrides: Partial<SourceFacts>) => classifySource({ ...base, ...overrides })

test('INTERNAL_SYNTHETIC with exact facts is an internal declaration, never external verification', () => {
  assert.deepEqual(classify({}), { ok: true, value: { classificationCode: 'INTERNAL_DECLARATION', normalizationOutcome: 'CLASSIFIED', reasonCode: 'SYNTHETIC_INTERNAL_SOURCE' } })
})

test('a claim of external verification is refused, whatever else is true', () => {
  assert.deepEqual(classify({ sourceKind: 'EXTERNAL_VERIFIED' }), { ok: false, refusal: 'EXTERNAL_VERIFICATION_UNPROVEN' })
  assert.deepEqual(classify({ sourceKind: 'EXTERNAL_VERIFIED', sourceVersion: null }), { ok: false, refusal: 'EXTERNAL_VERIFICATION_UNPROVEN' })
})

test('a declared external source without proof needs review', () => {
  assert.deepEqual(classify({ sourceKind: 'EXTERNAL_DECLARED' }), { ok: true, value: { classificationCode: 'EXTERNAL_SOURCE_UNVERIFIED', normalizationOutcome: 'NEEDS_REVIEW', reasonCode: 'EXTERNAL_PROOF_ABSENT' } })
})

test('every missing required fact fails closed as SOURCE_CONTEXT_MISSING', () => {
  for (const field of ['sourceEvidenceId', 'organizationId', 'claimSubmissionId', 'submissionOrganizationId', 'sourceKind', 'sourceReference', 'sourceVersion', 'receivedAtMicros'] as const) {
    for (const value of [null, '']) {
      const result = classify({ [field]: value })
      assert.ok(result.ok && result.value.reasonCode === 'SOURCE_CONTEXT_MISSING' && result.value.normalizationOutcome === 'NEEDS_REVIEW', `${field}=${value}`)
    }
  }
})

test('contradictory facts fail closed as SOURCE_CONTEXT_CONTRADICTORY', () => {
  for (const overrides of [
    { submissionOrganizationId: '00000000-0000-4000-8000-000000000002' },
    { sourceEvidenceId: 'NOT-A-UUID' },
    { claimSubmissionId: base.claimSubmissionId!.toUpperCase() },
    { receivedAtMicros: '2026-10-22T00:00:00Z' },
    { sourceDigestSha256: 'a'.repeat(64) },
  ]) {
    const result = classify(overrides)
    assert.ok(result.ok && result.value.classificationCode === 'INSUFFICIENT_CONTEXT' && result.value.reasonCode === 'SOURCE_CONTEXT_CONTRADICTORY', JSON.stringify(overrides))
  }
})

test('an unsupported contract or kind is UNSUPPORTED, never a guessed mapping', () => {
  assert.deepEqual(classify({ sourceVersion: 'A7-REVENUE-SOURCE-2' }), { ok: true, value: { classificationCode: 'UNSUPPORTED_SOURCE', normalizationOutcome: 'UNSUPPORTED', reasonCode: 'SOURCE_CONTRACT_UNSUPPORTED' } })
  for (const sourceKind of ['internal_synthetic', 'PAYER_REMITTANCE', 'MANUAL']) {
    assert.deepEqual(classify({ sourceKind }), { ok: true, value: { classificationCode: 'UNSUPPORTED_SOURCE', normalizationOutcome: 'UNSUPPORTED', reasonCode: 'SOURCE_KIND_UNSUPPORTED' } }, sourceKind)
  }
})

test('no input ever yields EXTERNAL_SOURCE_VERIFIED or a paid/denied/accepted label', () => {
  const kinds = ['INTERNAL_SYNTHETIC', 'EXTERNAL_DECLARED', 'EXTERNAL_VERIFIED', 'X', null]
  const versions = ['A7-REVENUE-SOURCE-1', 'A7-REVENUE-SOURCE-2', null]
  for (const sourceKind of kinds)
    for (const sourceVersion of versions) {
      const text = JSON.stringify(classify({ sourceKind, sourceVersion }))
      assert.ok(!/EXTERNAL_SOURCE_VERIFIED|PAID|DENIED|ACCEPTED/.test(text), text)
    }
})

test('the classifier is deterministic and ignores the time zone and locale', () => {
  const first = JSON.stringify(classify({}))
  process.env.TZ = 'America/New_York'
  assert.equal(JSON.stringify(classify({})), first)
  process.env.TZ = 'Asia/Dubai'
  assert.equal(JSON.stringify(classify({})), first)
})

test('the fingerprint text is exact and its digest is stable', () => {
  assert.equal(
    sourceFingerprintText(base),
    'SBN-A7-EVIDENCE-CLASS-1\ncontract=A7-EVIDENCE-CLASS-1\nsourceEvidenceId=00000000-0000-4000-8000-0000000000e1\nsourceKind=INTERNAL_SYNTHETIC\nsourceReference=SYN-E1\nsourceVersion=A7-REVENUE-SOURCE-1\nclaimSubmissionId=00000000-0000-4000-8000-0000000000f1\nreceivedAtMicros=1792650643051123\n',
  )
  assert.equal(sourceFingerprintSha256(base), sourceFingerprintSha256({ ...base }))
  assert.match(sourceFingerprintSha256(base), /^[0-9a-f]{64}$/)
})

test('each fingerprint field changes the digest, and a missing or non-canonical field is refused', () => {
  const digest = sourceFingerprintSha256(base)
  for (const overrides of [{ sourceEvidenceId: '00000000-0000-4000-8000-0000000000e2' }, { sourceReference: 'SYN-E2' }, { claimSubmissionId: '00000000-0000-4000-8000-0000000000f2' }, { receivedAtMicros: '1792650643051124' }]) {
    assert.notEqual(sourceFingerprintSha256({ ...base, ...overrides }), digest, JSON.stringify(overrides))
  }
  assert.throws(() => sourceFingerprintText({ ...base, sourceReference: null }))
  assert.throws(() => sourceFingerprintText({ ...base, sourceReference: 'A\nB' }))
  assert.throws(() => sourceFingerprintText({ ...base, sourceReference: 'A=B' }))
})

test('a recorded classification agrees only when every derived value matches exactly', () => {
  const derived = { classificationCode: 'INTERNAL_DECLARATION', normalizationOutcome: 'CLASSIFIED', reasonCode: 'SYNTHETIC_INTERNAL_SOURCE', sourceFingerprintSha256: sourceFingerprintSha256(base), organizationId: ORG }
  assert.equal(recordedClassificationAgrees({ ...derived }, derived), true)
  for (const change of [{ classificationCode: 'EXTERNAL_SOURCE_UNVERIFIED' }, { normalizationOutcome: 'NEEDS_REVIEW' }, { reasonCode: 'EXTERNAL_PROOF_ABSENT' }, { sourceFingerprintSha256: '0'.repeat(64) }, { organizationId: '00000000-0000-4000-8000-000000000002' }]) {
    assert.equal(recordedClassificationAgrees({ ...derived, ...change }, derived), false, JSON.stringify(change))
  }
})
