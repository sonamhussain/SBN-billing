import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatDateOnly } from '../../shared/format/date.ts'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { useClinicianName, useFacilityName } from '../encounter-lookups/encounter-lookups.queries.ts'
import type { Encounter } from './encounter.types.ts'

// FE-03 — a Patient's recorded Encounters from the Patient-scoped list route only, newest service date
// first. Rows show the service date, facility and clinician: no eligibility, authorization, readiness,
// claim or price column.

function EncounterRow({ encounter, to }: { encounter: Encounter; to: string }) {
  const facility = useFacilityName(encounter.facilityId)
  const clinician = useClinicianName(encounter.clinicianId)
  return (
    <Link
      to={to}
      className="grid grid-cols-[8rem_1fr_1fr_1rem] items-center gap-4 px-4 py-3.5 text-sm hover:bg-slate-50 focus-visible:bg-slate-50"
    >
      <span className="font-medium text-slate-950">{formatDateOnly(encounter.serviceDate)}</span>
      <span className="truncate text-slate-700">{facility}</span>
      <span className="truncate text-slate-700">{clinician}</span>
      <ChevronRight aria-hidden="true" size={16} className="text-slate-400" />
    </Link>
  )
}

// `linkTo` lets another workspace (FE-04 Billing) open the same rows in its own route; by default a row
// opens the Encounter Workspace.
export function EncounterList({
  items,
  linkTo = (encounter) => `/app/encounters/${encounter.id}`,
}: {
  items: Encounter[]
  linkTo?: (encounter: Encounter) => string
}) {
  if (items.length === 0) return <EmptyState title="No encounters recorded" message="Encounters recorded for this patient appear here." />

  // The backend lists by service date ascending (then creation, then id); the newest is shown first.
  const newestFirst = [...items].reverse()

  return (
    <div className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div aria-hidden="true" className="grid grid-cols-[8rem_1fr_1fr_1rem] gap-4 bg-slate-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        <span>Service date</span>
        <span>Facility</span>
        <span>Clinician</span>
        <span />
      </div>
      {newestFirst.map((encounter) => (
        <EncounterRow key={encounter.id} encounter={encounter} to={linkTo(encounter)} />
      ))}
    </div>
  )
}
