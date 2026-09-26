// A4.9 — the pure integrity rules. No database access lives here, so every rule below is
// unit-testable on its own and there is exactly one copy of each decision.
//
// The governing principle is: VERIFY, NEVER REPAIR. When a stored relationship contradicts itself,
// A4.9 reports the contradiction and stops. It never picks a replacement row, never falls back to
// "the latest" or "the first", and never silently drops a fact. A caller that receives a context
// can therefore trust that every part of it was consistent in one database snapshot.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isEncounterBillingContextUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

const conflict = (message: string): Outcome<never> => ({ ok: false, message })

// A date-only comparison against the Encounter's service date. Both bounds are inclusive, matching
// the A4.2 and A3 effective-period semantics; an absent bound is open, never "unknown = excluded".
function coversServiceDate(effectiveFrom: Date, effectiveTo: Date | null, serviceDate: Date): boolean {
  if (serviceDate.getTime() < effectiveFrom.getTime()) return false
  if (effectiveTo !== null && serviceDate.getTime() > effectiveTo.getTime()) return false
  return true
}

export type StoredAssignment = {
  id: string
  clinicianId: string
  facilityId: string
  effectiveFrom: Date
  effectiveTo: Date | null
}

export type EncounterBinding = {
  id: string
  clinicianId: string
  facilityId: string
  patientId: string
  serviceDate: Date
  clinicianFacilityAssignmentId: string
  facilityRegulatoryProfileId: string
  insuranceMembershipId: string | null
}

// The assignment must be the EXACT row the Encounter recorded, and it must still describe the same
// clinician practising at the same facility on the service date. A different assignment that is
// effective today is not a candidate: it was never the binding this Encounter was written against.
export function verifyStoredAssignment(
  encounter: EncounterBinding,
  assignment: StoredAssignment | null,
): Outcome<StoredAssignment> {
  if (!assignment) return conflict('the clinician facility assignment recorded on this encounter no longer exists')
  if (assignment.id !== encounter.clinicianFacilityAssignmentId)
    return conflict('the loaded assignment is not the one recorded on this encounter')
  if (assignment.clinicianId !== encounter.clinicianId)
    return conflict('the recorded assignment belongs to a different clinician than the encounter')
  if (assignment.facilityId !== encounter.facilityId)
    return conflict('the recorded assignment belongs to a different facility than the encounter')
  if (!coversServiceDate(assignment.effectiveFrom, assignment.effectiveTo, encounter.serviceDate))
    return conflict('the recorded assignment no longer covers the encounter service date')
  return { ok: true, value: assignment }
}

export type StoredProfile = {
  id: string
  facilityId: string
  effectiveFrom: Date
  effectiveTo: Date | null
}

// The regulatory profile is checked the same way, with one deliberate omission: its CURRENT status
// is not examined. The Encounter bound itself to this exact profile at write time; a later
// administrative retirement or supersession is a lifecycle fact, not permission to substitute a
// newer ACTIVE row into a historical context.
export function verifyStoredProfile(
  encounter: EncounterBinding,
  profile: StoredProfile | null,
): Outcome<StoredProfile> {
  if (!profile) return conflict('the facility regulatory profile recorded on this encounter no longer exists')
  if (profile.id !== encounter.facilityRegulatoryProfileId)
    return conflict('the loaded regulatory profile is not the one recorded on this encounter')
  if (profile.facilityId !== encounter.facilityId)
    return conflict('the recorded regulatory profile belongs to a different facility than the encounter')
  if (!coversServiceDate(profile.effectiveFrom, profile.effectiveTo, encounter.serviceDate))
    return conflict('the recorded regulatory profile no longer covers the encounter service date')
  return { ok: true, value: profile }
}

export type StoredMembership = {
  id: string
  patientId: string
  coverageFrom: Date | null
  coverageTo: Date | null
}

// Registration truth only. A membership that passes these checks is NOT thereby eligible: A4.3
// records what was registered, and A5 owns the evidence-bearing eligibility decision. An unknown
// coverage boundary stays unknown and is never treated as a failure.
export function verifySelectedMembership(
  encounter: EncounterBinding,
  membership: StoredMembership | null,
): Outcome<StoredMembership | null> {
  // No membership was selected on the Encounter. This says nothing about self-pay, uninsured or
  // ineligible status, and A4.9 must not invent such a label.
  if (encounter.insuranceMembershipId === null) return { ok: true, value: null }

  if (!membership) return conflict('the insurance membership recorded on this encounter no longer exists')
  if (membership.id !== encounter.insuranceMembershipId)
    return conflict('the loaded membership is not the one recorded on this encounter')
  if (membership.patientId !== encounter.patientId)
    return conflict('the recorded membership belongs to a different patient than the encounter')
  if (membership.coverageFrom !== null && encounter.serviceDate.getTime() < membership.coverageFrom.getTime())
    return conflict('the encounter service date precedes the recorded coverage period of the selected membership')
  if (membership.coverageTo !== null && encounter.serviceDate.getTime() > membership.coverageTo.getTime())
    return conflict('the encounter service date follows the recorded coverage period of the selected membership')
  return { ok: true, value: membership }
}

export type ObservationAnchor = {
  id: string
  encounterActivityId: string | null
}

export type ActivityAnchorState = {
  id: string
  encounterId: string
  removedAt: Date | null
}

// An observation anchored to an activity must point at an ACTIVE activity of the SAME Encounter.
// A dangling, foreign or removed anchor is an orphan, and an orphan is reported rather than
// quietly dropped: silently omitting it would hand A5 a context that looks complete and is not.
export function verifyObservationAnchors(
  encounterId: string,
  observations: ObservationAnchor[],
  activities: ActivityAnchorState[],
): Outcome<null> {
  const byId = new Map(activities.map((activity) => [activity.id, activity]))
  for (const observation of observations) {
    if (observation.encounterActivityId === null) continue
    const anchor = byId.get(observation.encounterActivityId)
    if (!anchor) return conflict(`observation ${observation.id} is anchored to an activity that is not an active activity of this encounter`)
    if (anchor.encounterId !== encounterId)
      return conflict(`observation ${observation.id} is anchored to an activity of a different encounter`)
    if (anchor.removedAt !== null)
      return conflict(`observation ${observation.id} is anchored to a removed activity`)
  }
  return { ok: true, value: null }
}

export type OrderableIdentifier = { sourceSystem: string; externalValue: string; id: string }

// A4.9 returns every mapping and chooses none. The order is total and deterministic so two reads of
// an unchanged database produce byte-identical arrays; it carries no notion of preference, and a
// consumer must select by the sourceSystem its own integration contract names.
export function orderExternalIdentifiers<T extends OrderableIdentifier>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      a.sourceSystem.localeCompare(b.sourceSystem) ||
      a.externalValue.localeCompare(b.externalValue) ||
      a.id.localeCompare(b.id),
  )
}

// The display name A4.1 derives, reproduced here only for the billing projection. The middle name
// is included when present; nothing else about the Patient reaches this contract.
export function billingDisplayName(parts: { givenName: string; middleName: string | null; familyName: string }): string {
  return [parts.givenName, parts.middleName, parts.familyName].filter((part) => part && part.trim() !== '').join(' ')
}
