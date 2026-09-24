import { formatDateOnly, parseStrictDateOnly } from '../../shared/rules/date-only.ts'
import { isCommercialContextUuid } from '../commercial-coverage/commercial-context.validation.ts'
import { encounterServerOwnedFields, encounterWritableFields, type EncounterDto } from './encounter.types.ts'

// A4.4 §14 — the pure validation contract, plus the §8/§10–§12 context decision. It reuses the
// shared strict date-only parser and UUID helper; there is no second parser, no future-date rule
// and no resolver algorithm here — the A4.2 and A3 resolvers are called by the service and only
// their zero/one/many outcome is judged below.

export function isEncounterUuid(value: unknown): value is string {
  return typeof value === 'string' && isCommercialContextUuid(value)
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

export type EncounterWriteInput = {
  facilityId: string
  clinicianId: string
  insuranceMembershipId: string | null
  serviceDate: Date
}

export type EncounterPatch = Partial<EncounterWriteInput>

function isPlainObject(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
}

// Server-owned fields first (so a forged patientId or context ID is named as such), then unknown.
function refuseForeignKeys(body: Record<string, unknown>, serverOwnedVerb: string): string | null {
  const keys = Object.keys(body)
  const serverOwned = encounterServerOwnedFields.filter((field) => keys.includes(field))
  if (serverOwned.length > 0) return `${serverOwned.join(', ')} ${serverOwnedVerb}`
  const allowed = new Set<string>(encounterWritableFields)
  const unknown = keys.filter((key) => !allowed.has(key))
  if (unknown.length > 0) return `unknown field(s): ${unknown.join(', ')}`
  return null
}

function requiredUuid(value: unknown, field: string): Outcome<string> {
  if (!isEncounterUuid(value)) return { ok: false, message: `${field} is required and must be a UUID` }
  return { ok: true, value }
}

function optionalMembership(value: unknown): Outcome<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (!isEncounterUuid(value)) return { ok: false, message: 'insuranceMembershipId must be a UUID or null' }
  return { ok: true, value }
}

// A strict calendar day. A syntactically valid future date is accepted: A4.4 invents no
// future-date rule.
function requiredServiceDate(value: unknown): Outcome<Date> {
  const parsed = parseStrictDateOnly(value)
  if (!parsed) return { ok: false, message: 'serviceDate must be a real calendar date in YYYY-MM-DD format' }
  return { ok: true, value: parsed }
}

export function validateCreateInput(body: unknown): Outcome<EncounterWriteInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'an encounter body is required' }
  const refused = refuseForeignKeys(body, 'is resolved by the server and cannot be supplied')
  if (refused) return { ok: false, message: refused }

  const facilityId = requiredUuid(body.facilityId, 'facilityId')
  if (!facilityId.ok) return facilityId
  const clinicianId = requiredUuid(body.clinicianId, 'clinicianId')
  if (!clinicianId.ok) return clinicianId
  const insuranceMembershipId = optionalMembership(body.insuranceMembershipId)
  if (!insuranceMembershipId.ok) return insuranceMembershipId
  const serviceDate = requiredServiceDate(body.serviceDate)
  if (!serviceDate.ok) return serviceDate

  return {
    ok: true,
    value: { facilityId: facilityId.value, clinicianId: clinicianId.value, insuranceMembershipId: insuranceMembershipId.value, serviceDate: serviceDate.value },
  }
}

// A PATCH carries only what it supplies. facilityId, clinicianId and serviceDate can be corrected
// but never cleared; an explicit null clears the optional membership (self-pay / unknown coverage).
export function validateUpdateInput(body: unknown): Outcome<EncounterPatch> {
  if (!isPlainObject(body)) return { ok: false, message: 'an encounter body is required' }
  const refused = refuseForeignKeys(body, 'cannot be changed')
  if (refused) return { ok: false, message: refused }
  const supplied = Object.keys(body)
  if (supplied.length === 0) return { ok: false, message: 'a patch must change at least one field' }

  const patch: EncounterPatch = {}
  for (const field of ['facilityId', 'clinicianId'] as const) {
    if (!supplied.includes(field)) continue
    const outcome = requiredUuid(body[field], field)
    if (!outcome.ok) return { ok: false, message: `${field} must be a UUID and cannot be cleared` }
    patch[field] = outcome.value
  }
  if (supplied.includes('insuranceMembershipId')) {
    const outcome = optionalMembership(body.insuranceMembershipId)
    if (!outcome.ok) return outcome
    patch.insuranceMembershipId = outcome.value
  }
  if (supplied.includes('serviceDate')) {
    const outcome = requiredServiceDate(body.serviceDate)
    if (!outcome.ok) return outcome
    patch.serviceDate = outcome.value
  }
  return { ok: true, value: patch }
}

export type StoredEncounterInput = EncounterWriteInput

export function mergeEncounter(stored: StoredEncounterInput, patch: EncounterPatch): EncounterWriteInput {
  return {
    facilityId: patch.facilityId ?? stored.facilityId,
    clinicianId: patch.clinicianId ?? stored.clinicianId,
    insuranceMembershipId: patch.insuranceMembershipId !== undefined ? patch.insuranceMembershipId : stored.insuranceMembershipId,
    serviceDate: patch.serviceDate ?? stored.serviceDate,
  }
}

