import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateActivationBlockers, isEffective } from './rule-source-version.activation.ts'

const publishedVersion = {
  publicationStatus: 'PUBLISHED',
  effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
  effectiveTo: null,
  verificationStatus: 'VERIFIED',
}

const source = { jurisdictionCode: 'AE-DU', organizationId: 'org-1' }
const verifiedInterpretation = [{ verificationStatus: 'VERIFIED' }]
const context = { businessDate: new Date('2026-10-15T00:00:00.000Z'), jurisdictionCode: 'AE-DU', requestingOrganizationId: 'org-1' }

test('isEffective requires effectiveFrom', () => {
  assert.equal(isEffective(null, null, new Date()), false)
})

test('isEffective true within open-ended range', () => {
  assert.equal(isEffective(new Date('2026-01-01'), null, new Date('2026-06-01')), true)
})

test('isEffective false before effectiveFrom', () => {
  assert.equal(isEffective(new Date('2026-06-01'), null, new Date('2026-01-01')), false)
})

test('isEffective false after effectiveTo', () => {
  assert.equal(isEffective(new Date('2026-01-01'), new Date('2026-03-01'), new Date('2026-06-01')), false)
})

test('all gates satisfied returns no blockers', () => {
  assert.deepEqual(evaluateActivationBlockers(publishedVersion, source, verifiedInterpretation, context), [])
})

test('DRAFT publication yields SOURCE_NOT_PUBLISHED', () => {
  const blockers = evaluateActivationBlockers({ ...publishedVersion, publicationStatus: 'DRAFT' }, source, verifiedInterpretation, context)
  assert.ok(blockers.includes('SOURCE_NOT_PUBLISHED'))
})

test('missing effectiveFrom yields EFFECTIVE_DATE_INCOMPLETE', () => {
  const blockers = evaluateActivationBlockers({ ...publishedVersion, effectiveFrom: null }, source, verifiedInterpretation, context)
  assert.ok(blockers.includes('EFFECTIVE_DATE_INCOMPLETE'))
  assert.ok(!blockers.includes('SOURCE_NOT_EFFECTIVE'))
})

test('businessDate before effectiveFrom yields SOURCE_NOT_EFFECTIVE', () => {
  const blockers = evaluateActivationBlockers(
    publishedVersion,
    source,
    verifiedInterpretation,
    { ...context, businessDate: new Date('2026-01-01T00:00:00.000Z') },
  )
  assert.ok(blockers.includes('SOURCE_NOT_EFFECTIVE'))
})

test('businessDate after effectiveTo yields SOURCE_NOT_EFFECTIVE', () => {
  const version = { ...publishedVersion, effectiveTo: new Date('2026-10-10T00:00:00.000Z') }
  const blockers = evaluateActivationBlockers(version, source, verifiedInterpretation, context)
  assert.ok(blockers.includes('SOURCE_NOT_EFFECTIVE'))
})

test('inverted effective dates yield CONTRADICTORY_DATES', () => {
  const version = {
    ...publishedVersion,
    effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
    effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
  }
  const blockers = evaluateActivationBlockers(version, source, verifiedInterpretation, context)
  assert.ok(blockers.includes('CONTRADICTORY_DATES'))
})

test('unverified source yields AUTHORITY_UNVERIFIED', () => {
  const blockers = evaluateActivationBlockers({ ...publishedVersion, verificationStatus: 'IN_REVIEW' }, source, verifiedInterpretation, context)
  assert.ok(blockers.includes('AUTHORITY_UNVERIFIED'))
})

test('no verified interpretation yields INTERPRETATION_UNVERIFIED', () => {
  const blockers = evaluateActivationBlockers(publishedVersion, source, [{ verificationStatus: 'UNVERIFIED' }], context)
  assert.ok(blockers.includes('INTERPRETATION_UNVERIFIED'))
})

test('empty interpretation list yields INTERPRETATION_UNVERIFIED', () => {
  const blockers = evaluateActivationBlockers(publishedVersion, source, [], context)
  assert.ok(blockers.includes('INTERPRETATION_UNVERIFIED'))
})

test('mismatched jurisdiction yields JURISDICTION_INCOMPATIBLE', () => {
  const blockers = evaluateActivationBlockers(
    publishedVersion,
    { jurisdictionCode: 'AE-AZ', organizationId: 'org-1' },
    verifiedInterpretation,
    context,
  )
  assert.ok(blockers.includes('JURISDICTION_INCOMPATIBLE'))
})

test('jurisdiction comparison trims and ignores case', () => {
  const blockers = evaluateActivationBlockers(
    publishedVersion,
    { jurisdictionCode: '  ae-du  ', organizationId: 'org-1' },
    verifiedInterpretation,
    context,
  )
  assert.ok(!blockers.includes('JURISDICTION_INCOMPATIBLE'))
})

test('organization mismatch yields OWNERSHIP_MISMATCH', () => {
  const blockers = evaluateActivationBlockers(publishedVersion, { ...source, organizationId: 'org-2' }, verifiedInterpretation, context)
  assert.ok(blockers.includes('OWNERSHIP_MISMATCH'))
})

test('multiple failures return unique sorted blockers', () => {
  const version = { publicationStatus: 'DRAFT', effectiveFrom: null, effectiveTo: null, verificationStatus: 'UNVERIFIED' }
  const blockers = evaluateActivationBlockers(version, source, [], context)
  assert.deepEqual(blockers, [...blockers].sort())
  assert.ok(blockers.includes('SOURCE_NOT_PUBLISHED'))
  assert.ok(blockers.includes('EFFECTIVE_DATE_INCOMPLETE'))
  assert.ok(blockers.includes('AUTHORITY_UNVERIFIED'))
  assert.ok(blockers.includes('INTERPRETATION_UNVERIFIED'))
})

test('no relationship signals yields no relationship blockers', () => {
  const blockers = evaluateActivationBlockers(publishedVersion, source, verifiedInterpretation, context)
  assert.ok(!blockers.includes('DEPENDENCY_UNRESOLVED'))
  assert.ok(!blockers.includes('SOURCE_CONFLICT'))
})

test('unresolved dependency yields DEPENDENCY_UNRESOLVED', () => {
  const blockers = evaluateActivationBlockers(publishedVersion, source, verifiedInterpretation, context, {
    hasUnresolvedDependency: true,
    hasConflict: false,
  })
  assert.ok(blockers.includes('DEPENDENCY_UNRESOLVED'))
  assert.ok(!blockers.includes('SOURCE_CONFLICT'))
})

test('conflict edge yields SOURCE_CONFLICT', () => {
  const blockers = evaluateActivationBlockers(publishedVersion, source, verifiedInterpretation, context, {
    hasUnresolvedDependency: false,
    hasConflict: true,
  })
  assert.ok(blockers.includes('SOURCE_CONFLICT'))
  assert.ok(!blockers.includes('DEPENDENCY_UNRESOLVED'))
})

test('both relationship blockers can appear together, unique and sorted', () => {
  const blockers = evaluateActivationBlockers(publishedVersion, source, verifiedInterpretation, context, {
    hasUnresolvedDependency: true,
    hasConflict: true,
  })
  assert.deepEqual(blockers, ['DEPENDENCY_UNRESOLVED', 'SOURCE_CONFLICT'])
})
