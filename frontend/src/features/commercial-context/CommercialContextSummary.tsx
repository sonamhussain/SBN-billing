import { describeApiFailure } from '../../shared/api/error-message.ts'
import { formatDateOnly, formatInstant } from '../../shared/format/date.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { DetailItem } from '../../shared/ui/DetailItem.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { RecordSection } from '../../shared/ui/RecordSection.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { useCommercialContext, useProviderContract, useTariffSchedule, useTariffScheduleVersion } from './commercial-context.queries.ts'
import type { PreClaimCommercialContext } from './commercial-context.types.ts'

// FE-04 — Commercial context: the server's A5.5 resolution, read-only. When resolved it names the provider
// contract, tariff schedule and the exact VERIFIED tariff version; when not, it shows the backend's reason.
// There is no contract/tariff selector, no business-date input and no rate, amount or reimbursement.

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'

const period = (from: string | null, to: string | null) => `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`

function ResolvedContext({ context }: { context: PreClaimCommercialContext }) {
  const contract = useProviderContract(context.providerContractId)
  const schedule = useTariffSchedule(context.tariffScheduleId)
  const version = useTariffScheduleVersion(context.tariffScheduleVersionId)
  const label = <T,>(query: { permitted: boolean; isError: boolean; data: T | undefined }, show: (data: T) => string) =>
    !query.permitted || query.isError ? 'Unavailable' : query.data ? show(query.data) : 'Loading...'

  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      <DetailItem label="Provider contract" value={label(contract, (c) => `${c.displayName} (${c.contractKey}) · ${period(c.effectiveFrom, c.effectiveTo)}`)} />
      <DetailItem label="Tariff schedule" value={label(schedule, (s) => `${s.displayName} (${s.tariffKey})`)} />
      <DetailItem label="Tariff version" value={label(version, (v) => `${v.version} · ${v.verificationStatus} · ${period(v.effectiveFrom, v.effectiveTo)}`)} />
    </dl>
  )
}

export function CommercialContextSummary({ encounterId, readable }: { encounterId: string; readable: boolean }) {
  const context = useCommercialContext(encounterId, readable)

  return (
    <RecordSection
      title="Commercial context"
      description="Provider contract and tariff resolved by the server for this encounter's service date. Read-only; no pricing."
      action={
        readable ? (
          <Button type="button" className={secondaryButton} disabled={context.isFetching} onClick={() => context.refetch()}>
            {context.isFetching ? 'Resolving...' : 'Resolve again'}
          </Button>
        ) : undefined
      }
    >
      {!readable && <EmptyState title="Commercial context is not available to you." />}
      {readable && context.isPending && <Skeleton className="h-16 w-full" />}
      {readable && context.isError && <Alert tone="danger">{describeApiFailure(context.error, 'Commercial context')}</Alert>}
      {context.data && !context.isError && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
          <p className="text-xs text-slate-500">
            Resolved {formatInstant(context.data.resolvedAt)} for service date {formatDateOnly(context.data.serviceDate)}
          </p>
          <ResolvedContext context={context.data} />
        </div>
      )}
    </RecordSection>
  )
}
