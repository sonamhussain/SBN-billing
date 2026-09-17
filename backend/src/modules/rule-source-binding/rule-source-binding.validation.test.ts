import test from 'node:test'
import assert from 'node:assert/strict'
import {
  executabilityBlockerCodes,
  isExecutabilityBlockerCode,
  isRuleSourceBindingUuid,
  isSourceRole,
  normalizeSourceRole,
  toExecutabilityBlockerCodes,
} from './rule-source-binding.validation.ts'
import { evaluateActivationBlockers } from '../rule-source-version/rule-source-version.activation.ts'

test('UUID shape is accepted', () => {
  assert.equal(isRuleSourceBindingUuid('550e8400-e29b-41d4-a716-446655440000'), true)
})

test('invalid UUID rejected', () => {
  assert.equal(isRuleSourceBindingUuid('not-a-uuid'), false)
})

test('GOVERNING and SUPPORTING are recognized source roles', () => {
  assert.equal(isSourceRole('GOVERNING'), true)
  assert.equal(isSourceRole('SUPPORTING'), true)
})

test('unknown source role rejected', () => {
  assert.equal(isSourceRole('MADE_UP'), false)
})

test('normalizeSourceRole trims and validates', () => {
  assert.equal(normalizeSourceRole('  GOVERNING  '), 'GOVERNING')
})

test('normalizeSourceRole rejects invalid value', () => {
  assert.equal(normalizeSourceRole('NOT_A_ROLE'), null)
})

test('normalizeSourceRole rejects non-string', () => {
  assert.equal(normalizeSourceRole(42), null)
})

test('all 15 A3.7/REF-01 blocker codes are recognized', () => {
  const codes = [
    'RULE_UNVERIFIED',
    'RULE_NOT_EFFECTIVE',
    'APPLICABILITY_MISMATCH',
    'MISSING_GOVERNING_SOURCE',
    'SOURCE_NOT_ACTIVE',
    'AUTHORITY_UNVERIFIED',
    'INTERPRETATION_UNVERIFIED',
    'SOURCE_NOT_EFFECTIVE',
    'SOURCE_NOT_PUBLISHED',
    'DEPENDENCY_UNRESOLVED',
    'SOURCE_CONFLICT',
    'JURISDICTION_INCOMPATIBLE',
    'OWNERSHIP_MISMATCH',
    'SOURCE_EFFECT_INCOMPATIBLE',
    'SOURCE_CONTEXT_INCOMPATIBLE',
  ]
  for (const code of codes) assert.equal(isExecutabilityBlockerCode(code), true, code)
})

test('unrelated blocker code is not an A3.7 code', () => {
  assert.equal(isExecutabilityBlockerCode('CONTRADICTORY_DATES'), false)
  assert.equal(isExecutabilityBlockerCode('EFFECTIVE_DATE_INCOMPLETE'), false)
})

// --- A3.7 effective-date gate correction ------------------------------------------------------

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

// An otherwise fully valid source version, evaluated exactly as A3.7's gate evaluates it.
function liveBlockersFor(effectiveFrom: Date | null, effectiveTo: Date | null): string[] {
  return evaluateActivationBlockers(
    { publicationStatus: 'PUBLISHED', effectiveFrom, effectiveTo, verificationStatus: 'VERIFIED' },
    { jurisdictionCode: 'AE-DU', organizationId: 'org-1' },
    [{ verificationStatus: 'VERIFIED' }],
    { businessDate: d('2026-10-15'), jurisdictionCode: 'AE-DU', requestingOrganizationId: 'org-1' },
    { hasUnresolvedDependency: false, hasConflict: false },
  )
}

test('date gate: missing effectiveFrom raises only EFFECTIVE_DATE_INCOMPLETE upstream (the case that slipped through)', () => {
  assert.deepEqual(liveBlockersFor(null, null), ['EFFECTIVE_DATE_INCOMPLETE'])
})

test('date gate: missing effectiveFrom now blocks with SOURCE_NOT_EFFECTIVE', () => {
  assert.deepEqual(toExecutabilityBlockerCodes(liveBlockersFor(null, null)), ['SOURCE_NOT_EFFECTIVE'])
})

test('date gate: contradictory effective dates block with SOURCE_NOT_EFFECTIVE', () => {
  const upstream = liveBlockersFor(d('2026-09-01'), d('2026-02-01'))
  assert.equal(upstream.includes('CONTRADICTORY_DATES'), true)
  assert.deepEqual(toExecutabilityBlockerCodes(upstream), ['SOURCE_NOT_EFFECTIVE'])
})

test('date gate: valid effective dates still pass with no blockers', () => {
  assert.deepEqual(toExecutabilityBlockerCodes(liveBlockersFor(d('2026-01-01'), null)), [])
  assert.deepEqual(toExecutabilityBlockerCodes(liveBlockersFor(d('2026-01-01'), d('2026-12-31'))), [])
})

test('date gate: raw EFFECTIVE_DATE_INCOMPLETE / CONTRADICTORY_DATES never leak into the public vocabulary', () => {
  assert.equal(executabilityBlockerCodes.length, 15)
  const mapped = toExecutabilityBlockerCodes(['EFFECTIVE_DATE_INCOMPLETE', 'CONTRADICTORY_DATES', 'SOURCE_NOT_EFFECTIVE'])
  assert.deepEqual(mapped, ['SOURCE_NOT_EFFECTIVE'])
  for (const code of mapped) assert.equal(isExecutabilityBlockerCode(code), true, code)
})

test('date gate: in-vocabulary codes pass through unchanged and unknown codes are still dropped', () => {
  assert.deepEqual(toExecutabilityBlockerCodes(['SOURCE_NOT_PUBLISHED', 'AUTHORITY_UNVERIFIED']), [
    'AUTHORITY_UNVERIFIED',
    'SOURCE_NOT_PUBLISHED',
  ])
  assert.deepEqual(toExecutabilityBlockerCodes(['SOMETHING_UNKNOWN']), [])
})
