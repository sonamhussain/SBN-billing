import { useState, type ReactNode } from 'react'
import { formatDateOnly } from '../../shared/format/date.ts'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { Sheet } from '../../shared/ui/Sheet.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { useFacilityName } from '../encounter-lookups/encounter-lookups.queries.ts'
import { useOwnerItems, useOwnerRecord } from '../admin/owner-query.ts'

// FE-05 — a Clinician's recorded A4.2 assignments, read-only, from the assignment owner routes. Facility
// and Specialty names are read by ID. A facility named by an assignment is a known facility context, so its
// recorded regulatory profiles can be shown (read-only) beneath it. Nothing is created, inferred or
// resolved here: the assignment and profile periods are shown exactly as recorded, and no "current" one is
// chosen.

type Assignment = { id: string; effectiveFrom: string; effectiveTo: string | null }
type FacilityAssignment = Assignment & { facilityId: string }
type SpecialtyAssignment = Assignment & { specialtyId: string }
type RegulatoryProfile = {
  id: string
  jurisdictionCode: string
  regulatoryAuthorityCode: string
  effectiveFrom: string
  effectiveTo: string | null
  status: string
}

// A period with neither end recorded reads as one "Not recorded" rather than two placeholders.
const period = (from: string | null, to: string | null) =>
  !from && !to ? 'Not recorded' : `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`

function RegulatoryProfiles({ facilityId }: { facilityId: string }) {
  const profiles = useOwnerItems<RegulatoryProfile>(`/api/facilities/${facilityId}/regulatory-profiles`, 'facility_regulatory_profile.read')
  if (!profiles.permitted) return <p className="text-xs text-slate-500">Regulatory profiles are not available to you.</p>
  if (profiles.isPending) return <Skeleton className="h-6 w-full" />
  if (profiles.isError) return <p className="text-xs text-red-700">Regulatory profiles could not be loaded.</p>
  if (profiles.data.length === 0) return <p className="text-xs text-slate-500">No regulatory profile recorded.</p>
  return (
    <ul className="space-y-0.5 text-xs text-slate-600">
      {profiles.data.map((profile) => (
        <li key={profile.id}>
          {profile.jurisdictionCode} / {profile.regulatoryAuthorityCode} · {profile.status} · {period(profile.effectiveFrom, profile.effectiveTo)}
        </li>
      ))}
    </ul>
  )
}

function FacilityAssignmentRow({ assignment }: { assignment: FacilityAssignment }) {
  const facility = useFacilityName(assignment.facilityId)
  const [open, setOpen] = useState(false)
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-slate-950">{facility}</p>
          <p className="text-xs text-slate-500">{period(assignment.effectiveFrom, assignment.effectiveTo)}</p>
        </div>
        <button type="button" aria-expanded={open} className="shrink-0 text-xs text-[var(--sbn-accent)] hover:underline" onClick={() => setOpen(!open)}>
          {open ? 'Hide regulatory profiles' : 'Regulatory profiles'}
        </button>
      </div>
      {open && (
        <div className="mt-2 rounded-md bg-slate-50 p-2">
          <RegulatoryProfiles facilityId={assignment.facilityId} />
        </div>
      )}
    </li>
  )
}

function SpecialtyAssignmentRow({ assignment }: { assignment: SpecialtyAssignment }) {
  const specialty = useOwnerRecord<{ displayName: string }>(`/api/specialties/${assignment.specialtyId}`, 'specialty.read')
  const name = !specialty.permitted || specialty.isError ? 'Unavailable' : (specialty.data?.displayName ?? 'Loading...')
  return (
    <li className="px-3 py-2 text-sm">
      <p className="font-medium text-slate-950">{name}</p>
      <p className="text-xs text-slate-500">{period(assignment.effectiveFrom, assignment.effectiveTo)}</p>
    </li>
  )
}

function AssignmentList<T extends { id: string }>({
  title,
  query,
  render,
}: {
  title: string
  query: { data: T[] | undefined; isPending: boolean; isError: boolean; permitted: boolean }
  render: (item: T) => ReactNode
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
      {!query.permitted && <EmptyState title={`${title} are not available to you.`} />}
      {query.permitted && query.isPending && <Skeleton className="h-12 w-full" />}
      {query.isError && <p className="text-sm text-red-700">{title} could not be loaded.</p>}
      {query.data &&
        (query.data.length === 0 ? (
          <EmptyState title={`No ${title.toLowerCase()} recorded`} />
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">{query.data.map(render)}</ul>
        ))}
    </section>
  )
}

function Assignments({ clinicianId }: { clinicianId: string }) {
  const facilities = useOwnerItems<FacilityAssignment>(`/api/clinicians/${clinicianId}/facility-assignments`, 'clinicianAssignment.read')
  const specialties = useOwnerItems<SpecialtyAssignment>(`/api/clinicians/${clinicianId}/specialty-assignments`, 'clinicianAssignment.read')
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">Recorded assignment history. Assignments are managed by their owner records and are shown here read-only.</p>
      <AssignmentList title="Facility assignments" query={facilities} render={(item) => <FacilityAssignmentRow key={item.id} assignment={item} />} />
      <AssignmentList title="Specialty assignments" query={specialties} render={(item) => <SpecialtyAssignmentRow key={item.id} assignment={item} />} />
    </div>
  )
}

export function ClinicianDetailSheet({ clinicianId, name }: { clinicianId: string; name: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet
      title={name}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100">
          Assignments
        </button>
      }
    >
      {open && <Assignments clinicianId={clinicianId} />}
    </Sheet>
  )
}
