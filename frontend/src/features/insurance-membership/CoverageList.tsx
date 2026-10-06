import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { labelOf, useCoverageMasters } from './coverage-labels.ts'
import { CoverageEditorSheet } from './CoverageEditorSheet.tsx'
import { CoverageSummary } from './CoverageSummary.tsx'
import type { InsuranceMembership } from './insurance-membership.types.ts'

// Payer and product names come from the organization's master lists. While they load the name says so;
// a name that cannot be resolved is 'Unavailable', never a raw identifier.
export function CoverageList({ items }: { items: InsuranceMembership[] }) {
  const { organizationId } = useOrganization()
  const masters = useCoverageMasters(organizationId)

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-500">No insurance membership recorded.</p>
    )
  }

  return (
    <div className="space-y-3">
      {items.map((membership) => (
        <CoverageSummary
          key={membership.id}
          membership={membership}
          payerName={masters.payers.isPending ? 'Loading payer...' : (labelOf(masters.payers.data, membership.payerId) ?? 'Unavailable')}
          productName={masters.products.isPending ? 'Loading product...' : labelOf(masters.products.data, membership.insuranceProductId)}
          action={
            <PermissionGate permission="insuranceMembership.update">
              <CoverageEditorSheet
                membership={membership}
                trigger={
                  <button type="button" className="text-sm text-[var(--sbn-accent)] hover:underline">
                    Edit
                  </button>
                }
              />
            </PermissionGate>
          }
        />
      ))}
    </div>
  )
}
