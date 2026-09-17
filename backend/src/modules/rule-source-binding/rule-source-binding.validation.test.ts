import test from 'node:test'
import assert from 'node:assert/strict'
import {
  executabilityBlockerCodes,
  isExecutabilityBlockerCode,
  isRuleSourceBindingUuid,
  isSourceRole,
  normalizeSourceRole,
  toExecutabilityBlockerCodes,
  translateActivationBlockers,
  unmappedBlockerFallback,
} from './rule-source-binding.validation.ts'
import { activationBlockerCodes, evaluateActivationBlockers } from '../rule-source-version/rule-source-version.activation.ts'

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

// --- F01: lossless, fail-closed blocker translation --------------------------------------------

test('F01: every A3.3 blocker code has a translation inside the public vocabulary', () => {
  for (const code of activationBlockerCodes) {
    const { codes, unmappedReasons } = translateActivationBlockers([code])
    assert.equal(codes.length, 1, code)
    assert.equal(isExecutabilityBlockerCode(codes[0]), true, code)
    assert.deepEqual(unmappedReasons, [], code)
  }
})

test('F01: the two date aliases map to SOURCE_NOT_EFFECTIVE', () => {
  assert.deepEqual(toExecutabilityBlockerCodes(['EFFECTIVE_DATE_INCOMPLETE']), ['SOURCE_NOT_EFFECTIVE'])
  assert.deepEqual(toExecutabilityBlockerCodes(['CONTRADICTORY_DATES']), ['SOURCE_NOT_EFFECTIVE'])
})

test('F01: known A3.3 codes that are already public pass through unchanged', () => {
  for (const code of [
    'SOURCE_NOT_PUBLISHED',
    'SOURCE_NOT_EFFECTIVE',
    'AUTHORITY_UNVERIFIED',
    'INTERPRETATION_UNVERIFIED',
    'JURISDICTION_INCOMPATIBLE',
    'OWNERSHIP_MISMATCH',
    'DEPENDENCY_UNRESOLVED',
    'SOURCE_CONFLICT',
  ]) {
    assert.deepEqual(toExecutabilityBlockerCodes([code]), [code], code)
  }
})

test('F01: every existing A3.7 public code passes through unchanged', () => {
  for (const code of executabilityBlockerCodes) {
    assert.deepEqual(toExecutabilityBlockerCodes([code]), [code], code)
  }
})

test('F01: an unknown future upstream blocker fails closed instead of disappearing', () => {
  const { codes, unmappedReasons } = translateActivationBlockers(['SOME_FUTURE_A33_BLOCKER'])
  assert.deepEqual(codes, [unmappedBlockerFallback])
  assert.equal(unmappedBlockerFallback, 'SOURCE_NOT_ACTIVE')
  assert.deepEqual(unmappedReasons, ['SOME_FUTURE_A33_BLOCKER'])
})

test('F01: prototype-like names are unknown strings, never object properties', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const { codes, unmappedReasons } = translateActivationBlockers([name])
    assert.deepEqual(codes, ['SOURCE_NOT_ACTIVE'], name)
    assert.deepEqual(unmappedReasons, [name], name)
    for (const code of codes) assert.equal(typeof code, 'string', name)
  }
})

test('F01: empty strings and non-string entries in a non-empty response never become success', () => {
  for (const entry of ['', null, undefined, 42, {}, []]) {
    const { codes, unmappedReasons } = translateActivationBlockers([entry])
    assert.deepEqual(codes, ['SOURCE_NOT_ACTIVE'], String(entry))
    assert.equal(unmappedReasons.length, 1, String(entry))
  }
})

test('F01: only a genuinely empty upstream list yields an empty result', () => {
  assert.deepEqual(translateActivationBlockers([]), { codes: [], unmappedReasons: [] })
})

test('F01: mixed and duplicate input yields unique, deterministically sorted public codes', () => {
  const forward = toExecutabilityBlockerCodes([
    'SOURCE_CONFLICT',
    'EFFECTIVE_DATE_INCOMPLETE',
    'NEW_UNKNOWN',
    'SOURCE_NOT_EFFECTIVE',
    'SOURCE_CONFLICT',
    'CONTRADICTORY_DATES',
    'constructor',
  ])
  const reversed = toExecutabilityBlockerCodes([
    'constructor',
    'CONTRADICTORY_DATES',
    'SOURCE_CONFLICT',
    'SOURCE_NOT_EFFECTIVE',
    'NEW_UNKNOWN',
    'EFFECTIVE_DATE_INCOMPLETE',
    'SOURCE_CONFLICT',
  ])
  assert.deepEqual(forward, ['SOURCE_CONFLICT', 'SOURCE_NOT_ACTIVE', 'SOURCE_NOT_EFFECTIVE'])
  assert.deepEqual(reversed, forward)
  for (const code of forward) assert.equal(isExecutabilityBlockerCode(code), true, code)
})

test('F01: the public vocabulary stays at exactly fifteen codes', () => {
  assert.equal(executabilityBlockerCodes.length, 15)
  assert.equal(isExecutabilityBlockerCode('EFFECTIVE_DATE_INCOMPLETE'), false)
  assert.equal(isExecutabilityBlockerCode('CONTRADICTORY_DATES'), false)
})
