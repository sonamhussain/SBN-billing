import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { EncounterList } from '../features/encounter/EncounterList.tsx'
import { usePatientEncounters } from '../features/encounter/encounter.queries.ts'
import { usePatients } from '../features/patient/patient.queries.ts'
import type { Patient } from '../features/patient/patient.types.ts'
import { usePermission } from '../shared/auth/usePermission.ts'
import { formatDateOnly } from '../shared/format/date.ts'
import { PageHeader } from '../shared/layout/PageHeader.tsx'
import { useOrganization } from '../shared/organization/useOrganization.ts'
import { EmptyState } from '../shared/ui/EmptyState.tsx'
import { Skeleton } from '../shared/ui/Skeleton.tsx'

// FE-04 — Billing entry: choose a Patient, then one of their Encounters for billing review. The backend has
// no organization-wide billing queue, so none is assembled here; the chosen Patient is held in page state
// only, never in the URL or browser storage.

function PatientEncounters({ patient, onBack }: { patient: Patient; onBack: () => void }) {
  const canRead = usePermission().can('encounter.read')
  const encounters = usePatientEncounters(canRead ? patient.id : '')

  return (
    <>
      <button type="button" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-950" onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={15} /> All patients
      </button>
      <h2 className="mb-3 text-lg font-semibold text-slate-950">{patient.displayName}</h2>
      {!canRead && <EmptyState title="Encounters are not available to you." />}
      {canRead && encounters.isPending && <Skeleton className="h-28 w-full" />}
      {encounters.isError && !encounters.data && (
        <p role="alert" className="text-sm text-red-700">
          Encounters could not be loaded.
        </p>
      )}
      {encounters.data && <EncounterList items={encounters.data} linkTo={(encounter) => `/app/billing/encounters/${encounter.id}`} />}
    </>
  )
}

export default function BillingPage() {
  const { organizationId } = useOrganization()
  const patients = usePatients(organizationId)
  const [patient, setPatient] = useState<Patient | null>(null)

  return (
    <>
      <PageHeader eyebrow="Billing" title="Billing" />
      <p className="-mt-3 mb-6 text-sm text-slate-500">Billing review is opened per encounter. Choose a patient, then an encounter.</p>

      {patient ? (
        <PatientEncounters patient={patient} onBack={() => setPatient(null)} />
      ) : (
        <>
          {patients.isPending && <Skeleton className="h-28 w-full" />}
          {patients.isError && !patients.data && (
            <p role="alert" className="text-sm text-red-700">
              Patients could not be loaded.
            </p>
          )}
          {patients.data &&
            (patients.data.length === 0 ? (
              <EmptyState title="No patients recorded yet." />
            ) : (
              <ul className="divide-y divide-slate-200 border-y border-slate-200">
                {patients.data.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="grid w-full grid-cols-[1fr_10rem] gap-4 px-1 py-3.5 text-left hover:bg-slate-50 focus-visible:bg-slate-50"
                      onClick={() => setPatient(item)}
                    >
                      <span className="font-medium text-slate-950">{item.displayName}</span>
                      <span className="text-sm text-slate-600">{formatDateOnly(item.dateOfBirth)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}
    </>
  )
}
