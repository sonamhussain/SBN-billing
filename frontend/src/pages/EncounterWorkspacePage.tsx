import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ActivityCreateDialog } from '../features/encounter-activity/ActivityCreateDialog.tsx'
import { ActivityList } from '../features/encounter-activity/ActivityList.tsx'
import { useEncounterActivities } from '../features/encounter-activity/encounter-activity.queries.ts'
import { EncounterContextPanel } from '../features/encounter-context/EncounterContextPanel.tsx'
import { DiagnosisAddDialog } from '../features/encounter-diagnosis/DiagnosisAddDialog.tsx'
import { DiagnosisList } from '../features/encounter-diagnosis/DiagnosisList.tsx'
import { useEncounterDiagnoses } from '../features/encounter-diagnosis/encounter-diagnosis.queries.ts'
import { EncounterEditorSheet } from '../features/encounter/EncounterEditorSheet.tsx'
import { useRecordedMemberships } from '../features/encounter/encounter-membership.ts'
import { useEncounter } from '../features/encounter/encounter.queries.ts'
import type { Encounter } from '../features/encounter/encounter.types.ts'
import { useClinicianName, useFacilityName } from '../features/encounter-lookups/encounter-lookups.queries.ts'
import { ObservationCreateDialog } from '../features/encounter-observation/ObservationCreateDialog.tsx'
import { ObservationList } from '../features/encounter-observation/ObservationList.tsx'
import { useEncounterObservations } from '../features/encounter-observation/encounter-observation.queries.ts'
import { usePatient } from '../features/patient/patient.queries.ts'
import { PermissionGate } from '../shared/auth/PermissionGate.tsx'
import { usePermission } from '../shared/auth/usePermission.ts'
import { formatDateOnly } from '../shared/format/date.ts'
import { PageHeader } from '../shared/layout/PageHeader.tsx'
import { Button } from '../shared/ui/Button.tsx'
import { DetailItem } from '../shared/ui/DetailItem.tsx'
import { EmptyState } from '../shared/ui/EmptyState.tsx'
import { RecordSection } from '../shared/ui/RecordSection.tsx'
import { Skeleton } from '../shared/ui/Skeleton.tsx'

// FE-03 — the permanent Encounter Workspace: the recorded service event and its billing facts, as
// sections rather than a tab per backend module. One primary action (Edit encounter); every section
// action is local and permission-gated. Nothing here says eligible, authorized, ready or approved.
// A missing Encounter and another organization's Encounter look the same: unavailable.

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'

function ListState<T>({ query, failed, children }: { query: { isPending: boolean; isError: boolean; data: T | undefined }; failed: string; children: (data: T) => ReactNode }) {
  if (query.isPending) return <Skeleton className="h-20 w-full" />
  if (query.isError && query.data === undefined) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {failed}
      </p>
    )
  }
  return query.data === undefined ? null : <>{children(query.data)}</>
}

const notAvailable = (what: string) => <EmptyState title={`${what} are not available to you.`} />

