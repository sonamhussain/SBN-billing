import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { useCoverageMasters } from './coverage-labels.ts'
import { emptyCoverageDraft, type CoverageDraft } from './coverage-draft.ts'
import { CoverageFields } from './CoverageFields.tsx'
import { useCreateMembership } from './insurance-membership.queries.ts'

const orNull = (value: string) => value.trim() || null

export function CoverageCreateDialog({ patientId, trigger }: { patientId: string; trigger: ReactNode }) {
  const { organizationId } = useOrganization()
  const masters = useCoverageMasters(organizationId)
  const create = useCreateMembership(patientId)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CoverageDraft>(emptyCoverageDraft)

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDraft(emptyCoverageDraft)
      create.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await create.mutateAsync({
        payerId: draft.payerId,
        tpaId: orNull(draft.tpaId),
        networkId: orNull(draft.networkId),
        insuranceProductId: orNull(draft.insuranceProductId),
        memberIdentifier: draft.memberIdentifier,
        policyIdentifier: orNull(draft.policyIdentifier),
        coverageFrom: orNull(draft.coverageFrom),
        coverageTo: orNull(draft.coverageTo),
      })
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; a backend coherence refusal records nothing.
    }
  }

  return (
    <Dialog trigger={trigger} title="Add coverage" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {create.isError && <Alert tone="danger">{describeSaveError(create.error, 'Coverage')}</Alert>}
        <CoverageFields draft={draft} onChange={setDraft} masters={masters} />
        <div className="flex justify-end">
          <Button disabled={create.isPending} type="submit">
            {create.isPending ? 'Saving...' : 'Add coverage'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
