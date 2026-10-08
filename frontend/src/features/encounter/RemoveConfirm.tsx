import { useState } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'

// FE-03 — a lightweight confirmation before an owner "remove" route. Removal is a history-preserving
// correction (the row is kept as removed, never deleted), so the user confirms it once.
export function RemoveConfirm({
  subject,
  description,
  onConfirm,
}: {
  // What is being removed, e.g. "diagnosis"; used in the button label and error text.
  subject: string
  description: string
  onConfirm: () => Promise<unknown>
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
    <Dialog
      trigger={
        <button type="button" className="rounded px-1.5 py-1 text-sm text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">
          Remove
        </button>
      }
      title={`Remove ${subject}?`}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{description}</p>
        {error !== null && <Alert tone="danger">{describeSaveError(error, `The ${subject} removal`)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50" onClick={() => onOpenChange(false)}>
            Keep
          </Button>
          <Button type="button" className="bg-red-700" disabled={pending} onClick={confirm}>
            {pending ? 'Removing...' : `Remove ${subject}`}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
