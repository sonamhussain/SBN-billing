import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { EncounterFields } from './EncounterFields.tsx'
import { emptyEncounterDraft, useEncounterFormOptions, type EncounterDraft } from './encounter-form.ts'
import { useCreateEncounter } from './encounter.queries.ts'

// Sends only the four A4.4 writable fields. A refusal (no or ambiguous assignment/profile, membership
// conflict) is shown with its requestId; nothing is auto-repaired and no other record is chosen.
export function EncounterCreateDialog({ patientId, trigger }: { patientId: string; trigger: ReactNode }) {
  const navigate = useNavigate()
  const create = useCreateEncounter(patientId)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<EncounterDraft>(emptyEncounterDraft)
  const options = useEncounterFormOptions(patientId, draft, open)

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDraft(emptyEncounterDraft)
      create.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (options.blocked) return
    try {
      const encounter = await create.mutateAsync({
        serviceDate: draft.serviceDate,
        clinicianId: draft.clinicianId,
        facilityId: draft.facilityId,
        insuranceMembershipId: draft.insuranceMembershipId || null,
      })
      onOpenChange(false)
      navigate(`/app/encounters/${encounter.id}`)
    } catch {
      // Shown below from the mutation state; a refused create records nothing.
    }
  }

  return (
    <Dialog trigger={trigger} title="New encounter" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {create.isError && <Alert tone="danger">{describeSaveError(create.error, 'Encounter')}</Alert>}
        {options.blocked && <Alert tone="danger">Required setup options are unavailable, so an encounter cannot be recorded here.</Alert>}
        <EncounterFields draft={draft} onChange={setDraft} options={options} />
        <div className="flex justify-end">
          <Button disabled={create.isPending || options.blocked} type="submit">
            {create.isPending ? 'Saving...' : 'Create encounter'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
