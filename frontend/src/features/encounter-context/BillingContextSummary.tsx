import type { UseQueryResult } from '@tanstack/react-query'
import { ApiClientError } from '../../shared/api/client.ts'
import { describeApiFailure } from '../../shared/api/error-message.ts'
import { formatDateOnly } from '../../shared/format/date.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { DetailItem } from '../../shared/ui/DetailItem.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { isContextConflict } from './context-conflict.ts'
import type { EncounterBillingContext } from './encounter-context.types.ts'

// FE-04 — the compact Billing context, taken directly from the one A4.9 aggregate (never composed from
// separate queries). A recorded membership is registration, not eligibility, and no member or policy
// identifier is shown. An integrity conflict is shown plainly; the Billing workspace then disables the
// actions that need a coherent context.

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const period = (from: string, to: string | null) => `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`

export function BillingContextSummary({ context, readable }: { context: UseQueryResult<EncounterBillingContext>; readable: boolean }) {
  if (!readable) return <EmptyState title="The billing context is not available to you." />
  if (context.isPending) return <Skeleton className="h-28 w-full" />
  if (context.isError) {
    const reference = context.error instanceof ApiClientError && context.error.requestId ? ` Request ID: ${context.error.requestId}` : ''
    return (
      <Alert tone="danger">
        {isContextConflict(context.error)
          ? `Encounter context is inconsistent and needs correction. Actions that depend on it are unavailable.${reference}`
          : describeApiFailure(context.error, 'The billing context')}
      </Alert>
    )
  }

  const data = context.data
  const profile = data.providerContext.facilityRegulatoryProfile
  return (
    <section aria-labelledby="billing-context" className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 id="billing-context" className="text-sm font-semibold text-slate-950">
        Context
      </h2>
      <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <DetailItem label="Patient" value={data.patient.displayName} />
        <DetailItem label="Service date" value={formatDateOnly(data.encounter.serviceDate)} />
        <DetailItem label="Facility" value={data.facility.name} />
        <DetailItem label="Clinician" value={data.clinician.displayName} />
        <DetailItem label="Recorded membership" value={data.insuranceMembership ? 'Recorded (not an eligibility result)' : 'Not recorded'} />
        <DetailItem
          label="Recorded facts"
          value={`${count(data.diagnoses.length, 'diagnosis', 'diagnoses')} · ${count(data.activities.length, 'activity', 'activities')} · ${count(data.observations.length, 'fact', 'facts')}`}
        />
        <DetailItem label="Regulatory context" value={`${profile.jurisdictionCode} / ${profile.regulatoryAuthorityCode} · ${profile.status}`} />
        <DetailItem label="Facility assignment period" value={period(data.providerContext.clinicianFacilityAssignment.effectiveFrom, data.providerContext.clinicianFacilityAssignment.effectiveTo)} />
      </dl>
    </section>
  )
}
