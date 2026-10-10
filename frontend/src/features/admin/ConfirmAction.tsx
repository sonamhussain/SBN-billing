import { useState, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'

// FE-05 — a confirmation before an explicit governed action (verify, publish, activate, suspend, resume,
// retire). The action is decided and recorded by the backend owner route; the dialog only makes sure the
// user means it, then shows the backend's answer, including a refusal with its requestId.
export function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel,
  subject,
  onConfirm,
  children,
}: {
  trigger: ReactNode
  title: string
  description: string
  confirmLabel: string
  // What the action changes, for error text, e.g. "Source version".
  subject: string
  onConfirm: () => Promise<unknown>
  // Optional extra input shown above the buttons (for example a status choice).
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) setError(null)
  }

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      setOpen(false)
    } catch (caught) {
      setError(caught)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog trigger={trigger} title={title} open={open} onOpenChange={onOpenChange}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{description}</p>
        {children}
        {error !== null && <Alert tone="danger">{describeSaveError(error, subject)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={pending} onClick={confirm}>
            {pending ? 'Saving...' : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
