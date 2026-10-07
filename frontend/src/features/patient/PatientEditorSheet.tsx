import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { Sheet } from '../../shared/ui/Sheet.tsx'
import { useUpdatePatient } from './patient.queries.ts'
import type { Patient, PatientPatch } from './patient.types.ts'

type Draft = { givenName: string; middleName: string; familyName: string; dateOfBirth: string; mobilePhone: string; email: string }

const draftOf = (patient: Patient): Draft => ({
  givenName: patient.givenName,
  middleName: patient.middleName ?? '',
  familyName: patient.familyName,
  dateOfBirth: patient.dateOfBirth,
  mobilePhone: patient.mobilePhone ?? '',
  email: patient.email ?? '',
})

// Only the fields the user actually changed are sent; an emptied optional field becomes null. Required
// fields are sent as typed, and the backend decides whether they are acceptable.
function changes(patient: Patient, draft: Draft): PatientPatch {
  const patch: PatientPatch = {}
  if (draft.givenName !== patient.givenName) patch.givenName = draft.givenName
  if (draft.familyName !== patient.familyName) patch.familyName = draft.familyName
  if (draft.dateOfBirth !== patient.dateOfBirth) patch.dateOfBirth = draft.dateOfBirth
  const optional = (value: string) => value.trim() || null
  if (optional(draft.middleName) !== patient.middleName) patch.middleName = optional(draft.middleName)
  if (optional(draft.mobilePhone) !== patient.mobilePhone) patch.mobilePhone = optional(draft.mobilePhone)
  if (optional(draft.email) !== patient.email) patch.email = optional(draft.email)
  return patch
}

export function PatientEditorSheet({ patient, trigger }: { patient: Patient; trigger: ReactNode }) {
  const { organizationId } = useOrganization()
  const update = useUpdatePatient(organizationId, patient.id)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => draftOf(patient))
  const set = (key: keyof Draft) => (value: string) => setDraft((current) => ({ ...current, [key]: value }))
  const patch = changes(patient, draft)
  const hasChanges = Object.keys(patch).length > 0

  function onOpenChange(next: boolean) {
    setOpen(next)
    setDraft(draftOf(patient))
    update.reset()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!hasChanges) return
    try {
      await update.mutateAsync(patch)
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; the form keeps the user's edits.
    }
  }

  return (
    <Sheet trigger={trigger} title="Edit patient" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {update.isError && <Alert tone="danger">{describeSaveError(update.error, 'Patient')}</Alert>}
        <Field label="Given name">
          <Input required value={draft.givenName} onChange={(e) => set('givenName')(e.target.value)} />
        </Field>
        <Field label="Middle name" hint="(optional)">
          <Input value={draft.middleName} onChange={(e) => set('middleName')(e.target.value)} />
        </Field>
        <Field label="Family name">
          <Input required value={draft.familyName} onChange={(e) => set('familyName')(e.target.value)} />
        </Field>
        <Field label="Date of birth">
          <Input required type="date" value={draft.dateOfBirth} onChange={(e) => set('dateOfBirth')(e.target.value)} />
        </Field>
        <Field label="Mobile phone" hint="(optional)">
          <Input type="tel" value={draft.mobilePhone} onChange={(e) => set('mobilePhone')(e.target.value)} />
        </Field>
        <Field label="Email" hint="(optional)">
          <Input type="email" value={draft.email} onChange={(e) => set('email')(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button disabled={update.isPending || !hasChanges} type="submit">
            {update.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
