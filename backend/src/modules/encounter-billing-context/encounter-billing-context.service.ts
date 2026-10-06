import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import type { EncounterBillingContextResult, EncounterBillingContextV1 } from './encounter-billing-context.types.ts'
import {
  billingDisplayName,
  isEncounterBillingContextUuid,
  orderExternalIdentifiers,
  verifyObservationAnchors,
  verifySelectedMembership,
  verifyStoredAssignment,
  verifyStoredProfile,
} from './encounter-billing-context.validation.ts'
import {
  findActiveActivities,
  findActiveDiagnoses,
  findActiveObservations,
  findEncounterForBillingContext,
  findExternalIdentifiersForEncounterContext,
  findStoredAssignment,
  findStoredRegulatoryProfile,
  readTransactionTimestamp,
} from './encounter-billing-context.repository.ts'
import { toEncounterDto } from '../encounter/encounter.validation.ts'
import { toMembershipDto } from '../insurance-membership/insurance-membership.validation.ts'
import { toFacilityDto as toAssignmentDto } from '../clinician-assignment/clinician-assignment.validation.ts'
import { toFacilityRegulatoryProfileDto } from '../facility-regulatory/facility-regulatory.validation.ts'
import { toExternalIdentifierDto } from '../external-identifier/external-identifier.validation.ts'
import { checkReadInvariant, toEncounterDiagnosisDto } from '../encounter-diagnosis/encounter-diagnosis.validation.ts'
import { checkModifierInvariant, toEncounterActivityDto } from '../encounter-activity/encounter-activity.validation.ts'
import { toEncounterObservationDto, verifyStoredObservation } from '../encounter-observation/encounter-observation.validation.ts'

// A4.9 — compose and verify. This service creates no billing fact, decides no eligibility, selects
// no contract or tariff, evaluates no rule and writes nothing. It assembles what A4.1-A4.8 already
// own into one bundle read from a single database snapshot, and it fails closed when the stored
// relationships contradict each other.
//
// The read runs inside `withReadSnapshot`, which opens a REPEATABLE READ transaction and issues
// `SET TRANSACTION READ ONLY` before the first query. Two things follow from that, and both are
// load-bearing:
//
//   * every query below sees the same instant, so the bundle can never mix a pre-correction
//     diagnosis list with a post-correction activity list;
//   * PostgreSQL itself refuses any write on this path, so "a read has no side effects" is an
//     engine guarantee here rather than a convention someone has to keep.
//
// No row locks are taken. A consistent snapshot is sufficient for a read, and locking would block
// the ordinary corrections that clinicians and coders make while a context is being assembled.

const conflict = (message: string): EncounterBillingContextResult<never> => ({
  ok: false,
  code: 'INTEGRITY_CONFLICT',
  message,
})

