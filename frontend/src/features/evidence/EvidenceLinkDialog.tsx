import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { useEvidenceLinkMutations } from './evidence.queries.ts'
import { EvidenceVersionPicker } from './EvidenceVersionPicker.tsx'

// "Link evidence": attaches one exact registered evidence version to this Encounter. Only the version id
// is sent; the backend validates ownership and duplicates.
export function EvidenceLinkDialog({ encounterId, trigger }: { encounterId: string; trigger: ReactNode }) {
  const { link } = useEvidenceLinkMutations(encounterId)
  const [open, setOpen] = useState(false)
  const [versionId, setVersionId] = useState('')

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setVersionId('')
      link.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (versionId === '') return
    try {
      await link.mutateAsync(versionId)
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; nothing was linked.
    }
  }

  return (
    <Dialog trigger={trigger} title="Link evidence" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {link.isError && <Alert tone="danger">{describeSaveError(link.error, 'Evidence link')}</Alert>}
        <EvidenceVersionPicker label="Registered evidence" required value={versionId} onChange={setVersionId} />
        <div className="flex justify-end">
          <Button disabled={link.isPending || versionId === ''} type="submit">
            {link.isPending ? 'Saving...' : 'Link evidence'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
