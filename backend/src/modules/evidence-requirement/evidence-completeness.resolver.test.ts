import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyCandidate, evaluateRequirement, freshnessThreshold, type PoolEvidence, type RequirementSpec } from './evidence-completeness.resolver.ts'

// A5.6 — the pure classification and completeness rules. Synthetic identifiers only.

const d = (value: string) => new Date(`${value}T00:00:00.000Z`)
const SERVICE_DATE = d('2026-06-15')
let serial = 0
const evidence = (overrides: Partial<PoolEvidence> = {}): PoolEvidence => ({
  id: `aaaaaaaa-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
  documentType: 'SYNTHETIC_REPORT',
  sourceDate: d('2026-06-01'),
  ...overrides,
})
const spec = (overrides: Partial<RequirementSpec> = {}): RequirementSpec => ({
  acceptedDocumentTypes: ['SYNTHETIC_REPORT'],
  minimumCount: 1,
  sourceDateRequired: false,
  maxSourceAgeDays: null,
  ...overrides,
})

test('the freshness threshold is calendar days before the service date', () => {
  assert.equal(freshnessThreshold(SERVICE_DATE, 30).toISOString().slice(0, 10), '2026-05-16')
  assert.equal(freshnessThreshold(SERVICE_DATE, 0).toISOString().slice(0, 10), '2026-06-15')
})

test('a missing source date is VALID unless one is required', () => {
  assert.equal(classifyCandidate(evidence({ sourceDate: null }), spec(), SERVICE_DATE), 'VALID')
  assert.equal(classifyCandidate(evidence({ sourceDate: null }), spec({ sourceDateRequired: true }), SERVICE_DATE), 'INVALID')
})

test('the stale threshold is inclusive', () => {
  const rule = spec({ sourceDateRequired: true, maxSourceAgeDays: 30 })
  assert.equal(classifyCandidate(evidence({ sourceDate: d('2026-05-16') }), rule, SERVICE_DATE), 'VALID')
  assert.equal(classifyCandidate(evidence({ sourceDate: d('2026-05-15') }), rule, SERVICE_DATE), 'STALE')
  assert.equal(classifyCandidate(evidence({ sourceDate: d('2026-06-10') }), rule, SERVICE_DATE), 'VALID')
})

test('a source date after the service date is never made stale by the age rule', () => {
  assert.equal(classifyCandidate(evidence({ sourceDate: d('2026-07-01') }), spec({ sourceDateRequired: true, maxSourceAgeDays: 0 }), SERVICE_DATE), 'VALID')
})

test('a zero-day limit accepts only the service date itself or later', () => {
  const rule = spec({ sourceDateRequired: true, maxSourceAgeDays: 0 })
  assert.equal(classifyCandidate(evidence({ sourceDate: SERVICE_DATE }), rule, SERVICE_DATE), 'VALID')
  assert.equal(classifyCandidate(evidence({ sourceDate: d('2026-06-14') }), rule, SERVICE_DATE), 'STALE')
})

test('the document type matches exactly, case included', () => {
  const result = evaluateRequirement(spec(), [evidence({ documentType: 'synthetic_report' }), evidence({ documentType: 'SYNTHETIC_REPORT ' })], SERVICE_DATE)
  assert.equal(result.state, 'MISSING')
  assert.equal(result.totalCandidateCount, 0)
})

test('several accepted types are alternatives', () => {
  const result = evaluateRequirement(spec({ acceptedDocumentTypes: ['A', 'B'] }), [evidence({ documentType: 'B' })], SERVICE_DATE)
  assert.equal(result.state, 'SATISFIED')
})

test('no candidate is MISSING', () => {
  assert.equal(evaluateRequirement(spec(), [], SERVICE_DATE).state, 'MISSING')
  assert.equal(evaluateRequirement(spec(), [evidence({ documentType: 'OTHER' })], SERVICE_DATE).state, 'MISSING')
})

test('one valid candidate satisfies a minimum of one', () => {
  const only = evidence()
  const result = evaluateRequirement(spec(), [only], SERVICE_DATE)
  assert.equal(result.state, 'SATISFIED')
  assert.deepEqual(result.validEvidenceArtifactVersionIds, [only.id])
})

test('a minimum above one needs that many distinct valid versions', () => {
  const two = [evidence(), evidence()]
  assert.equal(evaluateRequirement(spec({ minimumCount: 2 }), two, SERVICE_DATE).state, 'SATISFIED')
  assert.equal(evaluateRequirement(spec({ minimumCount: 3 }), two, SERVICE_DATE).state, 'INCOMPLETE')
})

test('the same exact version referenced twice counts once', () => {
  const once = evidence()
  const result = evaluateRequirement(spec({ minimumCount: 2 }), [once, { ...once }], SERVICE_DATE)
  assert.equal(result.validCount, 1)
  assert.equal(result.state, 'INCOMPLETE')
})

test('invalid-only and stale-only candidates are INCOMPLETE with their counts', () => {
  const rule = spec({ sourceDateRequired: true, maxSourceAgeDays: 30 })
  const invalidOnly = evaluateRequirement(rule, [evidence({ sourceDate: null })], SERVICE_DATE)
  assert.deepEqual([invalidOnly.state, invalidOnly.invalidCount, invalidOnly.staleCount], ['INCOMPLETE', 1, 0])
  const staleOnly = evaluateRequirement(rule, [evidence({ sourceDate: d('2025-01-01') })], SERVICE_DATE)
  assert.deepEqual([staleOnly.state, staleOnly.invalidCount, staleOnly.staleCount], ['INCOMPLETE', 0, 1])
})

test('mixed defects keep both counts, with no invented priority', () => {
  const rule = spec({ sourceDateRequired: true, maxSourceAgeDays: 30 })
  const result = evaluateRequirement(rule, [evidence({ sourceDate: null }), evidence({ sourceDate: d('2025-01-01') })], SERVICE_DATE)
  assert.deepEqual([result.state, result.validCount, result.invalidCount, result.staleCount, result.totalCandidateCount], ['INCOMPLETE', 0, 1, 1, 2])
})

test('a satisfied requirement still reports its defective candidates', () => {
  const rule = spec({ sourceDateRequired: true, maxSourceAgeDays: 30 })
  const result = evaluateRequirement(rule, [evidence(), evidence({ sourceDate: null }), evidence({ sourceDate: d('2025-01-01') })], SERVICE_DATE)
  assert.deepEqual([result.state, result.validCount, result.invalidCount, result.staleCount], ['SATISFIED', 1, 1, 1])
})

test('id arrays are sorted and independent of pool order', () => {
  const pool = [evidence(), evidence(), evidence({ sourceDate: null })]
  const rule = spec({ sourceDateRequired: true })
  const forward = evaluateRequirement(rule, pool, SERVICE_DATE)
  assert.deepEqual(evaluateRequirement(rule, [...pool].reverse(), SERVICE_DATE), forward)
  assert.deepEqual(forward.validEvidenceArtifactVersionIds, [...forward.validEvidenceArtifactVersionIds].sort())
})

test('the result carries no validation outcome or readiness field', () => {
  const text = JSON.stringify(evaluateRequirement(spec(), [evidence()], SERVICE_DATE))
  for (const forbidden of ['PASS', 'WARNING', 'RESTRICT', 'FAIL', 'ready', 'submission']) assert.equal(text.includes(forbidden), false, forbidden)
})
