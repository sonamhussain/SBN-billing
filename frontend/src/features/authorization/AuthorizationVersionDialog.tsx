import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { authorizationInput, draftIsComplete, emptyAuthorizationDraft, type AuthorizationDraft } from './authorization-form.ts'
import { useAddAuthorizationVersion } from './authorization.queries.ts'
import { AuthorizationVersionFields } from './AuthorizationVersionFields.tsx'

// "Add authorization version": a payer response, amendment, extension or correction recorded as a new
// immutable version. Earlier versions and their lines stay exactly as recorded; there is no edit.
export function AuthorizationVersionDialog({
  encounterId,
  authorizationId,
  trigger,
}: {
  encounterId: string
  authorizationId: string
  trigger: ReactNode
}) {
  const add = useAddAuthorizationVersion(encounterId, authorizationId)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AuthorizationDraft>(() => emptyAuthorizationDraft(''))

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDraft(emptyAuthorizationDraft(''))
      add.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!draftIsComplete(draft)) return
    try {
      await add.mutateAsync(authorizationInput(draft))
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; no version was added.
    }
  }

  return (
    <Dialog trigger={trigger} title="Add authorization version" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {add.isError && <Alert tone="danger">{describeSaveError(add.error, 'Authorization version')}</Alert>}
        <AuthorizationVersionFields encounterId={encounterId} draft={draft} onChange={setDraft} firstVersion={false} />
        <div className="flex justify-end">
          <Button disabled={add.isPending || !draftIsComplete(draft)} type="submit">
            {add.isPending ? 'Saving...' : 'Add version'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
