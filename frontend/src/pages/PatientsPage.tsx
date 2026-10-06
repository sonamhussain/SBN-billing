import { PatientCreateDialog } from '../features/patient/PatientCreateDialog.tsx'
import { PatientList } from '../features/patient/PatientList.tsx'
import { usePatients } from '../features/patient/patient.queries.ts'
import { PermissionGate } from '../shared/auth/PermissionGate.tsx'
import { PageHeader } from '../shared/layout/PageHeader.tsx'
import { useOrganization } from '../shared/organization/useOrganization.ts'
import { Button } from '../shared/ui/Button.tsx'
import { Skeleton } from '../shared/ui/Skeleton.tsx'

// FE-02 — the current organization's real Patient list. One primary action; no search (the backend has
// no search route), no cards, no counts.
export default function PatientsPage() {
  const { organizationId } = useOrganization()
  const patients = usePatients(organizationId)

  return (
    <>
      <PageHeader
        eyebrow="Patients"
        title="Patients"
        action={
          <PermissionGate permission="patient.create">
            <PatientCreateDialog trigger={<Button>New patient</Button>} />
          </PermissionGate>
        }
      />

      {patients.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      )}

      {/* A failed refresh keeps the list already shown; only a list that never loaded shows the error. */}
      {patients.isError && !patients.data && (
        <p role="alert" className="text-sm text-red-700">
          Patients could not be loaded.
        </p>
      )}

      {patients.data && <PatientList items={patients.data} />}
    </>
  )
}
