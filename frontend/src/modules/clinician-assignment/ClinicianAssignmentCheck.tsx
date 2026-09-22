import { useState, type FormEvent } from 'react'
import {
  closeAssignment,
  createAssignment,
  getAssignment,
  listAssignments,
  type Assignment,
  type AssignmentKind,
} from './clinician-assignment.api.ts'

// A4.2 — minimal developer check: create, list, get and close, for both assignment kinds, using
// synthetic IDs. It shows identifiers and effective periods only — no licence, no credentialing,
// no patient or encounter coupling, and nothing kept in browser storage.

export default function ClinicianAssignmentCheck() {
  const [kind, setKind] = useState<AssignmentKind>('facility')
  const [clinicianId, setClinicianId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState('2026-01-01')
  const [effectiveTo, setEffectiveTo] = useState('')
  const [assignmentId, setAssignmentId] = useState('')
  const [closeDate, setCloseDate] = useState('')
  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [items, setItems] = useState<Assignment[] | null>(null)
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

  function handleCreate(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const created = await createAssignment(kind, clinicianId, targetId, effectiveFrom, effectiveTo)
      setAssignment(created)
      setAssignmentId(created.id)
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'
  const targetLabel = kind === 'facility' ? 'Facility UUID' : 'Specialty UUID'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Clinician Assignment Check (A4.2)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. An assignment records that a clinician practised at a facility, or in a specialty, between
        two dates. Both boundaries are inclusive, the same pair may not have overlapping periods, and an assignment is closed once —
        never reopened or deleted. This is not credentialing and not payer participation.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value as AssignmentKind)} aria-label="Assignment kind">
          <option value="facility">facility assignment</option>
          <option value="specialty">specialty assignment</option>
        </select>
        <input className={inputClass} value={clinicianId} onChange={(event) => setClinicianId(event.target.value)} placeholder="Clinician UUID" aria-label="Clinician UUID" />
        <input className={inputClass} value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder={targetLabel} aria-label={targetLabel} />
        <input className={inputClass} value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} placeholder="effectiveFrom (YYYY-MM-DD)" aria-label="Effective from" />
        <input className={inputClass} value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} placeholder="effectiveTo (blank = still open)" aria-label="Effective to" />
        <button className={buttonClass} disabled={busy} type="submit">
          Create Assignment
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setItems(await listAssignments(kind, clinicianId)))}>
          List Assignments
        </button>
        <input className={inputClass} value={assignmentId} onChange={(event) => setAssignmentId(event.target.value)} placeholder="Assignment UUID" aria-label="Assignment UUID" />
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setAssignment(await getAssignment(kind, assignmentId)))}>
          Get Assignment
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <input className={inputClass} value={closeDate} onChange={(event) => setCloseDate(event.target.value)} placeholder="close on (YYYY-MM-DD)" aria-label="Closing date" />
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setAssignment(await closeAssignment(kind, assignmentId, closeDate)))}>
          Close Assignment
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {assignment && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm">
          <p>
            id: {assignment.id} — clinicianId: {assignment.clinicianId}
          </p>
          <p>
            {assignment.facilityId ? `facilityId: ${assignment.facilityId}` : `specialtyId: ${assignment.specialtyId}`} — period:{' '}
            <strong>
              {assignment.effectiveFrom} → {assignment.effectiveTo ?? 'open'}
            </strong>
          </p>
        </div>
      )}

      {items && (
        <div className="mt-3 text-sm text-slate-700">
          <p>{items.length} assignment(s) for this clinician:</p>
          <ul className="mt-1 list-disc pl-5">
            {items.map((item) => (
              <li key={item.id}>
                {item.id} — {item.facilityId ?? item.specialtyId} — {item.effectiveFrom} → {item.effectiveTo ?? 'open'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
