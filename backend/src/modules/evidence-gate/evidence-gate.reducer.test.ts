import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySource } from '../evidence-classification/evidence-classification.classifier.ts'
import type { SourceFacts } from '../evidence-classification/evidence-classification.types.ts'
import { deriveReadiness, recordedReadinessAgrees } from './evidence-gate.reducer.ts'
import { readinessCodes, type ClassificationFacts } from './evidence-gate.types.ts'

// A7.3 — the pure readiness reducer. Synthetic values only.

const FP = 'c3d934c8e96c'.padEnd(64, '0')
const base: ClassificationFacts = { contractVersion: 'A7-EVIDENCE-CLASS-1', classificationCode: 'INTERNAL_DECLARATION', normalizationOutcome: 'CLASSIFIED', reasonCode: 'SYNTHETIC_INTERNAL_SOURCE', sourceFingerprintSha256: FP }
const derive = (overrides: Partial<ClassificationFacts>) => deriveReadiness({ ...base, ...overrides })
const conflict = { ok: false, refusal: 'PROVENANCE_CONFLICT' }

test('a synthetic internal declaration is NOT_READY_FOR_ADJUDICATION: no external adjudication evidence exists', () => {
  assert.deepEqual(derive({}), { ok: true, value: { readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT' } })
})

test('every controlled NEEDS_REVIEW classification requires review', () => {
  for (const [classificationCode, reasonCode] of [['EXTERNAL_SOURCE_UNVERIFIED', 'EXTERNAL_PROOF_ABSENT'], ['INSUFFICIENT_CONTEXT', 'SOURCE_CONTEXT_MISSING'], ['INSUFFICIENT_CONTEXT', 'SOURCE_CONTEXT_CONTRADICTORY']]) {
    assert.deepEqual(derive({ classificationCode, normalizationOutcome: 'NEEDS_REVIEW', reasonCode }), { ok: true, value: { readinessCode: 'SOURCE_REQUIRES_REVIEW', reasonCode: 'CLASSIFICATION_REVIEW_REQUIRED' } }, reasonCode)
  }
})

test('every controlled UNSUPPORTED classification is SOURCE_UNSUPPORTED', () => {
  for (const reasonCode of ['SOURCE_KIND_UNSUPPORTED', 'SOURCE_CONTRACT_UNSUPPORTED']) {
    assert.deepEqual(derive({ classificationCode: 'UNSUPPORTED_SOURCE', normalizationOutcome: 'UNSUPPORTED', reasonCode }), { ok: true, value: { readinessCode: 'SOURCE_UNSUPPORTED', reasonCode: 'CLASSIFICATION_UNSUPPORTED' } }, reasonCode)
  }
})

test('a forged, impossible or verified combination is a provenance conflict, never a result', () => {
  for (const overrides of [
    { classificationCode: 'EXTERNAL_SOURCE_VERIFIED' },
    { classificationCode: 'EXTERNAL_SOURCE_VERIFIED', normalizationOutcome: 'CLASSIFIED', reasonCode: 'EXTERNAL_PROOF_ABSENT' },
    { normalizationOutcome: 'NEEDS_REVIEW' },
    { classificationCode: 'INSUFFICIENT_CONTEXT', normalizationOutcome: 'CLASSIFIED', reasonCode: 'SOURCE_CONTEXT_MISSING' },
    { classificationCode: 'UNSUPPORTED_SOURCE', normalizationOutcome: 'UNSUPPORTED', reasonCode: 'SYNTHETIC_INTERNAL_SOURCE' },
    { classificationCode: 'internal_declaration' },
    { classificationCode: 'INTERNAL_DECLARATION ' },
    { normalizationOutcome: 'PAID' },
    { reasonCode: 'SYNTHETIC_INTERNAL_SOURCE|X' },
    { classificationCode: null },
    { normalizationOutcome: null },
    { reasonCode: null },
  ]) {
    assert.deepEqual(derive(overrides), conflict, JSON.stringify(overrides))
  }
})

test('another classification contract, or a missing or malformed fingerprint, is a provenance conflict', () => {
  for (const overrides of [{ contractVersion: 'A7-EVIDENCE-CLASS-2' }, { contractVersion: null }, { sourceFingerprintSha256: null }, { sourceFingerprintSha256: 'A'.repeat(64) }, { sourceFingerprintSha256: 'a'.repeat(63) }, { sourceFingerprintSha256: '' }]) {
    assert.deepEqual(derive(overrides), conflict, JSON.stringify(overrides))
  }
})

test('every result the A7.2 classifier can produce maps to a controlled readiness (parity with the owner)', () => {
  const facts: SourceFacts = {
    sourceEvidenceId: '00000000-0000-4000-8000-0000000000e1',
    organizationId: '00000000-0000-4000-8000-000000000001',
    claimSubmissionId: '00000000-0000-4000-8000-0000000000f1',
    submissionOrganizationId: '00000000-0000-4000-8000-000000000001',
    sourceKind: 'INTERNAL_SYNTHETIC',
    sourceReference: 'SYN-E1',
    sourceVersion: 'A7-REVENUE-SOURCE-1',
    sourceDigestSha256: null,
    receivedAtMicros: '1792650643051123',
  }
  const variants: Partial<SourceFacts>[] = [{}, { sourceKind: 'EXTERNAL_DECLARED' }, { sourceReference: '' }, { sourceDigestSha256: 'a'.repeat(64) }, { sourceVersion: 'A7-REVENUE-SOURCE-2' }, { sourceKind: 'PAYER_PORTAL' }]
  const seen = new Set<string>()
  for (const variant of variants) {
    const classified = classifySource({ ...facts, ...variant })
    assert.equal(classified.ok, true, JSON.stringify(variant))
    if (!classified.ok) continue
    const readiness = deriveReadiness({ contractVersion: 'A7-EVIDENCE-CLASS-1', ...classified.value, sourceFingerprintSha256: FP })
    assert.equal(readiness.ok, true, JSON.stringify(classified.value))
    if (readiness.ok) seen.add(readiness.value.readinessCode)
  }
  assert.deepEqual([...seen].sort(), [...readinessCodes].sort())
})

test('no input yields a ready, adjudicated, paid, allowed, denied, settled or balance code', () => {
  const vocabulary = ['INTERNAL_DECLARATION', 'EXTERNAL_SOURCE_UNVERIFIED', 'EXTERNAL_SOURCE_VERIFIED', 'INSUFFICIENT_CONTEXT', 'UNSUPPORTED_SOURCE', 'CLASSIFIED', 'NEEDS_REVIEW', 'UNSUPPORTED', 'SYNTHETIC_INTERNAL_SOURCE', 'EXTERNAL_PROOF_ABSENT', 'SOURCE_CONTEXT_MISSING', 'SOURCE_CONTEXT_CONTRADICTORY', 'SOURCE_KIND_UNSUPPORTED', 'SOURCE_CONTRACT_UNSUPPORTED']
  for (const classificationCode of vocabulary) for (const normalizationOutcome of vocabulary) for (const reasonCode of vocabulary) {
    const result = derive({ classificationCode, normalizationOutcome, reasonCode })
    if (result.ok) assert.doesNotMatch(JSON.stringify(result.value), /(^|[^_])READY_FOR|ADJUDICATED|PAID|ALLOWED|DENIED|SETTLED|REMITTED|BALANCE/)
  }
})

test('the reducer is deterministic and ignores the time zone and locale', () => {
  const runs = Array.from({ length: 20 }, () => JSON.stringify(derive({})))
  assert.equal(new Set(runs).size, 1)
})

test('a recorded result agrees only when every derived value matches exactly', () => {
  const derived = { readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', classificationFingerprintSha256: FP, sourceEvidenceId: 'E1', organizationId: 'O1' }
  assert.equal(recordedReadinessAgrees({ ...derived }, derived), true)
  for (const change of [{ readinessCode: 'SOURCE_UNSUPPORTED' }, { reasonCode: 'CLASSIFICATION_UNSUPPORTED' }, { classificationFingerprintSha256: 'f'.repeat(64) }, { sourceEvidenceId: 'E2' }, { organizationId: 'O2' }]) {
    assert.equal(recordedReadinessAgrees({ ...derived, ...change }, derived), false, JSON.stringify(change))
  }
})
