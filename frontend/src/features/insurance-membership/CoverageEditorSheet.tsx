import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Sheet } from '../../shared/ui/Sheet.tsx'
import { useCoverageMasters } from './coverage-labels.ts'
import type { CoverageDraft } from './coverage-draft.ts'
import { CoverageFields } from './CoverageFields.tsx'
import { useUpdateMembership } from './insurance-membership.queries.ts'
import type { InsuranceMembership, InsuranceMembershipPatch } from './insurance-membership.types.ts'

const draftOf = (membership: InsuranceMembership): CoverageDraft => ({
  payerId: membership.payerId,
  tpaId: membership.tpaId ?? '',
  networkId: membership.networkId ?? '',
  insuranceProductId: membership.insuranceProductId ?? '',
  memberIdentifier: membership.memberIdentifier,
  policyIdentifier: membership.policyIdentifier ?? '',
  coverageFrom: membership.coverageFrom ?? '',
  coverageTo: membership.coverageTo ?? '',
})

// Only changed fields are sent; an emptied optional field becomes null.
function changes(membership: InsuranceMembership, draft: CoverageDraft): InsuranceMembershipPatch {
  const patch: InsuranceMembershipPatch = {}
  const orNull = (value: string) => value.trim() || null
  if (draft.payerId !== membership.payerId) patch.payerId = draft.payerId
  if (draft.memberIdentifier !== membership.memberIdentifier) patch.memberIdentifier = draft.memberIdentifier
  if (orNull(draft.tpaId) !== membership.tpaId) patch.tpaId = orNull(draft.tpaId)
  if (orNull(draft.networkId) !== membership.networkId) patch.networkId = orNull(draft.networkId)
  if (orNull(draft.insuranceProductId) !== membership.insuranceProductId) patch.insuranceProductId = orNull(draft.insuranceProductId)
  if (orNull(draft.policyIdentifier) !== membership.policyIdentifier) patch.policyIdentifier = orNull(draft.policyIdentifier)
  if (orNull(draft.coverageFrom) !== membership.coverageFrom) patch.coverageFrom = orNull(draft.coverageFrom)
  if (orNull(draft.coverageTo) !== membership.coverageTo) patch.coverageTo = orNull(draft.coverageTo)
  return patch
}

export function CoverageEditorSheet({ membership, trigger }: { membership: InsuranceMembership; trigger: ReactNode }) {
  const { organizationId } = useOrganization()
  const masters = useCoverageMasters(organizationId)
  const update = useUpdateMembership(membership.patientId, membership.id)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CoverageDraft>(() => draftOf(membership))
  const patch = changes(membership, draft)
  const hasChanges = Object.keys(patch).length > 0

  function onOpenChange(next: boolean) {
    setOpen(next)
    setDraft(draftOf(membership))
    update.reset()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!hasChanges) return
    try {
      await update.mutateAsync(patch)
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; the recorded membership stays unchanged.
    }
  }

  return (
    <Sheet trigger={trigger} title="Edit coverage" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {update.isError && <Alert tone="danger">{describeSaveError(update.error, 'Coverage')}</Alert>}
        <CoverageFields draft={draft} onChange={setDraft} masters={masters} />
        <div className="flex justify-end">
          <Button disabled={update.isPending || !hasChanges} type="submit">
            {update.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
