import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { useClinicianOptions, useFacilityAssignments, useFacilityNames } from '../encounter-lookups/encounter-lookups.queries.ts'
import { useRecordedMemberships } from './encounter-membership.ts'

// FE-03 — the Encounter form state and the option lists it needs, shared by create and edit.

export type EncounterDraft = {
  serviceDate: string
  clinicianId: string
  facilityId: string
  // '' means "Not recorded".
  insuranceMembershipId: string
}

export const emptyEncounterDraft: EncounterDraft = { serviceDate: '', clinicianId: '', facilityId: '', insuranceMembershipId: '' }

// Required options that could not be loaded stop the form instead of offering a fallback.
export function useEncounterFormOptions(patientId: string, draft: EncounterDraft, open: boolean) {
  const { organizationId } = useOrganization()
  const clinicians = useClinicianOptions(organizationId, open)
  const assignments = useFacilityAssignments(open ? draft.clinicianId : '')
  const facilityIds = [...new Set((assignments.data ?? []).map((assignment) => assignment.facilityId))]
  const facilityNames = useFacilityNames(facilityIds)
  const memberships = useRecordedMemberships(open ? patientId : '')

  const blocked =
    !clinicians.permitted ||
    clinicians.isError ||
    !assignments.permitted ||
    assignments.isError ||
    (facilityIds.length > 0 && facilityNames.unavailable)

  return { clinicians, assignments, facilityIds, facilityNames, memberships, blocked }
}
