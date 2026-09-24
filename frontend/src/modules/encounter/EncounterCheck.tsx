import { useState, type FormEvent } from 'react'
import { createEncounter, getEncounter, listEncounters, patchEncounter, type Encounter, type EncounterInput } from './encounter.api.ts'

// A4.4 — minimal developer check: create, list, get and correct an Encounter with synthetic IDs.
// It shows the context the SERVER resolved (assignment and regulatory profile) — never an
// eligibility badge, claim status or price — and keeps nothing in browser storage. This is not the
// front-desk or clinical UI.

const patchableFields = ['serviceDate', 'facilityId', 'clinicianId', 'insuranceMembershipId'] as const

export default function EncounterCheck() {
  const [patientId, setPatientId] = useState('')
  const [input, setInput] = useState<EncounterInput>({ facilityId: '', clinicianId: '', insuranceMembershipId: '', serviceDate: '2026-09-23' })
  const [encounterId, setEncounterId] = useState('')
  const [patchField, setPatchField] = useState<(typeof patchableFields)[number]>('serviceDate')
  const [patchValue, setPatchValue] = useState('')
  const [encounter, setEncounter] = useState<Encounter | null>(null)
  const [items, setItems] = useState<Encounter[] | null>(null)
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
      const created = await createEncounter(patientId, input)
      setEncounter(created)
      setEncounterId(created.id)
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'
  const field = (key: keyof EncounterInput, placeholder: string) => (
    <input className={inputClass} value={input[key]} onChange={(event) => setInput({ ...input, [key]: event.target.value })} placeholder={placeholder} aria-label={placeholder} />
  )

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Encounter Check (A4.4)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. An encounter records one service event: patient, facility, clinician and service date, with an
        optional recorded insurance membership. The server resolves the clinician's facility assignment and the facility's ACTIVE regulatory
        profile for that date, and refuses the encounter if either is missing or ambiguous. This is not eligibility, authorization or a claim.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input className={inputClass} value={patientId} onChange={(event) => setPatientId(event.target.value)} placeholder="Patient UUID" aria-label="Patient UUID" />
        {field('facilityId', 'Facility UUID')}
        {field('clinicianId', 'Clinician UUID')}
        {field('insuranceMembershipId', 'Insurance membership UUID (blank = self-pay)')}
        {field('serviceDate', 'Service date (YYYY-MM-DD)')}
        <button className={buttonClass} disabled={busy} type="submit">
          Create Encounter
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setItems(await listEncounters(patientId)))}>
          List Encounters
        </button>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setEncounter(await getEncounter(encounterId)))}>
          Get Encounter
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <select className={inputClass} value={patchField} onChange={(event) => setPatchField(event.target.value as (typeof patchableFields)[number])} aria-label="Field to correct">
          {patchableFields.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input className={inputClass} value={patchValue} onChange={(event) => setPatchValue(event.target.value)} placeholder="new value (blank clears membership)" aria-label="New value" />
        <button
          className={buttonClass}
          disabled={busy}
          type="button"
          onClick={() => void run(async () => setEncounter(await patchEncounter(encounterId, { [patchField]: patchValue.trim() === '' ? null : patchValue })))}
        >
          Correct Encounter
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {encounter && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm">
          <p>
            id: {encounter.id} — patientId: {encounter.patientId} — service date: <strong>{encounter.serviceDate}</strong>
          </p>
          <p>
            facility: {encounter.facilityId} — clinician: {encounter.clinicianId} — membership: {encounter.insuranceMembershipId ?? 'none (self-pay)'}
          </p>
          <p>
            server-resolved assignment: {encounter.clinicianFacilityAssignmentId} — regulatory profile: {encounter.facilityRegulatoryProfileId}
          </p>
        </div>
      )}

      {items && (
        <div className="mt-3 text-sm text-slate-700">
          <p>{items.length} encounter(s) for this patient:</p>
          <ul className="mt-1 list-disc pl-5">
            {items.map((item) => (
              <li key={item.id}>
                {item.id} — {item.serviceDate} — facility {item.facilityId}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
