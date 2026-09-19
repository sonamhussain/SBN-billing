import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideActivation,
  decideMemberEligibility,
  decideVerification,
  hasCoherentDates,
  isDraft,
  isRulePackUuid,
  isWithinPackPeriod,
  jurisdictionsMatch,
  normalizePackDisplayName,
  normalizePackJurisdictionCode,
  normalizePackKey,
  normalizePackVersion,
} from './rule-pack.validation.ts'

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'

// --- identity fields (T07) ------------------------------------------------------------------

test('packKey, displayName, jurisdictionCode and version trim and reject blanks and non-strings', () => {
  assert.equal(normalizePackKey('  DUBAI_CLAIMS  '), 'DUBAI_CLAIMS')
  assert.equal(normalizePackKey('   '), null)
  assert.equal(normalizePackKey(42), null)
  assert.equal(normalizePackDisplayName(' Dubai claims pack '), 'Dubai claims pack')
  assert.equal(normalizePackDisplayName(''), null)
  assert.equal(normalizePackJurisdictionCode(' AE-DU '), 'AE-DU')
  assert.equal(normalizePackJurisdictionCode(null), null)
  assert.equal(normalizePackVersion(' v2 '), 'v2')
  assert.equal(normalizePackVersion(undefined), null)
})

test('rule pack ids must be UUID-shaped', () => {
  assert.equal(isRulePackUuid(ORG), true)
  assert.equal(isRulePackUuid('not-a-uuid'), false)
  assert.equal(isRulePackUuid(42), false)
})

// --- membership eligibility (T19, T20, T21) --------------------------------------------------

test('jurisdiction comparison trims and ignores case', () => {
  assert.equal(jurisdictionsMatch(' ae-du ', 'AE-DU'), true)
  assert.equal(jurisdictionsMatch('AE-DU', 'AE-AZ'), false)
})

test('an organization pack accepts its own organization rules', () => {
  assert.deepEqual(decideMemberEligibility({ organizationId: ORG, jurisdictionCode: 'AE-DU' }, { organizationId: ORG, jurisdictionCode: 'AE-DU' }), { kind: 'eligible' })
})

test('an organization pack accepts a compatible SYSTEM_SHARED rule, and rejects an incompatible one', () => {
  const pack = { organizationId: ORG, jurisdictionCode: 'AE-DU' }
  assert.deepEqual(decideMemberEligibility(pack, { organizationId: null, jurisdictionCode: 'ae-du' }), { kind: 'eligible' })
  assert.deepEqual(decideMemberEligibility(pack, { organizationId: null, jurisdictionCode: 'AE-AZ' }), { kind: 'jurisdiction_mismatch' })
})

test('another organization rule is never a member', () => {
  assert.deepEqual(decideMemberEligibility({ organizationId: ORG, jurisdictionCode: 'AE-DU' }, { organizationId: OTHER_ORG, jurisdictionCode: 'AE-DU' }), { kind: 'foreign' })
})

test('a SYSTEM_SHARED pack takes only SYSTEM_SHARED rules', () => {
  const shared = { organizationId: null, jurisdictionCode: 'AE-DU' }
  assert.deepEqual(decideMemberEligibility(shared, { organizationId: null, jurisdictionCode: 'AE-DU' }), { kind: 'eligible' })
  assert.deepEqual(decideMemberEligibility(shared, { organizationId: ORG, jurisdictionCode: 'AE-DU' }), { kind: 'shared_pack_requires_shared_rule' })
})

test('a jurisdiction mismatch is reported for an own-organization rule too', () => {
  assert.deepEqual(decideMemberEligibility({ organizationId: ORG, jurisdictionCode: 'AE-DU' }, { organizationId: ORG, jurisdictionCode: 'AE-AZ' }), { kind: 'jurisdiction_mismatch' })
})

// --- lifecycle (T14, T27, T28) ---------------------------------------------------------------

test('only UNVERIFIED + INACTIVE is a draft; every other state is an immutable snapshot', () => {
  assert.equal(isDraft({ verificationStatus: 'UNVERIFIED', activationStatus: 'INACTIVE' }), true)
  assert.equal(isDraft({ verificationStatus: 'VERIFIED', activationStatus: 'INACTIVE' }), false)
  assert.equal(isDraft({ verificationStatus: 'VERIFIED', activationStatus: 'ACTIVE' }), false)
  assert.equal(isDraft({ verificationStatus: 'VERIFIED', activationStatus: 'SUPERSEDED' }), false)
})

test('dates: open ends are coherent, an inverted period is not, a single day is (T16)', () => {
  assert.equal(hasCoherentDates({ effectiveFrom: null, effectiveTo: null }), true)
  assert.equal(hasCoherentDates({ effectiveFrom: d('2026-01-01'), effectiveTo: null }), true)
  assert.equal(hasCoherentDates({ effectiveFrom: null, effectiveTo: d('2026-12-31') }), true)
  assert.equal(hasCoherentDates({ effectiveFrom: d('2026-06-01'), effectiveTo: d('2026-06-01') }), true)
  assert.equal(hasCoherentDates({ effectiveFrom: d('2026-12-31'), effectiveTo: d('2026-01-01') }), false)
  assert.equal(hasCoherentDates({ effectiveFrom: new Date(Number.NaN), effectiveTo: null }), false)
})

