import { PatientList } from '../features/patient/PatientList.tsx'
import { usePatients } from '../features/patient/patient.queries.ts'
import { PageHeader } from '../shared/layout/PageHeader.tsx'
import { useOrganization } from '../shared/organization/useOrganization.ts'
import { Skeleton } from '../shared/ui/Skeleton.tsx'

// FE-03 — Encounters are recorded under a Patient and the backend lists them per Patient only, so this
// page is a truthful Patient chooser (the FE-02 Patient list), not an organization-wide Encounter list.
export default function EncountersPage() {
  const { organizationId } = useOrganization()
  const patients = usePatients(organizationId)

  return (
    <>
      <PageHeader eyebrow="Encounters" title="Encounters" />
      <p className="-mt-3 mb-6 text-sm text-slate-500">Encounters are recorded under a patient. Choose a patient to see and record their encounters.</p>

      {patients.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      )}

      {patients.isError && !patients.data && (
        <p role="alert" className="text-sm text-red-700">
          Patients could not be loaded.
        </p>
      )}

      {patients.data && <PatientList items={patients.data} />}
    </>
  )
}
