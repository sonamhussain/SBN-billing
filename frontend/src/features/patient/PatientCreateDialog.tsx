import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { useCreatePatient } from './patient.queries.ts'

const empty = { givenName: '', middleName: '', familyName: '', dateOfBirth: '', mobilePhone: '', email: '' }

// One compact form. Native constraints help the user; the backend remains the validation authority.
// After the server confirms the new record, its Patient Workspace opens.
export function PatientCreateDialog({ trigger }: { trigger: ReactNode }) {
  const { organizationId } = useOrganization()
  const create = useCreatePatient(organizationId)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(empty)
  const set = (key: keyof typeof empty) => (value: string) => setForm((current) => ({ ...current, [key]: value }))

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setForm(empty)
      create.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      const patient = await create.mutateAsync({
        givenName: form.givenName,
        middleName: form.middleName.trim() || null,
        familyName: form.familyName,
        dateOfBirth: form.dateOfBirth,
        mobilePhone: form.mobilePhone.trim() || null,
        email: form.email.trim() || null,
      })
      onOpenChange(false)
      navigate(`/app/patients/${patient.id}`)
    } catch {
      // The mutation state carries the error; it is shown below without any form values.
    }
  }

  return (
    <Dialog trigger={trigger} title="New patient" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {create.isError && <Alert tone="danger">{describeSaveError(create.error, 'Patient')}</Alert>}
        <Field label="Given name">
          <Input required value={form.givenName} onChange={(e) => set('givenName')(e.target.value)} />
        </Field>
        <Field label="Middle name" hint="(optional)">
          <Input value={form.middleName} onChange={(e) => set('middleName')(e.target.value)} />
        </Field>
        <Field label="Family name">
          <Input required value={form.familyName} onChange={(e) => set('familyName')(e.target.value)} />
        </Field>
        <Field label="Date of birth">
          <Input required type="date" value={form.dateOfBirth} onChange={(e) => set('dateOfBirth')(e.target.value)} />
        </Field>
        <Field label="Mobile phone" hint="(optional)">
          <Input type="tel" value={form.mobilePhone} onChange={(e) => set('mobilePhone')(e.target.value)} />
        </Field>
        <Field label="Email" hint="(optional)">
          <Input type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button disabled={create.isPending} type="submit">
            {create.isPending ? 'Saving...' : 'Create patient'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
