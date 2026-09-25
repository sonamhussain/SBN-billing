import { useState, type FormEvent } from 'react'
import { addDiagnosis, listDiagnoses, removeDiagnosis, reorderDiagnoses, type EncounterDiagnosis } from './encounter-diagnosis.api.ts'

// A4.5 — minimal engineering check: add a DiagnosisCode to an Encounter, load the ordered active
// list, move a row to the top, and remove a row (history is kept server-side). Synthetic data only;
// nothing is logged or kept in browser storage. This is not the final FE-04 product UI.

export default function EncounterDiagnosisCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [diagnosisCodeId, setDiagnosisCodeId] = useState('')
  const [items, setItems] = useState<EncounterDiagnosis[] | null>(null)
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
    void run(async () => {
      await addDiagnosis(encounterId, diagnosisCodeId)
      setItems(await listDiagnoses(encounterId))
    })
  }

  function moveToFirst(id: string) {
    if (!items) return
    const ordered = [id, ...items.map((item) => item.id).filter((other) => other !== id)]
    void run(async () => setItems(await reorderDiagnoses(encounterId, ordered)))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'
  const smallButtonClass = 'rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Encounter Diagnosis Check (A4.5)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Diagnoses attached to an encounter form an ordered list 1..N set by the server. Removing a
        diagnosis keeps it as history and closes the gap; a correction is a new row. Order is coding order, not a medical or payer decision.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleAdd}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <input className={inputClass} value={diagnosisCodeId} onChange={(event) => setDiagnosisCodeId(event.target.value)} placeholder="Diagnosis Code UUID" aria-label="Diagnosis Code UUID" />
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={busy} type="submit">
            Add diagnosis
          </button>
          <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setItems(await listDiagnoses(encounterId)))}>
            Load diagnoses
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {items && (
        <div className="mt-3 text-sm text-slate-700">
          <p>{items.length} active diagnosis(es):</p>
          <ol className="mt-2 grid gap-1">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-100 px-3 py-2">
                <strong>{item.sequence}</strong>
                <span>{item.diagnosisCode.code}</span>
                <span className="text-slate-600">{item.diagnosisCode.displayName}</span>
                <span className="ml-auto flex gap-2">
                  <button className={smallButtonClass} disabled={busy || item.sequence === 1} type="button" onClick={() => moveToFirst(item.id)}>
                    Move to first
                  </button>
                  <button className={smallButtonClass} disabled={busy} type="button" onClick={() => void run(async () => setItems(await removeDiagnosis(item.id)))}>
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}
