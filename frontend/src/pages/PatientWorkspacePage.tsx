import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { CoverageCreateDialog } from '../features/insurance-membership/CoverageCreateDialog.tsx'
import { CoverageList } from '../features/insurance-membership/CoverageList.tsx'
import { EncounterCreateDialog } from '../features/encounter/EncounterCreateDialog.tsx'
import { EncounterList } from '../features/encounter/EncounterList.tsx'
import { usePatientEncounters } from '../features/encounter/encounter.queries.ts'
import { useMemberships } from '../features/insurance-membership/insurance-membership.queries.ts'
import { PatientEditorSheet } from '../features/patient/PatientEditorSheet.tsx'
import { PatientSummary } from '../features/patient/PatientSummary.tsx'
import { usePatient } from '../features/patient/patient.queries.ts'
import { PermissionGate } from '../shared/auth/PermissionGate.tsx'
import { usePermission } from '../shared/auth/usePermission.ts'
import { PageHeader } from '../shared/layout/PageHeader.tsx'
import { Button } from '../shared/ui/Button.tsx'
import { EmptyState } from '../shared/ui/EmptyState.tsx'
import { RecordSection } from '../shared/ui/RecordSection.tsx'
import { Skeleton } from '../shared/ui/Skeleton.tsx'

// FE-02 — a calm Patient Workspace: identity and recorded coverage. FE-03 — and the Patient's recorded
// Encounters from the Patient-scoped list route.
// A missing record and another organization's record look the same: unavailable.
export default function PatientWorkspacePage() {
  const { patientId = '' } = useParams()
  const patient = usePatient(patientId)
  // Coverage is requested only after the Patient itself has loaded, so a missing or foreign Patient never
  // triggers a membership request and nothing reveals whether memberships exist.
  const memberships = useMemberships(patient.data ? patientId : '')
  // The same sequencing for Encounters: requested only once the Patient is accessible and only with
  // encounter.read.
  const canReadEncounters = usePermission().can('encounter.read')
  const encounters = usePatientEncounters(patient.data && canReadEncounters ? patientId : '')

  if (patient.isPending) return <Skeleton className="h-40 w-full" />
  if (!patient.data) {
    return (
      <>
        <nav aria-label="Back" className="mb-4 text-sm text-slate-500">
          <Link to="/app/patients" className="inline-flex items-center gap-1.5 hover:text-slate-950">
            <ArrowLeft aria-hidden="true" size={15} /> Patients
          </Link>
        </nav>
        <p role="alert" className="text-sm text-red-700">
          This patient record is unavailable.
        </p>
      </>
    )
  }

  return (
    <>
      <nav aria-label="Back" className="mb-4 text-sm text-slate-500">
        <Link to="/app/patients" className="inline-flex items-center gap-1.5 hover:text-slate-950">
          <ArrowLeft aria-hidden="true" size={15} /> Patients
        </Link>
      </nav>

      <PageHeader
        eyebrow="Patient record"
        title={patient.data.displayName}
        action={
          <div className="flex items-center gap-3">
            <PermissionGate permission="patient.update">
              <PatientEditorSheet
                patient={patient.data}
                trigger={
                  <Button className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50">Edit patient</Button>
                }
              />
            </PermissionGate>
            <PermissionGate permission="insuranceMembership.create">
              <CoverageCreateDialog patientId={patientId} trigger={<Button>Add coverage</Button>} />
            </PermissionGate>
          </div>
        }
      />

      <PatientSummary patient={patient.data} />

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold">Coverage</h2>
          <p className="mt-1 text-sm text-slate-500">Recorded insurance memberships. Eligibility is checked separately.</p>
        </div>

        {memberships.isPending && <Skeleton className="h-28 w-full" />}
        {memberships.isError && !memberships.data && (
          <p role="alert" className="text-sm text-red-700">
            Coverage could not be loaded.
          </p>
        )}
        {memberships.data && <CoverageList items={memberships.data} />}
      </section>

      <RecordSection
        title="Encounters"
        description="Recorded service events for this patient."
        action={
          <PermissionGate permission="encounter.create">
            <EncounterCreateDialog
              patientId={patientId}
              trigger={<Button className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50">New encounter</Button>}
            />
          </PermissionGate>
        }
      >
        {!canReadEncounters && <EmptyState title="Encounters are not available to you." />}
        {canReadEncounters && encounters.isPending && <Skeleton className="h-28 w-full" />}
        {encounters.isError && !encounters.data && (
          <p role="alert" className="text-sm text-red-700">
            Encounters could not be loaded.
          </p>
        )}
        {encounters.data && <EncounterList items={encounters.data} />}
      </RecordSection>
    </>
  )
}
