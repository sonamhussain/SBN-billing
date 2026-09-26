import test from 'node:test'
import assert from 'node:assert/strict'
import {
  billingDisplayName,
  isEncounterBillingContextUuid,
  orderExternalIdentifiers,
  verifyObservationAnchors,
  verifySelectedMembership,
  verifyStoredAssignment,
  verifyStoredProfile,
  type EncounterBinding,
} from './encounter-billing-context.validation.ts'

// A4.9 — the pure integrity rules. Synthetic values only; no database access.

const d = (text: string) => new Date(`${text}T00:00:00.000Z`)
const E = '11111111-1111-4111-8111-111111111111'
const C = '22222222-2222-4222-8222-222222222222'
const F = '33333333-3333-4333-8333-333333333333'
const P = '44444444-4444-4444-8444-444444444444'
const A = '55555555-5555-4555-8555-555555555555'
const R = '66666666-6666-4666-8666-666666666666'
const M = '77777777-7777-4777-8777-777777777777'

const encounter = (overrides: Partial<EncounterBinding> = {}): EncounterBinding => ({
  id: E,
  clinicianId: C,
  facilityId: F,
  patientId: P,
  serviceDate: d('2026-06-15'),
  clinicianFacilityAssignmentId: A,
  facilityRegulatoryProfileId: R,
  insuranceMembershipId: null,
  ...overrides,
})

const assignment = (overrides: Record<string, unknown> = {}) => ({
  id: A,
  clinicianId: C,
  facilityId: F,
  effectiveFrom: d('2026-01-01'),
  effectiveTo: null as Date | null,
  ...overrides,
})

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: R,
  facilityId: F,
  effectiveFrom: d('2026-01-01'),
  effectiveTo: null as Date | null,
  ...overrides,
})

test('an encounter id must be UUID-shaped', () => {
  assert.equal(isEncounterBillingContextUuid(E), true)
  assert.equal(isEncounterBillingContextUuid('not-a-uuid'), false)
  assert.equal(isEncounterBillingContextUuid(7), false)
  assert.equal(isEncounterBillingContextUuid(null), false)
})

// ---------------------------------------------------------------- assignment

test('the exact stored assignment is accepted when it still coheres', () => {
  const outcome = verifyStoredAssignment(encounter(), assignment())
  assert.equal(outcome.ok, true)
})

test('a missing, substituted or mismatched assignment fails closed', () => {
  assert.equal(verifyStoredAssignment(encounter(), null).ok, false, 'deleted')
  // A different row that is perfectly valid today is still not the one this encounter recorded.
  assert.equal(verifyStoredAssignment(encounter(), assignment({ id: M })).ok, false, 'a substituted row')
  assert.equal(verifyStoredAssignment(encounter(), assignment({ clinicianId: M })).ok, false, 'another clinician')
  assert.equal(verifyStoredAssignment(encounter(), assignment({ facilityId: M })).ok, false, 'another facility')
})

test('an assignment period edited into contradiction fails closed, on both sides', () => {
  assert.equal(verifyStoredAssignment(encounter(), assignment({ effectiveFrom: d('2026-07-01') })).ok, false, 'starts after the service date')
  assert.equal(verifyStoredAssignment(encounter(), assignment({ effectiveTo: d('2026-05-31') })).ok, false, 'ended before the service date')
})

test('both assignment boundaries are inclusive', () => {
  assert.equal(verifyStoredAssignment(encounter(), assignment({ effectiveFrom: d('2026-06-15') })).ok, true, 'starts on the day')
  assert.equal(verifyStoredAssignment(encounter(), assignment({ effectiveTo: d('2026-06-15') })).ok, true, 'ends on the day')
})

// ---------------------------------------------------------------- profile

test('the exact stored profile is accepted when it still coheres', () => {
  assert.equal(verifyStoredProfile(encounter(), profile()).ok, true)
})

// The point of the whole package: a later lifecycle change must not erase a historical binding.
test('the stored profile is returned whatever its current status became', () => {
  for (const status of ['ACTIVE', 'INACTIVE', 'SUPERSEDED', 'RETIRED', 'BLOCKED']) {
    const outcome = verifyStoredProfile(encounter(), { ...profile(), status } as never)
    assert.equal(outcome.ok, true, `status ${status} must not change the answer`)
  }
})

test('a missing, substituted or mismatched profile fails closed', () => {
  assert.equal(verifyStoredProfile(encounter(), null).ok, false, 'deleted')
  assert.equal(verifyStoredProfile(encounter(), profile({ id: M })).ok, false, 'a substituted row')
  assert.equal(verifyStoredProfile(encounter(), profile({ facilityId: M })).ok, false, 'another facility')
  assert.equal(verifyStoredProfile(encounter(), profile({ effectiveFrom: d('2026-07-01') })).ok, false, 'starts later')
  assert.equal(verifyStoredProfile(encounter(), profile({ effectiveTo: d('2026-05-31') })).ok, false, 'ended earlier')
})

// ---------------------------------------------------------------- membership

test('no membership selected yields null, and says nothing more than that', () => {
  const outcome = verifySelectedMembership(encounter(), null)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.value, null)
})

test('a membership is ignored entirely when the encounter selected none', () => {
  // Even if a row is loaded, an encounter that recorded no selection has no coverage context.
  const outcome = verifySelectedMembership(encounter(), { id: M, patientId: P, coverageFrom: null, coverageTo: null })
  assert.equal(outcome.ok && outcome.value, null)
})

