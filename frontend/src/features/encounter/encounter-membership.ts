import { useMemberships } from '../insurance-membership/insurance-membership.queries.ts'
import { labelOf, useCoverageMasters } from '../insurance-membership/coverage-labels.ts'
import type { InsuranceMembership } from '../insurance-membership/insurance-membership.types.ts'
import { usePermission } from '../../shared/auth/usePermission.ts'
import { formatDateOnly } from '../../shared/format/date.ts'
import { maskIdentifier } from '../../shared/format/mask.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'

// FE-03 — the Patient's recorded memberships as Encounter choices and labels, reusing the FE-02 queries
// and labels. A label says which recorded membership it is (payer, masked member ID, recorded dates);
// it never says active, eligible, verified or primary.

function describe(membership: InsuranceMembership, payerName: string | null) {
  const period =
    membership.coverageFrom || membership.coverageTo
      ? ` (recorded ${formatDateOnly(membership.coverageFrom)} – ${membership.coverageTo ? formatDateOnly(membership.coverageTo) : 'no end recorded'})`
      : ''
  return `${payerName ?? 'Unavailable'} — Member ${maskIdentifier(membership.memberIdentifier)}${period}`
}

export function useRecordedMemberships(patientId: string) {
  const { organizationId } = useOrganization()
  const permitted = usePermission().can('insuranceMembership.read')
  const memberships = useMemberships(permitted ? patientId : '')
  const { payers } = useCoverageMasters(organizationId)

  const items = memberships.data ?? []
  const options = items.map((membership) => ({
    value: membership.id,
    label: describe(membership, payers.isPending ? 'Loading payer...' : labelOf(payers.data, membership.payerId)),
  }))

  function labelFor(membershipId: string | null) {
    if (membershipId === null) return 'Not recorded'
    if (!permitted || memberships.isError) return 'Unavailable'
    return options.find((option) => option.value === membershipId)?.label ?? (memberships.isPending ? 'Loading...' : 'Unavailable')
  }

  return {
    options,
    labelFor,
    loading: permitted && patientId !== '' && memberships.isPending,
    unavailable: !permitted || memberships.isError,
  }
}
