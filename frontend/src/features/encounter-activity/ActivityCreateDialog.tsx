import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { OptionPicker } from '../encounter-lookups/OptionPicker.tsx'
import { useProcedureCodeOptions, useServiceOptions } from '../encounter-lookups/encounter-lookups.queries.ts'
import { useActivityMutations } from './encounter-activity.queries.ts'

// FE-03 — records one activity. Service and Procedure are independent choices from their real master
// lists: one never filters or maps the other, and no mismatch is judged here. Quantity stays the exact
// text the user typed (the backend owns decimal validation). Unit and modifier codes are opaque; the
// modifier fields keep the order they were entered in.

type ModifierField = { key: number; code: string }

type Draft = { serviceId: string; procedureCodeId: string; quantity: string; unitCode: string; modifiers: ModifierField[] }

const emptyDraft: Draft = { serviceId: '', procedureCodeId: '', quantity: '', unitCode: '', modifiers: [] }

export function ActivityCreateDialog({ encounterId, trigger }: { encounterId: string; trigger: ReactNode }) {
  const { organizationId } = useOrganization()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [nextKey, setNextKey] = useState(0)
  const services = useServiceOptions(organizationId, open)
  const procedures = useProcedureCodeOptions(organizationId, open)
  const { create } = useActivityMutations(encounterId)

  const servicesUnavailable = !services.permitted || services.isError
  const proceduresUnavailable = !procedures.permitted || procedures.isError
  const blocked = servicesUnavailable && proceduresUnavailable
  const noIdentity = draft.serviceId === '' && draft.procedureCodeId === ''

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDraft(emptyDraft)
      create.reset()
    }
  }

  function addModifier() {
    setDraft({ ...draft, modifiers: [...draft.modifiers, { key: nextKey, code: '' }] })
    setNextKey(nextKey + 1)
  }

  function setModifier(key: number, code: string) {
    setDraft({ ...draft, modifiers: draft.modifiers.map((field) => (field.key === key ? { ...field, code } : field)) })
  }

  function removeModifier(key: number) {
    setDraft({ ...draft, modifiers: draft.modifiers.filter((field) => field.key !== key) })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (blocked || noIdentity) return
    try {
      await create.mutateAsync({
        serviceId: draft.serviceId || null,
        procedureCodeId: draft.procedureCodeId || null,
        quantity: draft.quantity,
        unitCode: draft.unitCode.trim() || null,
        // Empty modifier fields are left out; the entered order is kept.
        modifierCodes: draft.modifiers.map((field) => field.code.trim()).filter((code) => code !== ''),
      })
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; nothing was recorded.
    }
  }

  return (
    <Dialog trigger={trigger} title="Add activity" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {create.isError && <Alert tone="danger">{describeSaveError(create.error, 'Activity')}</Alert>}
        {blocked && <Alert tone="danger">Required setup options are unavailable, so an activity cannot be recorded here.</Alert>}
        <p className="text-sm text-slate-500">Choose a service, a procedure, or both.</p>
        <OptionPicker
          label="Service"
          hint="(optional)"
          value={draft.serviceId}
          onChange={(serviceId) => setDraft({ ...draft, serviceId })}
          options={services.data?.map((service) => ({ value: service.id, label: `${service.internalCode} — ${service.displayName}` }))}
          placeholder="Not recorded"
          loading={services.isPending && services.permitted}
          unavailable={servicesUnavailable}
        />
        <OptionPicker
          label="Procedure"
          hint="(optional)"
          value={draft.procedureCodeId}
          onChange={(procedureCodeId) => setDraft({ ...draft, procedureCodeId })}
          options={procedures.data?.map((procedure) => ({ value: procedure.id, label: `${procedure.internalCode} — ${procedure.displayName}` }))}
          placeholder="Not recorded"
          loading={procedures.isPending && procedures.permitted}
          unavailable={proceduresUnavailable}
        />
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <Field label="Quantity">
            <Input required inputMode="decimal" autoComplete="off" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value })} />
          </Field>
          <Field label="Unit code" hint="(optional)">
            <Input autoComplete="off" value={draft.unitCode} onChange={(event) => setDraft({ ...draft, unitCode: event.target.value })} />
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">
            Modifier codes <span className="font-normal text-slate-500">(optional, in order)</span>
          </legend>
          {draft.modifiers.map((field, index) => (
            <div key={field.key} className="flex items-center gap-2">
              <span className="w-5 text-right text-sm tabular-nums text-slate-500">{index + 1}</span>
              <Input
                aria-label={`Modifier code ${index + 1}`}
                autoComplete="off"
                value={field.code}
                onChange={(event) => setModifier(field.key, event.target.value)}
              />
              <button
                type="button"
                className="rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
                aria-label={`Remove modifier code ${index + 1}`}
                onClick={() => removeModifier(field.key)}
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="text-sm text-[var(--sbn-accent)] hover:underline" onClick={addModifier}>
            Add modifier code
          </button>
        </fieldset>
        <div className="flex justify-end">
          <Button disabled={create.isPending || blocked || noIdentity} type="submit">
            {create.isPending ? 'Saving...' : 'Add activity'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
