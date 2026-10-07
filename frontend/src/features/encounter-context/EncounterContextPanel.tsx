import { useState } from 'react'
import { ApiClientError } from '../../shared/api/client.ts'
import { formatDateOnly } from '../../shared/format/date.ts'
import { maskIdentifier } from '../../shared/format/mask.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { DetailItem } from '../../shared/ui/DetailItem.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { useEncounterBillingContext } from './encounter-context.queries.ts'
import type { ExternalReference } from './encounter-context.types.ts'

// FE-03 — the A4.9 "Current billing context", rendered only for encounterBillingContext.read and loaded
// only when asked for. Everything shown comes from the one aggregate response: the exact provider and
// regulatory rows the Encounter stored, and external references as secondary identifiers. It carries no
// eligibility, authorization, readiness, pricing or claim result, so none is shown. An integrity
// conflict is shown as such; no other record is substituted.

const loadedAtFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

function period(from: string, to: string | null) {
  return `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`
}

function failureMessage(error: unknown) {
  const reference = error instanceof ApiClientError && error.requestId ? ` Request ID: ${error.requestId}` : ''
  if (error instanceof ApiClientError) {
    if (error.status === 409) return `Encounter context is inconsistent and needs administrative correction.${reference}`
    if (error.status === 403) return `The billing context is not available to you.${reference}`
    if (error.status === 404) return `The billing context is unavailable.${reference}`
  }
  return `The billing context could not be loaded.${reference}`
}

function References({ title, items }: { title: string; items: ExternalReference[] }) {
  return (
    <div>
      <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-slate-400">None recorded</p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
          {items.map((reference) => (
            <li key={reference.id} className="break-all">
              <span className="text-slate-500">{reference.sourceSystem}:</span> {reference.externalValue}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function EncounterContextPanel({ encounterId }: { encounterId: string }) {
  const [requested, setRequested] = useState(false)
  const context = useEncounterBillingContext(encounterId, requested)

  if (!requested) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-5 text-sm">
        <p className="text-slate-600">The resolved provider and regulatory context and external references, read as one current snapshot.</p>
        <Button type="button" className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50" onClick={() => setRequested(true)}>
          View context
        </Button>
      </div>
    )
  }

  if (context.isPending) return <Skeleton className="h-40 w-full" />

  if (context.isError && !context.data) {
    return (
      <div className="space-y-3">
        <Alert tone="danger">{failureMessage(context.error)}</Alert>
        {!(context.error instanceof ApiClientError && [403, 404, 409].includes(context.error.status)) && (
          <Button type="button" className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50" onClick={() => context.refetch()}>
            Try again
          </Button>
        )}
      </div>
    )
  }

  const data = context.data
  if (!data) return null
  const { clinicianFacilityAssignment: assignment, facilityRegulatoryProfile: profile } = data.providerContext

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-slate-950">Current billing context</h3>
          <p className="mt-0.5 text-sm text-slate-500">Loaded at {loadedAtFormat.format(new Date(data.assembledAt))}</p>
        </div>
        <Button
          type="button"
          className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
          disabled={context.isFetching}
          onClick={() => context.refetch()}
        >
          {context.isFetching ? 'Loading...' : 'Reload'}
        </Button>
      </div>
      {context.isError && <div className="mt-3"><Alert tone="danger">{failureMessage(context.error)}</Alert></div>}

      <dl className="mt-5 grid gap-x-6 gap-y-4 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <DetailItem label="Facility" value={data.facility.name} />
        <DetailItem label="Clinician" value={data.clinician.displayName} />
        <DetailItem label="Service date" value={formatDateOnly(data.encounter.serviceDate)} />
        <DetailItem
          label="Recorded membership"
          value={data.insuranceMembership ? `Member ${maskIdentifier(data.insuranceMembership.memberIdentifier)}` : 'Not recorded'}
        />
      </dl>

      <h4 className="mt-6 text-sm font-semibold text-slate-950">Resolved provider and regulatory context</h4>
      <dl className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <DetailItem label="Facility assignment period" value={period(assignment.effectiveFrom, assignment.effectiveTo)} />
        <DetailItem label="Jurisdiction" value={profile.jurisdictionCode} />
        <DetailItem label="Regulatory authority" value={profile.regulatoryAuthorityCode} />
        <DetailItem label="Regulatory profile" value={`${profile.status}, ${period(profile.effectiveFrom, profile.effectiveTo)}`} />
      </dl>

      <div className="mt-6 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
        <References title="Patient external references" items={data.externalIdentifiers.patient} />
        <References title="Encounter external references" items={data.externalIdentifiers.encounter} />
      </div>
    </article>
  )
}