export async function loadEncounterBillingContext(
  encounterId: unknown,
): Promise<EncounterBillingContextResult<EncounterBillingContextV1>> {
  if (!isEncounterBillingContextUuid(encounterId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid encounter id' }

  return withReadSnapshot(undefined, async (tx) => {
    const assembledAt = await readTransactionTimestamp(tx)
    // The REPEATABLE READ snapshot is established by the statement above. Acceptance holds the read
    // here, commits a correction from another connection, then releases: everything loaded below
    // must still reflect the pre-correction state, proving the bundle is one snapshot rather than a
    // sequence of independent reads. In normal operation this is a no-op.
    await concurrencyProbe('encounter_billing_context.snapshot')
    const encounter = await findEncounterForBillingContext(encounterId, tx)
    if (!encounter) return { ok: false, code: 'NOT_FOUND', message: 'encounter not found' }

    const binding = {
      id: encounter.id,
      clinicianId: encounter.clinicianId,
      facilityId: encounter.facilityId,
      patientId: encounter.patientId,
      serviceDate: encounter.serviceDate,
      clinicianFacilityAssignmentId: encounter.clinicianFacilityAssignmentId,
      facilityRegulatoryProfileId: encounter.facilityRegulatoryProfileId,
      insuranceMembershipId: encounter.insuranceMembershipId,
    }

    // ---- provider and regulatory context: the EXACT stored rows, verified, never re-resolved
    const assignmentRow = await findStoredAssignment(encounter.clinicianFacilityAssignmentId, tx)
    const assignment = verifyStoredAssignment(binding, assignmentRow)
    if (!assignment.ok) return conflict(assignment.message)

    const profileRow = await findStoredRegulatoryProfile(encounter.facilityRegulatoryProfileId, tx)
    const profile = verifyStoredProfile(binding, profileRow)
    if (!profile.ok) return conflict(profile.message)

    // ---- registration context: recorded truth only, never an eligibility judgement
    const membership = verifySelectedMembership(binding, encounter.insuranceMembership)
    if (!membership.ok) return conflict(membership.message)

    // ---- child facts: the owners' invariants decide, A4.9 only relays the verdict
    const diagnosisRows = await findActiveDiagnoses(encounter.id, tx)
    const diagnosisInvariant = checkReadInvariant(
      diagnosisRows.map((row) => ({ id: row.id, diagnosisCodeId: row.diagnosisCodeId, sequence: row.sequence })),
    )
    if (!diagnosisInvariant.ok) return conflict(`stored diagnoses: ${diagnosisInvariant.message}`)

    const activityRows = await findActiveActivities(encounter.id, tx)
    const activities = []
    for (const row of activityRows) {
      const modifiers = checkModifierInvariant(row.modifiers.map((modifier) => ({ sequence: modifier.sequence, code: modifier.code })))
      if (!modifiers.ok) return conflict(`stored activity ${row.id}: ${modifiers.message}`)
      activities.push(toEncounterActivityDto(row, modifiers.value))
    }

    const observationRows = await findActiveObservations(encounter.id, tx)
    const anchors = verifyObservationAnchors(
      encounter.id,
      observationRows.map((row) => ({ id: row.id, encounterActivityId: row.encounterActivityId })),
      activityRows.map((row) => ({ id: row.id, encounterId: row.encounterId, removedAt: row.removedAt })),
    )
    if (!anchors.ok) return conflict(anchors.message)

    const observations = []
    for (const row of observationRows) {
      // A4.7's own invariant also wants the anchored activity's encounter, so it can catch a
      // cross-encounter anchor from the value side as well.
      const value = verifyStoredObservation({ ...row, activityEncounterId: row.encounterActivity?.encounterId ?? null })
      if (!value.ok) return conflict(`stored observation ${row.id}: ${value.message}`)
      observations.push(toEncounterObservationDto(row, value.value))
    }

    // ---- outside-system mappings: every match, in a deterministic order, none preferred
    const identifierRows = await findExternalIdentifiersForEncounterContext(encounter.patientId, encounter.id, tx)
    const identifiers = orderExternalIdentifiers(identifierRows).map((row) => toExternalIdentifierDto(row))

    return {
      ok: true,
      value: {
        schemaVersion: 'EncounterBillingContextV1',
        assembledAt: assembledAt.toISOString(),
        organizationId: encounter.patient.organizationId,
        encounter: toEncounterDto(encounter),
        patient: {
          id: encounter.patient.id,
          organizationId: encounter.patient.organizationId,
          givenName: encounter.patient.givenName,
          middleName: encounter.patient.middleName,
          familyName: encounter.patient.familyName,
          displayName: billingDisplayName(encounter.patient),
          dateOfBirth: formatDateOnly(encounter.patient.dateOfBirth) as string,
          updatedAt: encounter.patient.updatedAt.toISOString(),
        },
        facility: { id: encounter.facility.id, name: encounter.facility.name },
        clinician: { id: encounter.clinician.id, displayName: encounter.clinician.displayName },
        insuranceMembership: membership.value ? toMembershipDto(encounter.insuranceMembership as never) : null,
        providerContext: {
          clinicianFacilityAssignment: toAssignmentDto(assignmentRow as never),
          facilityRegulatoryProfile: toFacilityRegulatoryProfileDto(profileRow as never),
        },
        diagnoses: diagnosisRows.map((row) => toEncounterDiagnosisDto(row)),
        activities,
        observations,
        externalIdentifiers: {
          patient: identifiers.filter((identifier) => identifier.target.type === 'PATIENT'),
          encounter: identifiers.filter((identifier) => identifier.target.type === 'ENCOUNTER'),
        },
      },
    }
  })
}
