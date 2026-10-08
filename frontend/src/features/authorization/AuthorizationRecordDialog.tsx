import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { authorizationInput, draftIsComplete, emptyAuthorizationDraft, type AuthorizationDraft } from './authorization-form.ts'
import { useRecordAuthorization } from './authorization.queries.ts'
import { AuthorizationVersionFields } from './AuthorizationVersionFields.tsx'

// "Record authorization": a new case with its immutable INITIAL version. It records what was requested or
// received outside SBN; nothing is requested from or submitted to a payer.
export function AuthorizationRecordDialog({ encounterId, trigger }: { encounterId: string; trigger: ReactNode }) {
  const record = useRecordAuthorization(encounterId)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AuthorizationDraft>(() => emptyAuthorizationDraft('INITIAL'))

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDraft(emptyAuthorizationDraft('INITIAL'))
      record.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!draftIsComplete(draft)) return
    try {
      await record.mutateAsync(authorizationInput(draft))
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; nothing was recorded.
    }
  }

  return (
    <Dialog trigger={trigger} title="Record authorization" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {record.isError && <Alert tone="danger">{describeSaveError(record.error, 'Authorization')}</Alert>}
        <p className="text-sm text-slate-500">Records an authorization request or decision handled outside SBN. Nothing is sent to the payer.</p>
        <AuthorizationVersionFields encounterId={encounterId} draft={draft} onChange={setDraft} firstVersion />
        <div className="flex justify-end">
          <Button disabled={record.isPending || !draftIsComplete(draft)} type="submit">
            {record.isPending ? 'Saving...' : 'Record authorization'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
