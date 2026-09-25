import { useState, type FormEvent } from 'react'
import { addActivity, listActivities, removeActivity, type EncounterActivity } from './encounter-activity.api.ts'

// A4.6 — minimal engineering check: capture a service/procedure activity on an Encounter with an
// exact quantity, optional unit and ordered modifiers, load the active list, and remove an activity
// (its facts are kept server-side as history). Synthetic data only; nothing is logged or kept in
// browser storage. This is not the final FE-04 product UI.

const orNull = (value: string) => (value.trim() === '' ? null : value.trim())

export default function EncounterActivityCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [procedureCodeId, setProcedureCodeId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unitCode, setUnitCode] = useState('')
  const [modifiers, setModifiers] = useState('')
  const [items, setItems] = useState<EncounterActivity[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function handleAdd(event: FormEvent) {
    event.preventDefault()
    // Modifiers are typed comma-separated and sent in the typed order; the server trims each one.
    const modifierCodes = modifiers.trim() === '' ? [] : modifiers.split(',')
    void run(async () => {
      await addActivity(encounterId, { serviceId: orNull(serviceId), procedureCodeId: orNull(procedureCodeId), quantity, unitCode: orNull(unitCode), modifierCodes })
      setItems(await listActivities(encounterId))
    })
  }

  function handleRemove(id: string) {
    void run(async () => {
      await removeActivity(id)
      setItems(await listActivities(encounterId))
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'
  const smallButtonClass = 'rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Encounter Activity Check (A4.6)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. An activity names a Service, a Procedure code or both, with an exact quantity, an optional unit and
        ordered modifiers. Removing keeps it as history; a correction is a new activity. List order is display order, not a claim line order.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleAdd}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <input className={inputClass} value={serviceId} onChange={(event) => setServiceId(event.target.value)} placeholder="Service UUID (optional)" aria-label="Service UUID" />
        <input className={inputClass} value={procedureCodeId} onChange={(event) => setProcedureCodeId(event.target.value)} placeholder="Procedure code UUID (optional)" aria-label="Procedure code UUID" />
        <input className={inputClass} value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="Quantity, e.g. 2.5" aria-label="Quantity" />
        <input className={inputClass} value={unitCode} onChange={(event) => setUnitCode(event.target.value)} placeholder="Unit code (optional)" aria-label="Unit code" />
        <input className={inputClass} value={modifiers} onChange={(event) => setModifiers(event.target.value)} placeholder="Modifiers in order, comma-separated (optional)" aria-label="Modifier codes" />
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={busy} type="submit">
            Add activity
          </button>
          <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setItems(await listActivities(encounterId)))}>
            Load activities
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {items && (
        <div className="mt-3 text-sm text-slate-700">
          <p>{items.length} active activit{items.length === 1 ? 'y' : 'ies'}:</p>
          <ul className="mt-2 grid gap-1">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-100 px-3 py-2">
                <span>Service {item.serviceId ?? '—'}</span>
                <span>Procedure {item.procedureCodeId ?? '—'}</span>
                <span>
                  Qty {item.quantity}
                  {item.unitCode ? ` ${item.unitCode}` : ''}
                </span>
                <span>Modifiers {item.modifierCodes.length > 0 ? item.modifierCodes.join(', ') : '—'}</span>
                <span className="ml-auto">
                  <button className={smallButtonClass} disabled={busy} type="button" onClick={() => handleRemove(item.id)}>
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
