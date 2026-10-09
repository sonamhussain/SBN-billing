import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { Select } from '../../shared/ui/Select.tsx'

// FE-05 — create or edit one master record through its owner route. The fields are the owner's exact text
// fields; an edit sends only what changed, and an emptied optional field becomes null. The backend
// validates every value and its answer (including a conflict) is shown with its requestId.

// A text field by default; `options` makes it a choice from the owner's fixed vocabulary and `type: 'date'`
// a calendar date (YYYY-MM-DD).
export type MasterField = { key: string; label: string; required?: boolean; hint?: string; options?: readonly string[]; type?: 'date' }

type Values = Record<string, string>

const valuesOf = (fields: MasterField[], record: Record<string, unknown> | undefined): Values =>
  Object.fromEntries(fields.map((field) => [field.key, typeof record?.[field.key] === 'string' ? (record[field.key] as string) : '']))

export function MasterFormDialog({
  title,
  subject,
  fields,
  record,
  trigger,
  onSubmit,
}: {
  title: string
  // Singular name for messages, e.g. "Clinician".
  subject: string
  fields: MasterField[]
  // The record being edited; absent when creating.
  record?: Record<string, unknown>
  trigger: ReactNode
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Values>(() => valuesOf(fields, record))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const editing = record !== undefined

  const body: Record<string, unknown> = {}
  for (const field of fields) {
    const value = field.required ? values[field.key] : values[field.key].trim() || null
    const original = editing ? ((record[field.key] as string | null | undefined) ?? (field.required ? '' : null)) : undefined
    if (!editing ? value !== null : value !== original) body[field.key] = value
  }
  const hasChanges = Object.keys(body).length > 0

  function onOpenChange(next: boolean) {
    setOpen(next)
    setValues(valuesOf(fields, record))
    setError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (editing && !hasChanges) return
    setPending(true)
    setError(null)
    try {
      await onSubmit(body)
      onOpenChange(false)
    } catch (caught) {
      setError(caught)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog trigger={trigger} title={title} open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {error !== null && <Alert tone="danger">{describeSaveError(error, subject)}</Alert>}
        {fields.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint ?? (field.required ? undefined : '(optional)')}>
            {field.options ? (
              <Select required={field.required} value={values[field.key]} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}>
                <option value="">{field.required ? 'Select' : 'Not recorded'}</option>
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={field.type ?? 'text'}
                required={field.required}
                autoComplete="off"
                value={values[field.key]}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
              />
            )}
          </Field>
        ))}
        <div className="flex justify-end">
          <Button type="submit" disabled={pending || (editing && !hasChanges)}>
            {pending ? 'Saving...' : editing ? 'Save changes' : `Create ${subject === subject.toUpperCase() ? subject : subject.toLowerCase()}`}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
