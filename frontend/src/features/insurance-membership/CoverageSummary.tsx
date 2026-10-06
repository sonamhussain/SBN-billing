import type { ReactNode } from 'react'
import { formatDateOnly } from '../../shared/format/date.ts'
import { maskIdentifier } from '../../shared/format/mask.ts'
import { Badge } from '../../shared/ui/Badge.tsx'
import { DetailItem } from '../../shared/ui/DetailItem.tsx'
import type { InsuranceMembership } from './insurance-membership.types.ts'

// Registration truth only: who the payer is, which product was recorded, masked identifiers and the
// recorded dates. It never says a membership is active, eligible, verified or primary.
export function CoverageSummary({
  membership,
  payerName,
  productName,
  action,
}: {
  membership: InsuranceMembership
  payerName: string
  productName: string | null
  action?: ReactNode
}) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-slate-950">{payerName}</h3>
          <p className="mt-0.5 text-sm text-slate-600">{productName ?? 'Product not recorded'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Badge>Recorded coverage</Badge>
          {action}
        </div>
      </div>

      <dl className="mt-5 grid gap-x-6 gap-y-4 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <DetailItem label="Member ID" value={maskIdentifier(membership.memberIdentifier)} />
        <DetailItem label="Policy ID" value={membership.policyIdentifier ? maskIdentifier(membership.policyIdentifier) : null} />
        <DetailItem label="Recorded from" value={membership.coverageFrom ? formatDateOnly(membership.coverageFrom) : null} />
        <DetailItem label="Recorded to" value={membership.coverageTo ? formatDateOnly(membership.coverageTo) : null} />
      </dl>
    </article>
  )
}
