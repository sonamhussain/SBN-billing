import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Sheet } from '../../shared/ui/Sheet.tsx'
import { EncounterFields } from './EncounterFields.tsx'
import { useEncounterFormOptions, type EncounterDraft } from './encounter-form.ts'
import { useUpdateEncounter } from './encounter.queries.ts'
import type { Encounter, EncounterPatch } from './encounter.types.ts'

const draftOf = (encounter: Encounter): EncounterDraft => ({
  serviceDate: encounter.serviceDate,
  clinicianId: encounter.clinicianId,
  facilityId: encounter.facilityId,
  insuranceMembershipId: encounter.insuranceMembershipId ?? '',
})

// Only changed A4.4 fields are sent; the server re-resolves the full resulting context.
function changes(encounter: Encounter, draft: EncounterDraft): EncounterPatch {
  const patch: EncounterPatch = {}
  if (draft.serviceDate !== encounter.serviceDate) patch.serviceDate = draft.serviceDate
  if (draft.clinicianId !== encounter.clinicianId) patch.clinicianId = draft.clinicianId
  if (draft.facilityId !== encounter.facilityId) patch.facilityId = draft.facilityId
  const membership = draft.insuranceMembershipId || null
  if (membership !== encounter.insuranceMembershipId) patch.insuranceMembershipId = membership
  return patch
}

export function EncounterEditorSheet({ encounter, trigger }: { encounter: Encounter; trigger: ReactNode }) {
  const update = useUpdateEncounter(encounter.patientId, encounter.id)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<EncounterDraft>(() => draftOf(encounter))
  const options = useEncounterFormOptions(encounter.patientId, draft, open)
  const patch = changes(encounter, draft)
  const hasChanges = Object.keys(patch).length > 0

  function onOpenChange(next: boolean) {
    setOpen(next)
    setDraft(draftOf(encounter))
    update.reset()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!hasChanges || options.blocked) return
    try {
      await update.mutateAsync(patch)
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; the recorded Encounter stays unchanged.
    }
  }

  return (
    <Sheet trigger={trigger} title="Edit encounter" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {update.isError && <Alert tone="danger">{describeSaveError(update.error, 'Encounter')}</Alert>}
        {options.blocked && <Alert tone="danger">Required setup options are unavailable, so this encounter cannot be edited here.</Alert>}
        <EncounterFields draft={draft} onChange={setDraft} options={options} />
        <div className="flex justify-end">
          <Button disabled={update.isPending || !hasChanges || options.blocked} type="submit">
            {update.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