// Which supplied fields actually differ from what is stored. A patch that changes nothing is
// refused and never produces an AuditEvent.
export function changedFields(stored: StoredEncounterInput, patch: EncounterPatch): string[] {
  const changed: string[] = []
  if (patch.facilityId !== undefined && patch.facilityId !== stored.facilityId) changed.push('facilityId')
  if (patch.clinicianId !== undefined && patch.clinicianId !== stored.clinicianId) changed.push('clinicianId')
  if (patch.insuranceMembershipId !== undefined && patch.insuranceMembershipId !== stored.insuranceMembershipId) changed.push('insuranceMembershipId')
  if (patch.serviceDate !== undefined && patch.serviceDate.getTime() !== stored.serviceDate.getTime()) changed.push('serviceDate')
  return changed
}

// ---- §8/§10–§12 context decision ----------------------------------------------------------------

// What the service read and resolved INSIDE the write transaction, after taking the locks.
export type ContextFacts = {
  patientId: string
  patientOrganizationId: string
  serviceDate: Date
  clinician: { organizationId: string } | null
  facility: { organizationId: string } | null
  membership: { patientId: string; coverageFrom: Date | null; coverageTo: Date | null } | null | 'not-supplied'
  assignment: { status: 'RESOLVED'; id: string } | { status: 'NO_MATCH' } | { status: 'INTEGRITY_CONFLICT'; matchedIds: string[] }
  profile: { kind: 'one'; id: string } | { kind: 'none' } | { kind: 'many'; profileIds: string[] }
}

export type ContextDecision =
  | { ok: true; clinicianFacilityAssignmentId: string; facilityRegulatoryProfileId: string }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR'; message: string }

// Fail closed at every step. Missing and foreign masters — and a membership of another patient —
// are refused identically as "not found", so a caller never learns another record exists. Zero or
// several assignment/profile matches block the write; nothing is ever chosen by order. A recorded
// membership boundary that excludes the service date is a recorded-context mismatch; an unknown
// boundary is never invented, and passing this check is NOT eligibility.
export function decideEncounterContext(facts: ContextFacts): ContextDecision {
  const own = (master: { organizationId: string } | null) => master !== null && master.organizationId === facts.patientOrganizationId
  if (!own(facts.clinician)) return { ok: false, code: 'NOT_FOUND', message: 'clinician not found' }
  if (!own(facts.facility)) return { ok: false, code: 'NOT_FOUND', message: 'facility not found' }
  if (facts.membership !== 'not-supplied') {
    if (facts.membership === null || facts.membership.patientId !== facts.patientId)
      return { ok: false, code: 'NOT_FOUND', message: 'insurance membership not found' }
  }

  if (facts.assignment.status === 'NO_MATCH')
    return { ok: false, code: 'VALIDATION_ERROR', message: 'no clinician-facility assignment is effective on serviceDate for this clinician and facility' }
  if (facts.assignment.status === 'INTEGRITY_CONFLICT')
    return { ok: false, code: 'VALIDATION_ERROR', message: 'clinician-facility assignment integrity conflict: more than one assignment is effective on serviceDate' }

  if (facts.profile.kind === 'none')
    return { ok: false, code: 'VALIDATION_ERROR', message: 'no ACTIVE facility regulatory profile is effective on serviceDate for this facility' }
  if (facts.profile.kind === 'many')
    return { ok: false, code: 'VALIDATION_ERROR', message: 'facility regulatory profile integrity conflict: more than one ACTIVE profile is effective on serviceDate' }

  if (facts.membership !== 'not-supplied' && facts.membership !== null) {
    const { coverageFrom, coverageTo } = facts.membership
    const date = facts.serviceDate.getTime()
    if ((coverageFrom !== null && date < coverageFrom.getTime()) || (coverageTo !== null && date > coverageTo.getTime()))
      return { ok: false, code: 'VALIDATION_ERROR', message: 'serviceDate is outside the recorded coverage period of the selected insurance membership' }
  }

  return { ok: true, clinicianFacilityAssignmentId: facts.assignment.id, facilityRegulatoryProfileId: facts.profile.id }
}

export function toEncounterDto(record: {
  id: string
  patientId: string
  facilityId: string
  clinicianId: string
  insuranceMembershipId: string | null
  serviceDate: Date
  clinicianFacilityAssignmentId: string
  facilityRegulatoryProfileId: string
  createdAt: Date
  updatedAt: Date
}): EncounterDto {
  return {
    id: record.id,
    patientId: record.patientId,
    facilityId: record.facilityId,
    clinicianId: record.clinicianId,
    insuranceMembershipId: record.insuranceMembershipId,
    serviceDate: formatDateOnly(record.serviceDate) as string,
    clinicianFacilityAssignmentId: record.clinicianFacilityAssignmentId,
    facilityRegulatoryProfileId: record.facilityRegulatoryProfileId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}
