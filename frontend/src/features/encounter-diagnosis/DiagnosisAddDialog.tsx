import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { OptionPicker } from '../encounter-lookups/OptionPicker.tsx'
import { useDiagnosisCodeOptions } from '../encounter-lookups/encounter-lookups.queries.ts'
import { useDiagnosisMutations } from './encounter-diagnosis.queries.ts'

// Diagnosis codes come from the organization's real master list, shown as code and name. The backend
// appends the diagnosis at the end of the active order and validates it.
export function DiagnosisAddDialog({ encounterId, trigger }: { encounterId: string; trigger: ReactNode }) {
  const { organizationId } = useOrganization()
  const [open, setOpen] = useState(false)
  const [diagnosisCodeId, setDiagnosisCodeId] = useState('')
  const codes = useDiagnosisCodeOptions(organizationId, open)
  const { add } = useDiagnosisMutations(encounterId)
  const unavailable = !codes.permitted || codes.isError

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDiagnosisCodeId('')
      add.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (unavailable) return
    try {
      await add.mutateAsync(diagnosisCodeId)
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; nothing was attached.
    }
  }

  return (
    <Dialog trigger={trigger} title="Add diagnosis" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {add.isError && <Alert tone="danger">{describeSaveError(add.error, 'Diagnosis')}</Alert>}
        <OptionPicker
          label="Diagnosis code"
          required
          value={diagnosisCodeId}
          onChange={setDiagnosisCodeId}
          options={codes.data?.map((code) => ({ value: code.id, label: `${code.code} — ${code.displayName}` }))}
          placeholder="Select a diagnosis code"
          loading={codes.isPending && codes.permitted}
          unavailable={unavailable}
        />
        <div className="flex justify-end">
          <Button disabled={add.isPending || unavailable} type="submit">
            {add.isPending ? 'Saving...' : 'Add diagnosis'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
