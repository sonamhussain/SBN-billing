import { useState, type FormEvent } from 'react'
import { addObservation, listObservations, removeObservation, type EncounterObservation, type ObservationValue } from './encounter-observation.api.ts'

// A4.7 — minimal engineering check: record a typed structured fact on an Encounter (optionally
// anchored to one of its active activities), load the active list, and remove a fact (it is kept
// server-side as history). Synthetic data only; nothing is logged or kept in browser storage. This
// is not the final FE-04 product UI, and no fact is interpreted here.

type ValueType = ObservationValue['type']

function describe(value: ObservationValue): string {
  if (value.type === 'TEXT') return value.text
  if (value.type === 'DECIMAL') return value.unitCode ? `${value.decimal} ${value.unitCode}` : value.decimal
  if (value.type === 'BOOLEAN') return value.boolean ? 'true' : 'false'
  return value.date
}

export default function EncounterObservationCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [activityId, setActivityId] = useState('')
  const [factKey, setFactKey] = useState('')
  const [valueType, setValueType] = useState<ValueType>('DECIMAL')
  const [rawValue, setRawValue] = useState('')
  const [unitCode, setUnitCode] = useState('')
  const [items, setItems] = useState<EncounterObservation[] | null>(null)
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

  // The typed value is sent exactly as entered; the server validates it and never coerces.
  function buildValue(): ObservationValue {
    if (valueType === 'TEXT') return { type: 'TEXT', text: rawValue }
    if (valueType === 'DECIMAL') return { type: 'DECIMAL', decimal: rawValue, unitCode: unitCode.trim() === '' ? null : unitCode }
    if (valueType === 'BOOLEAN') {
      // An unchosen selector must not silently become false: the check UI never guesses a typed value.
      if (rawValue !== 'true' && rawValue !== 'false') throw new Error('Choose true or false')
      return { type: 'BOOLEAN', boolean: rawValue === 'true' }
    }
    return { type: 'DATE', date: rawValue }
  }

  function handleAdd(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      // Built inside run() so a refused typed value is reported in the error line, not swallowed.
      const value = buildValue()
      await addObservation(encounterId, { encounterActivityId: activityId.trim() === '' ? null : activityId.trim(), factKey, value })
      setItems(await listObservations(encounterId))
    })
  }

  function handleRemove(id: string) {
    void run(async () => {
      await removeObservation(id)
      setItems(await listObservations(encounterId))
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'
  const smallButtonClass = 'rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Encounter Observation Check (A4.7)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. A structured fact has an opaque key and exactly one typed value (text, decimal with an optional unit,
        true/false or a date), about the Encounter or one of its active activities. Facts are stored, never evaluated; removing keeps history.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleAdd}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <input className={inputClass} value={activityId} onChange={(event) => setActivityId(event.target.value)} placeholder="Activity UUID (optional)" aria-label="Activity UUID" />
        <input className={inputClass} value={factKey} onChange={(event) => setFactKey(event.target.value)} placeholder="Fact key, e.g. SYNTHETIC_HEIGHT" aria-label="Fact key" />
        <select className={inputClass} value={valueType} onChange={(event) => setValueType(event.target.value as ValueType)} aria-label="Value type">
          <option value="TEXT">TEXT</option>
          <option value="DECIMAL">DECIMAL</option>
          <option value="BOOLEAN">BOOLEAN</option>
          <option value="DATE">DATE</option>
        </select>
        {valueType === 'BOOLEAN' ? (
          <select className={inputClass} value={rawValue} onChange={(event) => setRawValue(event.target.value)} aria-label="Value">
            <option value="">Choose true or false</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            className={inputClass}
            value={rawValue}
            onChange={(event) => setRawValue(event.target.value)}
            placeholder={valueType === 'DATE' ? 'YYYY-MM-DD' : valueType === 'DECIMAL' ? 'e.g. 175.5' : 'Text value'}
            aria-label="Value"
          />
        )}
        {valueType === 'DECIMAL' && (
          <input className={inputClass} value={unitCode} onChange={(event) => setUnitCode(event.target.value)} placeholder="Unit (optional), e.g. cm" aria-label="Unit code" />
        )}
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={busy} type="submit">
            Add observation
          </button>
          <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setItems(await listObservations(encounterId)))}>
            Load observations
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {items && (
        <div className="mt-3 text-sm text-slate-700">
          <p>{items.length} active observation(s):</p>
          <ul className="mt-2 grid gap-1">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-100 px-3 py-2">
                <strong>{item.factKey}</strong>
                <span>= {describe(item.value)}</span>
                <span className="text-slate-600">Scope: {item.encounterActivityId ? `Activity ${item.encounterActivityId}` : 'Encounter'}</span>
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
