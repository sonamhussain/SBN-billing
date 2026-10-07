import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { CoverageCreateDialog } from '../features/insurance-membership/CoverageCreateDialog.tsx'
import { CoverageList } from '../features/insurance-membership/CoverageList.tsx'
import { useMemberships } from '../features/insurance-membership/insurance-membership.queries.ts'
import { PatientEditorSheet } from '../features/patient/PatientEditorSheet.tsx'
import { PatientSummary } from '../features/patient/PatientSummary.tsx'
import { usePatient } from '../features/patient/patient.queries.ts'
import { PermissionGate } from '../shared/auth/PermissionGate.tsx'
import { PageHeader } from '../shared/layout/PageHeader.tsx'
import { Button } from '../shared/ui/Button.tsx'
import { Skeleton } from '../shared/ui/Skeleton.tsx'

// FE-02 — a calm Patient Workspace: identity, recorded coverage and a truthful Encounter placeholder.
// A missing record and another organization's record look the same: unavailable.
export default function PatientWorkspacePage() {
  const { patientId = '' } = useParams()
  const patient = usePatient(patientId)
  // Coverage is requested only after the Patient itself has loaded, so a missing or foreign Patient never
  // triggers a membership request and nothing reveals whether memberships exist.
  const memberships = useMemberships(patient.data ? patientId : '')

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

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Encounters</h2>
        <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-500">
          Encounter workspace arrives in FE-03.
        </div>
      </section>
    </>
  )
}
