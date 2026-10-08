import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { emptyEvidenceDraft, evidenceInput, type EvidenceDraft } from './evidence-form.ts'
import { useRegisterEvidence } from './evidence.queries.ts'
import { EvidenceVersionFields } from './EvidenceVersionFields.tsx'

// "Register evidence": records a new evidence artifact with its immutable version 1 (metadata only).
// Linking it to this Encounter is a separate, explicit action.
export function EvidenceRegisterDialog({ trigger }: { trigger: ReactNode }) {
  const { organizationId } = useOrganization()
  const register = useRegisterEvidence(organizationId)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<EvidenceDraft>(emptyEvidenceDraft)

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDraft(emptyEvidenceDraft)
      register.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await register.mutateAsync(evidenceInput(draft))
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; nothing was registered.
    }
  }

  return (
    <Dialog trigger={trigger} title="Register evidence" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {register.isError && <Alert tone="danger">{describeSaveError(register.error, 'Evidence')}</Alert>}
        <EvidenceVersionFields draft={draft} onChange={setDraft} />
        <div className="flex justify-end">
          <Button disabled={register.isPending} type="submit">
            {register.isPending ? 'Saving...' : 'Register evidence'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