test('the selected membership is accepted when it belongs to the patient and covers the date', () => {
  const outcome = verifySelectedMembership(encounter({ insuranceMembershipId: M }), {
    id: M,
    patientId: P,
    coverageFrom: d('2026-01-01'),
    coverageTo: d('2026-12-31'),
  })
  assert.equal(outcome.ok, true)
})

test('a membership of another patient fails closed', () => {
  const outcome = verifySelectedMembership(encounter({ insuranceMembershipId: M }), {
    id: M,
    patientId: E,
    coverageFrom: null,
    coverageTo: null,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && /different patient/.test(outcome.message), true)
})

test('a service date outside the recorded coverage period fails closed on either side', () => {
  const before = verifySelectedMembership(encounter({ insuranceMembershipId: M }), { id: M, patientId: P, coverageFrom: d('2026-07-01'), coverageTo: null })
  const after = verifySelectedMembership(encounter({ insuranceMembershipId: M }), { id: M, patientId: P, coverageFrom: null, coverageTo: d('2026-05-31') })
  assert.equal(before.ok, false)
  assert.equal(after.ok, false)
})

// Unknown is not a failure. A4.3 records what was registered, and an absent boundary means the
// boundary is unknown, never that coverage is absent.
test('unknown coverage boundaries stay unknown and are accepted', () => {
  const outcome = verifySelectedMembership(encounter({ insuranceMembershipId: M }), { id: M, patientId: P, coverageFrom: null, coverageTo: null })
  assert.equal(outcome.ok, true)
})

test('coverage boundaries are inclusive', () => {
  const outcome = verifySelectedMembership(encounter({ insuranceMembershipId: M }), {
    id: M,
    patientId: P,
    coverageFrom: d('2026-06-15'),
    coverageTo: d('2026-06-15'),
  })
  assert.equal(outcome.ok, true)
})

test('a selected membership that no longer exists fails closed', () => {
  assert.equal(verifySelectedMembership(encounter({ insuranceMembershipId: M }), null).ok, false)
})

// ---------------------------------------------------------------- observation anchors

const activeActivity = { id: A, encounterId: E, removedAt: null as Date | null }

test('unanchored observations are always fine', () => {
  assert.equal(verifyObservationAnchors(E, [{ id: M, encounterActivityId: null }], []).ok, true)
})

test('an observation anchored to an active activity of the same encounter is fine', () => {
  assert.equal(verifyObservationAnchors(E, [{ id: M, encounterActivityId: A }], [activeActivity]).ok, true)
})

// A bad anchor is reported, never dropped: silently omitting it would hand A5 a context that looks
// complete and is not.
test('a dangling, foreign or removed anchor fails closed and names the observation', () => {
  const dangling = verifyObservationAnchors(E, [{ id: M, encounterActivityId: R }], [activeActivity])
  assert.equal(dangling.ok, false)
  assert.equal(dangling.ok === false && dangling.message.includes(M), true, 'the message names the observation')

  const foreign = verifyObservationAnchors(E, [{ id: M, encounterActivityId: A }], [{ ...activeActivity, encounterId: C }])
  assert.equal(foreign.ok, false)
  assert.equal(foreign.ok === false && /different encounter/.test(foreign.message), true)

  const removed = verifyObservationAnchors(E, [{ id: M, encounterActivityId: A }], [{ ...activeActivity, removedAt: d('2026-06-20') }])
  assert.equal(removed.ok, false)
  assert.equal(removed.ok === false && /removed activity/.test(removed.message), true)
})

// ---------------------------------------------------------------- external identifiers

test('external identifiers are ordered by source, then value, then id — and never by preference', () => {
  const rows = [
    { sourceSystem: 'B_SYS', externalValue: 'a', id: '2' },
    { sourceSystem: 'A_SYS', externalValue: 'b', id: '1' },
    { sourceSystem: 'A_SYS', externalValue: 'a', id: '9' },
    { sourceSystem: 'A_SYS', externalValue: 'a', id: '3' },
  ]
  assert.deepEqual(
    orderExternalIdentifiers(rows).map((row) => `${row.sourceSystem}/${row.externalValue}/${row.id}`),
    ['A_SYS/a/3', 'A_SYS/a/9', 'A_SYS/b/1', 'B_SYS/a/2'],
  )
})

test('ordering is total, stable and leaves the caller\'s array untouched', () => {
  const rows = [
    { sourceSystem: 'B', externalValue: 'x', id: '2' },
    { sourceSystem: 'A', externalValue: 'x', id: '1' },
  ]
  const first = orderExternalIdentifiers(rows)
  const second = orderExternalIdentifiers(rows)
  assert.deepEqual(first, second, 'two reads of the same rows give the same order')
  assert.equal(rows[0].sourceSystem, 'B', 'the input array is not mutated')
})

test('an empty identifier list is simply empty, never a chosen default', () => {
  assert.deepEqual(orderExternalIdentifiers([]), [])
})

// ---------------------------------------------------------------- display name

test('the billing display name joins the name parts and includes a middle name when present', () => {
  assert.equal(billingDisplayName({ givenName: 'Synthetic', middleName: null, familyName: 'Example' }), 'Synthetic Example')
  assert.equal(billingDisplayName({ givenName: 'Synthetic', middleName: 'Q', familyName: 'Example' }), 'Synthetic Q Example')
  assert.equal(billingDisplayName({ givenName: 'Synthetic', middleName: '  ', familyName: 'Example' }), 'Synthetic Example', 'a blank middle name is not a part')
})
