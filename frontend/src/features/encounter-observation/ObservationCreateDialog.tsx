import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { Select } from '../../shared/ui/Select.tsx'
import { useActivityLabel } from '../encounter-activity/activity-label.ts'
import type { EncounterActivity } from '../encounter-activity/encounter-activity.types.ts'
import { useObservationMutations } from './encounter-observation.queries.ts'
import type { ObservationValue, ObservationValueType } from './encounter-observation.types.ts'
import { valueTypeLabels } from './observation-value.ts'

// FE-03 — records one structured fact. The value type is chosen first and only its input is shown, so a
// value is never coerced between text, decimal, yes/no and date. The fact key is free text: there is no
// governed vocabulary, so no list of facts is invented. The activity link offers only this Encounter's
// active activities.

type Draft = {
  factKey: string
  type: ObservationValueType | ''
  text: string
  decimal: string
  unitCode: string
  boolean: '' | 'true' | 'false'
  date: string
  encounterActivityId: string
}

const emptyDraft: Draft = { factKey: '', type: '', text: '', decimal: '', unitCode: '', boolean: '', date: '', encounterActivityId: '' }

function valueOf(draft: Draft): ObservationValue | null {
  switch (draft.type) {
    case 'TEXT':
      return { type: 'TEXT', text: draft.text }
    case 'DECIMAL':
      return { type: 'DECIMAL', decimal: draft.decimal, unitCode: draft.unitCode.trim() || null }
    case 'BOOLEAN':
      return draft.boolean === '' ? null : { type: 'BOOLEAN', boolean: draft.boolean === 'true' }
    case 'DATE':
      return { type: 'DATE', date: draft.date }
    default:
      return null
  }
}

function ActivityOption({ activity }: { activity: EncounterActivity }) {
  const label = useActivityLabel(activity)
  return <option value={activity.id}>{`${label} — qty ${activity.quantity}`}</option>
}

export function ObservationCreateDialog({
  encounterId,
  activities,
  trigger,
}: {
  encounterId: string
  // This Encounter's active activities, or undefined when they are not available to the user.
  activities: EncounterActivity[] | undefined
  trigger: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const { create } = useObservationMutations(encounterId)
  const value = valueOf(draft)

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDraft(emptyDraft)
      create.reset()
    }
  }

  function chooseType(type: Draft['type']) {
    // Switching type clears every value input, so nothing typed under one type travels as another.
    setDraft({ ...emptyDraft, factKey: draft.factKey, encounterActivityId: draft.encounterActivityId, type })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (value === null) return
    try {
      await create.mutateAsync({ factKey: draft.factKey, value, encounterActivityId: draft.encounterActivityId || null })
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; nothing was recorded.
    }
  }

  return (
    <Dialog trigger={trigger} title="Add fact" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {create.isError && <Alert tone="danger">{describeSaveError(create.error, 'Fact')}</Alert>}
        <Field label="Fact key">
          <Input required autoComplete="off" value={draft.factKey} onChange={(event) => setDraft({ ...draft, factKey: event.target.value })} />
        </Field>
        <Field label="Value type">
          <Select required value={draft.type} onChange={(event) => chooseType(event.target.value as Draft['type'])}>
            <option value="">Select a value type</option>
            {(Object.keys(valueTypeLabels) as ObservationValueType[]).map((type) => (
              <option key={type} value={type}>
                {valueTypeLabels[type]}
              </option>
            ))}
          </Select>
        </Field>
        {draft.type === 'TEXT' && (
          <Field label="Text value">
            <Input required autoComplete="off" value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
          </Field>
        )}
        {draft.type === 'DECIMAL' && (
          <div className="grid items-end gap-3 sm:grid-cols-2">
            <Field label="Decimal value">
              <Input required inputMode="decimal" autoComplete="off" value={draft.decimal} onChange={(event) => setDraft({ ...draft, decimal: event.target.value })} />
            </Field>
            <Field label="Unit code" hint="(optional)">
              <Input autoComplete="off" value={draft.unitCode} onChange={(event) => setDraft({ ...draft, unitCode: event.target.value })} />
            </Field>
          </div>
        )}
        {draft.type === 'BOOLEAN' && (
          <Field label="Value">
            <Select required value={draft.boolean} onChange={(event) => setDraft({ ...draft, boolean: event.target.value as Draft['boolean'] })}>
              <option value="">Select yes or no</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
          </Field>
        )}
        {draft.type === 'DATE' && (
          <Field label="Date value">
            <Input type="date" required value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
          </Field>
        )}
        <Field label="About" hint="(optional activity link)">
          <Select
            value={draft.encounterActivityId}
            onChange={(event) => setDraft({ ...draft, encounterActivityId: event.target.value })}
            disabled={activities === undefined}
          >
            <option value="">{activities === undefined ? 'Activities are unavailable' : 'The encounter in general'}</option>
            {(activities ?? []).map((activity) => (
              <ActivityOption key={activity.id} activity={activity} />
            ))}
          </Select>
        </Field>
        <div className="flex justify-end">
          <Button disabled={create.isPending || value === null} type="submit">
            {create.isPending ? 'Saving...' : 'Add fact'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
