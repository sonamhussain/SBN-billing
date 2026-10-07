import { formatDateOnly } from '../../shared/format/date.ts'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { OptionPicker } from '../encounter-lookups/OptionPicker.tsx'
import type { ClinicianFacilityAssignment } from '../encounter-lookups/encounter-lookups.api.ts'
import type { EncounterDraft, useEncounterFormOptions } from './encounter-form.ts'

// FE-03 — the Encounter form shared by create and edit. The Patient is fixed by the route. Facility
// choices come only from the selected Clinician's recorded facility assignments, shown with their
// recorded periods as a chooser aid; the backend still resolves the exact assignment and regulatory
// profile for the service date. Every choice is a human-readable option; no UUID is ever typed.

function periodOf(assignment: ClinicianFacilityAssignment) {
  return `${formatDateOnly(assignment.effectiveFrom)} – ${assignment.effectiveTo ? formatDateOnly(assignment.effectiveTo) : 'no end recorded'}`
}

type FormOptions = ReturnType<typeof useEncounterFormOptions>

export function EncounterFields({
  draft,
  onChange,
  options,
}: {
  draft: EncounterDraft
  onChange: (next: EncounterDraft) => void
  options: FormOptions
}) {
  const { clinicians, assignments, facilityIds, facilityNames, memberships } = options

  const facilityOptions = facilityIds.map((facilityId) => {
    const periods = (assignments.data ?? []).filter((assignment) => assignment.facilityId === facilityId).map(periodOf)
    return { value: facilityId, label: `${facilityNames.names.get(facilityId) ?? 'Loading...'} (${periods.join('; ')})` }
  })

  function chooseClinician(clinicianId: string) {
    // A Facility the new Clinician has no recorded assignment at is cleared, never silently kept. The
    // assignments of the new Clinician load after this change, so the Facility is chosen again.
    onChange({ ...draft, clinicianId, facilityId: clinicianId === draft.clinicianId ? draft.facilityId : '' })
  }

  const noAssignments = draft.clinicianId !== '' && assignments.data !== undefined && assignments.data.length === 0

  return (
    <>
      <Field label="Service date">
        <Input type="date" required value={draft.serviceDate} onChange={(event) => onChange({ ...draft, serviceDate: event.target.value })} />
      </Field>
      <OptionPicker
        label="Clinician"
        required
        value={draft.clinicianId}
        onChange={chooseClinician}
        options={clinicians.data?.map((clinician) => ({ value: clinician.id, label: clinician.displayName }))}
        placeholder="Select a clinician"
        loading={clinicians.isPending && clinicians.permitted}
        unavailable={!clinicians.permitted || clinicians.isError}
      />
      <OptionPicker
        label="Facility"
        hint="(from the clinician's recorded facility assignments)"
        required
        value={draft.facilityId}
        onChange={(facilityId) => onChange({ ...draft, facilityId })}
        options={facilityOptions}
        placeholder={draft.clinicianId === '' ? 'Select a clinician first' : 'Select a facility'}
        loading={draft.clinicianId !== '' && (assignments.isPending || facilityNames.loading)}
        unavailable={!assignments.permitted || assignments.isError || (facilityIds.length > 0 && facilityNames.unavailable)}
        disabled={draft.clinicianId === ''}
      />
      {noAssignments && <p className="text-sm text-slate-500">This clinician has no recorded facility assignment.</p>}
      <OptionPicker
        label="Insurance membership"
        hint="(recorded membership; not an eligibility check)"
        value={draft.insuranceMembershipId}
        onChange={(insuranceMembershipId) => onChange({ ...draft, insuranceMembershipId })}
        options={memberships.options}
        placeholder="Not recorded"
        loading={memberships.loading}
        unavailable={memberships.unavailable}
      />
    </>
  )
}