test('the pack period is inclusive on both ends and open where a date is missing', () => {
  const v = { effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-12-31') }
  assert.equal(isWithinPackPeriod(v, d('2026-01-01')), true)
  assert.equal(isWithinPackPeriod(v, d('2026-12-31')), true)
  assert.equal(isWithinPackPeriod(v, d('2025-12-31')), false)
  assert.equal(isWithinPackPeriod(v, d('2027-01-01')), false)
  assert.equal(isWithinPackPeriod({ effectiveFrom: null, effectiveTo: null }, d('1999-01-01')), true)
  assert.equal(isWithinPackPeriod(v, new Date(Number.NaN)), false)
})

// --- verification (T24, T25, T26) ------------------------------------------------------------

const draft = { verificationStatus: 'UNVERIFIED', activationStatus: 'INACTIVE' }
const orgPack = { organizationId: ORG, jurisdictionCode: 'AE-DU' }
const verifiedMember = (id: string) => ({ ruleVersionId: id, verificationStatus: 'VERIFIED', organizationId: ORG, jurisdictionCode: 'AE-DU' })

test('verification rejects an empty snapshot', () => {
  const decision = decideVerification(draft, orgPack, [])
  assert.equal(decision.kind, 'rejected')
  assert.match(decision.kind === 'rejected' ? decision.message : '', /at least one member/)
})

test('verification rejects while any member RuleVersion is not VERIFIED, and names it', () => {
  const decision = decideVerification(draft, orgPack, [verifiedMember('a'), { ...verifiedMember('b'), verificationStatus: 'UNVERIFIED' }])
  assert.equal(decision.kind, 'rejected')
  assert.match(decision.kind === 'rejected' ? decision.message : '', /not verified: b/)
})

test('verification rechecks ownership and jurisdiction of every member', () => {
  const foreign = decideVerification(draft, orgPack, [verifiedMember('a'), { ...verifiedMember('c'), organizationId: OTHER_ORG }])
  assert.match(foreign.kind === 'rejected' ? foreign.message : '', /no longer eligible.*c/)
  const wrongJurisdiction = decideVerification(draft, orgPack, [{ ...verifiedMember('d'), jurisdictionCode: 'AE-AZ' }])
  assert.equal(wrongJurisdiction.kind, 'rejected')
})

test('verification accepts a draft whose members are all VERIFIED and eligible', () => {
  assert.deepEqual(decideVerification(draft, orgPack, [verifiedMember('a'), verifiedMember('b')]), { kind: 'verifiable' })
})

test('an already VERIFIED (or ACTIVE, or SUPERSEDED) snapshot cannot be verified again', () => {
  for (const state of [
    { verificationStatus: 'VERIFIED', activationStatus: 'INACTIVE' },
    { verificationStatus: 'VERIFIED', activationStatus: 'ACTIVE' },
    { verificationStatus: 'VERIFIED', activationStatus: 'SUPERSEDED' },
  ]) {
    assert.equal(decideVerification(state, orgPack, [verifiedMember('a')]).kind, 'rejected')
  }
})

// --- activation (T29, T30, T33) --------------------------------------------------------------

const verifiedInactive = { verificationStatus: 'VERIFIED', activationStatus: 'INACTIVE', effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-12-31') }

test('activation rejects an UNVERIFIED version', () => {
  assert.equal(decideActivation({ ...verifiedInactive, verificationStatus: 'UNVERIFIED' }, d('2026-06-01')).kind, 'rejected')
})

test('activation accepts a VERIFIED, INACTIVE version for a businessDate inside its period', () => {
  assert.deepEqual(decideActivation(verifiedInactive, d('2026-06-01')), { kind: 'activatable' })
  assert.deepEqual(decideActivation(verifiedInactive, d('2026-12-31')), { kind: 'activatable' })
})

test('activation rejects a businessDate outside the period, but a dateless version has no restriction', () => {
  assert.equal(decideActivation(verifiedInactive, d('2027-01-01')).kind, 'rejected')
  assert.equal(decideActivation(verifiedInactive, d('2025-12-31')).kind, 'rejected')
  assert.deepEqual(decideActivation({ ...verifiedInactive, effectiveFrom: null, effectiveTo: null }, d('2030-01-01')), { kind: 'activatable' })
})

test('an ACTIVE version is already current and a SUPERSEDED version is never reactivated', () => {
  assert.equal(decideActivation({ ...verifiedInactive, activationStatus: 'ACTIVE' }, d('2026-06-01')).kind, 'rejected')
  const superseded = decideActivation({ ...verifiedInactive, activationStatus: 'SUPERSEDED' }, d('2026-06-01'))
  assert.match(superseded.kind === 'rejected' ? superseded.message : '', /SUPERSEDED/)
})

test('T33 no lexical rank: the activation rule never sees the version text, so v10 cannot outrank v2', () => {
  // decideActivation takes lifecycle state and dates only. Two snapshots labelled v2 and v10 with
  // identical state get identical answers; which one is current is decided by explicit activation.
  const v2 = { ...verifiedInactive, version: 'v2' }
  const v10 = { ...verifiedInactive, version: 'v10' }
  assert.deepEqual(decideActivation(v2, d('2026-06-01')), decideActivation(v10, d('2026-06-01')))
  assert.equal(decideActivation.length, 2)
})
