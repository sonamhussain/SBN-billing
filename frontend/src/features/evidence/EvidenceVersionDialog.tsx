import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { emptyEvidenceDraft, evidenceInput, type EvidenceDraft } from './evidence-form.ts'
import { useAddEvidenceVersion } from './evidence.queries.ts'
import { EvidenceVersionFields } from './EvidenceVersionFields.tsx'

// "Add evidence version": a new immutable representation of the same artifact. Earlier versions, and any
// Encounter link to them, stay exactly as recorded; there is no edit.
export function EvidenceVersionDialog({ artifactId, trigger }: { artifactId: string; trigger: ReactNode }) {
  const { organizationId } = useOrganization()
  const add = useAddEvidenceVersion(organizationId, artifactId)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<EvidenceDraft>(emptyEvidenceDraft)

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDraft(emptyEvidenceDraft)
      add.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await add.mutateAsync(evidenceInput(draft))
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; no version was added.
    }
  }

  return (
    <Dialog trigger={trigger} title="Add evidence version" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {add.isError && <Alert tone="danger">{describeSaveError(add.error, 'Evidence version')}</Alert>}
        <p className="text-sm text-slate-500">Earlier versions stay unchanged. Link the new version to an encounter separately if it should be used.</p>
        <EvidenceVersionFields draft={draft} onChange={setDraft} />
        <div className="flex justify-end">
          <Button disabled={add.isPending} type="submit">
            {add.isPending ? 'Saving...' : 'Add version'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