function EncounterWorkspace({ encounter }: { encounter: Encounter }) {
  const { can } = usePermission()
  const patient = usePatient(can('patient.read') ? encounter.patientId : '')
  const facility = useFacilityName(encounter.facilityId)
  const clinician = useClinicianName(encounter.clinicianId)
  const membership = useRecordedMemberships(encounter.patientId).labelFor(encounter.insuranceMembershipId)
  const diagnoses = useEncounterDiagnoses(encounter.id, can('encounterDiagnosis.read'))
  const activities = useEncounterActivities(encounter.id, can('encounterActivity.read'))
  const observations = useEncounterObservations(encounter.id, can('encounterObservation.read'))

  return (
    <>
      <nav aria-label="Back" className="mb-4 text-sm text-slate-500">
        <Link to={`/app/patients/${encounter.patientId}`} className="inline-flex items-center gap-1.5 hover:text-slate-950">
          <ArrowLeft aria-hidden="true" size={15} /> {patient.data?.displayName ?? 'Patient record'} / Encounters
        </Link>
      </nav>

      <PageHeader
        eyebrow="Encounter"
        title={`Encounter — ${formatDateOnly(encounter.serviceDate)}`}
        action={
          <div className="flex items-center gap-3">
            {/* FE-04 — a permission-neutral way into Billing review; the Billing page gates its own reads. */}
            <Link
              to={`/app/billing/encounters/${encounter.id}`}
              className="inline-flex min-h-10 items-center rounded-md px-3 text-sm font-medium text-[var(--sbn-accent)] hover:bg-slate-100"
            >
              Billing review
            </Link>
            <PermissionGate permission="encounter.update">
              <EncounterEditorSheet encounter={encounter} trigger={<Button className={secondaryButton}>Edit encounter</Button>} />
            </PermissionGate>
          </div>
        }
      />
      <p className="-mt-4 mb-6 text-sm text-slate-500">
        {facility} • {clinician} • {encounter.insuranceMembershipId === null ? 'No recorded insurance' : 'Recorded insurance'}
      </p>

      <section aria-labelledby="encounter-details" className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 id="encounter-details" className="text-sm font-semibold text-slate-950">
          Encounter details
        </h2>
        <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailItem label="Service date" value={formatDateOnly(encounter.serviceDate)} />
          <DetailItem label="Facility" value={facility} />
          <DetailItem label="Clinician" value={clinician} />
          <DetailItem label="Recorded membership" value={membership} />
        </dl>
      </section>

      <RecordSection
        title="Diagnoses"
        description="Active diagnoses in their recorded order. The order is not a principal or primary designation."
        action={
          <PermissionGate permission="encounterDiagnosis.create">
            <DiagnosisAddDialog encounterId={encounter.id} trigger={<Button className={secondaryButton}>Add diagnosis</Button>} />
          </PermissionGate>
        }
      >
        <PermissionGate permission="encounterDiagnosis.read" fallback={notAvailable('Diagnoses')}>
          <ListState query={diagnoses} failed="Diagnoses could not be loaded.">
            {(items) => <DiagnosisList encounterId={encounter.id} items={items} />}
          </ListState>
        </PermissionGate>
      </RecordSection>

      <RecordSection
        title="Services / activities"
        description="To correct a recorded activity, remove it and add the corrected one."
        action={
          <PermissionGate permission="encounterActivity.create">
            <ActivityCreateDialog encounterId={encounter.id} trigger={<Button className={secondaryButton}>Add activity</Button>} />
          </PermissionGate>
        }
      >
        <PermissionGate permission="encounterActivity.read" fallback={notAvailable('Activities')}>
          <ListState query={activities} failed="Activities could not be loaded.">
            {(items) => <ActivityList encounterId={encounter.id} items={items} />}
          </ListState>
        </PermissionGate>
      </RecordSection>

      <RecordSection
        title="Structured facts"
        description="Additional recorded billing facts. To correct a fact, remove it and add the corrected one."
        action={
          <PermissionGate permission="encounterObservation.create">
            <ObservationCreateDialog encounterId={encounter.id} activities={activities.data} trigger={<Button className={secondaryButton}>Add fact</Button>} />
          </PermissionGate>
        }
      >
        <PermissionGate permission="encounterObservation.read" fallback={notAvailable('Structured facts')}>
          <ListState query={observations} failed="Structured facts could not be loaded.">
            {(items) => <ObservationList encounterId={encounter.id} items={items} activities={activities.data} />}
          </ListState>
        </PermissionGate>
      </RecordSection>

      <PermissionGate permission="encounterBillingContext.read">
        <RecordSection title="Billing context" description="Read-only. Shown as one current snapshot from the backend.">
          <EncounterContextPanel encounterId={encounter.id} />
        </RecordSection>
      </PermissionGate>
    </>
  )
}

export default function EncounterWorkspacePage() {
  const { encounterId = '' } = useParams()
  const encounter = useEncounter(encounterId)

  if (encounter.isPending) return <Skeleton className="h-40 w-full" />
  if (!encounter.data) {
    return (
      <>
        <nav aria-label="Back" className="mb-4 text-sm text-slate-500">
          <Link to="/app/encounters" className="inline-flex items-center gap-1.5 hover:text-slate-950">
            <ArrowLeft aria-hidden="true" size={15} /> Encounters
          </Link>
        </nav>
        <p role="alert" className="text-sm text-red-700">
          This encounter record is unavailable.
        </p>
      </>
    )
  }

  // Child sections mount only once the Encounter itself is accessible, so a missing or foreign
  // Encounter never triggers a diagnosis, activity, fact, membership or context request.
  return <EncounterWorkspace key={encounter.data.id} encounter={encounter.data} />
}
